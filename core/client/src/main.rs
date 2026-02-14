// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod audio_capture;
#[cfg(not(target_os = "windows"))]
mod audio_capture_stub;
#[cfg(not(target_os = "windows"))]
use audio_capture_stub as audio_capture;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

const DEFAULT_SERVER: &str = "https://echo.fellowshipoftheboatrace.party:9443";

#[derive(Deserialize)]
struct Config {
    server: Option<String>,
}

#[derive(Serialize)]
struct AppInfo {
    version: String,
    native: bool,
    platform: String,
    server: String,
}

/// Load config.json from next to the executable.
/// Falls back to defaults if missing or invalid.
fn load_config() -> String {
    let config_path = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("config.json")))
        .unwrap_or_else(|| PathBuf::from("config.json"));

    if config_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(&config_path) {
            let contents = contents.trim_start_matches('\u{FEFF}');
            if let Ok(cfg) = serde_json::from_str::<Config>(contents) {
                if let Some(server) = cfg.server {
                    let server = server.trim_end_matches('/').to_string();
                    eprintln!("[config] server = {}", server);
                    return server;
                }
            }
        }
    }

    eprintln!(
        "[config] no config.json found, using default: {}",
        DEFAULT_SERVER
    );
    DEFAULT_SERVER.to_string()
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

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<String, String> {
    let updater = app.updater_builder().build().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            eprintln!("[updater] manual check: update available v{}", version);
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(_) => {
                    eprintln!("[updater] manual update installed, restarting...");
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

#[tauri::command]
fn list_capturable_windows() -> Vec<audio_capture::WindowInfo> {
    audio_capture::list_capturable_windows()
}

#[tauri::command]
fn start_audio_capture(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    audio_capture::start_capture(pid, app).map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_audio_capture() -> Result<(), String> {
    audio_capture::stop_capture();
    Ok(())
}

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

fn main() {
    // Windows: WebView2 browser arguments for GPU encoding + self-signed TLS
    #[cfg(target_os = "windows")]
    unsafe {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--ignore-certificate-errors --enable-features=AcceleratedVideoEncoder,MediaFoundationVideoEncoding --ignore-gpu-blocklist --webrtc-max-cpu-consumption-percentage=100 --force-fieldtrials=WebRTC-Bwe-AllocationProbing/Enabled/",
        );
    }

    let server = load_config();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(server)
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_control_url,
            toggle_fullscreen,
            set_always_on_top,
            open_external_url,
            save_settings,
            load_settings,
            list_capturable_windows,
            start_audio_capture,
            stop_audio_capture,
            check_for_updates,
        ])
        .setup(move |app| {
            // Clear WebView2 cache on version upgrade so stale cached content doesn't persist
            clear_cache_on_upgrade(app);

            // Load viewer from the server so JS/CSS updates are live without reinstalling
            let viewer_url = format!("{}/viewer", app.state::<String>().inner());
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(viewer_url.parse().unwrap()),
            )
            .title("Echo Chamber")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .initialization_script("window.__ECHO_NATIVE__ = true;")
            .build()?;

            // Check for updates in the background
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Small delay so the window is visible before any update dialog
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
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
        .run(tauri::generate_context!())
        .expect("Error while running Echo Chamber");
}
