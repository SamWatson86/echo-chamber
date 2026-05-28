//! WASAPI per-process audio capture for Windows 10 2004+
//!
//! Captures audio output from a specific process using the
//! AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK API and streams
//! base64-encoded PCM float32 chunks via Tauri events.

use crate::file_debug_log;
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
const BITS_PER_BYTE: u16 = 8;

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

fn process_loopback_initialize_flags(use_autoconvert: bool) -> u32 {
    let flags = system_loopback_initialize_flags();
    if use_autoconvert {
        flags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
    } else {
        flags
    }
}

fn system_loopback_initialize_flags() -> u32 {
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_LOOPBACK
}

fn process_loopback_fallback_format() -> WAVEFORMATEX {
    let channels = 2_u16;
    let sample_rate = 44_100_u32;
    let bits = 16_u16;
    let block_align = channels * bits / BITS_PER_BYTE;

    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: channels,
        nSamplesPerSec: sample_rate,
        nAvgBytesPerSec: sample_rate * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits,
        cbSize: 0,
    }
}

fn log_audio_capture(message: &str) {
    eprintln!("{}", message);
    file_debug_log::append(message);
}

fn audio_capture_peak_from_f32_bytes(bytes: &[u8]) -> f32 {
    bytes
        .chunks_exact(4)
        .filter_map(|chunk| {
            let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            sample.is_finite().then_some(sample.abs())
        })
        .fold(0.0_f32, f32::max)
}

fn audio_capture_frame_diagnostic(frame_count: u64, sample_count: usize, peak: f32) -> String {
    format!(
        "[audio-capture] converted frame #{} samples={} peak={:.6}",
        frame_count, sample_count, peak
    )
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
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
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
        let build_str = String::from_utf16_lossy(wide)
            .trim_matches('\0')
            .to_string();

        let build_num: u32 = build_str.parse().unwrap_or(0);
        eprintln!(
            "[audio-capture] Windows build: {} ({})",
            build_str, build_num
        );

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
        log_audio_capture(&format!("[audio-capture] {}", msg));
        return Err(Error::new(E_FAIL, msg));
    }

    log_audio_capture(&format!(
        "[audio-capture] start_capture requested pid={}",
        pid
    ));
    stop_capture();

    let running = Arc::new(AtomicBool::new(true));
    let r2 = running.clone();

    let thread = std::thread::spawn(move || {
        if let Err(e) = capture_loop(pid, &app, &r2) {
            log_audio_capture(&format!("[audio-capture] error: {}", e));
            let _ = app.emit("audio-capture-error", format!("{}", e));
        }
        let _ = app.emit("audio-capture-stopped", ());
        log_audio_capture("[audio-capture] thread exited");
    });

    *global_state().lock().unwrap() = Some(CaptureHandle {
        running,
        thread: Some(thread),
    });

    Ok(())
}

