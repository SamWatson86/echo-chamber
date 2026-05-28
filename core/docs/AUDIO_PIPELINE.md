# Audio Pipeline

## Native Screen-Share Audio Capture (WASAPI Process Loopback)

Captures audio output from a specific process using WASAPI's process loopback API, available on Windows 10 build 20348+ (Server 2022) and Windows 11.

**SAM-PC (GTX 760, Win10 build 19045) does not support this.** Process loopback requires build 20348+.

### Rust Modules

`core/client/src/audio_capture.rs`

Uses `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` (constant = 1) with `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE` to capture all audio from the target process and its child processes.

`core/admin-client/src/audio_capture.rs` carries the same local-admin capture path.

When `IAudioClient::GetMixFormat` is unavailable for process loopback, Echo initializes with stereo PCM16 at 44.1 kHz plus `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`, then converts captured PCM16 samples to float32 before sending them to the viewer. Do not fall back to raw 48 kHz float32 without autoconvert; that path can produce silent frames.

### Full Pipeline

```text
[Target process audio output]
  |
  v WASAPI AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
[PCM float32 chunks - 44100/48000 Hz, stereo]
  |
  v base64::encode (Engine::encode)
[base64 string]
  |
  v tauri::Emitter - event "audio-capture-data"
[Tauri IPC event -> WebView2]
  |
  v JS event listener in screen-share-native.js
[ArrayBuffer from base64 decode]
  |
  v AudioWorklet (rnnoise-processor.js or passthrough)
[processed audio frames]
  |
  v MediaStreamDestination node
[MediaStream]
  |
  v LiveKit publishTrack({ dtx: false, red: false, audioBitrate: 128000 })
[Opus audio -> SFU -> all participants]
```

### JS Entry Point

`startNativeAudioCapture()` in `screen-share-native.js`:

1. Calls `tauriInvoke('list_capturable_windows')` and receives `WindowInfo[]` (pid, hwnd, title, exe_name).
2. User selects process from picker.
3. Calls `tauriInvoke('start_audio_capture', { pid })`, which begins the WASAPI capture loop in a background thread.
4. Registers `window.__TAURI__.event.listen('audio-capture-data', ...)`.
5. Feeds PCM data into AudioWorklet -> MediaStreamDestination -> LiveKit track.

**Important:** Use `startNativeAudioCapture()`, not a raw `tauriInvoke`. The function sets up the event listener, the AudioWorklet, and the LiveKit track in the correct order. Calling `tauriInvoke('start_audio_capture')` directly without the listener means audio data is emitted but nobody reads it.

### IPC Commands

| Command | Direction | Purpose |
|---------|-----------|---------|
| `list_capturable_windows` | JS -> Rust | Enumerate visible windows with PIDs |
| `start_audio_capture` | JS -> Rust | Start WASAPI loop for given PID |
| `stop_audio_capture` | JS -> Rust | Stop capture loop |
| `audio-capture-format` event | Rust -> JS | Captured WASAPI format metadata |
| `audio-capture-data` event | Rust -> JS | PCM float32 chunk as base64 |

### DTX Must Be Disabled

Screen share audio published with DTX (Discontinuous Transmission) enabled causes audio to cut out during screen shares because DTX suppresses "silent" frames, which in the context of game audio means any pause in sound effects.

Always publish with:

```js
{ dtx: false, red: false, audioBitrate: 128000 }
```

## Standard Mic/Camera Audio

Normal microphone audio uses the standard LiveKit SDK flow:

- `room.localParticipant.setMicrophoneEnabled(true)`
- WebRTC handles device enumeration, MediaStream acquisition, and Opus encoding
- RNNoise noise suppression is applied via AudioWorklet (`rnnoise.js`, `rnnoise-processor.js`) if enabled in settings

## Jam Session Audio (Spotify)

JamBot captures Spotify from the control plane with `core/control/src/audio_capture.rs`. It finds `Spotify.exe`, starts WASAPI process loopback with `INCLUDE_TARGET_PROCESS_TREE`, converts chunks to 48 kHz stereo 20 ms float32 frames, and serves them to viewers over `/api/jam/audio`.

The control-plane capture path uses the same PCM16 44.1 kHz autoconvert fallback described above. Jam audio does not depend on WebRTC mic publishing or VB-Cable in this flow.

WASAPI output device switching (`set_audio_output_device`) was removed because changing the system-wide default is too dangerous. WebView2's `setSinkId` is a silent no-op.

## Platform Stubs

`core/client/src/audio_capture_stub.rs`, `core/admin-client/src/audio_capture_stub.rs`, and `audio_output_stub.rs` are compiled on non-Windows targets. They return empty lists and no-op all operations, keeping the build clean on macOS/Linux.
