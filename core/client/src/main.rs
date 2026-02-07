// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const CONTROL_URL: &str = "https://127.0.0.1:9443";
const VIEWER_URL: &str = "https://127.0.0.1:9443/viewer";

#[derive(Serialize)]
struct AppInfo {
    version: String,
    native: bool,
    platform: String,
}

#[tauri::command]
fn get_app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        native: true,
        platform: std::env::consts::OS.to_string(),
    }
}

#[tauri::command]
fn get_control_url() -> String {
    CONTROL_URL.to_string()
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
    // Allow WebView2 to accept our self-signed TLS cert on localhost
    unsafe {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--ignore-certificate-errors",
        );
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_control_url,
            toggle_fullscreen,
            set_always_on_top,
        ])
        .setup(|app| {
            let url = WebviewUrl::External(VIEWER_URL.parse().unwrap());
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
