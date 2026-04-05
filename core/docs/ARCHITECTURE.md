# Echo Chamber — System Architecture

## Component Overview

```
┌──────────────────────────────────────────────────────────┐
│                     Sam's PC (server + participant)       │
│                                                          │
│  ┌─────────────────┐        ┌────────────────────────┐   │
│  │  Rust Control   │◄──────►│  LiveKit SFU           │   │
│  │  Plane (axum)   │  gRPC  │  (native Windows bin)  │   │
│  │  port 9443      │        │  port 7880 (internal)  │   │
│  └────────┬────────┘        └──────────┬─────────────┘   │
│           │ serves                     │ WebRTC           │
│           │                            │                  │
│  ┌────────▼────────┐        ┌──────────▼─────────────┐   │
│  │  Web Viewer     │        │  TURN Server (Go/pion)  │   │
│  │  /viewer/*      │        │  port 3478 UDP          │   │
│  │  (static files) │        └─────────────────────────┘   │
│  └─────────────────┘                                      │
└──────────────────────────────────────────────────────────┘
         ▲ HTTPS/WSS :9443
         │ (all traffic through one port)
┌────────┴──────────────────────────────────────────────┐
│  Clients (all use Tauri native app)                   │
│                                                       │
│  ┌──────────────────┐    ┌──────────────────────────┐ │
│  │  Tauri Client    │    │  Tauri Client            │ │
│  │  (Sam — LAN or   │    │  (Friends — external)    │ │
│  │   domain URL)    │    │  domain URL              │ │
│  └──────────────────┘    └──────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

## Data Flow

### Capture → Encode → Stream → Display

```
[Sam's screen]
     │
     ▼ DXGI Desktop Duplication or WGC (Windows capture APIs)
[D3D11 GPU texture]
     │
     ▼ D3D11 compute shader (HDR→SDR + downscale, <1ms GPU)
[BGRA8 texture @ encode resolution]
     │
     ▼ CopyResource staging → libyuv BGRA→I420
[I420 frame in CPU memory]
     │
     ▼ NativeVideoSource::capture_frame (Rust LiveKit SDK)
[H264 via NVENC (RTX 4090)]
     │
     ▼ RTP over WebSocket
[LiveKit SFU]
     │
     ▼ forwarded RTP streams
[Viewer (WebRTC decode in WebView2)]
     │
     ▼ <video> element
[Screen displayed to friend]
```

### Authentication Flow

```
Client                    Control Plane              LiveKit SFU
  │                            │                          │
  ├── POST /v1/auth/login ────►│                          │
  │◄── JWT admin token ────────┤                          │
  │                            │                          │
  ├── POST /v1/auth/token ────►│                          │
  │   (room, identity)         │──── generate LK token    │
  │◄── LiveKit access token ───┤                          │
  │                            │                          │
  ├── WSS /rtc?access_token=.. ─────────────────────────►│
  │   (proxied by control plane)                          │
  │◄─────────────── WebRTC signaling ────────────────────►│
```

## Deployment

All components run on Sam's PC. There is no cloud.

| Component | Binary | Port |
|-----------|--------|------|
| Control Plane | `core/target/debug/echo-core-control.exe` | 9443 (HTTPS) |
| LiveKit SFU | `core/sfu/livekit-server.exe` | 7880 (internal only) |
| TURN Server | `core/turn/` (Go/pion) | 3478 UDP |
| Tauri Client | `core/target/release/echo-core-client.exe` | — |

The SFU is **never exposed directly**. All traffic (HTTP, WebSocket, signaling) enters through port 9443 on the control plane. The control plane proxies WebSocket connections to the SFU.

## Network Topology

See [NETWORKING.md](NETWORKING.md) for full detail.

```
Internet
   │
[ATT BGW320-500] — IP passthrough
   │
[Eero router] — real DHCP/NAT/port-forward
   │ Port forwards: 9443 TCP, 7881 TCP, 3478 UDP, 40000-40099 UDP
   │
[Main PC — 192.168.5.70]
   ├── Control Plane (:9443)
   ├── SFU (:7880 internal, :7881 TCP external relay)
   └── TURN (:3478)
   │
[SAM-PC — 192.168.5.149] — test/friend machine on same LAN
```

Public domain: `echo.fellowshipoftheboatrace.party` → `99.111.153.69` → Eero → Main PC

## Key Design Decisions

- **Single-port external access** — friends only need port 9443 open (TLS for everything)
- **SFU proxied through control plane** — never expose port 7880; derive SFU WSS URL from control URL
- **Tauri loads viewer from server** — JS/CSS changes are live on refresh, no client rebuild needed
- **$screen companion identity** — screen share Rust participant joins as `{id}$screen`, viewer merges tracks under real participant

See [DECISIONS.md](DECISIONS.md) for full decision log.
