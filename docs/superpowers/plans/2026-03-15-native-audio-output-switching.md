# Native Audio Output Device Switching

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to switch audio output devices from the Echo Chamber UI, working around WebView2's broken `setSinkId`.

**Architecture:** Add a Rust module (`audio_output.rs`) that uses WASAPI `IMMDeviceEnumerator` to list output devices and `IPolicyConfig` to switch the system default endpoint. The viewer JS calls these via Tauri IPC when running natively, falling back to the existing `setSinkId` approach in browsers. The previous default is saved and restored when the app exits.

**Tech Stack:** Rust + `windows` crate (WASAPI COM), Tauri IPC, viewer JS

**Key constraint:** macOS must not break. macOS gets a stub module that returns empty lists and no-ops on switch. The viewer falls back to its existing `setSinkId` path which works in WKWebView.

**Limitation:** On Windows, switching changes the system-wide default audio output (affects all apps while Echo Chamber is running). The previous default is restored on app exit. This is the same approach used by SoundSwitch, AudioSwitch, and other popular audio device switchers. The undocumented per-app API (`IAudioPolicyConfig`) was considered but rejected as too fragile.

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `core/client/src/audio_output.rs` | CREATE | Windows WASAPI: enumerate output devices + switch via IPolicyConfig |
| `core/client/src/audio_output_stub.rs` | CREATE | macOS/Linux stub: empty list + no-op switch |
| `core/client/src/main.rs` | MODIFY | Add mod declarations + 2 Tauri commands + restore-on-exit hook |
| `core/viewer/media-controls.js` | MODIFY | Use native enumeration/switching when Tauri IPC available |

No changes to: `Cargo.toml` (already has `Win32_Media_Audio` + `Win32_System_Com`), `tauri.conf.json`, `urls.js`, `index.html`, `style.css`.

---

## Task 1: Create macOS/Linux stub

**Files:**
- Create: `core/client/src/audio_output_stub.rs`

- [ ] **Step 1: Write the stub module**

```rust
// Stub audio output module for non-Windows platforms.
// WASAPI output device switching is Windows-only.
// On macOS, setSinkId in WKWebView handles output routing.

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
}

pub fn list_output_devices() -> Vec<OutputDevice> {
    Vec::new()
}

pub fn set_output_device(_device_id: &str) -> Result<(), String> {
    // No-op on non-Windows — setSinkId handles it in the viewer
    Ok(())
}

pub fn restore_default_output() {
    // No-op on non-Windows
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd core && cargo check -p echo-core-client --target aarch64-apple-darwin` (or just `cargo check` if on macOS)

If cross-compilation isn't set up, just verify syntax — we'll test on macOS later.

- [ ] **Step 3: Commit**

```
git add core/client/src/audio_output_stub.rs
git commit -m "feat: add audio output stub for non-Windows platforms"
```

---

## Task 2: Create Windows WASAPI audio output module

**Files:**
- Create: `core/client/src/audio_output.rs`

This module does two things:
1. Enumerate active audio output (render) devices via `IMMDeviceEnumerator`
2. Switch the system default endpoint via `IPolicyConfig` COM interface

- [ ] **Step 1: Write the module**

