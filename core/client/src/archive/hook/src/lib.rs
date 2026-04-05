#![allow(non_snake_case)]

pub mod control_block;
mod format_convert;
mod present_hook;
mod shared_texture;

use std::ffi::c_void;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use windows::Win32::Foundation::{BOOL, HINSTANCE, TRUE};
use windows::Win32::System::LibraryLoader::DisableThreadLibraryCalls;
use windows::Win32::System::Threading::GetCurrentProcessId;

static mut DLL_MODULE: HINSTANCE = HINSTANCE(std::ptr::null_mut());

/// Log file for hook diagnostics (game process has no stderr console).
static LOG: std::sync::OnceLock<Mutex<std::fs::File>> = std::sync::OnceLock::new();

/// Write a log line to the hook log file.
pub fn hook_log(msg: &str) {
    if let Some(lock) = LOG.get() {
        if let Ok(mut f) = lock.lock() {
            let _ = writeln!(f, "{msg}");
            let _ = f.flush();
        }
    }
    // Also try eprintln in case someone is watching
    eprintln!("{msg}");
}

/// Initialize the log file.
fn init_log() {
    let pid = unsafe { GetCurrentProcessId() };
    // Write to a known location Sam can check
    let log_path = format!("F:\\Codex AI\\The Echo Chamber\\core\\logs\\echo-hook-{pid}.log");
    if let Ok(file) = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
    {
        let _ = LOG.set(Mutex::new(file));
        hook_log(&format!("[echo-hook] log started for PID {pid}"));
    }
}

/// DllMain -- entry point when loaded into game process.
#[no_mangle]
pub unsafe extern "system" fn DllMain(
    hmodule: HINSTANCE,
    reason: u32,
    _reserved: *mut c_void,
) -> BOOL {
    const DLL_PROCESS_ATTACH: u32 = 1;
    const DLL_PROCESS_DETACH: u32 = 0;

    match reason {
        DLL_PROCESS_ATTACH => {
            DLL_MODULE = hmodule;
            let _ = DisableThreadLibraryCalls(hmodule);
            // Spawn init on a new thread to avoid loader lock deadlock
            std::thread::spawn(|| {
                init_log();
                hook_log("[echo-hook] DllMain ATTACH — initializing hooks...");
                match present_hook::initialize() {
                    Ok(()) => hook_log("[echo-hook] hooks installed successfully"),
                    Err(e) => hook_log(&format!("[echo-hook] init FAILED: {e}")),
                }
            });
        }
        DLL_PROCESS_DETACH => {
            hook_log("[echo-hook] DllMain DETACH — shutting down");
            present_hook::shutdown();
        }
        _ => {}
    }
    TRUE
}

/// CBT hook proc -- kept for compatibility but no longer the primary injection method.
#[no_mangle]
pub unsafe extern "system" fn CBTProc(
    code: i32,
    wparam: usize,
    lparam: isize,
) -> isize {
    windows::Win32::UI::WindowsAndMessaging::CallNextHookEx(
        None,
        code,
        windows::Win32::Foundation::WPARAM(wparam),
        windows::Win32::Foundation::LPARAM(lparam),
    )
    .0
}
