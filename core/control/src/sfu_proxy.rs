use axum::extract::ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::extract::OriginalUri;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

/// Global connection counter for unique IDs per proxy session.
static CONN_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) async fn sfu_proxy(
    ws: WebSocketUpgrade,
    uri: OriginalUri,
    headers: HeaderMap,
) -> impl IntoResponse {
    let subprotocol = headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("<none>");
    let token_len = uri
        .query()
        .and_then(|q| q.split('&').find(|p| p.starts_with("access_token=")))
        .map(|p| p.trim_start_matches("access_token=").len())
        .unwrap_or(0);
    // LiveKit Rust SDK sends token as Authorization: Bearer header instead of
    // access_token query param. Extract it so we can inject into the upstream URL.
    let bearer_token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|s| s.to_string());
    let auth_source = if bearer_token.is_some() {
        "bearer-header"
    } else if token_len > 0 {
        "query-param"
    } else {
        "none"
    };
    let conn_id = CONN_ID.fetch_add(1, Ordering::Relaxed);
    info!(
        "[proxy:{}] new request: {} (subprotocol: {}, auth: {}, token_len: {})",
        conn_id, uri.0, subprotocol, auth_source,
        token_len.max(bearer_token.as_ref().map_or(0, |t| t.len()))
    );
    // Negotiate the `livekit` WebSocket subprotocol — Rust SDK requires it in the
    // handshake response or it closes the connection immediately.
    ws.protocols(["livekit"])
        .on_upgrade(move |socket| handle_sfu_socket(conn_id, socket, uri.0, bearer_token))
}

