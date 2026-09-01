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
use windows::Win32::System::Diagnostics::ToolHelp::*;
use windows::Win32::System::Registry::*;
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::WindowsAndMessaging::*;

// --- Process loopback constants (may not be in older windows crate versions) ---

/// AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
const ACTIVATION_TYPE_PROCESS_LOOPBACK: u32 = 1;
/// PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0
const LOOPBACK_MODE_INCLUDE_TREE: u32 = 0;
/// PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
const LOOPBACK_MODE_EXCLUDE_TREE: u32 = 1;
/// VT_BLOB variant type
const VT_BLOB: u16 = 65;
const BITS_PER_BYTE: u16 = 8;
const OWNED_CAPTURE_CHANNEL_CAPACITY: usize = 64;
const WEBVIEW2_PROCESS_NAME: &str = "msedgewebview2.exe";
const PROCESS_LOOPBACK_ACTIVATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const ATTESTED_SYSTEM_CAPTURE_START_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(8);

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

/// The VT_BLOB arm of PROPVARIANT, represented with the platform ABI instead
/// of casting an under-aligned byte array. The blob points to activation
/// parameters that remain live until ActivateAudioInterfaceAsync completes.
#[repr(C)]
struct ProcessLoopbackPropVariant {
    vt: u16,
    reserved1: u16,
    reserved2: u16,
    reserved3: u16,
    blob: BLOB,
}

const _: [(); std::mem::size_of::<PROPVARIANT>()] =
    [(); std::mem::size_of::<ProcessLoopbackPropVariant>()];
const _: [(); std::mem::align_of::<PROPVARIANT>()] =
    [(); std::mem::align_of::<ProcessLoopbackPropVariant>()];

impl ProcessLoopbackPropVariant {
    fn new(params: &mut AudioClientActivationParams) -> Self {
        Self {
            vt: VT_BLOB,
            reserved1: 0,
            reserved2: 0,
            reserved3: 0,
            blob: BLOB {
                cbSize: std::mem::size_of::<AudioClientActivationParams>() as u32,
                pBlobData: params as *mut AudioClientActivationParams as *mut u8,
            },
        }
    }

    fn as_propvariant(&self) -> &PROPVARIANT {
        // SAFETY: ProcessLoopbackPropVariant is repr(C), has the same size and
        // alignment as PROPVARIANT, and models its VT_BLOB arm exactly. Unit
        // tests lock those ABI properties down for the compiled target.
        unsafe { &*(self as *const Self as *const PROPVARIANT) }
    }
}

/// Heap-stable activation data owned by the COM completion handler.
///
/// `ActivateAudioInterfaceAsync` may still be using the PROPVARIANT after the
/// initiating thread's bounded wait times out. Keeping both allocations inside
/// the handler makes Windows' retained handler reference the lifetime owner,
/// including a late completion after our local timeout.
struct ProcessLoopbackActivationStorage {
    _params: Box<AudioClientActivationParams>,
    value: Box<ProcessLoopbackPropVariant>,
}

impl ProcessLoopbackActivationStorage {
    fn new(pid: u32, process_loopback_mode: u32) -> Self {
        let mut params = Box::new(AudioClientActivationParams {
            activation_type: ACTIVATION_TYPE_PROCESS_LOOPBACK,
            loopback_params: ProcessLoopbackParams {
                target_process_id: pid,
                process_loopback_mode,
            },
        });
        let value = Box::new(ProcessLoopbackPropVariant::new(params.as_mut()));
        Self {
            _params: params,
            value,
        }
    }

    fn propvariant_ptr(&self) -> *const PROPVARIANT {
        self.value.as_propvariant() as *const PROPVARIANT
    }
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

#[derive(Serialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioIsolationAttestation {
    pub isolation_mode: &'static str,
    pub excluded_pid: u32,
    pub excluded_process: String,
    pub activation_started: bool,
}

