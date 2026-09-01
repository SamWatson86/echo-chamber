// Prevents additional console window on Windows
#![windows_subsystem = "windows"]

#[cfg(target_os = "windows")]
mod audio_capture;
#[cfg(not(target_os = "windows"))]
mod audio_capture_stub;
#[cfg(target_os = "windows")]
mod jam_source;
#[cfg(target_os = "windows")]
mod spotify_connect_repair;
#[cfg(not(target_os = "windows"))]
use audio_capture_stub as audio_capture;

#[cfg(target_os = "windows")]
mod screen_capture;
#[cfg(any(target_os = "windows", test))]
mod spotify_link;
#[cfg(target_os = "windows")]
mod spotify_output_route;

#[cfg(target_os = "windows")]
mod audio_output;
#[cfg(not(target_os = "windows"))]
mod audio_output_stub;
#[cfg(target_os = "windows")]
mod capture_health;
#[cfg(target_os = "windows")]
mod capture_pipeline;
#[cfg(target_os = "windows")]
mod desktop_capture;
#[cfg(target_os = "windows")]
mod display_placement;
#[cfg(target_os = "windows")]
mod file_debug_log;
#[cfg(target_os = "windows")]
mod gpu_converter;
#[cfg(target_os = "windows")]
mod gpu_preference;
#[cfg(target_os = "windows")]
mod native_presenter;
#[cfg(not(target_os = "windows"))]
use audio_output_stub as audio_output;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "windows")]
use crate::capture_health::{CaptureHealthSnapshot, CaptureHealthState};
#[cfg(target_os = "windows")]
use crate::native_presenter::{
    NativePresenterManager, NativePresenterStartRequest, NativePresenterStatus,
};

const DEFAULT_SERVER: &str = "https://echo.fellowshipoftheboatrace.party:9443";

/// Linearizes native audio start/stop commands across viewer reloads.
///
/// A navigation creates a fresh JavaScript context, so viewer-side promises
/// cannot fence an older in-flight Tauri command. Every command reserves a
/// generation before any await, then installs or stops capture only while it
/// owns this gate and is still the newest command.
struct AudioCaptureCommandCoordinator {
    generation: std::sync::atomic::AtomicU64,
    gate: std::sync::Mutex<()>,
}

impl AudioCaptureCommandCoordinator {
    const fn new() -> Self {
        Self {
            generation: std::sync::atomic::AtomicU64::new(0),
            gate: std::sync::Mutex::new(()),
        }
    }

    fn reserve(&self) -> u64 {
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            .wrapping_add(1)
    }

    fn is_current(&self, generation: u64) -> bool {
        self.generation.load(std::sync::atomic::Ordering::SeqCst) == generation
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.gate.lock().unwrap_or_else(|error| error.into_inner())
    }
}

static AUDIO_CAPTURE_COMMANDS: AudioCaptureCommandCoordinator =
    AudioCaptureCommandCoordinator::new();

fn audio_capture_command_superseded() -> String {
    "Native audio command was superseded by a newer start or stop".to_string()
}

#[cfg(test)]
mod audio_capture_command_coordinator_tests {
    use super::AudioCaptureCommandCoordinator;

    #[test]
    fn newest_reservation_fences_old_start_and_stale_stop() {
        let commands = AudioCaptureCommandCoordinator::new();
        let old_start = commands.reserve();
        let stale_stop = commands.reserve();
        let replacement_start = commands.reserve();

        let _gate = commands.lock();
        assert!(!commands.is_current(old_start));
        assert!(!commands.is_current(stale_stop));
        assert!(commands.is_current(replacement_start));
    }
}

#[derive(Deserialize)]
struct Config {
    server: Option<String>,
    force_software_encoder: Option<bool>,
    #[cfg(target_os = "windows")]
    #[serde(default)]
    jam_source: Option<jam_source::JamSourceConfig>,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    native: bool,
    platform: String,
    server: String,
}

fn is_local_test_build_version(version: &str) -> bool {
    let lower = version.trim().to_ascii_lowercase();
    let Some((_, prerelease)) = lower.split_once('-') else {
        return false;
    };
    prerelease
        .split('.')
        .any(|part| matches!(part, "local" | "dev" | "test" | "lab" | "dirty"))
}