pub(crate) async fn handle_sfu_socket(
    conn_id: u64,
    socket: WebSocket,
    uri: axum::http::Uri,
    bearer_token: Option<String>,
) {
    let upstream_base =
        std::env::var("CORE_SFU_PROXY").unwrap_or_else(|_| "ws://127.0.0.1:7880".to_string());
    let mut query = uri.query().unwrap_or("").to_string();
    // If the client sent Authorization: Bearer (Rust SDK) and no access_token in the
    // query string, inject it so the upstream SFU receives the token.
    if let Some(ref token) = bearer_token {
        let has_access_token = query.split('&').any(|p| p.starts_with("access_token="));
        if !has_access_token {
            if query.is_empty() {
                query = format!("access_token={}", token);
            } else {
                query = format!("{}&access_token={}", query, token);
            }
        }
    }
    let trimmed = upstream_base.trim_end_matches('/');
    let needs_rtc = !trimmed.ends_with("/rtc");
    let base_with_path = if needs_rtc {
        format!("{}/rtc", trimmed)
    } else {
        trimmed.to_string()
    };
    let upstream = if query.is_empty() {
        base_with_path
    } else {
        format!("{}?{}", base_with_path, query)
    };
    info!("[proxy:{}] upstream: {} (path: {})", conn_id, upstream, uri.path());
    let mut request = match upstream.clone().into_client_request() {
        Ok(req) => req,
        Err(e) => {
            warn!("[proxy:{}] failed to build ws request: {}", conn_id, e);
            return;
        }
    };
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static("livekit"),
    );
    let (upstream_ws, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(pair) => pair,
        Err(err) => {
            warn!("[proxy:{}] failed to connect to SFU: {}", conn_id, err);
            return;
        }
    };
    info!("[proxy:{}] connected to SFU", conn_id);

    let (up_tx, up_rx) = upstream_ws.split();
    let (client_tx, client_rx) = socket.split();

    let start = std::time::Instant::now();

    // ── Full-duplex forwarding via two independent spawned tasks ──
    //
    // CRITICAL FIX: The previous code used a single `tokio::select!` loop that
    // processed one direction at a time. While awaiting a send to the WAN client,
    // messages from the client (including LiveKit protobuf heartbeat pongs) could
    // not be forwarded to the SFU. Under multi-user load (more signaling traffic),
    // this caused the SFU's 15-second ping timeout to fire, disconnecting $screen
    // every 10-15 seconds.
    //
    // Now each direction runs as an independent spawned task. A slow WAN send in
    // one direction cannot block heartbeat forwarding in the other.
    //
    // No proxy-level keepalive pings: both sides handle their own heartbeats.
    // LiveKit sends protobuf pings every 5 seconds — more than enough to keep
    // connections alive through NAT/firewalls. Extra WS-level pings from the proxy
    // interfered with the SDK's RTT measurement and added unnecessary traffic.

    let c2s_count = Arc::new(AtomicU64::new(0));
    let s2c_count = Arc::new(AtomicU64::new(0));

    let c2s_counter = c2s_count.clone();
    let s2c_counter = s2c_count.clone();

    // Use a notify to signal shutdown between the two tasks.
    let c2s_done = Arc::new(tokio::sync::Notify::new());
    let s2c_done = Arc::new(tokio::sync::Notify::new());

    // ── Client → SFU ──
    let c2s_done_signal = c2s_done.clone();
    let s2c_done_signal = s2c_done.clone();
    let c2s_handle = tokio::spawn(async move {
        let mut client_rx = client_rx;
        let mut up_tx = up_tx;
        let reason = loop {
            tokio::select! {
                biased;
                _ = s2c_done_signal.notified() => {
                    // Other direction closed — shut down gracefully
                    let _ = up_tx.send(WsMessage::Close(None)).await;
                    break "peer-shutdown";
                }
                msg = client_rx.next() => {
                    match msg {
                        Some(Ok(AxumMessage::Binary(bin))) => {
                            c2s_counter.fetch_add(1, Ordering::Relaxed);
                            if let Err(e) = up_tx.send(WsMessage::Binary(bin)).await {
                                warn!("[proxy:{}] c→s send error: {}", conn_id, e);
                                break "send-error-upstream";
                            }
                        }
                        Some(Ok(AxumMessage::Text(text))) => {
                            c2s_counter.fetch_add(1, Ordering::Relaxed);
                            if let Err(e) = up_tx.send(WsMessage::Text(text)).await {
                                warn!("[proxy:{}] c→s send error: {}", conn_id, e);
                                break "send-error-upstream";
                            }
                        }
                        Some(Ok(AxumMessage::Ping(p))) => {
                            if let Err(e) = up_tx.send(WsMessage::Ping(p)).await {
                                warn!("[proxy:{}] c→s ping fwd error: {}", conn_id, e);
                                break "send-error-upstream";
                            }
                        }
                        Some(Ok(AxumMessage::Pong(p))) => {
                            if let Err(e) = up_tx.send(WsMessage::Pong(p)).await {
                                warn!("[proxy:{}] c→s pong fwd error: {}", conn_id, e);
                                break "send-error-upstream";
                            }
                        }
                        Some(Ok(AxumMessage::Close(frame))) => {
                            let (code, reason) = frame
                                .map(|f| (f.code, f.reason.to_string()))
                                .unwrap_or((0, String::new()));
                            info!(
                                "[proxy:{}] client sent Close (code={}, reason='{}')",
                                conn_id, code, reason
                            );
                            let _ = up_tx.send(WsMessage::Close(None)).await;
                            break "client-close";
                        }
                        Some(Err(e)) => {
                            warn!("[proxy:{}] client read error: {}", conn_id, e);
                            let _ = up_tx.send(WsMessage::Close(None)).await;
                            break "client-read-error";
                        }
                        None => {
                            info!("[proxy:{}] client stream ended", conn_id);
                            let _ = up_tx.send(WsMessage::Close(None)).await;
                            break "client-stream-end";
                        }
                    }
                }
            }
        };
        c2s_done_signal.notify_one(); // tell the other direction to stop
        reason
    });

    // ── SFU → Client ──
    let c2s_done_signal2 = c2s_done.clone();
    let s2c_done_signal2 = s2c_done.clone();
    let s2c_handle = tokio::spawn(async move {
        let mut up_rx = up_rx;
        let mut client_tx = client_tx;
        let reason = loop {
            tokio::select! {
                biased;
                _ = c2s_done_signal2.notified() => {
                    let _ = client_tx.send(AxumMessage::Close(None)).await;
                    break "peer-shutdown";
                }
                msg = up_rx.next() => {
                    match msg {
                        Some(Ok(WsMessage::Binary(bin))) => {
                            s2c_counter.fetch_add(1, Ordering::Relaxed);
                            if let Err(e) = client_tx.send(AxumMessage::Binary(bin)).await {
                                warn!("[proxy:{}] s→c send error: {}", conn_id, e);
                                break "send-error-client";
                            }
                        }
                        Some(Ok(WsMessage::Text(text))) => {
                            s2c_counter.fetch_add(1, Ordering::Relaxed);
                            if let Err(e) = client_tx.send(AxumMessage::Text(text)).await {
                                warn!("[proxy:{}] s→c send error: {}", conn_id, e);
                                break "send-error-client";
                            }
                        }
                        Some(Ok(WsMessage::Ping(p))) => {
                            if let Err(e) = client_tx.send(AxumMessage::Ping(p)).await {
                                warn!("[proxy:{}] s→c ping fwd error: {}", conn_id, e);
                                break "send-error-client";
                            }
                        }
                        Some(Ok(WsMessage::Pong(p))) => {
                            if let Err(e) = client_tx.send(AxumMessage::Pong(p)).await {
                                warn!("[proxy:{}] s→c pong fwd error: {}", conn_id, e);
                                break "send-error-client";
                            }
                        }
                        Some(Ok(WsMessage::Close(frame))) => {
                            let (code, reason) = frame
                                .map(|f| (f.code.into(), f.reason.to_string()))
                                .unwrap_or((0u16, String::new()));
                            info!(
                                "[proxy:{}] SFU sent Close (code={}, reason='{}')",
                                conn_id, code, reason
                            );
                            let _ = client_tx.send(AxumMessage::Close(None)).await;
                            break "sfu-close";
                        }
                        Some(Ok(WsMessage::Frame(_))) => {
                            // Raw frame — shouldn't happen, ignore
                        }
                        Some(Err(e)) => {
                            warn!("[proxy:{}] SFU read error: {}", conn_id, e);
                            let _ = client_tx.send(AxumMessage::Close(None)).await;
                            break "sfu-read-error";
                        }
                        None => {
                            info!("[proxy:{}] SFU stream ended", conn_id);
                            let _ = client_tx.send(AxumMessage::Close(None)).await;
                            break "sfu-stream-end";
                        }
                    }
                }
            }
        };
        s2c_done_signal2.notify_one(); // tell the other direction to stop
        reason
    });

    // Wait for both tasks to finish
    let c2s_reason = c2s_handle.await.unwrap_or("task-panic");
    let s2c_reason = s2c_handle.await.unwrap_or("task-panic");

    let elapsed = start.elapsed();
    let c2s_total = c2s_count.load(Ordering::Relaxed);
    let s2c_total = s2c_count.load(Ordering::Relaxed);
    info!(
        "[proxy:{}] closed — lifetime={:.1}s, c→s={} msgs, s→c={} msgs, c2s_exit={}, s2c_exit={}",
        conn_id, elapsed.as_secs_f64(), c2s_total, s2c_total, c2s_reason, s2c_reason
    );
}
