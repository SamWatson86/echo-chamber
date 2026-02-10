// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_updater::UpdaterExt;

const DEFAULT_SERVER: &str = "https://99.111.153.69:9443";

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
            if let Ok(cfg) = serde_json::from_str::<Config>(&contents) {
                if let Some(server) = cfg.server {
                    let server = server.trim_end_matches('/').to_string();
                    eprintln!("[config] server = {}", server);
                    return server;
                }
            }
        }
    }

    eprintln!("[config] no config.json found, using default: {}", DEFAULT_SERVER);
    DEFAULT_SERVER.to_string()
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
    window
        .set_always_on_top(on_top)
        .map_err(|e| e.to_string())
}

fn main() {
    // WebView2 browser arguments:
    // --ignore-certificate-errors: Accept self-signed TLS cert
    // --enable-features=AcceleratedVideoEncoder: Enable GPU hardware video encoding (NVENC on NVIDIA)
    // --ignore-gpu-blocklist: Force GPU acceleration even if driver is blocklisted
    // --webrtc-max-cpu-consumption-percentage=100: Allow WebRTC full CPU for encoding
    // --force-fieldtrials: Tune WebRTC BWE for faster ramp-up
    unsafe {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--ignore-certificate-errors --enable-features=AcceleratedVideoEncoder,MediaFoundationVideoEncoding --ignore-gpu-blocklist --webrtc-max-cpu-consumption-percentage=100 --force-fieldtrials=WebRTC-Bwe-AllocationProbing/Enabled/",
        );
    }

    let server = load_config();
    let viewer_url = format!("{}/viewer", server);

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(server)
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_control_url,
            toggle_fullscreen,
            set_always_on_top,
        ])
        .setup(move |app| {
            let url = WebviewUrl::External(viewer_url.parse().unwrap());
            WebviewWindowBuilder::new(app, "main", url)
                .title("Echo Chamber")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 600.0)
                .build()?;

            // Check for updates in the background
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let updater = handle.updater_builder().build().unwrap();
                match updater.check().await {
                    Ok(Some(update)) => {
                        eprintln!("[updater] update available: v{}", update.version);
                        if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                            eprintln!("[updater] install failed: {}", e);
                        }
                    }
                    Ok(None) => eprintln!("[updater] up to date"),
                    Err(e) => eprintln!("[updater] check failed (ok if offline): {}", e),
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Error while running Echo Chamber");
}
