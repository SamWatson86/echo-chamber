//! Bounded, on-demand Spotify Connect recovery for the provisioned Jam source.
//!
//! This module is Windows-only. It activates the registered Microsoft Store
//! Spotify application identity and, only when explicitly requested after the
//! server's registration poll fails, restarts Spotify processes in Echo's own
//! interactive session. It never runs as a background watchdog.

use crate::audio_capture::find_spotify_process_ids;
use crate::jam_source::store_spotify_process_identity;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows::core::{HSTRING, PWSTR};
use windows::Management::Deployment::PackageManager;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, LPARAM, WAIT_OBJECT_0, WPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::Shell::{
    ApplicationActivationManager, IApplicationActivationManager, AO_NOERRORUI,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
};

const SPOTIFY_STORE_PACKAGE_NAME: &str = "SpotifyAB.SpotifyMusic";
const SPOTIFY_STORE_PACKAGE_FAMILY: &str = "SpotifyAB.SpotifyMusic_zpdnekdrzrea0";
const SPOTIFY_STORE_APP_SUFFIX: &str = "!Spotify";
const SPOTIFY_STORE_AUMID: &str = "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify";
const GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const FORCED_EXIT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SpotifyConnectRepairAction {
    Activate,
    Restart,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SpotifyConnectRepairOutcome {
    Activated,
    Restarted,
    NotRunning,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SpotifyConnectRepairReport {
    pub outcome: SpotifyConnectRepairOutcome,
    pub was_running_before: bool,
}

pub(crate) fn repair_spotify_connect(
    action: SpotifyConnectRepairAction,
    cancelled: &AtomicBool,
) -> Result<SpotifyConnectRepairReport, String> {
    ensure_not_cancelled(cancelled)?;
    repair_spotify_connect_with(
        action,
        find_exact_store_spotify_process_ids,
        || activate_spotify_store_app(cancelled),
        |pids| restart_spotify_processes(pids, cancelled),
    )
}

fn repair_spotify_connect_with(
    action: SpotifyConnectRepairAction,
    list_processes: impl Fn() -> Result<Vec<u32>, String>,
    activate: impl Fn() -> Result<(), String>,
    restart_processes: impl Fn(&[u32]) -> Result<(), String>,
) -> Result<SpotifyConnectRepairReport, String> {
    match action {
        SpotifyConnectRepairAction::Activate => {
            let was_running = !list_processes()?.is_empty();
            if !was_running {
                return Ok(SpotifyConnectRepairReport {
                    outcome: SpotifyConnectRepairOutcome::NotRunning,
                    was_running_before: false,
                });
            }
            activate().map_err(|error| {
                format!(
                    "Spotify app activation failed; Spotify may not be installed or its Windows app registration may be damaged: {error}"
                )
            })?;
            Ok(SpotifyConnectRepairReport {
                outcome: SpotifyConnectRepairOutcome::Activated,
                was_running_before: was_running,
            })
        }
        SpotifyConnectRepairAction::Restart => {
            let pids = list_processes()?;
            if pids.is_empty() {
                return Ok(SpotifyConnectRepairReport {
                    outcome: SpotifyConnectRepairOutcome::NotRunning,
                    was_running_before: false,
                });
            }
            restart_processes(&pids)?;
            Ok(SpotifyConnectRepairReport {
                outcome: SpotifyConnectRepairOutcome::Restarted,
                was_running_before: true,
            })
        }
    }
}

fn find_exact_store_spotify_process_ids() -> Result<Vec<u32>, String> {
    let echo_session = process_session_id(std::process::id())?;
    let mut exact = Vec::new();
    for pid in find_spotify_process_ids()? {
        let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
        else {
            continue;
        };
        let process = OwnedProcess(handle);
        if validate_spotify_process_for_restart(pid, &process, echo_session).is_ok() {
            exact.push(pid);
        }
    }
    exact.sort_unstable();
    exact.dedup();
    Ok(exact)
}

struct OwnedProcess(HANDLE);

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn restart_spotify_processes(pids: &[u32], cancelled: &AtomicBool) -> Result<(), String> {
    ensure_not_cancelled(cancelled)?;
    let echo_session = process_session_id(std::process::id())?;
    let mut processes = Vec::with_capacity(pids.len());
    for &pid in pids {
        let handle = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid,
            )
        }
        .map_err(|error| format!("Could not open Spotify PID {pid} for restart: {error}"))?;
        let process = OwnedProcess(handle);
        validate_spotify_process_for_restart(pid, &process, echo_session)?;
        processes.push((pid, process));
    }

    ensure_not_cancelled(cancelled)?;
    ensure_spotify_not_playing()?;
    // This is the final cancellation boundary. Once the first WM_CLOSE may be
    // posted, the operation is restorative: it must finish relaunching Spotify
    // even if the server deadline, consent, or WebSocket changes mid-restart.
    ensure_not_cancelled(cancelled)?;
    let stop_result = (|| -> Result<(), String> {
        request_graceful_spotify_close(pids)?;
        if wait_for_processes(&processes, GRACEFUL_EXIT_TIMEOUT) {
            return Ok(());
        }

        for (pid, process) in &processes {
            if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0 {
                continue;
            }
            // Revalidate the still-open process object immediately before the
            // destructive fallback. Held handles fence PID reuse.
            validate_spotify_process_for_restart(*pid, process, echo_session)?;
            unsafe { TerminateProcess(process.0, 0) }
                .map_err(|error| format!("Could not stop Spotify PID {pid}: {error}"))?;
        }
        if wait_for_processes(&processes, FORCED_EXIT_TIMEOUT) {
            Ok(())
        } else {
            Err(format!(
                "Spotify did not stop within {} seconds",
                (GRACEFUL_EXIT_TIMEOUT + FORCED_EXIT_TIMEOUT).as_secs()
            ))
        }
    })();
    finish_restorative_restart(stop_result, activate_spotify_store_app_restorative)
}