#[cfg(target_os = "windows")]
fn detect_windows_build_number() -> u32 {
    // Use RtlGetVersion (ntdll) — GetVersionEx lies on Win8.1+
    #[repr(C)]
    struct OsVersionInfoExW {
        dw_os_version_info_size: u32,
        dw_major_version: u32,
        dw_minor_version: u32,
        dw_build_number: u32,
        dw_platform_id: u32,
        sz_csd_version: [u16; 128],
        w_service_pack_major: u16,
        w_service_pack_minor: u16,
        w_suite_mask: u16,
        w_product_type: u8,
        w_reserved: u8,
    }

    unsafe {
        let lib =
            windows::Win32::System::LibraryLoader::LoadLibraryW(windows::core::w!("ntdll.dll"));
        if let Ok(h) = lib {
            let proc = windows::Win32::System::LibraryLoader::GetProcAddress(
                h,
                windows::core::s!("RtlGetVersion"),
            );
            if let Some(rtl_get_version) = proc {
                let func: extern "system" fn(*mut OsVersionInfoExW) -> i32 =
                    std::mem::transmute(rtl_get_version);
                let mut info: OsVersionInfoExW = std::mem::zeroed();
                info.dw_os_version_info_size = std::mem::size_of::<OsVersionInfoExW>() as u32;
                func(&mut info);
                return info.dw_build_number;
            }
        }
    }

    0
}

#[cfg(not(target_os = "windows"))]
fn detect_windows_build_number() -> u32 {
    0
}

/// Load config.json from next to the executable.
/// Falls back to defaults if missing or invalid.
fn load_config() -> Config {
    let config_path = executable_sibling_path("config.json");

    if config_path.exists() {
        match std::fs::read_to_string(&config_path) {
            Ok(contents) => {
                let contents = contents.trim_start_matches('\u{FEFF}');
                match serde_json::from_str::<Config>(contents) {
                    Ok(cfg) => {
                        let server = cfg
                            .server
                            .as_deref()
                            .unwrap_or(DEFAULT_SERVER)
                            .trim_end_matches('/')
                            .to_string();
                        eprintln!("[config] server = {}", server);
                        match cfg.force_software_encoder {
                            Some(force_software_encoder) => {
                                eprintln!(
                                    "[config] force_software_encoder = {}",
                                    force_software_encoder
                                );
                            }
                            None => {
                                eprintln!("[config] force_software_encoder = <auto>");
                            }
                        }
                        return Config {
                            server: Some(server),
                            force_software_encoder: cfg.force_software_encoder,
                            #[cfg(target_os = "windows")]
                            jam_source: cfg.jam_source,
                        };
                    }
                    Err(error) => {
                        let message =
                            format!("[config] invalid {}: {}", config_path.display(), error);
                        eprintln!("{}", message);
                        #[cfg(target_os = "windows")]
                        file_debug_log::append(&message);
                    }
                }
            }
            Err(error) => {
                let message = format!(
                    "[config] could not read {}: {}",
                    config_path.display(),
                    error
                );
                eprintln!("{}", message);
                #[cfg(target_os = "windows")]
                file_debug_log::append(&message);
            }
        }
    }

    eprintln!(
        "[config] using default server configuration: {}",
        DEFAULT_SERVER
    );
    Config {
        server: Some(DEFAULT_SERVER.to_string()),
        force_software_encoder: None,
        #[cfg(target_os = "windows")]
        jam_source: None,
    }
}

fn executable_sibling_path(file_name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|directory| directory.join(file_name)))
        .unwrap_or_else(|| PathBuf::from(file_name))
}

/// Clear webview cache when the app version changes (prevents stale content after update)
fn clear_cache_on_upgrade(app: &tauri::App) {
    let version = env!("CARGO_PKG_VERSION");
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&data_dir);
    let version_file = data_dir.join(".last-version");

    let stored = std::fs::read_to_string(&version_file).unwrap_or_default();
    if stored.trim() == version {
        return; // Same version, no cache clear needed
    }

    eprintln!(
        "[cache] Version upgrade detected ({} -> {}) — clearing webview cache",
        stored.trim(),
        version
    );

    // Windows: WebView2 stores cache under EBWebView/Default/
    #[cfg(target_os = "windows")]
    {
        let webview_dir = data_dir.join("EBWebView").join("Default");
        for dir_name in ["Cache", "Code Cache", "GPUCache"] {
            let dir = webview_dir.join(dir_name);
            if dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }

    // macOS: WKWebView stores cache under WebKit/
    #[cfg(target_os = "macos")]
    {
        let webkit_dir = data_dir.join("WebKit");
        if webkit_dir.exists() {
            let _ = std::fs::remove_dir_all(&webkit_dir);
        }
    }

    let _ = std::fs::write(&version_file, version);
}