```rust
//! WASAPI audio output device enumeration and switching for Windows.
//!
//! Enumerates active render (output) endpoints and switches the system
//! default via the IPolicyConfig COM interface.  The previous default is
//! saved so it can be restored when the app exits.

use serde::Serialize;
use std::sync::Mutex;

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;

// ── IPolicyConfig COM interface (undocumented but stable since Windows 7) ──
// Used by SoundSwitch, EarTrumpet, AudioSwitch, and the Windows Sound settings.
//
// GUID: {F8679F50-850A-41CF-9C72-430F290290C8}
// CLSID: {870AF99C-171D-4F9E-AF0D-E63DF40C2BC9}

#[windows_interface::interface("F8679F50-850A-41CF-9C72-430F290290C8")]
unsafe trait IPolicyConfig: IUnknown {
    unsafe fn _unused1(&self) -> HRESULT;
    unsafe fn _unused2(&self) -> HRESULT;
    unsafe fn _unused3(&self) -> HRESULT;
    unsafe fn _unused4(&self) -> HRESULT;
    unsafe fn _unused5(&self) -> HRESULT;
    unsafe fn _unused6(&self) -> HRESULT;
    unsafe fn _unused7(&self) -> HRESULT;
    unsafe fn _unused8(&self) -> HRESULT;
    unsafe fn _unused9(&self) -> HRESULT;
    unsafe fn _unused10(&self) -> HRESULT;
    unsafe fn SetDefaultEndpoint(
        &self,
        device_id: PCWSTR,
        role: ERole,
    ) -> HRESULT;
}

// CLSID for CPolicyConfigClient
const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(
    0x870af99c_171d_4f9e_af0d_e63df40c2bc9
);

// ── Saved previous default (restored on exit) ──
static SAVED_DEFAULT: Mutex<Option<String>> = Mutex::new(None);

// ── Public types ──

#[derive(Serialize, Clone, Debug)]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
}

// ── Device enumeration ──

pub fn list_output_devices() -> Vec<OutputDevice> {
    match enumerate_render_devices() {
        Ok(devices) => devices,
        Err(e) => {
            eprintln!("[audio-output] enumeration failed: {e}");
            Vec::new()
        }
    }
}

fn enumerate_render_devices() -> Result<Vec<OutputDevice>> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok();

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;

        let collection = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let count = collection.GetCount()?;

        let mut devices = Vec::with_capacity(count as usize + 1);

        // "Default" entry first — maps to whatever the OS default is
        devices.push(OutputDevice {
            id: String::new(),
            name: "Default".to_string(),
        });

        for i in 0..count {
            let device = collection.Item(i)?;
            let id_raw = device.GetId()?;
            let id = id_raw.to_string().unwrap_or_default();
            CoTaskMemFree(Some(id_raw.as_ptr() as *const _));

            let store = device.OpenPropertyStore(STGM_READ)?;
            let name = match store.GetValue(&PKEY_Device_FriendlyName) {
                Ok(prop) => {
                    let pwsz = prop.Anonymous.Anonymous.Anonymous.pwszVal;
                    if pwsz.is_null() {
                        format!("Output Device {}", i + 1)
                    } else {
                        let wide: &[u16] = std::slice::from_raw_parts(
                            pwsz.0,
                            (0..).take_while(|&j| *pwsz.0.add(j) != 0).count(),
                        );
                        String::from_utf16_lossy(wide)
                    }
                }
                Err(_) => format!("Output Device {}", i + 1),
            };

            devices.push(OutputDevice { id, name });
        }

        Ok(devices)
    }
}

// ── Device switching ──

pub fn set_output_device(device_id: &str) -> Result<(), String> {
    // Empty = restore to whatever was the default before we changed it
    if device_id.is_empty() {
        restore_default_output();
        return Ok(());
    }

    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| format!("COM init failed: {e}"))?;

        // Save current default before switching (only on first switch)
        let mut saved = SAVED_DEFAULT.lock().unwrap();
        if saved.is_none() {
            if let Ok(cur) = get_current_default_id() {
                *saved = Some(cur);
            }
        }
        drop(saved);

        let policy: IPolicyConfig = CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL)
            .map_err(|e| format!("IPolicyConfig create failed: {e}"))?;

        let wide: Vec<u16> = device_id.encode_utf16().chain(std::iter::once(0)).collect();
        let pcwstr = PCWSTR(wide.as_ptr());

        // Set for both multimedia and communications roles
        policy.SetDefaultEndpoint(pcwstr, eMultimedia)
            .ok()
            .map_err(|e| format!("SetDefaultEndpoint(eMultimedia) failed: {e}"))?;

        policy.SetDefaultEndpoint(pcwstr, eCommunications)
            .ok()
            .map_err(|e| format!("SetDefaultEndpoint(eCommunications) failed: {e}"))?;

        Ok(())
    }
}

pub fn restore_default_output() {
    let saved = SAVED_DEFAULT.lock().unwrap().take();
    if let Some(prev_id) = saved {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok();
            if let Ok(policy) = CoCreateInstance::<_, IPolicyConfig>(
                &CLSID_POLICY_CONFIG, None, CLSCTX_ALL,
            ) {
                let wide: Vec<u16> = prev_id.encode_utf16().chain(std::iter::once(0)).collect();
                let pcwstr = PCWSTR(wide.as_ptr());
                let _ = policy.SetDefaultEndpoint(pcwstr, eMultimedia);
                let _ = policy.SetDefaultEndpoint(pcwstr, eCommunications);
                eprintln!("[audio-output] restored previous default endpoint");
            }
        }
    }
}

fn get_current_default_id() -> Result<String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
        let id_raw = device.GetId()?;
        let id = id_raw.to_string().unwrap_or_default();
        CoTaskMemFree(Some(id_raw.as_ptr() as *const _));
        Ok(id)
    }
}
```