/// Native process-loopback events for callers that own their capture handle.
/// `Data` is always little-endian float32 PCM bytes.
#[derive(Debug)]
pub enum ProcessCaptureEvent {
    Format(ProcessCaptureFormat),
    Started { pid: u32 },
    Data(Vec<u8>),
    Error(String),
    Stopped,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessCaptureFormat {
    pub sample_rate: u32,
    pub channels: u32,
    pub bits_per_sample: u16,
    pub format_tag: u16,
    pub is_float: bool,
}

type ProcessCaptureSink = Arc<dyn Fn(ProcessCaptureEvent) + Send + Sync + 'static>;

/// A process-loopback capture owned by one subsystem. Dropping it cannot stop
/// captures owned by any other subsystem (notably screen-share audio).
pub struct OwnedProcessCapture {
    running: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl OwnedProcessCapture {
    pub fn stop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for OwnedProcessCapture {
    fn drop(&mut self) {
        self.stop();
    }
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

fn process_entry_name(entry: &PROCESSENTRY32W) -> String {
    let len = entry
        .szExeFile
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(entry.szExeFile.len());
    String::from_utf16_lossy(&entry.szExeFile[..len])
}

fn find_processes_by_name(exe_name: &str) -> Vec<(u32, u32)> {
    let mut processes = Vec::new();

    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return processes;
        };

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let name = process_entry_name(&entry);
                if name.eq_ignore_ascii_case(exe_name) {
                    processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
                }

                entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);
    }

    processes
}

fn select_root_process_pid(processes: &[(u32, u32)]) -> Option<u32> {
    let pids: std::collections::HashSet<u32> = processes.iter().map(|(pid, _)| *pid).collect();
    let mut roots = processes
        .iter()
        .filter(|(_, parent_pid)| !pids.contains(parent_pid))
        .map(|(pid, _)| *pid)
        .collect::<Vec<_>>();
    roots.sort_unstable();
    roots
        .into_iter()
        .next()
        .or_else(|| processes.iter().map(|(pid, _)| *pid).min())
}

fn process_session_id(pid: u32) -> Option<u32> {
    let mut session_id = 0_u32;
    unsafe {
        ProcessIdToSessionId(pid, &mut session_id)
            .is_ok()
            .then_some(session_id)
    }
}

fn live_process_exe_name(pid: u32) -> std::result::Result<String, String> {
    if pid == 0 {
        return Err("WebView2 reported an invalid browser process ID".to_string());
    }

    unsafe {
        let handle =
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|error| {
                format!(
                    "WebView2 browser process {} is not available: {}",
                    pid, error
                )
            })?;

        let result = (|| {
            let mut exit_code = 0_u32;
            GetExitCodeProcess(handle, &mut exit_code).map_err(|error| {
                format!(
                    "Cannot verify WebView2 browser process {} state: {}",
                    pid, error
                )
            })?;
            if exit_code != STILL_ACTIVE.0 as u32 {
                return Err(format!(
                    "WebView2 browser process {} is no longer running",
                    pid
                ));
            }

            let mut buf = [0_u16; 260];
            let mut size = buf.len() as u32;
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
            .map_err(|error| {
                format!(
                    "Cannot identify WebView2 browser process {}: {}",
                    pid, error
                )
            })?;

            let path = String::from_utf16_lossy(&buf[..size as usize]);
            path.rsplit('\\')
                .next()
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .ok_or_else(|| format!("WebView2 browser process {} has no executable name", pid))
        })();

        let _ = CloseHandle(handle);
        result
    }
}

fn validate_webview2_process_facts(
    pid: u32,
    process_name: &str,
    process_session: Option<u32>,
    echo_session: Option<u32>,
) -> std::result::Result<String, String> {
    if pid == 0 {
        return Err("WebView2 reported an invalid browser process ID".to_string());
    }
    if !process_name.eq_ignore_ascii_case(WEBVIEW2_PROCESS_NAME) {
        return Err(format!(
            "WebView2 browser PID {} resolved to unexpected process {}",
            pid, process_name
        ));
    }

    let process_session = process_session.ok_or_else(|| {
        format!(
            "Cannot determine Windows session for WebView2 browser process {}",
            pid
        )
    })?;
    let echo_session =
        echo_session.ok_or_else(|| "Cannot determine Echo's Windows session".to_string())?;
    if process_session != echo_session {
        return Err(format!(
            "WebView2 browser process {} is in Windows session {}, not Echo session {}",
            pid, process_session, echo_session
        ));
    }

    Ok(WEBVIEW2_PROCESS_NAME.to_string())
}

