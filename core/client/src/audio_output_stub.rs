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
    Ok(())
}

pub fn restore_default_output() {}