**Important notes about `IPolicyConfig`:**
- The vtable has 10 unused methods before `SetDefaultEndpoint` (method index 10, zero-based). This is well-documented in reverse-engineering projects (SoundSwitch, EarTrumpet).
- The `#[windows_interface::interface]` macro generates the COM vtable. If this macro isn't available, use manual `#[repr(C)]` vtable definition instead.
- If the `windows_interface` macro approach doesn't compile, fall back to `windows::core::implement` or raw COM pointer manipulation matching the pattern in `audio_capture.rs`.

- [ ] **Step 2: Check compilation**

Run: `cd core && cargo check -p echo-core-client`

If `#[windows_interface::interface]` is not available, the `windows` crate v0.58 uses `#[interface]` from `windows_core`. Try:
```rust
use windows_core::interface;

#[interface("F8679F50-850A-41CF-9C72-430F290290C8")]
unsafe trait IPolicyConfig: IUnknown {
    // ... same methods
}
```

Or define the vtable manually if macros don't cooperate. The key is getting `SetDefaultEndpoint` at vtable slot 13 (IUnknown has 3 methods + 10 unused = slot 13).

- [ ] **Step 3: Commit**

```
git add core/client/src/audio_output.rs
git commit -m "feat: Windows WASAPI audio output enumeration and switching"
```

---

## Task 3: Wire up Tauri IPC commands

**Files:**
- Modify: `core/client/src/main.rs`

- [ ] **Step 1: Add module declarations (after line 9)**

```rust
#[cfg(target_os = "windows")]
mod audio_output;
#[cfg(not(target_os = "windows"))]
mod audio_output_stub;
#[cfg(not(target_os = "windows"))]
use audio_output_stub as audio_output;
```

- [ ] **Step 2: Add Tauri commands (after line 169, after `stop_audio_capture`)**

```rust
#[tauri::command]
fn list_audio_output_devices() -> Vec<audio_output::OutputDevice> {
    audio_output::list_output_devices()
}

#[tauri::command]
fn set_audio_output_device(device_id: String) -> Result<(), String> {
    audio_output::set_output_device(&device_id)
}
```

- [ ] **Step 3: Register in handler (add to `generate_handler!` array, ~line 259)**

```rust
list_audio_output_devices,
set_audio_output_device,
```

- [ ] **Step 4: Add restore-on-exit hook in the `.setup()` closure**

Find the `app.on_window_event` or similar exit handler. If none exists, add one after the `.setup()` block. The key is calling `audio_output::restore_default_output()` when the app closes.

Look for the `on_window_event` pattern or add to the existing `.build()` chain:

```rust
// In the .setup() closure or after .build():
let app_handle = app.handle().clone();
app.on_window_event(move |_window, event| {
    if let tauri::WindowEvent::Destroyed = event {
        audio_output::restore_default_output();
    }
});
```

If there's already a window event handler, add the `restore_default_output()` call to the existing `Destroyed` or `CloseRequested` branch.

- [ ] **Step 5: Verify compilation**

Run: `cd core && cargo check --workspace`
Expected: compiles with at most existing warnings.

- [ ] **Step 6: Commit**

```
git add core/client/src/main.rs
git commit -m "feat: wire up audio output IPC commands with restore-on-exit"
```

---

## Task 4: Integrate native switching in viewer JS

**Files:**
- Modify: `core/viewer/media-controls.js`

The key changes:
1. In `refreshDevices()`: use native device list when available (better than browser enumeration which is broken in WebView2)
2. In `switchSpeaker()`: call native `set_audio_output_device` instead of relying on `setSinkId`

- [ ] **Step 1: Modify `refreshDevices()` to use native output device list**

In `refreshDevices()`, after `const speakers = devices.filter(...)` (approximately line 73), add:

```javascript
// On native Tauri (Windows), use WASAPI enumeration for output devices
// because WebView2's enumerateDevices may return incomplete/broken output list
if (hasTauriIPC()) {
  try {
    var nativeOutputs = await tauriInvoke("list_audio_output_devices");
    if (Array.isArray(nativeOutputs) && nativeOutputs.length > 0) {
      // Replace browser speaker list with native list
      speakers = nativeOutputs.map(function(dev) {
        return { deviceId: dev.id, kind: "audiooutput", label: dev.name, groupId: "" };
      });
      debugLog("[devices] using " + speakers.length + " native output devices");
    }
  } catch (err) {
    debugLog("[devices] native output enumeration failed: " + (err.message || err));
    // Fall through to browser enumeration
  }
}
```

