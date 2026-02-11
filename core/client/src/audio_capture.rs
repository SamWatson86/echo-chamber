//! WASAPI per-process audio capture for Windows 10 2004+
//!
//! Captures audio output from a specific process using the
//! AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK API and streams
//! base64-encoded PCM float32 chunks via Tauri events.

use base64::Engine;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use windows::core::*;
use windows::Win32::Foundation::*;
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Registry::*;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::WindowsAndMessaging::*;

// --- Process loopback constants (may not be in older windows crate versions) ---

/// AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
const ACTIVATION_TYPE_PROCESS_LOOPBACK: u32 = 1;
/// PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0
const LOOPBACK_MODE_INCLUDE_TREE: u32 = 0;
/// VT_BLOB variant type
const VT_BLOB: u16 = 65;

/// Manual repr(C) structs for process loopback activation params.
/// These may not be available in all versions of the windows crate.
#[repr(C)]
struct ProcessLoopbackParams {
    target_process_id: u32,
    process_loopback_mode: u32,
}

#[repr(C)]
struct AudioClientActivationParams {
    activation_type: u32,
    loopback_params: ProcessLoopbackParams,
}

// --- Public types ---

#[derive(Serialize, Clone, Debug)]
pub struct WindowInfo {
    pub pid: u32,
    pub hwnd: u64,
    pub title: String,
    pub exe_name: String,
}

// --- Window enumeration ---

pub fn list_capturable_windows() -> Vec<WindowInfo> {
    let mut windows: Vec<WindowInfo> = Vec::new();
    let windows_ptr = &mut windows as *mut Vec<WindowInfo>;

    unsafe {
        let _ = EnumWindows(Some(enum_window_cb), LPARAM(windows_ptr as isize));
    }

    // Deduplicate by PID — keep entry with longest title
    let mut by_pid = std::collections::HashMap::<u32, WindowInfo>::new();
    for w in windows {
        let entry = by_pid.entry(w.pid).or_insert_with(|| w.clone());
        if w.title.len() > entry.title.len() {
            *entry = w;
        }
    }

    let mut result: Vec<WindowInfo> = by_pid.into_values().collect();
    result.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    result
}

unsafe extern "system" fn enum_window_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }

    let mut buf = [0u16; 512];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len == 0 {
        return TRUE;
    }
    let title = String::from_utf16_lossy(&buf[..len as usize]);

    // Skip system windows
    if title.is_empty()
        || title == "Program Manager"
        || title == "Windows Input Experience"
        || title == "MSCTFIME UI"
        || title == "Default IME"
    {
        return TRUE;
    }

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return TRUE;
    }

    let exe_name = get_exe_name(pid).unwrap_or_default();

    let list = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    list.push(WindowInfo {
        pid,
        hwnd: hwnd.0 as u64,
        title,
        exe_name,
    });

    TRUE
}

fn get_exe_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 260];
        let mut size = buf.len() as u32;
        let ok =
            QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(handle);
        ok.ok()?;
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        path.rsplit('\\').next().map(|s| s.to_string())
    }
}

// --- Windows build check ---

/// Process loopback capture requires Windows 10 build 20348+.
/// Returns Ok(()) if supported, Err with message if not.
fn check_process_loopback_support() -> std::result::Result<(), String> {
    unsafe {
        let key_path = w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
        let mut hkey = HKEY::default();
        let status = RegOpenKeyExW(HKEY_LOCAL_MACHINE, key_path, 0, KEY_READ, &mut hkey);
        if status.is_err() {
            return Err("Cannot read Windows version from registry".to_string());
        }

        let value_name = w!("CurrentBuildNumber");
        let mut buf = [0u8; 64];
        let mut buf_size = buf.len() as u32;
        let mut kind = REG_VALUE_TYPE::default();
        let result = RegQueryValueExW(
            hkey,
            value_name,
            None,
            Some(&mut kind),
            Some(buf.as_mut_ptr()),
            Some(&mut buf_size),
        );
        let _ = RegCloseKey(hkey);

        if result.is_err() {
            return Err("Cannot read CurrentBuildNumber".to_string());
        }

        // Value is REG_SZ (UTF-16 null-terminated string)
        let chars = buf_size as usize / 2;
        let wide = std::slice::from_raw_parts(buf.as_ptr() as *const u16, chars);
        let build_str = String::from_utf16_lossy(wide).trim_matches('\0').to_string();

        let build_num: u32 = build_str.parse().unwrap_or(0);
        eprintln!("[audio-capture] Windows build: {} ({})", build_str, build_num);

        if build_num < 20348 {
            return Err(format!(
                "Per-process audio capture requires Windows 10 build 20348 or later. \
                 This PC has build {}. Share entire screen with 'Share system audio' instead.",
                build_num
            ));
        }

        Ok(())
    }
}

// --- Capture state ---

