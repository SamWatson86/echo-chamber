# Tauri Client Module Map

Source: `core/client/src/`

The client is a Tauri v2 app. It opens a WebView2 window that loads the viewer from the server URL. Most functionality is in the viewer JS — the native binary exists for capture, audio, window management, and auto-update.

## Modules

| File | Platform | Purpose |
|------|----------|---------|
| `main.rs` | all | Entry point, IPC command registration, window setup, updater |
| `desktop_capture.rs` | Windows | DXGI Desktop Duplication capture + GPU pipeline |
| `screen_capture.rs` | Windows | WGC (Windows.Graphics.Capture) capture + GPU pipeline |
| `gpu_converter.rs` | Windows | Shared D3D11 compute shader: HDR→SDR + downscale |
| `audio_capture.rs` | Windows | WASAPI per-process loopback capture |
| `audio_capture_stub.rs` | non-Windows | No-op stubs for audio capture types |
| `audio_output.rs` | Windows | Output device enumeration |
| `audio_output_stub.rs` | non-Windows | No-op stubs for audio output types |

## Platform Abstraction

Conditional compilation via `#[cfg(target_os = "windows")]`:

```rust
#[cfg(target_os = "windows")]
mod audio_capture;
#[cfg(not(target_os = "windows"))]
mod audio_capture_stub;
#[cfg(not(target_os = "windows"))]
use audio_capture_stub as audio_capture;

#[cfg(target_os = "windows")]
mod screen_capture;

#[cfg(target_os = "windows")]
mod gpu_converter;
#[cfg(target_os = "windows")]
mod desktop_capture;
```

Non-Windows builds compile cleanly with stub modules. There is no macOS/Linux capture support.

## IPC Command Routing

All Tauri IPC commands are registered in `main.rs` via `tauri::generate_handler![]`.

| Command | Module | Purpose |
|---------|--------|---------|
| `get_app_info` | main.rs | Returns version, native flag, platform, server URL |
| `get_control_url` | main.rs | Returns configured server URL |
| `check_for_updates` | main.rs | Checks GitHub releases, downloads + installs if available |
| `toggle_fullscreen` | main.rs | Toggles window fullscreen state |
| `set_always_on_top` | main.rs | Pins window above all others |
| `open_external_url` | main.rs | Opens http/https URL in system browser (rundll32 on Windows) |
| `save_settings` | main.rs | Writes settings JSON to `%APPDATA%/echo-chamber/settings.json` |
| `load_settings` | main.rs | Reads settings JSON (returns `{}` if missing) |
| `get_os_build_number` | main.rs | Returns Windows build number (for WGC availability check) |
| `list_capturable_windows` | audio_capture.rs | Lists visible windows with PID/title/exe |
| `start_audio_capture` | audio_capture.rs | Starts WASAPI process loopback for given PID |
| `stop_audio_capture` | audio_capture.rs | Stops WASAPI capture loop |
| `list_audio_output_devices` | audio_output.rs | Enumerates audio output devices |
| `list_capture_sources` | screen_capture.rs / desktop_capture.rs | Lists monitors + windows for picker |
| `start_screen_share_wgc` | screen_capture.rs | Starts WGC capture + LiveKit publish |
| `start_screen_share_dxgi` | desktop_capture.rs | Starts DXGI DD capture + LiveKit publish |
| `stop_screen_share` | screen_capture.rs / desktop_capture.rs | Stops active capture |
| `get_screen_share_stats` | screen_capture.rs / desktop_capture.rs | Returns FPS, resolution, encoder, bitrate |

## Tauri Events (Rust → JS)

| Event | Source | Payload |
|-------|--------|---------|
| `audio-chunk` | audio_capture.rs | base64-encoded PCM float32 chunk |
| `screen-share-stats` | screen_capture.rs / desktop_capture.rs | JSON with fps, width, height, bitrate_kbps, encoder |

## Configuration

`config.json` sits next to the `.exe`. Loaded at startup by `load_config()`:

```json
{ "server": "https://echo.fellowshipoftheboatrace.party:9443" }
```

If missing, defaults to `DEFAULT_SERVER` constant. BOM-stripped before JSON parse (PowerShell 5.1 BOM issue).

Both debug (`core/target/debug/`) and release (`core/target/release/`) directories need their own `config.json`.

## Auto-Update

Uses `tauri-plugin-updater`. Checks `/api/update/latest.json` on the control plane (which proxies from GitHub releases). On update found: downloads + installs + restarts. Triggered on startup and by `check_for_updates` IPC command.

Cache is cleared on version upgrade: `clear_cache_on_upgrade()` removes WebView2 cache directories to prevent stale content after updates.

## Archived Modules

Dead code lives in `core/client/src/archive/`. Not included in any build.

| File | What it was |
|------|------------|
| `nvfbc_capture.rs` | NVFBC capture (blocked on GeForce by driver 595.79) |
| `game_capture.rs` | Game capture via injected DLL |
| `injector.rs` | DLL injector for game capture hook |
| `hook/` | Hook DLL source (Present() intercept — dead with DLSS FG) |
| `control_block_client.rs` | Earlier IPC approach, superseded |

See `archive/README.md` for detailed post-mortems.
