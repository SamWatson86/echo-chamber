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

Jam capture is owned by one explicitly configured Echo desktop client running in
the same interactive Windows session as Spotify. The Windows service/control
plane must never attempt WASAPI capture: services run in session 0 and cannot
reliably capture a user's Spotify process or audio session.

The dedicated client source in `core/client/src/jam_source.rs` connects to
`/api/jam/source` using Jam source protocol v2 and separate source credentials.
On a generation-scoped `start` command it finds the Spotify root process,
starts an independently owned WASAPI process-loopback capture, and reports its
format and readiness before uploading float32 PCM. This capture is independent
of the viewer window, screen sharing, microphone state, and room media state.

`core/control/src/jam_source.rs` authenticates the single configured source,
fences messages by connection and generation, measures source health, and
replays the current `start` command after a reconnect. `JamBot` in
`core/control/src/jam_bot.rs` only normalizes uploaded PCM to 48 kHz stereo
20 ms frames and relays it to listeners over `/api/jam/audio`.

Spotify may be paused when a Jam starts. Readiness therefore means the source
has successfully opened capture; it does not require audible PCM. While
Spotify is playing, the control plane independently reports live, silent, or
stalled audio based on received frames and measured peak level.

If packet delivery stalls while Spotify is expected to be audible, the control
plane sends a generation-fenced, debounced `restart` command. The source drops
only the Jam-owned WASAPI handle, acknowledges the ordered restart boundary,
and opens a replacement capture. Existing listener sockets stay connected and
resume after the replacement reports ready.

Jam audio does not depend on WebRTC microphone publishing or VB-Cable.

WASAPI output device switching (`set_audio_output_device`) was removed because changing the system-wide default is too dangerous. WebView2's `setSinkId` is a silent no-op.

## Platform Stubs

`core/client/src/audio_capture_stub.rs`, `core/admin-client/src/audio_capture_stub.rs`, and `audio_output_stub.rs` are compiled on non-Windows targets. They return empty lists and no-op all operations, keeping the build clean on macOS/Linux.