#[tauri::command]
fn get_app_info(server: tauri::State<'_, String>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        native: true,
        platform: std::env::consts::OS.to_string(),
        server: server.to_string(),
    }
}

#[tauri::command]
fn get_control_url(server: tauri::State<'_, String>) -> String {
    server.to_string()
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn is_jam_source_host(control: tauri::State<'_, jam_source::JamSourceLocalControl>) -> bool {
    control.is_source_host()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn is_jam_source_host() -> bool {
    false
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_jam_source_local_control(
    control: tauri::State<'_, jam_source::JamSourceLocalControl>,
) -> jam_source::JamSourceLocalControlSnapshot {
    control.snapshot()
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_jam_source_takeover_enabled(
    enabled: bool,
    control: tauri::State<'_, jam_source::JamSourceLocalControl>,
) -> Result<jam_source::JamSourceLocalControlSnapshot, String> {
    control.set_takeover_enabled(enabled)
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_jam_source_monitor_enabled(
    enabled: bool,
    control: tauri::State<'_, jam_source::JamSourceLocalControl>,
) -> Result<jam_source::JamSourceLocalControlSnapshot, String> {
    control.set_monitor_enabled(enabled)
}

#[cfg(target_os = "windows")]
async fn shutdown_jam_source_agent(app: &tauri::AppHandle) {
    if let Some(agent) = app.try_state::<jam_source::JamSourceAgent>() {
        agent.begin_shutdown().wait().await;
    }
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<String, String> {
    let current_version = env!("CARGO_PKG_VERSION");
    if is_local_test_build_version(current_version) {
        eprintln!(
            "[updater] manual check skipped for local test build v{}",
            current_version
        );
        return Ok("local_test_build".to_string());
    }

    let updater = app.updater_builder().build().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            eprintln!("[updater] manual check: update available v{}", version);
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(_) => {
                    eprintln!("[updater] manual update installed, restarting...");
                    #[cfg(target_os = "windows")]
                    shutdown_jam_source_agent(&app).await;
                    app.restart();
                    #[allow(unreachable_code)]
                    Ok(format!("Updated to v{}", version))
                }
                Err(e) => Err(format!("Install failed: {}", e)),
            }
        }
        Ok(None) => Ok("up_to_date".to_string()),
        Err(e) => Err(format!("Check failed: {}", e)),
    }
}

#[tauri::command]
fn toggle_fullscreen(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
    window
        .set_fullscreen(!is_fullscreen)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_always_on_top(app: tauri::AppHandle, on_top: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    window.set_always_on_top(on_top).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn list_echo_displays(
    app: tauri::AppHandle,
    preferred_display_id: Option<String>,
) -> Result<Vec<display_placement::EchoDisplayInfo>, String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    display_placement::list_echo_displays(&window, preferred_display_id.as_deref())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_echo_display_status(
    app: tauri::AppHandle,
    preferred_display_id: Option<String>,
) -> Result<display_placement::EchoDisplayStatus, String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    display_placement::build_display_status(&window, preferred_display_id.as_deref())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn move_echo_to_display(
    app: tauri::AppHandle,
    display_id: String,
) -> Result<display_placement::EchoDisplayStatus, String> {
    let window = app.get_webview_window("main").ok_or("window not found")?;
    display_placement::move_window_to_display(&window, &display_id)
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_native_presenter(
    presenter: tauri::State<'_, Arc<NativePresenterManager>>,
    request: NativePresenterStartRequest,
) -> Result<NativePresenterStatus, String> {
    presenter.start_receive_probe(request).await
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn stop_native_presenter(
    presenter: tauri::State<'_, Arc<NativePresenterManager>>,
    reason: Option<String>,
) -> Result<NativePresenterStatus, String> {
    Ok(presenter.stop(reason.as_deref().unwrap_or("stopped by viewer")))
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_native_presenter_status(
    presenter: tauri::State<'_, Arc<NativePresenterManager>>,
) -> Result<NativePresenterStatus, String> {
    Ok(presenter.status())
}

#[tauri::command]
fn list_capturable_windows() -> Vec<audio_capture::WindowInfo> {
    audio_capture::list_capturable_windows()
}

#[tauri::command]
async fn start_audio_capture(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    let generation = AUDIO_CAPTURE_COMMANDS.reserve();
    tokio::task::spawn_blocking(move || {
        let _gate = AUDIO_CAPTURE_COMMANDS.lock();
        if !AUDIO_CAPTURE_COMMANDS.is_current(generation) {
            return Err(audio_capture_command_superseded());
        }

        let result = audio_capture::start_capture(pid, app).map_err(|error| error.to_string());
        if !AUDIO_CAPTURE_COMMANDS.is_current(generation) {
            audio_capture::stop_capture();
            return Err(audio_capture_command_superseded());
        }
        result
    })
    .await
    .map_err(|error| format!("Process audio capture startup task failed: {}", error))?
}

#[cfg(target_os = "windows")]
async fn current_webview2_browser_process_id(app: &tauri::AppHandle) -> Result<u32, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Echo main WebView2 window is not available".to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel();

    window
        .with_webview(move |webview| {
            let result = unsafe {
                (|| {
                    let core_webview = webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| format!("Cannot access Echo CoreWebView2: {}", error))?;
                    let mut browser_pid = 0_u32;
                    core_webview
                        .BrowserProcessId(&mut browser_pid)
                        .map_err(|error| {
                            format!("Cannot read CoreWebView2 BrowserProcessId: {}", error)
                        })?;
                    Ok(browser_pid)
                })()
            };
            let _ = tx.send(result);
        })
        .map_err(|error| format!("Cannot inspect Echo's WebView2 process: {}", error))?;

    tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .map_err(|_| "Timed out reading CoreWebView2 BrowserProcessId".to_string())?
        .map_err(|_| "CoreWebView2 BrowserProcessId lookup was cancelled".to_string())?
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_attested_system_audio_capture_excluding_echo(
    app: tauri::AppHandle,
) -> Result<audio_capture::SystemAudioIsolationAttestation, String> {
    let generation = AUDIO_CAPTURE_COMMANDS.reserve();
    let browser_pid_result = current_webview2_browser_process_id(&app).await;
    if !AUDIO_CAPTURE_COMMANDS.is_current(generation) {
        return Err(audio_capture_command_superseded());
    }
    let browser_pid = browser_pid_result?;
    tokio::task::spawn_blocking(move || {
        let _gate = AUDIO_CAPTURE_COMMANDS.lock();
        if !AUDIO_CAPTURE_COMMANDS.is_current(generation) {
            return Err(audio_capture_command_superseded());
        }

        let result = audio_capture::start_attested_system_capture_excluding_echo(browser_pid, app)
            .map_err(|error| error.to_string());
        if !AUDIO_CAPTURE_COMMANDS.is_current(generation) {
            audio_capture::stop_capture();
            return Err(audio_capture_command_superseded());
        }
        result
    })
    .await
    .map_err(|error| format!("System audio capture startup task failed: {}", error))?
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn start_attested_system_audio_capture_excluding_echo(
    app: tauri::AppHandle,
) -> Result<audio_capture::SystemAudioIsolationAttestation, String> {
    let generation = AUDIO_CAPTURE_COMMANDS.reserve();
    let _gate = AUDIO_CAPTURE_COMMANDS.lock();
    if !AUDIO_CAPTURE_COMMANDS.is_current(generation) {
        return Err(audio_capture_command_superseded());
    }
    audio_capture::start_attested_system_capture_excluding_echo(0, app)
}

#[tauri::command]
async fn stop_audio_capture() -> Result<(), String> {
    let generation = AUDIO_CAPTURE_COMMANDS.reserve();
    tokio::task::spawn_blocking(move || {
        let _gate = AUDIO_CAPTURE_COMMANDS.lock();
        if AUDIO_CAPTURE_COMMANDS.is_current(generation) {
            // A newer start always calls stop_capture() under this same gate
            // before installing its replacement. Therefore a stale stop may
            // safely no-op instead of tearing down that newer owner.
            audio_capture::stop_capture();
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Audio capture stop task failed: {}", error))?
}

#[tauri::command]
fn list_audio_output_devices() -> Vec<audio_output::OutputDevice> {
    audio_output::list_output_devices()
}

// set_audio_output_device removed — changing system-wide default is too dangerous.
// Force-kill/crash loses the saved previous default, leaving user's audio broken.
// Output device switching is a known WebView2 limitation (setSinkId is a silent no-op).

fn settings_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    eprintln!("[settings] saving to {:?} ({} bytes)", path, settings.len());
    std::fs::write(&path, &settings).map_err(|e| {
        eprintln!("[settings] write error: {}", e);
        e.to_string()
    })
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<String, String> {
    let path = settings_path(&app)?;
    eprintln!("[settings] loading from {:?}", path);
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            eprintln!("[settings] loaded {} bytes", s.len());
            Ok(s)
        }
        Err(e) => {
            eprintln!("[settings] file not found ({}), returning empty", e);
            Ok("{}".to_string())
        }
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    // Validate URL scheme to prevent command injection
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http/https URLs allowed".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── OS Detection ──

#[cfg(target_os = "windows")]
#[tauri::command]
fn open_spotify_uri(uri: String, url: String) -> Result<(), String> {
    spotify_link::open_spotify_target(&uri, &url)
}

#[tauri::command]
fn get_os_build_number() -> u32 {
    let build = detect_windows_build_number();
    #[cfg(target_os = "windows")]
    eprintln!("[os] Windows build {}", build);
    build
}

// ── Native Screen Capture IPC Commands ──

#[cfg(target_os = "windows")]
#[tauri::command]
fn list_screen_sources() -> Vec<screen_capture::CaptureSource> {
    screen_capture::list_sources()
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_screen_share(
    source_id: u64,
    sfu_url: String,
    token: String,
    publish_profile: Option<capture_pipeline::PublishProfile>,
    app: tauri::AppHandle,
    health: tauri::State<'_, std::sync::Arc<CaptureHealthState>>,
) -> Result<(), String> {
    let health_arc = std::sync::Arc::clone(&*health);
    screen_capture::start_share(
        source_id,
        sfu_url,
        token,
        publish_profile.unwrap_or_default(),
        app,
        health_arc,
    )
    .await
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn stop_screen_share() {
    screen_capture::stop_share();
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_source_thumbnail(source_id: u64, is_monitor: bool) -> Option<String> {
    screen_capture::get_thumbnail(source_id, is_monitor)
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_capture_window_status(source_id: u64) -> screen_capture::CaptureWindowStatus {
    screen_capture::get_capture_window_status(source_id)
}

// ── Desktop Capture (DXGI Desktop Duplication) IPC Commands ──

#[cfg(target_os = "windows")]
#[tauri::command]
fn check_desktop_capture_available() -> Result<(bool, String), String> {
    Ok(desktop_capture::check_available())
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_desktop_capture(
    hwnd: u64,
    fullscreen: bool,
    sfu_url: String,
    token: String,
    publish_profile: Option<capture_pipeline::PublishProfile>,
    app: tauri::AppHandle,
    health: tauri::State<'_, std::sync::Arc<CaptureHealthState>>,
) -> Result<(), String> {
    let health_arc = std::sync::Arc::clone(&*health);
    desktop_capture::start(
        hwnd,
        fullscreen,
        sfu_url,
        token,
        publish_profile.unwrap_or_default(),
        app,
        health_arc,
    )
    .await
}

/// Start WGC monitor capture (entire screen). Includes the cursor automatically
/// via Microsoft's Windows Graphics Capture API. Replaces the DXGI Desktop
/// Duplication path which doesn't include the cursor in the captured frames.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_screen_share_monitor(
    hmonitor: u64,
    sfu_url: String,
    token: String,
    app: tauri::AppHandle,
    health: tauri::State<'_, std::sync::Arc<CaptureHealthState>>,
) -> Result<(), String> {
    let health_arc = std::sync::Arc::clone(&*health);
    screen_capture::start_share_monitor(hmonitor, sfu_url, token, app, health_arc).await
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn stop_desktop_capture() {
    desktop_capture::stop();
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_capture_health(
    state: tauri::State<Arc<CaptureHealthState>>,
) -> Option<CaptureHealthSnapshot> {
    let snap = state.snapshot();
    if !snap.capture_active {
        None
    } else {
        Some(snap)
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn report_encoder_implementation(state: tauri::State<Arc<CaptureHealthState>>, encoder: String) {
    state.set_encoder_type_from_string(&encoder);
}

fn main() {
    #[cfg(target_os = "windows")]
    {
        file_debug_log::reset();
        let report = gpu_preference::ensure_startup_gpu_preferences();
        let summary = report.summary();
        eprintln!("[gpu-preference] startup {}", summary);
        file_debug_log::append(&format!("[gpu-preference] startup {}", summary));
        for path in &report.applied {
            eprintln!(
                "[gpu-preference] high-performance GPU preference set for {}",
                path.display()
            );
            file_debug_log::append(&format!(
                "[gpu-preference] high-performance GPU preference set for {}",
                path.display()
            ));
        }
        for (path, error) in &report.failed {
            eprintln!(
                "[gpu-preference] failed to set high-performance GPU preference for {}: {}",
                path.display(),
                error
            );
            file_debug_log::append(&format!(
                "[gpu-preference] failed to set high-performance GPU preference for {}: {}",
                path.display(),
                error
            ));
        }
    }

    // Windows: WebView2 browser arguments for GPU encoding + self-signed TLS
    #[cfg(target_os = "windows")]
    unsafe {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            gpu_preference::webview2_additional_browser_arguments(),
        );
    }

    let config = load_config();
    #[cfg(target_os = "windows")]
    let jam_source_config = config.jam_source.clone();
    let server = config
        .server
        .clone()
        .unwrap_or_else(|| DEFAULT_SERVER.to_string());
    #[cfg(target_os = "windows")]
    let windows_build = detect_windows_build_number();
    #[cfg(not(target_os = "windows"))]
    let windows_build = 0u32;
    let auto_force_software_encoder =
        config.force_software_encoder.is_none() && windows_build > 0 && windows_build < 22000;
    let force_software_encoder = config
        .force_software_encoder
        .unwrap_or(auto_force_software_encoder);

    #[cfg(target_os = "windows")]
    if auto_force_software_encoder {
        eprintln!(
            "[config] Windows build {} detected — forcing software H264 on Win10 native capture",
            windows_build
        );
    }

    #[cfg(target_os = "windows")]
    {
        file_debug_log::append(&format!(
            "[startup] echo-core-client boot version={} server={} force_software_encoder={} auto_force_software_encoder={} windows_build={}",
            env!("CARGO_PKG_VERSION"), server, force_software_encoder, auto_force_software_encoder, windows_build
        ));
    }

    #[cfg(target_os = "windows")]
    unsafe {
        if force_software_encoder {
            std::env::set_var("ECHO_FORCE_SOFTWARE_ENCODER", "1");
            eprintln!("[init] ECHO_FORCE_SOFTWARE_ENCODER=1");
        }
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(server);

    // capture_health module is Windows-only (DXGI + WGC capture paths).
    // Gate the state management so macOS builds compile.
    #[cfg(target_os = "windows")]
    let builder = builder.manage(Arc::new(CaptureHealthState::new()));
    #[cfg(target_os = "windows")]
    let builder = builder.manage(NativePresenterManager::new());

    builder
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_control_url,
            is_jam_source_host,
            #[cfg(target_os = "windows")]
            get_jam_source_local_control,
            #[cfg(target_os = "windows")]
            set_jam_source_takeover_enabled,
            #[cfg(target_os = "windows")]
            set_jam_source_monitor_enabled,
            toggle_fullscreen,
            set_always_on_top,
            open_external_url,
            #[cfg(target_os = "windows")]
            open_spotify_uri,
            save_settings,
            load_settings,
            list_capturable_windows,
            start_audio_capture,
            start_attested_system_audio_capture_excluding_echo,
            stop_audio_capture,
            list_audio_output_devices,
            check_for_updates,
            get_os_build_number,
            #[cfg(target_os = "windows")]
            list_screen_sources,
            #[cfg(target_os = "windows")]
            start_screen_share,
            #[cfg(target_os = "windows")]
            stop_screen_share,
            #[cfg(target_os = "windows")]
            get_source_thumbnail,
            #[cfg(target_os = "windows")]
            get_capture_window_status,
            #[cfg(target_os = "windows")]
            check_desktop_capture_available,
            #[cfg(target_os = "windows")]
            start_desktop_capture,
            #[cfg(target_os = "windows")]
            stop_desktop_capture,
            #[cfg(target_os = "windows")]
            start_screen_share_monitor,
            #[cfg(target_os = "windows")]
            get_capture_health,
            #[cfg(target_os = "windows")]
            report_encoder_implementation,
            #[cfg(target_os = "windows")]
            list_echo_displays,
            #[cfg(target_os = "windows")]
            get_echo_display_status,
            #[cfg(target_os = "windows")]
            move_echo_to_display,
            #[cfg(target_os = "windows")]
            start_native_presenter,
            #[cfg(target_os = "windows")]
            stop_native_presenter,
            #[cfg(target_os = "windows")]
            get_native_presenter_status,
        ])
        .setup(move |app| {
            // Pre-initialize LiveKit runtime so NVENC hardware encoder is detected
            // BEFORE any game launches. The factory persists via LK_RUNTIME_KEEP_ALIVE.
            // Without this, the $screen Room creates the factory while gaming,
            // CUDA check fails, and WebRTC falls back to OpenH264 (CPU, 9fps).
            #[cfg(target_os = "windows")]
            {
                std::thread::spawn(|| {
                    let force_software =
                        std::env::var("ECHO_FORCE_SOFTWARE_ENCODER").ok().as_deref() == Some("1");
                    if force_software {
                        eprintln!(
                            "[init] force_software_encoder active — skipping CUDA probe and preferring OpenH264"
                        );
                    }
                    // Direct CUDA probe to diagnose NVENC availability
                    unsafe {
                        if !force_software {
                            let lib = windows::Win32::System::LibraryLoader::LoadLibraryW(
                                windows::core::w!("nvcuda.dll"),
                            );
                            match lib {
                                Ok(h) => {
                                    // nvcuda.dll loaded — NVIDIA driver is present.
                                    // Set the global flag so capture_pipeline uses the
                                    // hardware (240fps) frame interval instead of the
                                    // software (20fps) cap. Also used by capture_health
                                    // to default EncoderType correctly for the chip.
                                    crate::capture_pipeline::HAS_NVCUDA.store(true, std::sync::atomic::Ordering::Relaxed);
                                    let cu_init = windows::Win32::System::LibraryLoader::GetProcAddress(
                                        h, windows::core::s!("cuInit"),
                                    );
                                    if let Some(init_fn) = cu_init {
                                        let init: extern "system" fn(u32) -> i32 = std::mem::transmute(init_fn);
                                        let result = init(0);
                                        eprintln!("[init] CUDA cuInit(0) = {} (0=success)", result);
                                    } else {
                                        eprintln!("[init] CUDA cuInit not found in nvcuda.dll");
                                    }
                                }
                                Err(e) => {
                                    eprintln!("[init] nvcuda.dll load failed: {e} — software OpenH264 fallback, capture capped at 20fps");
                                }
                            }
                        }
                    }
                    livekit::ensure_runtime_initialized();
                    eprintln!("[init] LiveKit runtime pre-initialized (NVENC detection)");
                });
            }

            // Clear WebView2 cache on version upgrade so stale cached content doesn't persist
            clear_cache_on_upgrade(app);

            // The configured Jam source is an app-lifetime native agent. It is
            // deliberately independent of viewer login/panels and owns a
            // separate WASAPI handle from screen-share audio.
            #[cfg(target_os = "windows")]
            {
                let source_data_dir = match app.path().app_data_dir() {
                    Ok(directory) => directory,
                    Err(app_data_error) => {
                        let fallback = std::env::var_os("LOCALAPPDATA")
                            .filter(|path| !path.is_empty())
                            .map(PathBuf::from)
                            .map(|directory| directory.join("Echo Chamber"));
                        match fallback {
                            Some(directory) => {
                                eprintln!(
                                    "[jam-source] app data directory unavailable ({}); using durable fallback '{}'",
                                    app_data_error,
                                    directory.display()
                                );
                                directory
                            }
                            None if jam_source_config.is_some() => {
                                let error = format!(
                                    "Configured Jam source cannot resolve a durable settings/journal directory: {}",
                                    app_data_error
                                );
                                eprintln!("[jam-source] {}", error);
                                file_debug_log::append(&format!("[jam-source] {}", error));
                                return Err(std::io::Error::other(error).into());
                            }
                            None => PathBuf::new(),
                        }
                    }
                };
                let source_settings_path = source_data_dir.join("jam-source-local.json");
                let source_control = jam_source::JamSourceLocalControl::load(
                    jam_source_config.as_ref(),
                    source_settings_path,
                );
                app.manage(source_control.clone());

                if let Some(source_config) = jam_source_config.clone() {
                    let source_server = app.state::<String>().inner().clone();
                    match jam_source::JamSourceAgent::start(
                        source_server,
                        source_config,
                        source_control,
                    ) {
                        Ok(agent) => {
                            app.manage(agent);
                            eprintln!("[jam-source] native source agent started");
                            file_debug_log::append("[jam-source] native source agent started");
                        }
                        Err(error) => {
                            eprintln!("[jam-source] source agent disabled: {}", error);
                            file_debug_log::append(&format!(
                                "[jam-source] source agent disabled: {}",
                                error
                            ));
                        }
                    }
                }
            }

            // Load viewer from the server so JS/CSS updates are live without reinstalling
            let viewer_url = format!("{}/viewer/", app.state::<String>().inner());
            let main_window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(viewer_url.parse().unwrap()),
            )
            .title("Echo Chamber")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .initialization_script("window.__ECHO_NATIVE__ = true;")
            .build()?;

            #[cfg(target_os = "windows")]
            {
                let app_handle = app.handle().clone();
                match display_placement::move_window_to_saved_preferred_display(
                    &app_handle,
                    &main_window,
                ) {
                    Ok(Some(status)) => {
                        eprintln!(
                            "[display] moved Echo to preferred display {:?} current={:?} spans={}",
                            status.preferred_display_id,
                            status.current_display_name,
                            status.window_spans_displays
                        );
                    }
                    Ok(None) => {
                        eprintln!("[display] no preferred Echo display saved");
                    }
                    Err(e) => {
                        eprintln!("[display] preferred display move failed: {}", e);
                    }
                }
            }

            // Check for updates in the background
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Small delay so the window is visible before any update dialog
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let current_version = env!("CARGO_PKG_VERSION");
                if is_local_test_build_version(current_version) {
                    eprintln!(
                        "[updater] background check disabled for local test build v{}",
                        current_version
                    );
                    return;
                }
                let updater = match handle.updater_builder().build() {
                    Ok(u) => u,
                    Err(e) => {
                        eprintln!("[updater] build failed: {}", e);
                        return;
                    }
                };
                match updater.check().await {
                    Ok(Some(update)) => {
                        eprintln!(
                            "[updater] update available: v{} -> v{}",
                            env!("CARGO_PKG_VERSION"),
                            update.version
                        );
                        match update
                            .download_and_install(
                                |ev, _| {
                                    eprintln!("[updater] download progress: {:?}", ev);
                                },
                                || {
                                    eprintln!("[updater] ready to install, app will restart...");
                                },
                            )
                            .await
                        {
                            Ok(_) => {
                                eprintln!("[updater] install complete, restarting...");
                                #[cfg(target_os = "windows")]
                                shutdown_jam_source_agent(&handle).await;
                                handle.restart();
                            }
                            Err(e) => eprintln!("[updater] install failed: {}", e),
                        }
                    }
                    Ok(None) => eprintln!("[updater] up to date (v{})", env!("CARGO_PKG_VERSION")),
                    Err(e) => eprintln!("[updater] check failed: {}", e),
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Error while building Echo Chamber")
        .run(|app, event| {
            #[cfg(target_os = "windows")]
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if let Some(agent) = app.try_state::<jam_source::JamSourceAgent>() {
                    if !agent.shutdown_complete() {
                        api.prevent_exit();
                        let shutdown = agent.begin_shutdown();
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            shutdown.wait().await;
                            handle.exit(code.unwrap_or(0));
                        });
                    }
                }
            }
        });
}
