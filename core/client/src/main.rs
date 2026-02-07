// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_SERVER: &str = "https://127.0.0.1:9443";

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
    // Allow WebView2 to accept our self-signed TLS cert
    unsafe {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--ignore-certificate-errors",
        );
    }

    let server = load_config();
    let viewer_url = format!("{}/viewer", server);

    tauri::Builder::default()
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Error while running Echo Chamber");
}