fn validate_webview2_exclusion_target(pid: u32) -> std::result::Result<String, String> {
    let process_name = live_process_exe_name(pid)?;
    let echo_pid = unsafe { GetCurrentProcessId() };
    validate_webview2_process_facts(
        pid,
        &process_name,
        process_session_id(pid),
        process_session_id(echo_pid),
    )
}

fn select_root_process_pid_for_session(
    processes: &[(u32, u32, u32)],
    session_id: u32,
) -> Option<u32> {
    let same_session = processes
        .iter()
        .filter(|(_, _, candidate_session)| *candidate_session == session_id)
        .map(|(pid, parent_pid, _)| (*pid, *parent_pid))
        .collect::<Vec<_>>();
    select_root_process_pid(&same_session)
}

/// Return the root Spotify.exe PID in Echo's interactive Windows session.
/// Capturing that root with INCLUDE_TREE covers Spotify's renderer descendants
/// and avoids binding to an arbitrary child process or another user session.
pub fn find_spotify_root_pid() -> std::result::Result<u32, String> {
    let current_pid = unsafe { GetCurrentProcessId() };
    let current_session = process_session_id(current_pid)
        .ok_or_else(|| "Cannot determine Echo's Windows session".to_string())?;
    let processes = find_processes_by_name("Spotify.exe")
        .into_iter()
        .filter_map(|(pid, parent_pid)| {
            process_session_id(pid).map(|session_id| (pid, parent_pid, session_id))
        })
        .collect::<Vec<_>>();

    select_root_process_pid_for_session(&processes, current_session).ok_or_else(|| {
        format!(
            "Spotify.exe not found in Echo's Windows session {}",
            current_session
        )
    })
}

/// Return every Spotify.exe PID in Echo's interactive Windows session.
///
/// This deliberately excludes Spotify processes in other signed-in sessions so
/// Jam recovery can restart only the source PC user's Spotify instance.
pub(crate) fn find_spotify_process_ids() -> std::result::Result<Vec<u32>, String> {
    let current_pid = unsafe { GetCurrentProcessId() };
    let current_session = process_session_id(current_pid)
        .ok_or_else(|| "Cannot determine Echo's Windows session".to_string())?;
    let mut pids = find_processes_by_name("Spotify.exe")
        .into_iter()
        .filter_map(|(pid, _)| (process_session_id(pid) == Some(current_session)).then_some(pid))
        .collect::<Vec<_>>();
    pids.sort_unstable();
    pids.dedup();
    Ok(pids)
}

/// Verify that an existing Jam capture is still bound to the Spotify root
/// selected for Echo's current Windows session. Spotify can exit without
/// WASAPI reporting a terminal capture event, so the Jam source polls this
/// cheaply and reconnects when the process tree changes.
pub fn validate_spotify_root_pid(expected_pid: u32) -> std::result::Result<(), String> {
    let selected_pid = find_spotify_root_pid()?;
    validate_selected_spotify_root_pid(expected_pid, selected_pid)
}

fn validate_selected_spotify_root_pid(
    expected_pid: u32,
    selected_pid: u32,
) -> std::result::Result<(), String> {
    if selected_pid == expected_pid {
        Ok(())
    } else {
        Err(format!(
            "Spotify root PID changed from {} to {}",
            expected_pid, selected_pid
        ))
    }
}

fn system_audio_feedback_capture_loopback_mode() -> u32 {
    LOOPBACK_MODE_EXCLUDE_TREE
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

fn tauri_capture_sink(app: AppHandle) -> ProcessCaptureSink {
    Arc::new(move |event| match event {
        ProcessCaptureEvent::Format(format) => {
            let _ = app.emit("audio-capture-format", format);
        }
        ProcessCaptureEvent::Started { pid } => {
            let _ = app.emit("audio-capture-started", pid);
        }
        ProcessCaptureEvent::Data(bytes) => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            let _ = app.emit("audio-capture-data", b64);
        }
        ProcessCaptureEvent::Error(message) => {
            let _ = app.emit("audio-capture-error", message);
        }
        ProcessCaptureEvent::Stopped => {
            let _ = app.emit("audio-capture-stopped", ());
        }
    })
}

