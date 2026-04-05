# Audio Pipeline

## Game Audio Capture (WASAPI Process Loopback)

Captures audio output from a specific process using WASAPI's process loopback API, available on Windows 10 build 20348+ (Server 2022) and Windows 11.

**SAM-PC (GTX 760, Win10 build 19045) does not support this.** Process loopback requires build 20348+.

### Rust Module

`core/client/src/audio_capture.rs`

Uses `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` (constant = 1) with `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` to capture all audio from the target process and its child processes.

### Full Pipeline

```
[Game process — audio output]
  │
  ▼ WASAPI AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
[PCM float32 chunks — 44100/48000 Hz, stereo]
  │
  ▼ base64::encode (Engine::encode)
[base64 string]
  │
  ▼ tauri::Emitter — event "audio-chunk"
[Tauri IPC event → WebView2]
  │
  ▼ JS event listener in screen-share-native.js
[ArrayBuffer from base64 decode]
  │
  ▼ AudioWorklet (rnnoise-processor.js or passthrough)
[processed audio frames]
  │
  ▼ MediaStreamDestination node
[MediaStream]
  │
  ▼ LiveKit publishTrack({ dtx: false, red: false, audioBitrate: 128000 })
[Opus audio → SFU → all participants]
```

### JS Entry Point

`startNativeAudioCapture()` in `screen-share-native.js`:

1. Calls `tauriInvoke('list_capturable_windows')` — returns `WindowInfo[]` (pid, hwnd, title, exe_name)
2. User selects process from picker
3. Calls `tauriInvoke('start_audio_capture', { pid })` — begins WASAPI capture loop in background thread
4. Registers `window.__TAURI__.event.listen('audio-chunk', ...)` event handler
5. Feeds PCM data into AudioWorklet → MediaStreamDestination → LiveKit track

**Important:** Use `startNativeAudioCapture()`, not a raw `tauriInvoke`. The function sets up the event listener, the AudioWorklet, and the LiveKit track in the correct order. Calling `tauriInvoke('start_audio_capture')` directly without the listener means audio data is emitted but nobody reads it.

### IPC Commands

| Command | Direction | Purpose |
|---------|-----------|---------|
| `list_capturable_windows` | JS → Rust | Enumerate visible windows with PIDs |
| `start_audio_capture` | JS → Rust | Start WASAPI loop for given PID |
| `stop_audio_capture` | JS → Rust | Stop capture loop |
| `audio-chunk` event | Rust → JS | PCM float32 chunk as base64 |

### DTX Must Be Disabled

Screen share audio published with DTX (Discontinuous Transmission) enabled causes audio to cut out during screen shares — DTX suppresses "silent" frames which in the context of game audio means any pause in sound effects.

Always publish with:
```js
{ dtx: false, red: false, audioBitrate: 128000 }
```

## Standard Mic/Camera Audio

Normal microphone audio uses the standard LiveKit SDK flow:
- `room.localParticipant.setMicrophoneEnabled(true)`
- WebRTC handles device enumeration, MediaStream acquisition, Opus encoding
- RNNoise noise suppression applied via AudioWorklet (`rnnoise.js`, `rnnoise-processor.js`) if enabled in settings

## Jam Session Audio (Spotify)

VB-Cable routes Spotify output as a virtual mic input. Sam selects the VB-Cable device as his microphone when hosting a Jam Session. The audio goes through normal WebRTC mic publish path.

WASAPI output device switching (`set_audio_output_device`) was removed — changing the system-wide default is too dangerous. WebView2's `setSinkId` is a silent no-op.

## Platform Stubs

`core/client/src/audio_capture_stub.rs` and `audio_output_stub.rs` are compiled on non-Windows targets. They return empty lists and no-op all operations, keeping the build clean on macOS/Linux.