fn ensure_spotify_not_playing() -> Result<(), String> {
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Could not verify Spotify playback state: {error}"))?;
    let sessions = manager
        .GetSessions()
        .map_err(|error| format!("Could not enumerate Windows media sessions: {error}"))?;
    let count = sessions
        .Size()
        .map_err(|error| format!("Could not count Windows media sessions: {error}"))?;
    for index in 0..count {
        let session = sessions
            .GetAt(index)
            .map_err(|error| format!("Could not inspect a Windows media session: {error}"))?;
        let source = session
            .SourceAppUserModelId()
            .map_err(|error| format!("Could not identify a Windows media session: {error}"))?
            .to_string();
        if !source.eq_ignore_ascii_case(SPOTIFY_STORE_AUMID) {
            continue;
        }
        let status = session
            .GetPlaybackInfo()
            .and_then(|info| info.PlaybackStatus())
            .map_err(|error| format!("Could not verify Spotify playback status: {error}"))?;
        if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing {
            return Err(
                "Spotify is currently playing; Echo did not interrupt it for Connect repair"
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn wait_for_processes(processes: &[(u32, OwnedProcess)], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if processes
            .iter()
            .all(|(_, process)| unsafe { WaitForSingleObject(process.0, 0) } == WAIT_OBJECT_0)
        {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

struct CloseWindowContext<'a> {
    pids: &'a [u32],
}

unsafe extern "system" fn close_spotify_window(
    hwnd: windows::Win32::Foundation::HWND,
    lparam: LPARAM,
) -> BOOL {
    let context = &*(lparam.0 as *const CloseWindowContext<'_>);
    let mut pid = 0_u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if context.pids.contains(&pid) {
        let _ = PostMessageW(hwnd, WM_CLOSE, WPARAM(0), LPARAM(0));
    }
    BOOL(1)
}

fn request_graceful_spotify_close(pids: &[u32]) -> Result<(), String> {
    let context = CloseWindowContext { pids };
    unsafe {
        EnumWindows(
            Some(close_spotify_window),
            LPARAM((&context as *const CloseWindowContext<'_>) as isize),
        )
    }
    .map_err(|error| format!("Could not request a graceful Spotify restart: {error}"))
}

fn finish_restorative_restart(
    stop_result: Result<(), String>,
    activate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let activation_result = activate();
    match (stop_result, activation_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(stop_error), Ok(())) => Err(format!(
            "Spotify restart did not stop cleanly, but restorative activation completed: {stop_error}"
        )),
        (Ok(()), Err(activation_error)) => Err(format!(
            "Spotify stopped, but restorative activation failed: {activation_error}"
        )),
        (Err(stop_error), Err(activation_error)) => Err(format!(
            "Spotify restart failed and restorative activation also failed: {stop_error}; {activation_error}"
        )),
    }
}

fn validate_spotify_process_for_restart(
    pid: u32,
    process: &OwnedProcess,
    echo_session: u32,
) -> Result<(), String> {
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
    }
    .map_err(|error| format!("Could not verify Spotify PID {pid} executable: {error}"))?;
    let path = String::from_utf16_lossy(&buffer[..length as usize]);
    let executable = path.rsplit(['\\', '/']).next().unwrap_or_default();
    if !executable.eq_ignore_ascii_case("Spotify.exe") {
        return Err(format!(
            "Spotify restart was cancelled because PID {pid} now belongs to a different process"
        ));
    }
    let session = process_session_id(pid)?;
    if session != echo_session {
        return Err(format!(
            "Spotify restart was cancelled because PID {pid} is outside Echo's Windows session"
        ));
    }
    store_spotify_process_identity(pid, process.0)?;
    Ok(())
}

fn process_session_id(pid: u32) -> Result<u32, String> {
    let mut session = 0_u32;
    unsafe { ProcessIdToSessionId(pid, &mut session) }
        .map_err(|error| format!("Could not determine Windows session for PID {pid}: {error}"))?;
    Ok(session)
}

fn activate_spotify_store_app(cancelled: &AtomicBool) -> Result<(), String> {
    ensure_not_cancelled(cancelled)?;
    let result = activate_spotify_store_app_restorative();
    ensure_not_cancelled(cancelled)?;
    result
}

fn activate_spotify_store_app_restorative() -> Result<(), String> {
    // Tokio workers may already be initialized with another COM apartment. A
    // changed-mode result is harmless because CoCreateInstance can use that
    // existing apartment; other initialization failures are surfaced below.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let application_user_model_id = installed_spotify_application_user_model_id()?;
    let manager: IApplicationActivationManager =
        unsafe { CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER) }
            .map_err(|error| format!("could not create the Windows activation manager: {error}"))?;
    let pid = unsafe {
        manager.ActivateApplication(
            &HSTRING::from(&application_user_model_id),
            &HSTRING::new(),
            AO_NOERRORUI,
        )
    }
    .map_err(|error| format!("Windows rejected Spotify app identity activation: {error}"))?;
    validate_activated_spotify_process(pid, &application_user_model_id)
}

fn installed_spotify_application_user_model_id() -> Result<String, String> {
    let manager = PackageManager::new()
        .map_err(|error| format!("could not open the Windows package manager: {error}"))?;
    let packages = manager
        .FindPackagesByUserSecurityId(&HSTRING::new())
        .map_err(|error| format!("could not enumerate installed Windows apps: {error}"))?;
    let mut matches = Vec::new();
    for package in packages {
        let id = package
            .Id()
            .map_err(|error| format!("could not inspect a Windows app identity: {error}"))?;
        let name = id
            .Name()
            .map_err(|error| format!("could not read a Windows app name: {error}"))?
            .to_string();
        if !name.eq_ignore_ascii_case(SPOTIFY_STORE_PACKAGE_NAME) {
            continue;
        }
        let family = id
            .FamilyName()
            .map_err(|error| format!("could not read Spotify's package family: {error}"))?
            .to_string();
        if family.eq_ignore_ascii_case(SPOTIFY_STORE_PACKAGE_FAMILY) {
            matches.push(format!("{family}{SPOTIFY_STORE_APP_SUFFIX}"));
        }
    }
    matches.sort_unstable();
    matches.dedup();
    match matches.as_slice() {
        [application_user_model_id] => Ok(application_user_model_id.clone()),
        [] => Err("the Microsoft Store Spotify app is not installed for this Windows user".to_string()),
        _ => Err("more than one Microsoft Store Spotify app identity is registered for this Windows user".to_string()),
    }
}

fn validate_activated_spotify_process(
    pid: u32,
    expected_application_user_model_id: &str,
) -> Result<(), String> {
    if pid == 0 {
        return Err("Windows activated Spotify without returning a process ID".to_string());
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map(OwnedProcess)
        .map_err(|error| format!("Could not inspect activated Spotify PID {pid}: {error}"))?;
    validate_spotify_process_for_restart(pid, &handle, process_session_id(std::process::id())?)?;
    let identity = store_spotify_process_identity(pid, handle.0)?;
    if !identity
        .application_user_model_id
        .eq_ignore_ascii_case(expected_application_user_model_id)
    {
        return Err("Windows activated an unexpected Spotify application identity".to_string());
    }
    Ok(())
}

fn ensure_not_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err("Spotify Connect repair was cancelled because the Jam source state changed".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn activation_does_not_restart_an_already_running_spotify() {
        let terminated = Cell::new(false);
        let activated = Cell::new(false);
        let report = repair_spotify_connect_with(
            SpotifyConnectRepairAction::Activate,
            || Ok(vec![101]),
            || {
                activated.set(true);
                Ok(())
            },
            |_| {
                terminated.set(true);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(report.outcome, SpotifyConnectRepairOutcome::Activated);
        assert!(report.was_running_before);
        assert!(activated.get());
        assert!(!terminated.get());
    }

    #[test]
    fn activation_never_launches_a_closed_spotify() {
        let activated = Cell::new(false);
        let report = repair_spotify_connect_with(
            SpotifyConnectRepairAction::Activate,
            || Ok(Vec::new()),
            || {
                activated.set(true);
                Ok(())
            },
            |_| panic!("nothing should be terminated"),
        )
        .unwrap();

        assert_eq!(report.outcome, SpotifyConnectRepairOutcome::NotRunning);
        assert!(!report.was_running_before);
        assert!(!activated.get());
    }

    #[test]
    fn restart_is_limited_to_the_exact_supplied_spotify_processes() {
        let terminated = std::cell::RefCell::new(Vec::new());
        let report = repair_spotify_connect_with(
            SpotifyConnectRepairAction::Restart,
            || Ok(vec![101, 102, 103]),
            || Ok(()),
            |pids| {
                terminated.borrow_mut().extend_from_slice(pids);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(report.outcome, SpotifyConnectRepairOutcome::Restarted);
        assert_eq!(*terminated.borrow(), vec![101, 102, 103]);
    }

    #[test]
    fn restart_refuses_to_launch_when_spotify_was_not_running() {
        let activated = Cell::new(false);
        let report = repair_spotify_connect_with(
            SpotifyConnectRepairAction::Restart,
            || Ok(Vec::new()),
            || {
                activated.set(true);
                Ok(())
            },
            |_| panic!("nothing should be terminated"),
        )
        .unwrap();

        assert_eq!(report.outcome, SpotifyConnectRepairOutcome::NotRunning);
        assert!(!report.was_running_before);
        assert!(!activated.get());
    }

    #[test]
    fn missing_or_damaged_install_has_clear_activation_error() {
        let error = repair_spotify_connect_with(
            SpotifyConnectRepairAction::Activate,
            || Ok(vec![101]),
            || Err("application identity was not registered".to_string()),
            |_| Ok(()),
        )
        .unwrap_err();

        assert!(error.contains("may not be installed"));
        assert!(error.contains("application identity was not registered"));
    }

    #[test]
    fn pid_reuse_validation_failure_prevents_activation() {
        let activated = Cell::new(false);
        let error = repair_spotify_connect_with(
            SpotifyConnectRepairAction::Restart,
            || Ok(vec![101]),
            || {
                activated.set(true);
                Ok(())
            },
            |_| Err("PID 101 now belongs to a different process".to_string()),
        )
        .unwrap_err();

        assert!(error.contains("different process"));
        assert!(!activated.get());
    }

    #[test]
    fn cancellation_or_failure_after_first_close_still_runs_one_restorative_activation() {
        let activated = Cell::new(0_u32);
        let error =
            finish_restorative_restart(Err("repair cancelled after WM_CLOSE".to_string()), || {
                activated.set(activated.get() + 1);
                Ok(())
            })
            .unwrap_err();

        assert_eq!(activated.get(), 1);
        assert!(error.contains("restorative activation completed"));
    }
}