pub fn start_system_capture(app: AppHandle) -> Result<()> {
    log_audio_capture("[audio-capture] start_system_capture requested");
    stop_capture();

    let running = Arc::new(AtomicBool::new(true));
    let r2 = running.clone();

    let thread = std::thread::spawn(move || {
        if let Err(e) = capture_system_loop(&app, &r2) {
            log_audio_capture(&format!("[audio-capture] error: {}", e));
            let _ = app.emit("audio-capture-error", format!("{}", e));
        }
        let _ = app.emit("audio-capture-stopped", ());
        log_audio_capture("[audio-capture] thread exited");
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

fn capture_with_audio_client(
    client: IAudioClient,
    app: &AppHandle,
    running: &AtomicBool,
    capture_label: &str,
    started_pid: u32,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    unsafe {
        // Get mix format - may fail with E_NOTIMPL on process loopback
        let (sample_rate, channels, bits, block_align, is_float);
        match client.GetMixFormat() {
            Ok(ptr) => {
                let fmt = &*ptr;
                sample_rate = fmt.nSamplesPerSec;
                channels = fmt.nChannels as u32;
                bits = fmt.wBitsPerSample;
                block_align = fmt.nBlockAlign as usize;
                let format_tag = fmt.wFormatTag;

                // Determine if the format is IEEE float32
                is_float = if format_tag == 3 {
                    true
                } else if format_tag == 0xFFFE_u16 {
                    let ext_ptr = ptr as *const u8;
                    let sub_format_offset = std::mem::size_of::<WAVEFORMATEX>();
                    let guid_offset = sub_format_offset + 2 + 4;
                    let guid_bytes = std::slice::from_raw_parts(ext_ptr.add(guid_offset), 16);
                    let first_u32 = u32::from_le_bytes([
                        guid_bytes[0],
                        guid_bytes[1],
                        guid_bytes[2],
                        guid_bytes[3],
                    ]);
                    first_u32 == 3
                } else {
                    false
                };

                log_audio_capture(&format!(
                    "[audio-capture] format from GetMixFormat: {}Hz {}ch {}bit blockAlign={} formatTag={} isFloat={}",
                    sample_rate, channels, bits, block_align, format_tag, is_float
                ));
                let _ = app.emit(
                    "audio-capture-format",
                    serde_json::json!({
                        "sampleRate": sample_rate,
                        "channels": channels,
                        "bitsPerSample": bits,
                        "formatTag": format_tag,
                        "isFloat": is_float,
                    }),
                );

                // Initialize with the mix format
                log_audio_capture(
                    "[audio-capture] initializing audio client (shared mode, event-driven, 20ms buffer)",
                );
                let buffer_duration: i64 = 200_000;
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    process_loopback_initialize_flags(false),
                    buffer_duration,
                    0,
                    ptr,
                    None,
                )?;
            }
            Err(e) => {
                log_audio_capture(&format!(
                    "[audio-capture] GetMixFormat failed: {} -- falling back to default 44.1kHz stereo PCM16",
                    e
                ));

                let default_fmt = process_loopback_fallback_format();
                sample_rate = default_fmt.nSamplesPerSec;
                channels = default_fmt.nChannels as u32;
                bits = default_fmt.wBitsPerSample;
                block_align = channels as usize * bits as usize / 8;
                is_float = false;

                log_audio_capture(&format!(
                    "[audio-capture] using default format: {}Hz {}ch {}bit blockAlign={} isFloat={}",
                    sample_rate, channels, bits, block_align, is_float
                ));

                let _ = app.emit(
                    "audio-capture-format",
                    serde_json::json!({
                        "sampleRate": sample_rate,
                        "channels": channels,
                        "bitsPerSample": bits,
                        "formatTag": WAVE_FORMAT_PCM,
                        "isFloat": false,
                    }),
                );

                // Initialize with default format + LOOPBACK/AUTOCONVERTPCM flags
                log_audio_capture(
                    "[audio-capture] initializing audio client with default format + LOOPBACK/AUTOCONVERTPCM flags"
                );
                let buffer_duration: i64 = 200_000;
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    process_loopback_initialize_flags(true),
                    buffer_duration,
                    0,
                    &default_fmt as *const WAVEFORMATEX,
                    None,
                )?;
            }
        }
        log_audio_capture("[audio-capture] audio client initialized");

        // Event-driven capture
        let event = CreateEventW(None, false, false, None)?;
        client.SetEventHandle(event)?;

        let capture: IAudioCaptureClient = client.GetService()?;
        log_audio_capture("[audio-capture] got IAudioCaptureClient, starting capture");

        client.Start()?;
        log_audio_capture(&format!("[audio-capture] started for {}", capture_label));
        let _ = app.emit("audio-capture-started", started_pid);

        // Read loop
        let mut frame_count: u64 = 0;
        let mut silent_packet_count: u64 = 0;
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

                let hr = capture.GetBuffer(&mut buf_ptr, &mut frames, &mut flags, None, None);

                if hr.is_err() || frames == 0 {
                    break;
                }

                let data_len = frames as usize * block_align;

                // AUDCLNT_BUFFERFLAGS_SILENT = 0x2
                let silent = (flags & 0x2) != 0;
                if silent {
                    silent_packet_count += 1;
                    if silent_packet_count <= 3 || silent_packet_count % 100 == 0 {
                        log_audio_capture(&format!(
                            "[audio-capture] silent packet #{} frames={} len={}",
                            silent_packet_count, frames, data_len
                        ));
                    }
                }

                if !silent && !buf_ptr.is_null() && data_len > 0 {
                    let slice = std::slice::from_raw_parts(buf_ptr, data_len);

                    // Log first few frames for diagnostics
                    frame_count += 1;
                    if frame_count <= 5 {
                        let preview_bytes = std::cmp::min(slice.len(), 32);
                        log_audio_capture(&format!(
                            "[audio-capture] frame #{} len={} first_bytes={:?}",
                            frame_count,
                            data_len,
                            &slice[..preview_bytes]
                        ));
                    }

                    let send_bytes: Vec<u8> = if is_float {
                        // Already float32 - send raw bytes as-is
                        slice.to_vec()
                    } else if bits == 16 {
                        // Int16 PCM to Float32 conversion
                        let sample_count = data_len / 2;
                        let mut float_buf = Vec::with_capacity(sample_count * 4);
                        let samples =
                            std::slice::from_raw_parts(buf_ptr as *const i16, sample_count);
                        for &s in samples {
                            let f = s as f32 / 32768.0;
                            float_buf.extend_from_slice(&f.to_le_bytes());
                        }
                        if frame_count <= 3 {
                            log_audio_capture(&format!(
                                "[audio-capture] int16->float32: {} samples, first few: {:?}",
                                sample_count,
                                &samples[..std::cmp::min(samples.len(), 8)]
                            ));
                        }
                        float_buf
                    } else if bits == 24 {
                        // Int24 PCM to Float32 conversion
                        let sample_count = data_len / 3;
                        let mut float_buf = Vec::with_capacity(sample_count * 4);
                        for i in 0..sample_count {
                            let b0 = slice[i * 3] as i32;
                            let b1 = slice[i * 3 + 1] as i32;
                            let b2 = slice[i * 3 + 2] as i32;
                            // Sign-extend 24-bit to 32-bit
                            let raw = b0 | (b1 << 8) | (b2 << 16);
                            let signed = if raw & 0x800000 != 0 {
                                raw | !0xFFFFFF_i32
                            } else {
                                raw
                            };
                            let f = signed as f32 / 8388608.0;
                            float_buf.extend_from_slice(&f.to_le_bytes());
                        }
                        if frame_count <= 3 {
                            log_audio_capture(&format!(
                                "[audio-capture] int24->float32: {} samples converted",
                                sample_count
                            ));
                        }
                        float_buf
                    } else {
                        // Unknown format - send raw and log warning
                        if frame_count <= 3 {
                            log_audio_capture(&format!(
                                "[audio-capture] WARNING: unknown format {}bit, sending raw bytes",
                                bits
                            ));
                        }
                        slice.to_vec()
                    };

                    if frame_count <= 5 || frame_count % 50 == 0 {
                        let sample_count = send_bytes.len() / 4;
                        let peak = audio_capture_peak_from_f32_bytes(&send_bytes);
                        log_audio_capture(&audio_capture_frame_diagnostic(
                            frame_count,
                            sample_count,
                            peak,
                        ));
                    }

                    let b64 = base64::engine::general_purpose::STANDARD.encode(&send_bytes);
                    let _ = app.emit("audio-capture-data", b64);
                }

                capture.ReleaseBuffer(frames)?;
            }
        }

        client.Stop()?;
        let _ = CloseHandle(event);

        log_audio_capture(&format!("[audio-capture] stopped for {}", capture_label));
        Ok(())
    }
}

