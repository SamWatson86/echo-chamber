# Networking

## Hardware Topology

```
Internet
    │
[ATT BGW320-500]
    │  IP Passthrough mode — NAT disabled, passes public IP to Eero
    │  Public IP: 99.111.153.69
    │
[Eero router]  ← real router: DHCP, NAT, port forwards, firewall
    │
    ├── Main PC         192.168.5.70    server + Sam's participant machine
    └── SAM-PC          192.168.5.149   test/friend machine (Sandy Bridge, GTX 760, Win10)
```

## Port Forwards (on Eero)

| Port | Protocol | Destination | Purpose |
|------|----------|-------------|---------|
| 9443 | TCP | 192.168.5.70:9443 | Control plane HTTPS + WSS |
| 7881 | TCP | 192.168.5.70:7881 | LiveKit SFU TCP relay |
| 3478 | UDP | 192.168.5.70:3478 | TURN server |
| 40000-40099 | UDP | 192.168.5.70 | SFU WebRTC media (SRTP/DTLS) |

## DNS

`echo.fellowshipoftheboatrace.party` → `99.111.153.69` (public IP, A record)

Let's Encrypt TLS cert for this domain. Cert path configured via `CORE_TLS_CERT` / `CORE_TLS_KEY` env vars.

## SFU Proxy

**The SFU is never exposed directly.** Friends must not connect to port 7880.

The control plane proxies WebSocket connections to the SFU at `/rtc`, `/sfu`, and `/sfu/rtc`. The proxy in `sfu_proxy.rs`:

1. Extracts `Authorization: Bearer <token>` from the upgrade request header
2. Appends `?access_token=<token>` to the upstream SFU URL (LiveKit accepts token as query param)
3. Upgrades both sides to WebSocket
4. Negotiates `livekit` subprotocol
5. Bidirectionally pipes frames

The JS viewer derives the SFU URL from the control URL:
```js
var sfuUrl = controlUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
// e.g. https://echo.fellowshipoftheboatrace.party:9443
//   →  wss://echo.fellowshipoftheboatrace.party:9443
```

This means all WebRTC signaling goes through port 9443, not 7880.

## TURN Server

Go/pion TURN server running at `core/turn/`. Provides ICE relay for guests with restrictive NAT.

Config via env vars: `TURN_PUBLIC_IP`, `TURN_PORT` (3478), `TURN_USER`, `TURN_PASS`.

The control plane returns TURN credentials via `/v1/ice-servers`. The viewer includes them in the LiveKit room connect options.

LiveKit SFU config (`livekit.yaml`) must include `use_external_ip: true` so the SFU advertises the public IP in ICE candidates, not the LAN IP. Without this, external users get LAN candidates that are unreachable.

## Hairpin NAT

Sam's PC connects to the server using the public domain URL. Eero supports hairpin NAT (loopback NAT), so `echo.fellowshipoftheboatrace.party:9443` resolves to the public IP but the traffic is correctly routed back to Main PC on the LAN. This works in testing without needing a split-horizon DNS setup.

## Testing Topology

### LAN (Sam + SAM-PC)

| Machine | Connection | URL |
|---------|-----------|-----|
| Main PC (Sam) | `https://echo.fellowshipoftheboatrace.party:9443` | hairpin NAT |
| SAM-PC | `https://192.168.5.70:9443` | direct LAN IP in `config.json` |

SAM-PC's `config.json` uses `192.168.5.70` instead of the domain — avoids hairpin NAT on older Eero firmware that may not support it reliably.

### WAN (Friends)

Friends use `https://echo.fellowshipoftheboatrace.party:9443` with no `config.json` override — the Tauri client binary has `DEFAULT_SERVER` hardcoded to the domain URL.

## CORS

Control plane applies a permissive CORS policy (`allow_origin: Any`, `allow_methods: Any`, `allow_headers: Any`) to all routes. This allows the viewer to call the control plane API from any origin, including Tauri's internal `tauri://` scheme.