Note: `speakers` is currently declared with `const`. Change it to `let` so we can reassign:
```javascript
// Change: const speakers = devices.filter(...)
// To:     let speakers = devices.filter(...)
```

- [ ] **Step 2: Modify `switchSpeaker()` to use native switching**

Replace the current `switchSpeaker` function:

```javascript
async function switchSpeaker(deviceId) {
  selectedSpeakerId = deviceId || "";
  echoSet("echo-device-speaker", selectedSpeakerId);
  debugLog("[speaker] switching to: " + (selectedSpeakerId || "default"));
  // On native Tauri (Windows): use WASAPI to switch system audio output.
  // WebView2's setSinkId resolves OK but silently fails to change output.
  if (hasTauriIPC()) {
    try {
      await tauriInvoke("set_audio_output_device", { deviceId: selectedSpeakerId });
      debugLog("[speaker] native switch OK");
    } catch (err) {
      debugLog("[speaker] native switch failed: " + (err.message || err));
    }
  }
  // Also apply setSinkId for browser-only viewers and as best-effort in WebView2
  await applySpeakerToMedia();
}
```

- [ ] **Step 3: Verify syntax**

Run: `node -e "new Function(require('fs').readFileSync('core/viewer/media-controls.js','utf8'))"`
Expected: no syntax errors

- [ ] **Step 4: Commit**

```
git add core/viewer/media-controls.js
git commit -m "feat: use native WASAPI for audio output switching on Windows"
```

---

## Task 5: Build, test, and verify

- [ ] **Step 1: Full build**

Run: `cd core && cargo build --workspace`

- [ ] **Step 2: Test device enumeration**

Start the Tauri client. Open DevTools (F12 or Debug button). Run in console:
```javascript
tauriInvoke("list_audio_output_devices").then(d => console.log(d))
```
Expected: Array of `{ id: "...", name: "Speakers (Realtek)" }` objects including a `{ id: "", name: "Default" }` entry.

- [ ] **Step 3: Test device switching**

1. Connect to a room with other participants talking
2. Open Settings, change output device dropdown
3. Verify audio actually moves to the selected device
4. Check debug log for `[speaker] native switch OK`
5. Switch back to "Default" — should restore original output

- [ ] **Step 4: Test restore-on-exit**

1. Switch to a non-default output device
2. Close Echo Chamber
3. Verify Windows Sound settings shows the original default restored

- [ ] **Step 5: Test macOS doesn't break**

If macOS build is available:
1. Build and run
2. Output dropdown should show browser-enumerated devices
3. Switching should use `setSinkId` (existing path)
4. No crashes, no errors

- [ ] **Step 6: Test browser viewer doesn't break**

1. Open `https://echo.fellowshipoftheboatrace.party:9443/viewer/` in Edge
2. `hasTauriIPC()` should be false
3. Output dropdown uses browser devices
4. Switching uses `setSinkId` (existing path)

- [ ] **Step 7: Update changelog**

Add to `core/viewer/changelog.js`:
```javascript
{
  version: "2026-03-15",
  title: "Audio Output Device Switching",
  notes: [
    "You can now switch audio output devices while connected — no disconnect required",
    "Windows: uses native WASAPI routing (fixes WebView2 setSinkId limitation)",
    "Previous output device is automatically restored when Echo Chamber closes"
  ]
}
```

- [ ] **Step 8: Commit final**

```
git add -A
git commit -m "feat: native audio output device switching (Windows WASAPI)"
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| `IPolicyConfig` COM interface vtable is wrong | The vtable layout is well-documented by SoundSwitch, EarTrumpet, and dozens of projects. If it fails, the error is caught and logged — fallback to setSinkId. |
| Changing system default surprises users | Only changes when user explicitly selects a device. Restored on app exit. |
| macOS breaks | Stub module returns empty list, no-op on switch. Viewer falls back to existing setSinkId path. |
| Browser viewer breaks | `hasTauriIPC()` guard prevents native calls. Existing setSinkId path unchanged. |
| Restore-on-exit doesn't fire (crash/kill) | System default stays changed. User can fix via Windows Sound settings. Low risk — same as SoundSwitch behavior. |
| `windows_interface` macro not available in crate v0.58 | Fall back to `windows_core::interface` or manual vtable. Multiple fallback approaches documented in Task 2. |