fn capture_system_loop(
    app: &AppHandle,
    running: &AtomicBool,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    unsafe {
        log_audio_capture("[audio-capture] system capture_loop starting");
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        log_audio_capture("[audio-capture] COM initialized");

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
        log_audio_capture("[audio-capture] got default render endpoint");

        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        log_audio_capture("[audio-capture] activated default render endpoint");

        let result = capture_with_audio_client(client, app, running, "system loopback", 0);
        CoUninitialize();
        result
    }
}

// --- Main capture loop ---

fn capture_loop(
    pid: u32,
    app: &AppHandle,
    running: &AtomicBool,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    unsafe {
        log_audio_capture(&format!(
            "[audio-capture] capture_loop starting for PID {}",
            pid
        ));
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        log_audio_capture("[audio-capture] COM initialized");

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
        let handler: IActivateAudioInterfaceCompletionHandler = ActivationHandler { tx }.into();

        // Activate audio interface for process loopback
        // VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback"
        log_audio_capture(&format!(
            "[audio-capture] calling ActivateAudioInterfaceAsync for PID {} (params_size={})",
            pid, params_size
        ));
        let _operation = ActivateAudioInterfaceAsync(
            w!("VAD\\Process_Loopback"),
            &IAudioClient::IID,
            Some(propvariant),
            &handler,
        )?;
        log_audio_capture(
            "[audio-capture] ActivateAudioInterfaceAsync call succeeded, waiting for completion...",
        );

        // Wait for activation (5 second timeout)
        let client = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("activation timeout: {}", e))?
            .map_err(|e| {
                log_audio_capture(&format!("[audio-capture] activation FAILED: {}", e));
                format!("activation failed: {}", e)
            })?;
        log_audio_capture("[audio-capture] activation completed -- got IAudioClient");

        let result = capture_with_audio_client(client, app, running, &format!("PID {}", pid), pid);
        CoUninitialize();
        result
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::{
        audio_capture_frame_diagnostic, audio_capture_peak_from_f32_bytes,
        process_loopback_fallback_format, process_loopback_initialize_flags,
        system_loopback_initialize_flags,
    };
    use windows::Win32::Media::Audio::{
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
    };

    #[test]
    fn process_loopback_fallback_uses_pcm16_format() {
        let format = process_loopback_fallback_format();
        let format_tag = format.wFormatTag;
        let channels = format.nChannels;
        let sample_rate = format.nSamplesPerSec;
        let bits = format.wBitsPerSample;
        let block_align = format.nBlockAlign;
        let avg_bytes_per_sec = format.nAvgBytesPerSec;
        let cb_size = format.cbSize;

        assert_eq!(format_tag, 1);
        assert_eq!(channels, 2);
        assert_eq!(sample_rate, 44_100);
        assert_eq!(bits, 16);
        assert_eq!(block_align, 4);
        assert_eq!(avg_bytes_per_sec, 176_400);
        assert_eq!(cb_size, 0);
    }

    #[test]
    fn process_loopback_fallback_enables_autoconvertpcm() {
        let flags = process_loopback_initialize_flags(true);

        assert_ne!(flags & AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0);
        assert_ne!(flags & AUDCLNT_STREAMFLAGS_LOOPBACK, 0);
        assert_ne!(flags & AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 0);
    }

    #[test]
    fn system_loopback_uses_event_loopback_flags() {
        let flags = system_loopback_initialize_flags();

        assert_ne!(flags & AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0);
        assert_ne!(flags & AUDCLNT_STREAMFLAGS_LOOPBACK, 0);
    }

    #[test]
    fn audio_capture_frame_diagnostic_includes_peak_level() {
        let samples = [0.0_f32, -0.25, 0.5, f32::NAN, -0.125];
        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();

        let peak = audio_capture_peak_from_f32_bytes(&bytes);
        let line = audio_capture_frame_diagnostic(7, 5, peak);

        assert_eq!(peak, 0.5);
        assert_eq!(
            line,
            "[audio-capture] converted frame #7 samples=5 peak=0.500000"
        );
    }
}