/// Start a process-loopback capture whose lifecycle belongs entirely to the
/// caller. Unlike `start_capture`, this does not touch the screen-share slot.
pub fn start_owned_process_capture(
    pid: u32,
) -> std::result::Result<
    (
        OwnedProcessCapture,
        tokio::sync::mpsc::Receiver<ProcessCaptureEvent>,
    ),
    String,
> {
    check_process_loopback_support()?;

    let (tx, rx) = tokio::sync::mpsc::channel(OWNED_CAPTURE_CHANNEL_CAPACITY);
    let sink: ProcessCaptureSink = Arc::new(move |event| {
        // WASAPI must never block behind network upload. Format and Started are
        // emitted before PCM begins; once the bounded queue fills, dropping PCM
        // is preferable to unbounded memory growth and increasing latency.
        let _ = try_send_owned_capture_event(&tx, event);
    });
    let running = Arc::new(AtomicBool::new(true));
    let thread_running = running.clone();
    let thread_sink = sink.clone();

    let thread = std::thread::spawn(move || {
        if let Err(error) = capture_loop(
            pid,
            LOOPBACK_MODE_INCLUDE_TREE,
            "owned process include-tree",
            &thread_sink,
            &thread_running,
        ) {
            log_audio_capture(&format!("[audio-capture] owned capture error: {}", error));
            thread_sink(ProcessCaptureEvent::Error(error.to_string()));
        }
        thread_sink(ProcessCaptureEvent::Stopped);
        log_audio_capture("[audio-capture] owned capture thread exited");
    });

    Ok((
        OwnedProcessCapture {
            running,
            thread: Some(thread),
        },
        rx,
    ))
}

fn try_send_owned_capture_event(
    tx: &tokio::sync::mpsc::Sender<ProcessCaptureEvent>,
    event: ProcessCaptureEvent,
) -> bool {
    tx.try_send(event).is_ok()
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
    let sink = tauri_capture_sink(app);

    let thread = std::thread::spawn(move || {
        if let Err(e) = capture_loop(
            pid,
            LOOPBACK_MODE_INCLUDE_TREE,
            "process include-tree",
            &sink,
            &r2,
        ) {
            log_audio_capture(&format!("[audio-capture] error: {}", e));
            sink(ProcessCaptureEvent::Error(e.to_string()));
        }
        sink(ProcessCaptureEvent::Stopped);
        log_audio_capture("[audio-capture] thread exited");
    });

    *global_state().lock().unwrap() = Some(CaptureHandle {
        running,
        thread: Some(thread),
    });

    Ok(())
}