struct CaptureHandle {
    running: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

fn global_state() -> &'static Mutex<Option<CaptureHandle>> {
    static STATE: OnceLock<Mutex<Option<CaptureHandle>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

pub fn start_capture(pid: u32, app: AppHandle) -> Result<()> {
    // Check if this Windows build supports process loopback
    if let Err(msg) = check_process_loopback_support() {
        eprintln!("[audio-capture] {}", msg);
        return Err(Error::new(E_FAIL, msg));
    }

    stop_capture();

    let running = Arc::new(AtomicBool::new(true));
    let r2 = running.clone();

    let thread = std::thread::spawn(move || {
        if let Err(e) = capture_loop(pid, &app, &r2) {
            eprintln!("[audio-capture] error: {}", e);
            let _ = app.emit("audio-capture-error", format!("{}", e));
        }
        let _ = app.emit("audio-capture-stopped", ());
        eprintln!("[audio-capture] thread exited");
    });

    *global_state().lock().unwrap() = Some(CaptureHandle {
        running,
        thread: Some(thread),
    });

    Ok(())
}

pub fn stop_capture() {
    if let Some(mut h) = global_state().lock().unwrap().take() {
        h.running.store(false, Ordering::SeqCst);
        if let Some(t) = h.thread.take() {
            let _ = t.join();
        }
    }
}

// --- COM completion handler for ActivateAudioInterfaceAsync ---

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    tx: std::sync::mpsc::SyncSender<windows::core::Result<IAudioClient>>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        operation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let result = (|| unsafe {
            let op = operation.ok_or(Error::from(E_POINTER))?;
            let mut hr = HRESULT::default();
            let mut punk: Option<IUnknown> = None;
            op.GetActivateResult(&mut hr, &mut punk)?;
            hr.ok()?;
            let client: IAudioClient = punk.ok_or(Error::from(E_POINTER))?.cast()?;
            Ok(client)
        })();
        let _ = self.tx.send(result);
        Ok(())
    }
}

// --- Main capture loop ---

fn capture_loop(
    pid: u32,
    app: &AppHandle,
    running: &AtomicBool,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;

        // Build activation params
        let params = AudioClientActivationParams {
            activation_type: ACTIVATION_TYPE_PROCESS_LOOPBACK,
            loopback_params: ProcessLoopbackParams {
                target_process_id: pid,
                process_loopback_mode: LOOPBACK_MODE_INCLUDE_TREE,
            },
        };
        let params_size = std::mem::size_of::<AudioClientActivationParams>() as u32;

        // Build PROPVARIANT with VT_BLOB pointing to our params.
        // PROPVARIANT layout on x64:
        //   offset 0:  vt (u16)
        //   offset 2:  3x u16 reserved
        //   offset 8:  BLOB.cbSize (u32)
        //   offset 12: padding (u32)
        //   offset 16: BLOB.pBlobData (*const u8)
        let mut pv = [0u8; 24];
        // VT_BLOB
        *(pv.as_mut_ptr() as *mut u16) = VT_BLOB;
        // cbSize at offset 8
        *(pv.as_mut_ptr().add(8) as *mut u32) = params_size;
        // pBlobData at offset 16
        *(pv.as_mut_ptr().add(16) as *mut *const u8) =
            &params as *const AudioClientActivationParams as *const u8;

        let propvariant = &pv as *const _ as *const PROPVARIANT;

        // Completion handler
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let handler: IActivateAudioInterfaceCompletionHandler =
            ActivationHandler { tx }.into();

        // Activate audio interface for process loopback
        // VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback"
        let _operation = ActivateAudioInterfaceAsync(
            w!("VAD\\Process_Loopback"),
            &IAudioClient::IID,
            Some(propvariant),
            &handler,
        )?;

        // Wait for activation (5 second timeout)
        let client = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("activation timeout: {}", e))?
            .map_err(|e| format!("activation failed: {}", e))?;

        // Get mix format
        let fmt_ptr = client.GetMixFormat()?;
        let fmt = &*fmt_ptr;
        let sample_rate = fmt.nSamplesPerSec;
        let channels = fmt.nChannels as u32;
        let bits = fmt.wBitsPerSample;
        let block_align = fmt.nBlockAlign as usize;

        eprintln!(
            "[audio-capture] format: {}Hz {}ch {}bit blockAlign={}",
            sample_rate, channels, bits, block_align
        );

        let _ = app.emit(
            "audio-capture-format",
            serde_json::json!({
                "sampleRate": sample_rate,
                "channels": channels,
                "bitsPerSample": bits,
            }),
        );

        // Initialize audio client — 20ms buffer, shared mode
        let buffer_duration: i64 = 200_000; // 20ms in 100ns units
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            buffer_duration,
            0,
            fmt_ptr,
            None,
        )?;

        // Event-driven capture
        let event = CreateEventW(None, false, false, None)?;
        client.SetEventHandle(event)?;

        let capture: IAudioCaptureClient = client.GetService()?;

        client.Start()?;
        eprintln!("[audio-capture] started for PID {}", pid);
        let _ = app.emit("audio-capture-started", pid);

        // Read loop
        while running.load(Ordering::SeqCst) {
            let wait = WaitForSingleObject(event, 100);
            if wait == WAIT_TIMEOUT {
                continue;
            }

            // Drain all available packets
            loop {
                let mut buf_ptr: *mut u8 = std::ptr::null_mut();
                let mut frames: u32 = 0;
                let mut flags: u32 = 0;

                let hr = capture.GetBuffer(
                    &mut buf_ptr,
                    &mut frames,
                    &mut flags,
                    None,
                    None,
                );

                if hr.is_err() || frames == 0 {
                    break;
                }

                let data_len = frames as usize * block_align;

                // AUDCLNT_BUFFERFLAGS_SILENT = 0x2
                let silent = (flags & 0x2) != 0;

                if !silent && !buf_ptr.is_null() && data_len > 0 {
                    let slice = std::slice::from_raw_parts(buf_ptr, data_len);
                    let b64 = base64::engine::general_purpose::STANDARD.encode(slice);
                    let _ = app.emit("audio-capture-data", b64);
                }

                capture.ReleaseBuffer(frames)?;
            }
        }

        client.Stop()?;
        let _ = CloseHandle(event);
        CoUninitialize();

        eprintln!("[audio-capture] stopped for PID {}", pid);
        Ok(())
    }
}
