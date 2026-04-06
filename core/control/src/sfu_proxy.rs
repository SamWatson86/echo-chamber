use axum::extract::ws::{Message as AxumMessage, WebSocket, WebSocketUpgrade};
use axum::extract::OriginalUri;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{info, warn};

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
    info!(
        "sfu proxy request: {} (subprotocol: {}, auth: {}, token_len: {})",
        uri.0, subprotocol, auth_source, token_len.max(bearer_token.as_ref().map_or(0, |t| t.len()))
    );
    // Negotiate the `livekit` WebSocket subprotocol — Rust SDK requires it in the
    // handshake response or it closes the connection immediately.
    ws.protocols(["livekit"])
        .on_upgrade(move |socket| handle_sfu_socket(socket, uri.0, bearer_token))
}

pub(crate) async fn handle_sfu_socket(socket: WebSocket, uri: axum::http::Uri, bearer_token: Option<String>) {
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
    info!("sfu proxy upstream: {} (path: {})", upstream, uri.path());
    let mut request = match upstream.clone().into_client_request() {
        Ok(req) => req,
        Err(_) => {
            warn!("failed to build ws request for {}", upstream);
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
            warn!("failed to connect to livekit via proxy: {}", err);
            return;
        }
    };
    info!("sfu proxy connected to livekit");
    let (mut up_tx, mut up_rx) = upstream_ws.split();
    let (mut client_tx, mut client_rx) = socket.split();

    loop {
        tokio::select! {
            Some(msg) = client_rx.next() => {
                match msg {
                    Ok(AxumMessage::Text(text)) => { let _ = up_tx.send(WsMessage::Text(text)).await; }
                    Ok(AxumMessage::Binary(bin)) => { let _ = up_tx.send(WsMessage::Binary(bin)).await; }
                    Ok(AxumMessage::Ping(payload)) => { let _ = up_tx.send(WsMessage::Ping(payload)).await; }
                    Ok(AxumMessage::Pong(payload)) => { let _ = up_tx.send(WsMessage::Pong(payload)).await; }
                    Ok(AxumMessage::Close(_)) | Err(_) => { let _ = up_tx.send(WsMessage::Close(None)).await; break; }
                }
            }
            Some(msg) = up_rx.next() => {
                match msg {
                    Ok(WsMessage::Text(text)) => { let _ = client_tx.send(AxumMessage::Text(text)).await; }
                    Ok(WsMessage::Binary(bin)) => { let _ = client_tx.send(AxumMessage::Binary(bin)).await; }
                    Ok(WsMessage::Ping(payload)) => { let _ = client_tx.send(AxumMessage::Ping(payload)).await; }
                    Ok(WsMessage::Pong(payload)) => { let _ = client_tx.send(AxumMessage::Pong(payload)).await; }
                    Ok(WsMessage::Close(_)) | Err(_) => { let _ = client_tx.send(AxumMessage::Close(None)).await; break; }
                    _ => {}
                }
            }
            else => break,
        }
    }
    info!("sfu proxy closed");
}