pub fn start_attested_system_capture_excluding_echo(
    exclude_pid: u32,
    app: AppHandle,
) -> Result<SystemAudioIsolationAttestation> {
    if let Err(message) = check_process_loopback_support() {
        log_audio_capture(&format!("[audio-capture] {}", message));
        return Err(Error::new(E_FAIL, message));
    }

    // BrowserProcessId comes from the active CoreWebView2 instance. Validate
    // the exact process before touching an existing capture or activating a
    // new one; an untrusted/stale PID must fail closed.
    let excluded_process = validate_webview2_exclusion_target(exclude_pid).map_err(|message| {
        log_audio_capture(&format!(
            "[audio-capture] isolation attestation failed: {}",
            message
        ));
        Error::new(E_FAIL, message)
    })?;

    log_audio_capture(&format!(
        "[audio-capture] start_attested_system_capture_excluding_echo requested exclude={} pid={}",
        excluded_process, exclude_pid
    ));
    stop_capture();

    let running = Arc::new(AtomicBool::new(true));
    let thread_running = running.clone();
    let app_sink = tauri_capture_sink(app);
    let (startup_tx, startup_rx) = std::sync::mpsc::sync_channel(1);
    let sink: ProcessCaptureSink = Arc::new(move |event| {
        let startup_result = match &event {
            ProcessCaptureEvent::Started { pid } => Some(Ok(*pid)),
            ProcessCaptureEvent::Error(message) => Some(Err(message.clone())),
            ProcessCaptureEvent::Stopped => Some(Err(
                "System audio capture stopped before activation completed".to_string(),
            )),
            ProcessCaptureEvent::Format(_) | ProcessCaptureEvent::Data(_) => None,
        };

        app_sink(event);
        if let Some(result) = startup_result {
            let _ = startup_tx.try_send(result);
        }
    });
    let thread_sink = sink.clone();
    let label = format!("system excluding {} tree", excluded_process);

    let thread = std::thread::spawn(move || {
        if let Err(error) = capture_loop(
            exclude_pid,
            system_audio_feedback_capture_loopback_mode(),
            &label,
            &thread_sink,
            &thread_running,
        ) {
            log_audio_capture(&format!("[audio-capture] error: {}", error));
            thread_sink(ProcessCaptureEvent::Error(error.to_string()));
        }
        thread_sink(ProcessCaptureEvent::Stopped);
        log_audio_capture("[audio-capture] attested system capture thread exited");
    });

    *global_state().lock().unwrap() = Some(CaptureHandle {
        running,
        thread: Some(thread),
    });

    match startup_rx.recv_timeout(ATTESTED_SYSTEM_CAPTURE_START_TIMEOUT) {
        Ok(Ok(started_pid)) if started_pid == exclude_pid => Ok(SystemAudioIsolationAttestation {
            isolation_mode: "webview2-process-tree",
            excluded_pid: exclude_pid,
            excluded_process,
            activation_started: true,
        }),
        Ok(Ok(started_pid)) => {
            stop_capture();
            Err(Error::new(
                E_FAIL,
                format!(
                    "System audio capture started for unexpected PID {} instead of {}",
                    started_pid, exclude_pid
                ),
            ))
        }
        Ok(Err(message)) => {
            stop_capture();
            Err(Error::new(
                E_FAIL,
                format!("System audio capture activation failed: {}", message),
            ))
        }
        Err(error) => {
            stop_capture();
            Err(Error::new(
                E_FAIL,
                format!(
                    "System audio capture did not start within {} seconds: {}",
                    ATTESTED_SYSTEM_CAPTURE_START_TIMEOUT.as_secs(),
                    error
                ),
            ))
        }
    }
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
    _activation_storage: ProcessLoopbackActivationStorage,
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
    sink: &ProcessCaptureSink,
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
                sink(ProcessCaptureEvent::Format(ProcessCaptureFormat {
                    sample_rate,
                    channels,
                    bits_per_sample: bits,
                    format_tag,
                    is_float,
                }));

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

                sink(ProcessCaptureEvent::Format(ProcessCaptureFormat {
                    sample_rate,
                    channels,
                    bits_per_sample: bits,
                    format_tag: WAVE_FORMAT_PCM as u16,
                    is_float: false,
                }));

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
        sink(ProcessCaptureEvent::Started { pid: started_pid });

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

                    let send_bytes: Vec<u8> = if is_float && bits == 32 {
                        // Already float32 - send raw bytes as-is.
                        slice.to_vec()
                    } else if is_float && bits == 64 {
                        let mut float_buf = Vec::with_capacity((data_len / 8) * 4);
                        for chunk in slice.chunks_exact(8) {
                            let sample = f64::from_le_bytes(chunk.try_into().unwrap()) as f32;
                            float_buf.extend_from_slice(&sample.to_le_bytes());
                        }
                        float_buf
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
                    } else if bits == 32 {
                        // Signed PCM32 to Float32 conversion.
                        let mut float_buf = Vec::with_capacity(data_len);
                        for chunk in slice.chunks_exact(4) {
                            let sample = i32::from_le_bytes(chunk.try_into().unwrap());
                            let value = sample as f32 / 2_147_483_648.0;
                            float_buf.extend_from_slice(&value.to_le_bytes());
                        }
                        float_buf
                    } else {
                        if frame_count <= 3 {
                            log_audio_capture(&format!(
                                "[audio-capture] WARNING: unsupported format {}bit; dropping packet",
                                bits
                            ));
                        }
                        Vec::new()
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

                    if !send_bytes.is_empty() {
                        sink(ProcessCaptureEvent::Data(send_bytes));
                    }
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

// --- Main capture loop ---

fn capture_loop(
    pid: u32,
    process_loopback_mode: u32,
    label: &str,
    sink: &ProcessCaptureSink,
    running: &AtomicBool,
) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    unsafe {
        log_audio_capture(&format!(
            "[audio-capture] capture_loop starting for {} PID {}",
            label, pid
        ));
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        log_audio_capture("[audio-capture] COM initialized");

        let params_size = std::mem::size_of::<AudioClientActivationParams>() as u32;

        // Completion handler
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let activation_storage = ProcessLoopbackActivationStorage::new(pid, process_loopback_mode);
        let propvariant = activation_storage.propvariant_ptr();
        let handler: IActivateAudioInterfaceCompletionHandler = ActivationHandler {
            tx,
            _activation_storage: activation_storage,
        }
        .into();

        // Activate audio interface for process loopback
        // VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback"
        log_audio_capture(&format!(
            "[audio-capture] calling ActivateAudioInterfaceAsync for PID {} (params_size={})",
            pid, params_size
        ));
        let operation = ActivateAudioInterfaceAsync(
            w!("VAD\\Process_Loopback"),
            &IAudioClient::IID,
            Some(&*propvariant),
            &handler,
        )?;
        log_audio_capture(
            "[audio-capture] ActivateAudioInterfaceAsync call succeeded, waiting for completion...",
        );

        // Wait for COM activation. The attested command has a longer outer
        // deadline so successful activation still has time to Initialize and
        // Start before the command decides startup failed.
        let activation_result = rx.recv_timeout(PROCESS_LOOPBACK_ACTIVATION_TIMEOUT);

        // The callback object owns the heap-stable PROPVARIANT and pointed-to
        // activation params. Windows retains the callback until completion, so
        // a late completion remains memory-safe after this local timeout.
        drop(operation);
        drop(handler);

        let client = activation_result
            .map_err(|e| format!("activation timeout: {}", e))?
            .map_err(|e| {
                log_audio_capture(&format!("[audio-capture] activation FAILED: {}", e));
                format!("activation failed: {}", e)
            })?;
        log_audio_capture("[audio-capture] activation completed -- got IAudioClient");

        let result = capture_with_audio_client(client, sink, running, label, pid);
        CoUninitialize();
        result
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::{
        audio_capture_frame_diagnostic, audio_capture_peak_from_f32_bytes,
        process_loopback_fallback_format, process_loopback_initialize_flags,
        select_root_process_pid, select_root_process_pid_for_session,
        system_audio_feedback_capture_loopback_mode, system_loopback_initialize_flags,
        try_send_owned_capture_event, validate_selected_spotify_root_pid,
        validate_webview2_process_facts, AudioClientActivationParams, ProcessCaptureEvent,
        ProcessLoopbackActivationStorage, ProcessLoopbackParams, ProcessLoopbackPropVariant,
        SystemAudioIsolationAttestation, ATTESTED_SYSTEM_CAPTURE_START_TIMEOUT,
        LOOPBACK_MODE_EXCLUDE_TREE, PROCESS_LOOPBACK_ACTIVATION_TIMEOUT, VT_BLOB,
    };
    use windows::core::PROPVARIANT;
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
    fn system_audio_feedback_capture_uses_exclude_tree_mode() {
        assert_eq!(
            system_audio_feedback_capture_loopback_mode(),
            LOOPBACK_MODE_EXCLUDE_TREE
        );
    }

    #[test]
    fn process_loopback_propvariant_matches_native_abi() {
        assert_eq!(
            std::mem::size_of::<ProcessLoopbackPropVariant>(),
            std::mem::size_of::<PROPVARIANT>()
        );
        assert_eq!(
            std::mem::align_of::<ProcessLoopbackPropVariant>(),
            std::mem::align_of::<PROPVARIANT>()
        );
        assert_eq!(std::mem::offset_of!(ProcessLoopbackPropVariant, blob), 8);
    }

    #[test]
    fn attested_start_deadline_exceeds_com_activation_deadline() {
        assert!(ATTESTED_SYSTEM_CAPTURE_START_TIMEOUT > PROCESS_LOOPBACK_ACTIVATION_TIMEOUT);
    }

    #[test]
    fn process_loopback_propvariant_points_to_live_activation_params() {
        let mut params = AudioClientActivationParams {
            activation_type: 1,
            loopback_params: ProcessLoopbackParams {
                target_process_id: 42,
                process_loopback_mode: LOOPBACK_MODE_EXCLUDE_TREE,
            },
        };
        let expected_params = &mut params as *mut AudioClientActivationParams as *mut u8;
        let value = ProcessLoopbackPropVariant::new(&mut params);

        assert_eq!(value.vt, VT_BLOB);
        assert_eq!(
            value.blob.cbSize,
            std::mem::size_of::<AudioClientActivationParams>() as u32
        );
        assert_eq!(value.blob.pBlobData, expected_params);
    }

    #[test]
    fn activation_storage_keeps_propvariant_and_params_heap_stable_when_moved() {
        let storage = ProcessLoopbackActivationStorage::new(42, LOOPBACK_MODE_EXCLUDE_TREE);
        let value_ptr_before_move = storage.propvariant_ptr();
        let params_ptr_before_move = storage.value.blob.pBlobData;

        let moved_storage = storage;

        assert_eq!(moved_storage.propvariant_ptr(), value_ptr_before_move);
        assert_eq!(moved_storage.value.blob.pBlobData, params_ptr_before_move);
        assert_eq!(
            moved_storage._params.as_ref() as *const AudioClientActivationParams as *mut u8,
            params_ptr_before_move
        );
    }

    #[test]
    fn webview2_exclusion_target_requires_expected_live_session_identity() {
        assert_eq!(
            validate_webview2_process_facts(4242, "MSEdgeWebView2.exe", Some(3), Some(3)).unwrap(),
            "msedgewebview2.exe"
        );

        assert!(
            validate_webview2_process_facts(4242, "echo-core-client.exe", Some(3), Some(3))
                .unwrap_err()
                .contains("unexpected process")
        );
        assert!(
            validate_webview2_process_facts(4242, "msedgewebview2.exe", Some(4), Some(3))
                .unwrap_err()
                .contains("not Echo session")
        );
        assert!(
            validate_webview2_process_facts(0, "msedgewebview2.exe", Some(3), Some(3))
                .unwrap_err()
                .contains("invalid browser process ID")
        );
    }

    #[test]
    fn system_audio_isolation_attestation_serializes_camel_case_contract() {
        let value = serde_json::to_value(SystemAudioIsolationAttestation {
            isolation_mode: "webview2-process-tree",
            excluded_pid: 4242,
            excluded_process: "msedgewebview2.exe".to_string(),
            activation_started: true,
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "isolationMode": "webview2-process-tree",
                "excludedPid": 4242,
                "excludedProcess": "msedgewebview2.exe",
                "activationStarted": true
            })
        );
    }

    #[test]
    fn selects_spotify_root_instead_of_renderer_child() {
        let spotify = vec![(20948, 900), (21000, 20948), (21001, 20948), (21002, 21000)];

        assert_eq!(select_root_process_pid(&spotify), Some(20948));
    }

    #[test]
    fn spotify_root_selection_is_limited_to_echo_session() {
        let spotify = vec![
            (100, 10, 0),
            (101, 100, 0),
            (20948, 900, 1),
            (21000, 20948, 1),
            (21001, 20948, 1),
        ];

        assert_eq!(
            select_root_process_pid_for_session(&spotify, 1),
            Some(20948)
        );
    }

    #[test]
    fn spotify_root_liveness_rejects_a_replacement_pid() {
        assert!(validate_selected_spotify_root_pid(20948, 20948).is_ok());

        let error = validate_selected_spotify_root_pid(20948, 31000).unwrap_err();
        assert!(error.contains("changed from 20948 to 31000"));
    }

    #[test]
    fn owned_capture_queue_drops_pcm_instead_of_blocking_when_full() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        assert!(try_send_owned_capture_event(
            &tx,
            ProcessCaptureEvent::Started { pid: 20948 }
        ));
        assert!(!try_send_owned_capture_event(
            &tx,
            ProcessCaptureEvent::Data(vec![0, 0, 0, 0])
        ));
        assert!(matches!(
            rx.try_recv(),
            Ok(ProcessCaptureEvent::Started { pid: 20948 })
        ));
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
