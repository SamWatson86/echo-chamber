// Stub audio capture module for non-Windows platforms.
// WASAPI per-process audio capture is Windows-only.
// On macOS, users should share their screen with "Share system audio" enabled.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct WindowInfo {
    pub title: String,
    pub pid: u32,
    pub exe_name: String,
}

pub fn list_capturable_windows() -> Vec<WindowInfo> {
    Vec::new()
}

pub fn start_capture(_pid: u32, _app: tauri::AppHandle) -> Result<(), String> {
    Err("Per-process audio capture is not supported on this platform. Share your screen with system audio enabled instead.".to_string())
}

pub fn stop_capture() {}
