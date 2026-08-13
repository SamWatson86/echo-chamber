//! Dedicated Spotify Jam source agent.
//!
//! This runs in the interactive desktop process, independently of the viewer
//! and independently of screen-share audio. The control plane selects when a
//! generation starts; this configured client is the only capture authority.

use crate::audio_capture::{
    find_spotify_root_pid, start_owned_process_capture, validate_spotify_root_pid,
    OwnedProcessCapture, ProcessCaptureEvent,
};
use crate::spotify_connect_repair::{
    repair_spotify_connect, SpotifyConnectRepairAction, SpotifyConnectRepairOutcome,
};
use crate::spotify_output_route::{
    SpotifyOutputRouteLease, SpotifyOutputRouter, StartupRecoveryOutcome,
    DEFAULT_SPOTIFY_ROUTE_TARGET,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, USER_AGENT};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use windows::core::PWSTR;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE, WIN32_ERROR,
};
use windows::Win32::Storage::Packaging::Appx::{GetApplicationUserModelId, GetPackageFamilyName};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

const PROTOCOL_VERSION: u8 = 3;
const SPOTIFY_CONNECT_REPAIR_CAPABILITY: &str = "spotify_connect_repair_v1";
// A restart may already be in its restorative phase (2s graceful + 3s force
// wait). Give that blocking worker enough time to relaunch Spotify before a
// connection teardown or app shutdown proceeds.
const SPOTIFY_CONNECT_REPAIR_CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(250);
const WEBSOCKET_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const WEBSOCKET_SEND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RECONNECT_DELAY_SECS: u64 = 30;
const ROUTE_JOURNAL_FILE_NAME: &str = "jam-source-route-journal.json";
const AMBIGUOUS_DISCONNECT_ROUTE_RELEASE_GRACE: Duration = Duration::from_secs(36);
const TAKEOVER_DISABLE_FALLBACK: Duration = Duration::from_secs(3);
const SHUTDOWN_STOP_ACK_TIMEOUT: Duration = Duration::from_secs(16);
const SPOTIFY_CONNECT_RESTART_COOLDOWN: Duration = Duration::from_secs(60);
const SPOTIFY_STORE_PACKAGE_FAMILY: &str = "SpotifyAB.SpotifyMusic_zpdnekdrzrea0";
const SPOTIFY_STORE_APP_SUFFIX: &str = "!Spotify";
const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

static PREFERENCE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[link(name = "kernel32")]
extern "system" {
    fn MoveFileExW(existing_file_name: *const u16, new_file_name: *const u16, flags: u32) -> i32;
}

fn log_jam_source(message: &str) {
    eprintln!("{}", message);
    crate::file_debug_log::append(message);
}

#[derive(Clone, Deserialize)]
pub struct JamSourceConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub token: String,
    #[serde(default = "default_silent_output_name")]
    pub silent_output_name: String,
}

fn default_silent_output_name() -> String {
    DEFAULT_SPOTIFY_ROUTE_TARGET.to_string()
}

impl JamSourceConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("jam_source.id cannot be empty".to_string());
        }
        if self.token.trim().is_empty() {
            return Err("jam_source.token cannot be empty".to_string());
        }
        if self.silent_output_name.trim().is_empty() {
            return Err("jam_source.silent_output_name cannot be empty".to_string());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct JamSourceLocalPreferences {
    #[serde(default = "default_takeover_enabled")]
    takeover_enabled: bool,
    #[serde(default)]
    monitor_enabled: bool,
}

fn default_takeover_enabled() -> bool {
    // A jam_source block is an explicit provisioning decision. Preserve the
    // pre-toggle behavior on upgrade while still letting this PC revoke access.
    true
}

impl Default for JamSourceLocalPreferences {
    fn default() -> Self {
        Self {
            takeover_enabled: default_takeover_enabled(),
            monitor_enabled: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct JamSourceLocalControlSnapshot {
    pub is_source_host: bool,
    pub takeover_enabled: bool,
    pub monitor_enabled: bool,
    pub takeover_active: bool,
    pub agent_running: bool,
    pub target_device_name: String,
    pub last_error: Option<String>,
}

struct JamSourceLocalControlInner {
    configured: bool,
    target_device_name: String,
    settings_path: PathBuf,
    preferences: Mutex<JamSourceLocalPreferences>,
    preferences_tx: watch::Sender<JamSourceLocalPreferences>,
    takeover_active: AtomicBool,
    agent_running: AtomicBool,
    spotify_connect_repair_active: AtomicBool,
    last_spotify_connect_restart_at: Mutex<Option<Instant>>,
    preference_error: Mutex<Option<String>>,
    last_error: Mutex<Option<String>>,
}

/// Local-only source consent and monitoring preferences.
///
/// This state is reachable only through Tauri IPC on the configured source
/// installation. It is deliberately not exposed through an HTTP endpoint.
#[derive(Clone)]
pub struct JamSourceLocalControl {
    inner: Arc<JamSourceLocalControlInner>,
}

impl JamSourceLocalControl {
    pub fn load(config: Option<&JamSourceConfig>, settings_path: PathBuf) -> Self {
        let configured = config.is_some();
        let target_device_name = config
            .map(|config| config.silent_output_name.trim().to_string())
            .unwrap_or_default();
        let (preferences, preference_error) = if configured {
            match load_local_preferences(&settings_path) {
                Ok(Some(preferences)) => (preferences, None),
                Ok(None) => (JamSourceLocalPreferences::default(), None),
                Err(error) => (
                    JamSourceLocalPreferences {
                        takeover_enabled: false,
                        monitor_enabled: false,
                    },
                    Some(error),
                ),
            }
        } else {
            (
                JamSourceLocalPreferences {
                    takeover_enabled: false,
                    monitor_enabled: false,
                },
                None,
            )
        };
        let (preferences_tx, _) = watch::channel(preferences);
        Self {
            inner: Arc::new(JamSourceLocalControlInner {
                configured,
                target_device_name,
                settings_path,
                preferences: Mutex::new(preferences),
                preferences_tx,
                takeover_active: AtomicBool::new(false),
                agent_running: AtomicBool::new(false),
                spotify_connect_repair_active: AtomicBool::new(false),
                last_spotify_connect_restart_at: Mutex::new(None),
                preference_error: Mutex::new(preference_error),
                last_error: Mutex::new(None),
            }),
        }
    }

    pub fn is_source_host(&self) -> bool {
        self.inner.configured
    }

    pub fn snapshot(&self) -> JamSourceLocalControlSnapshot {
        let preferences = *self
            .inner
            .preferences
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let preference_error = self
            .inner
            .preference_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let runtime_error = self
            .inner
            .last_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        JamSourceLocalControlSnapshot {
            is_source_host: self.inner.configured,
            takeover_enabled: preferences.takeover_enabled,
            monitor_enabled: preferences.monitor_enabled,
            takeover_active: self.inner.takeover_active.load(Ordering::Acquire),
            agent_running: self.inner.agent_running.load(Ordering::Acquire),
            target_device_name: self.inner.target_device_name.clone(),
            last_error: preference_error.or(runtime_error),
        }
    }

    pub fn set_takeover_enabled(
        &self,
        enabled: bool,
    ) -> Result<JamSourceLocalControlSnapshot, String> {
        self.update_preferences(|preferences| preferences.takeover_enabled = enabled)?;
        Ok(self.snapshot())
    }

    pub fn set_monitor_enabled(
        &self,
        enabled: bool,
    ) -> Result<JamSourceLocalControlSnapshot, String> {
        self.update_preferences(|preferences| preferences.monitor_enabled = enabled)?;
        Ok(self.snapshot())
    }

    fn update_preferences(
        &self,
        update: impl FnOnce(&mut JamSourceLocalPreferences),
    ) -> Result<(), String> {
        if !self.inner.configured {
            return Err("This Echo installation is not the Jam source host".to_string());
        }
        let next = {
            let mut preferences = self
                .inner
                .preferences
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut candidate = *preferences;
            update(&mut candidate);
            if let Err(error) = persist_local_preferences(&self.inner.settings_path, &candidate) {
                *self
                    .inner
                    .preference_error
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error.clone());
                return Err(error);
            }
            *preferences = candidate;
            candidate
        };
        *self
            .inner
            .preference_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.inner.preferences_tx.send_replace(next);
        Ok(())
    }

    fn subscribe(&self) -> watch::Receiver<JamSourceLocalPreferences> {
        self.inner.preferences_tx.subscribe()
    }

    fn route_journal_path(&self) -> PathBuf {
        self.inner
            .settings_path
            .parent()
            .map(|directory| directory.join(ROUTE_JOURNAL_FILE_NAME))
            .unwrap_or_else(|| PathBuf::from(ROUTE_JOURNAL_FILE_NAME))
    }

    fn preference_error(&self) -> Option<String> {
        self.inner
            .preference_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn set_agent_running(&self, running: bool) {
        self.inner.agent_running.store(running, Ordering::Release);
        if !running {
            self.set_takeover_active(false);
        }
    }

    fn set_takeover_active(&self, active: bool) {
        self.inner.takeover_active.store(active, Ordering::Release);
    }

    fn set_last_error(&self, error: Option<String>) {
        *self
            .inner
            .last_error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = error;
    }

    fn begin_spotify_connect_repair(
        &self,
        action: SpotifyConnectRepairAction,
    ) -> Result<SpotifyConnectRepairGuard, String> {
        self.inner
            .spotify_connect_repair_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                "A Spotify Connect repair is already running on this source PC".to_string()
            })?;
        if action == SpotifyConnectRepairAction::Restart {
            let mut last_restart = self
                .inner
                .last_spotify_connect_restart_at
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if last_restart
                .map(|started| started.elapsed() < SPOTIFY_CONNECT_RESTART_COOLDOWN)
                .unwrap_or(false)
            {
                self.inner
                    .spotify_connect_repair_active
                    .store(false, Ordering::Release);
                return Err(format!(
                    "Spotify Connect restart is cooling down for {} seconds",
                    SPOTIFY_CONNECT_RESTART_COOLDOWN.as_secs()
                ));
            }
            *last_restart = Some(Instant::now());
        }
        Ok(SpotifyConnectRepairGuard {
            control: self.clone(),
        })
    }

    fn finish_spotify_connect_repair(&self) {
        self.inner
            .spotify_connect_repair_active
            .store(false, Ordering::Release);
    }

    fn spotify_connect_repair_active(&self) -> bool {
        self.inner
            .spotify_connect_repair_active
            .load(Ordering::Acquire)
    }
}

struct SpotifyConnectRepairGuard {
    control: JamSourceLocalControl,
}

impl Drop for SpotifyConnectRepairGuard {
    fn drop(&mut self) {
        self.control.finish_spotify_connect_repair();
    }
}

fn load_local_preferences(path: &Path) -> Result<Option<JamSourceLocalPreferences>, String> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not read Jam source settings '{}': {}. Jam sharing was disabled for safety",
                path.display(),
                error
            ))
        }
    };
    serde_json::from_str(contents.trim_start_matches('\u{FEFF}'))
        .map(Some)
        .map_err(|error| {
            format!(
                "Could not parse Jam source settings '{}': {}. Jam sharing was disabled for safety",
                path.display(),
                error
            )
        })
}

fn persist_local_preferences(
    path: &Path,
    preferences: &JamSourceLocalPreferences,
) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create Jam source settings directory '{}': {}",
                parent.display(),
                error
            )
        })?;
    }
    let json = serde_json::to_string_pretty(preferences)
        .map_err(|error| format!("Could not serialize Jam source settings: {}", error))?;
    let temporary_path = preference_temporary_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|error| {
                format!(
                    "Could not create temporary Jam source settings '{}': {}",
                    temporary_path.display(),
                    error
                )
            })?;
        file.write_all(format!("{}\n", json).as_bytes())
            .map_err(|error| {
                format!(
                    "Could not write temporary Jam source settings '{}': {}",
                    temporary_path.display(),
                    error
                )
            })?;
        file.sync_all().map_err(|error| {
            format!(
                "Could not flush temporary Jam source settings '{}': {}",
                temporary_path.display(),
                error
            )
        })?;
        drop(file);
        replace_file_atomically(&temporary_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn preference_temporary_path(path: &Path) -> Result<PathBuf, String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| "Jam source settings path has no file name".to_string())?;
    let sequence = PREFERENCE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut temporary_name = OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(format!(".tmp-{}-{sequence}", std::process::id()));
    Ok(path.with_file_name(temporary_name))
}

fn replace_file_atomically(temporary_path: &Path, destination: &Path) -> Result<(), String> {
    let temporary_wide = temporary_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            temporary_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced != 0 {
        Ok(())
    } else {
        Err(format!(
            "Could not atomically save Jam source settings '{}': {}",
            destination.display(),
            std::io::Error::last_os_error()
        ))
    }
}

pub struct JamSourceAgent {
    shutdown: Arc<AtomicBool>,
    shutdown_complete: Arc<AtomicBool>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    control: JamSourceLocalControl,
}

pub struct JamSourceShutdown {
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    complete: Arc<AtomicBool>,
}

impl JamSourceShutdown {
    pub async fn wait(self) {
        if let Some(task) = self.task {
            let _ = task.await;
            self.complete.store(true, Ordering::Release);
            return;
        }
        while !self.complete.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

impl JamSourceAgent {
    pub fn start(
        server: String,
        config: JamSourceConfig,
        control: JamSourceLocalControl,
    ) -> Result<Self, String> {
        if let Err(error) = config.validate() {
            control.set_last_error(Some(error.clone()));
            return Err(error);
        }
        if !control.is_source_host() {
            let error = "Jam source local control is not configured".to_string();
            control.set_last_error(Some(error.clone()));
            return Err(error);
        }
        let router = SpotifyOutputRouter::new(control.route_journal_path()).map_err(|error| {
            control.set_last_error(Some(error.clone()));
            error
        })?;
        let endpoint = build_source_ws_url(&server, &config.id).map_err(|error| {
            control.set_last_error(Some(error.clone()));
            error
        })?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_complete = Arc::new(AtomicBool::new(false));
        let task_shutdown = shutdown.clone();
        let task_shutdown_complete = shutdown_complete.clone();
        let task_control = control.clone();
        control.set_agent_running(true);
        let task = tauri::async_runtime::spawn(async move {
            run_agent(
                endpoint,
                config,
                task_shutdown,
                task_control.clone(),
                router,
            )
            .await;
            task_control.set_agent_running(false);
            task_shutdown_complete.store(true, Ordering::Release);
        });

        Ok(Self {
            shutdown,
            shutdown_complete,
            task: Mutex::new(Some(task)),
            control,
        })
    }

    pub fn begin_shutdown(&self) -> JamSourceShutdown {
        self.shutdown.store(true, Ordering::SeqCst);
        let task = self
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        JamSourceShutdown {
            task,
            complete: self.shutdown_complete.clone(),
        }
    }

    pub fn shutdown_complete(&self) -> bool {
        self.shutdown_complete.load(Ordering::Acquire)
    }
}

impl Drop for JamSourceAgent {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.control.set_agent_running(false);
        if let Some(task) = self
            .task
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            task.abort();
        }
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ServerCommand {
    Start {
        generation: u64,
    },
    Stop {
        generation: u64,
    },
    Restart {
        generation: u64,
    },
    #[serde(rename = "spotify_connect_repair")]
    SpotifyConnectRepair {
        request_id: u64,
        action: SpotifyConnectRepairAction,
    },
    #[serde(rename = "spotify_connect_repair_cancel")]
    SpotifyConnectRepairCancel {
        request_id: u64,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum SourceMessage<'a> {
    Availability {
        enabled: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
        capabilities: &'static [&'static str],
    },
    Format {
        generation: u64,
        sample_rate: u32,
        channels: u32,
    },
    Ready {
        generation: u64,
        pid: u32,
    },
    Error {
        generation: u64,
        message: &'a str,
    },
    Heartbeat {
        generation: u64,
    },
    Restarting {
        generation: u64,
    },
    #[serde(rename = "spotify_connect_repair")]
    SpotifyConnectRepair {
        request_id: u64,
        success: bool,
        outcome: &'a str,
        was_running_before: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    },
}

struct ActiveCapture {
    generation: u64,
    _handle: OwnedProcessCapture,
    events: tokio::sync::mpsc::Receiver<ProcessCaptureEvent>,
}

struct ActiveTakeover {
    generation: u64,
    route: SpotifyOutputRouteLease,
    capture: Option<ActiveCapture>,
}

struct SpotifyConnectRepairTask {
    request_id: u64,
    cancelled: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<
        Result<crate::spotify_connect_repair::SpotifyConnectRepairReport, String>,
    >,
}

async fn next_spotify_connect_repair(
    repair: &mut Option<SpotifyConnectRepairTask>,
) -> Option<(
    u64,
    Result<crate::spotify_connect_repair::SpotifyConnectRepairReport, String>,
)> {
    let pending = match repair.as_mut() {
        Some(pending) => pending,
        None => return std::future::pending().await,
    };
    let request_id = pending.request_id;
    let result = (&mut pending.task)
        .await
        .map_err(|error| format!("Spotify Connect repair worker failed: {error}"))
        .and_then(|result| result);
    Some((request_id, result))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActiveConnectionExitPolicy {
    PreserveJournal,
    RestoreAfter(Duration),
}

fn active_connection_exit_policy(preserve_active_route: bool) -> ActiveConnectionExitPolicy {
    if preserve_active_route {
        ActiveConnectionExitPolicy::PreserveJournal
    } else {
        ActiveConnectionExitPolicy::RestoreAfter(AMBIGUOUS_DISCONNECT_ROUTE_RELEASE_GRACE)
    }
}

impl ActiveTakeover {
    fn pid(&self) -> u32 {
        self.route.info().spotify_pid
    }
}

#[derive(Default)]
struct GenerationFence {
    highest_seen: u64,
    stopped_through: Option<u64>,
}

impl GenerationFence {
    fn accept_start(&mut self, generation: u64, active_generation: Option<u64>) -> bool {
        if active_generation == Some(generation) || generation < self.highest_seen {
            return false;
        }
        if self
            .stopped_through
            .map(|stopped| generation <= stopped)
            .unwrap_or(false)
        {
            return false;
        }
        self.highest_seen = self.highest_seen.max(generation);
        true
    }

    fn accept_stop(&mut self, generation: u64) -> bool {
        if generation < self.highest_seen {
            return false;
        }
        self.highest_seen = generation;
        self.stopped_through = Some(
            self.stopped_through
                .map(|stopped| stopped.max(generation))
                .unwrap_or(generation),
        );
        true
    }

    fn accept_restart(&self, generation: u64, active_generation: Option<u64>) -> bool {
        active_generation == Some(generation)
            && self.highest_seen == generation
            && self
                .stopped_through
                .map(|stopped| generation > stopped)
                .unwrap_or(true)
    }
}

#[derive(Default)]
struct ConnectionAttemptState {
    websocket_established: bool,
}

impl ConnectionAttemptState {
    fn mark_websocket_established(&mut self) {
        self.websocket_established = true;
    }

    fn retry_delay_secs(&self, current_delay_secs: u64) -> u64 {
        if self.websocket_established {
            1
        } else {
            current_delay_secs
        }
    }
}

async fn run_agent(
    endpoint: String,
    config: JamSourceConfig,
    shutdown: Arc<AtomicBool>,
    control: JamSourceLocalControl,
    router: SpotifyOutputRouter,
) {
    let mut reconnect_delay_secs = 1_u64;

    while !shutdown.load(Ordering::SeqCst) {
        if let Err(error) = recover_local_spotify_route(&router) {
            control.set_last_error(Some(error.clone()));
            log_jam_source(&format!(
                "[jam-source] local Spotify route recovery blocked connection: {}",
                error
            ));
            if wait_or_shutdown(Duration::from_secs(1), &shutdown).await {
                break;
            }
            continue;
        }
        let mut attempt = ConnectionAttemptState::default();
        let result = run_connection(
            &endpoint,
            &config,
            &shutdown,
            &mut attempt,
            &control,
            &router,
        )
        .await;
        control.set_takeover_active(false);
        reconnect_delay_secs = attempt.retry_delay_secs(reconnect_delay_secs);

        match result {
            Ok(()) => {
                if !shutdown.load(Ordering::SeqCst) {
                    let error = "Jam source connection closed; reconnecting".to_string();
                    control.set_last_error(Some(error));
                    log_jam_source("[jam-source] connection closed; reconnecting");
                }
            }
            Err(error) => {
                control.set_last_error(Some(format!("Jam source connection failed: {error}")));
                log_jam_source(&format!(
                    "[jam-source] connection failed: {}; retrying in {}s",
                    error, reconnect_delay_secs
                ));
            }
        }

        if wait_or_shutdown(Duration::from_secs(reconnect_delay_secs), &shutdown).await {
            break;
        }
        reconnect_delay_secs = next_reconnect_delay(reconnect_delay_secs);
    }

    control.set_takeover_active(false);
    log_jam_source("[jam-source] agent stopped");
}

async fn run_connection(
    endpoint: &str,
    config: &JamSourceConfig,
    shutdown: &AtomicBool,
    attempt: &mut ConnectionAttemptState,
    control: &JamSourceLocalControl,
    router: &SpotifyOutputRouter,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut request = endpoint.into_client_request()?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", config.token))?,
    );
    request.headers_mut().insert(
        USER_AGENT,
        HeaderValue::from_str(&format!(
            "echo-core-client/{} jam-source/{}",
            env!("CARGO_PKG_VERSION"),
            PROTOCOL_VERSION
        ))?,
    );

    let connect_result = tokio::select! {
        result = tokio::time::timeout(
            WEBSOCKET_CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async(request),
        ) => result.map_err(|_| {
            reconnect_error(format!(
                "WebSocket connection timed out after {}s",
                WEBSOCKET_CONNECT_TIMEOUT.as_secs()
            ))
        })?,
        _ = wait_for_shutdown(shutdown) => return Ok(()),
    };
    let (socket, _) = connect_result?;
    attempt.mark_websocket_established();
    log_jam_source(&format!(
        "[jam-source] configured source '{}' connected",
        config.id
    ));
    let (mut writer, mut reader) = socket.split();
    let mut preferences_rx = control.subscribe();
    let (mut source_enabled, mut availability_error) = evaluate_local_availability(
        router,
        config,
        preferences_rx.borrow().takeover_enabled,
        control.preference_error(),
    );
    send_source_message(
        &mut writer,
        &SourceMessage::Availability {
            enabled: source_enabled,
            error: availability_error.as_deref(),
            capabilities: &[SPOTIFY_CONNECT_REPAIR_CAPABILITY],
        },
    )
    .await?;
    control.set_last_error(availability_error.clone());
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut shutdown_poll = tokio::time::interval(SHUTDOWN_POLL_INTERVAL);
    shutdown_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut active: Option<ActiveTakeover> = None;
    let mut spotify_connect_repair: Option<SpotifyConnectRepairTask> = None;
    let mut generation_fence = GenerationFence::default();
    let mut disable_fallback_deadline = None;
    let mut shutdown_stop_deadline = None;
    let mut preserve_active_route = false;

    let loop_result: Result<(), Box<dyn std::error::Error + Send + Sync>> = async {
        loop {
            tokio::select! {
            incoming = reader.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        let command = match parse_server_command(&text) {
                            Ok(command) => command,
                            Err(error) => {
                                send_source_message(
                                    &mut writer,
                                    &SourceMessage::Error {
                                        generation: active.as_ref().map(|takeover| takeover.generation).unwrap_or(0),
                                        message: &error,
                                    },
                                ).await?;
                                continue;
                            }
                        };

                        match command {
                            ServerCommand::Start { generation } => {
                                if control.spotify_connect_repair_active() || spotify_connect_repair.is_some() {
                                    let error = "Jam start is blocked while Spotify Connect repair is active";
                                    send_source_message(
                                        &mut writer,
                                        &SourceMessage::Error {
                                            generation,
                                            message: error,
                                        },
                                    ).await?;
                                    continue;
                                }
                                if !source_enabled || !preferences_rx.borrow().takeover_enabled {
                                    let error = availability_error
                                        .as_deref()
                                        .unwrap_or("Jam sharing is turned off on this source PC");
                                    send_source_message(
                                        &mut writer,
                                        &SourceMessage::Error {
                                            generation,
                                            message: error,
                                        },
                                    ).await?;
                                    continue;
                                }
                                if !generation_fence.accept_start(
                                    generation,
                                    active.as_ref().map(|takeover| takeover.generation),
                                ) {
                                    continue;
                                }
                                disable_fallback_deadline = None;

                                if let Some(previous) = active.take() {
                                    if let Err(error) = stop_spotify_takeover(previous) {
                                        log_jam_source(&format!(
                                            "[jam-source] prior Spotify route restore failed: {}",
                                            error
                                        ));
                                    }
                                }
                                match start_spotify_takeover(router, config, generation) {
                                    Ok(takeover) => {
                                        control.set_takeover_active(true);
                                        control.set_last_error(None);
                                        active = Some(takeover);
                                    }
                                    Err(error) => {
                                        control.set_takeover_active(false);
                                        control.set_last_error(Some(error.clone()));
                                        send_source_message(
                                            &mut writer,
                                            &SourceMessage::Error {
                                                generation,
                                                message: &error,
                                            },
                                        ).await?;
                                        return Err(reconnect_error(error));
                                    }
                                }
                            }
                            ServerCommand::Stop { generation } => {
                                let stop_accepted = generation_fence.accept_stop(generation);
                                disable_fallback_deadline = disable_fallback_deadline_after_stop(
                                    disable_fallback_deadline,
                                    stop_accepted,
                                );
                                if !stop_accepted {
                                    continue;
                                }
                                let acknowledged_shutdown = shutdown_stop_deadline.is_some()
                                    && active
                                        .as_ref()
                                        .map(|takeover| takeover.generation == generation)
                                        .unwrap_or(false);
                                if active
                                    .as_ref()
                                    .map(|takeover| takeover.generation <= generation)
                                    .unwrap_or(false)
                                {
                                    log_jam_source(&format!(
                                        "[jam-source] stopping generation {}",
                                        generation
                                    ));
                                    if let Some(takeover) = active.take() {
                                        if let Err(error) = stop_spotify_takeover(takeover) {
                                            control.set_last_error(Some(error.clone()));
                                            log_jam_source(&format!(
                                                "[jam-source] Spotify route restore failed: {}",
                                                error
                                            ));
                                        }
                                    }
                                    control.set_takeover_active(false);
                                }
                                if acknowledged_shutdown {
                                    shutdown_stop_deadline = None;
                                    send_ws_message(&mut writer, Message::Close(None)).await?;
                                    break;
                                }
                            }
                            ServerCommand::Restart { generation } => {
                                if shutdown_stop_deadline.is_some() {
                                    continue;
                                }
                                if !generation_fence.accept_restart(
                                    generation,
                                    active.as_ref().map(|takeover| takeover.generation),
                                ) {
                                    continue;
                                }

                                // Drop the old handle before acknowledging. Messages sent
                                // before `restarting` belong to the old capture; messages
                                // after it belong to the replacement on this ordered socket.
                                let Some(takeover) = active.as_mut() else {
                                    continue;
                                };
                                takeover.capture.take();
                                log_jam_source(&format!(
                                    "[jam-source] restarting stalled capture generation {}",
                                    generation
                                ));
                                send_source_message(
                                    &mut writer,
                                    &SourceMessage::Restarting { generation },
                                ).await?;

                                match restart_spotify_capture(takeover) {
                                    Ok(capture) => {
                                        control.set_takeover_active(true);
                                        control.set_last_error(None);
                                        takeover.capture = Some(capture);
                                    }
                                    Err(error) => {
                                        control.set_takeover_active(false);
                                        control.set_last_error(Some(error.clone()));
                                        send_source_message(
                                            &mut writer,
                                            &SourceMessage::Error {
                                                generation,
                                                message: &error,
                                            },
                                        ).await?;
                                        return Err(reconnect_error(error));
                                    }
                                }
                            }
                            ServerCommand::SpotifyConnectRepair { request_id, action } => {
                                let consent_enabled = preferences_rx.borrow().takeover_enabled;
                                let route_journal_exists = control.route_journal_path().exists();
                                let rejection = if !source_enabled || !consent_enabled {
                                    Some("Spotify Connect repair is disabled on the Jam source PC")
                                } else if active.is_some() || shutdown_stop_deadline.is_some() || shutdown.load(Ordering::SeqCst) {
                                    Some("Spotify Connect repair is unavailable while a Jam source generation or shutdown is active")
                                } else if route_journal_exists {
                                    Some("Spotify Connect repair is blocked while an Echo Spotify route journal exists")
                                } else if spotify_connect_repair.is_some() {
                                    Some("A Spotify Connect repair is already running on the source PC")
                                } else {
                                    None
                                };
                                if let Some(error) = rejection {
                                    send_source_message(
                                        &mut writer,
                                        &SourceMessage::SpotifyConnectRepair {
                                            request_id,
                                            success: false,
                                            outcome: "busy",
                                            was_running_before: false,
                                            error: Some(error),
                                        },
                                    ).await?;
                                    continue;
                                }
                                let repair_guard = match control.begin_spotify_connect_repair(action) {
                                    Ok(guard) => guard,
                                    Err(error) => {
                                        send_source_message(
                                            &mut writer,
                                            &SourceMessage::SpotifyConnectRepair {
                                                request_id,
                                                success: false,
                                                outcome: "busy",
                                                was_running_before: false,
                                                error: Some(&error),
                                            },
                                        ).await?;
                                        continue;
                                    }
                                };
                                let cancelled = Arc::new(AtomicBool::new(false));
                                let task_cancelled = cancelled.clone();
                                let task = tokio::task::spawn_blocking(move || {
                                    let _repair_guard = repair_guard;
                                    repair_spotify_connect(action, &task_cancelled)
                                });
                                spotify_connect_repair = Some(SpotifyConnectRepairTask {
                                    request_id,
                                    cancelled,
                                    task,
                                });
                            }
                            ServerCommand::SpotifyConnectRepairCancel { request_id } => {
                                if let Some(repair) = spotify_connect_repair
                                    .as_ref()
                                    .filter(|repair| repair.request_id == request_id)
                                {
                                    repair.cancelled.store(true, Ordering::Release);
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        send_ws_message(&mut writer, Message::Pong(payload)).await?;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(error.into()),
                }
            }
            repair_result = next_spotify_connect_repair(&mut spotify_connect_repair) => {
                let Some((request_id, result)) = repair_result else {
                    continue;
                };
                spotify_connect_repair = None;
                match result {
                    Ok(report) => {
                        let (next_enabled, next_error) = evaluate_local_availability(
                            router,
                            config,
                            preferences_rx.borrow().takeover_enabled,
                            control.preference_error(),
                        );
                        source_enabled = next_enabled;
                        availability_error = next_error;
                        control.set_last_error(availability_error.clone());
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Availability {
                                enabled: source_enabled,
                                error: availability_error.as_deref(),
                                capabilities: &[SPOTIFY_CONNECT_REPAIR_CAPABILITY],
                            },
                        ).await?;
                        let outcome = match report.outcome {
                            SpotifyConnectRepairOutcome::Activated => "activated",
                            SpotifyConnectRepairOutcome::Restarted => "restarted",
                            SpotifyConnectRepairOutcome::NotRunning => "not_running",
                        };
                        log_jam_source(&format!(
                            "[jam-source] Spotify Connect repair completed: {}",
                            outcome
                        ));
                        send_source_message(
                            &mut writer,
                            &SourceMessage::SpotifyConnectRepair {
                                request_id,
                                success: true,
                                outcome,
                                was_running_before: report.was_running_before,
                                error: None,
                            },
                        ).await?;
                    }
                    Err(error) => {
                        control.set_last_error(Some(error.clone()));
                        log_jam_source("[jam-source] Spotify Connect repair failed");
                        send_source_message(
                            &mut writer,
                            &SourceMessage::SpotifyConnectRepair {
                                request_id,
                                success: false,
                                outcome: "failed",
                                was_running_before: false,
                                error: Some(&error),
                            },
                        ).await?;
                    }
                }
            }
            changed = preferences_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                let takeover_enabled = preferences_rx.borrow().takeover_enabled;
                if !takeover_enabled {
                    if let Some(repair) = spotify_connect_repair.as_ref() {
                        repair.cancelled.store(true, Ordering::Release);
                    }
                }
                if takeover_enabled {
                    disable_fallback_deadline = None;
                }
                if shutdown_stop_deadline.is_some() {
                    continue;
                }
                let (next_enabled, next_error) = if active.is_some() {
                    (takeover_enabled, None)
                } else {
                    evaluate_local_availability(
                        router,
                        config,
                        takeover_enabled,
                        control.preference_error(),
                    )
                };
                if next_enabled != source_enabled || next_error != availability_error {
                    source_enabled = next_enabled;
                    availability_error = next_error;
                    control.set_last_error(availability_error.clone());
                    send_source_message(
                        &mut writer,
                        &SourceMessage::Availability {
                            enabled: source_enabled,
                            error: availability_error.as_deref(),
                            capabilities: &[SPOTIFY_CONNECT_REPAIR_CAPABILITY],
                        },
                    ).await?;
                }
                // Arm only after Availability(false) was successfully written.
                // Repeated monitor preference notifications must not extend it.
                disable_fallback_deadline = next_disable_fallback_deadline(
                    disable_fallback_deadline,
                    takeover_enabled,
                    active.is_some(),
                    tokio::time::Instant::now(),
                );
            }
            capture_event = next_capture_event(&mut active) => {
                let Some((generation, event)) = capture_event else {
                    if let Some(takeover) = active.as_ref() {
                        let message = "Spotify audio capture event channel closed";
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Error {
                                generation: takeover.generation,
                                message,
                            },
                        ).await?;
                        return Err(reconnect_error(format!(
                            "generation {} {}",
                            takeover.generation, message
                        )));
                    }
                    continue;
                };
                let terminal_reason = terminal_capture_reconnect_reason(&event);
                match event {
                    ProcessCaptureEvent::Format(format) => {
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Format {
                                generation,
                                sample_rate: format.sample_rate,
                                channels: format.channels,
                            },
                        ).await?;
                    }
                    ProcessCaptureEvent::Started { pid } => {
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Ready { generation, pid },
                        ).await?;
                    }
                    ProcessCaptureEvent::Data(bytes) => {
                        send_ws_message(
                            &mut writer,
                            Message::Binary(frame_payload(generation, &bytes)),
                        ).await?;
                    }
                    ProcessCaptureEvent::Error(message) => {
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Error {
                                generation,
                                message: &message,
                            },
                        ).await?;
                    }
                    ProcessCaptureEvent::Stopped => {
                        let message = "Spotify audio capture stopped";
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Error { generation, message },
                        ).await?;
                    }
                }
                if let Some(reason) = terminal_reason {
                    return Err(reconnect_error(format!(
                        "generation {} {}",
                        generation, reason
                    )));
                }
            }
            _ = heartbeat.tick() => {
                if let Some((generation, pid)) = active
                    .as_ref()
                    .map(|takeover| (takeover.generation, takeover.pid()))
                {
                    if let Err(error) = validate_spotify_root_pid(pid) {
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Error {
                                generation,
                                message: &error,
                            },
                        ).await?;
                        return Err(reconnect_error(format!(
                            "generation {} lost Spotify root PID {}: {}",
                            generation, pid, error
                        )));
                    }
                } else {
                    let (next_enabled, next_error) = evaluate_local_availability(
                        router,
                        config,
                        preferences_rx.borrow().takeover_enabled,
                        control.preference_error(),
                    );
                    if next_enabled != source_enabled || next_error != availability_error {
                        source_enabled = next_enabled;
                        availability_error = next_error;
                        control.set_last_error(availability_error.clone());
                        send_source_message(
                            &mut writer,
                            &SourceMessage::Availability {
                                enabled: source_enabled,
                                error: availability_error.as_deref(),
                                capabilities: &[SPOTIFY_CONNECT_REPAIR_CAPABILITY],
                            },
                        ).await?;
                    }
                }
                send_source_message(
                    &mut writer,
                    &SourceMessage::Heartbeat {
                        generation: active.as_ref().map(|takeover| takeover.generation).unwrap_or(0),
                    },
                ).await?;
            }
            _ = shutdown_poll.tick() => {
                if shutdown.load(Ordering::SeqCst) && shutdown_stop_deadline.is_none() {
                    if let Some(repair) = spotify_connect_repair.as_ref() {
                        repair.cancelled.store(true, Ordering::Release);
                    }
                    source_enabled = false;
                    availability_error = None;
                    disable_fallback_deadline = None;
                    send_source_message(
                        &mut writer,
                        &SourceMessage::Availability {
                            enabled: false,
                            error: None,
                            capabilities: &[SPOTIFY_CONNECT_REPAIR_CAPABILITY],
                        },
                    ).await?;
                    if let Some(generation) = active.as_ref().map(|takeover| takeover.generation) {
                        shutdown_stop_deadline = Some(
                            tokio::time::Instant::now() + SHUTDOWN_STOP_ACK_TIMEOUT
                        );
                        log_jam_source(&format!(
                            "[jam-source] shutdown waiting for generation {} Stop",
                            generation
                        ));
                    } else {
                        send_ws_message(&mut writer, Message::Close(None)).await?;
                        break;
                    }
                }
            }
            _ = wait_for_optional_deadline(disable_fallback_deadline), if disable_fallback_deadline.is_some() => {
                disable_fallback_deadline = None;
                if !preferences_rx.borrow().takeover_enabled {
                    if let Some(takeover) = active.take() {
                        log_jam_source(&format!(
                            "[jam-source] local disable fallback stopping generation {} after {}ms",
                            takeover.generation,
                            TAKEOVER_DISABLE_FALLBACK.as_millis()
                        ));
                        if let Err(error) = stop_spotify_takeover(takeover) {
                            control.set_last_error(Some(error.clone()));
                            log_jam_source(&format!(
                                "[jam-source] local disable fallback could not restore Spotify: {}",
                                error
                            ));
                        }
                        control.set_takeover_active(false);
                    }
                }
            }
            _ = wait_for_optional_deadline(shutdown_stop_deadline), if shutdown_stop_deadline.is_some() => {
                shutdown_stop_deadline = None;
                preserve_active_route = active.is_some();
                break;
            }
            }
        }
        Ok(())
    }
    .await;

    if let Some(repair) = spotify_connect_repair.take() {
        repair.cancelled.store(true, Ordering::Release);
        let mut task = repair.task;
        if tokio::time::timeout(SPOTIFY_CONNECT_REPAIR_CLEANUP_TIMEOUT, &mut task)
            .await
            .is_err()
        {
            task.abort();
        }
    }

    // Close the socket before the release grace so the control plane observes
    // disconnect and has its full pause timeout before Spotify can be audible.
    drop(writer);
    drop(reader);

    let mut cleanup_error = None;
    if let Some(takeover) = active.take() {
        match active_connection_exit_policy(preserve_active_route) {
            ActiveConnectionExitPolicy::PreserveJournal => {
                log_jam_source(&format!(
                    "[jam-source] shutdown timed out waiting for generation {} Stop; preserving the Spotify route journal",
                    takeover.generation
                ));
                // Process exit is imminent. Leaking the lease deliberately prevents
                // its synchronous Drop restore; next launch recovers the journal.
                std::mem::forget(takeover);
            }
            ActiveConnectionExitPolicy::RestoreAfter(delay) => {
                log_jam_source(&format!(
                    "[jam-source] connection ended with generation {} active; holding the silent route for up to {}s before restore",
                    takeover.generation,
                    delay.as_secs()
                ));
                let restore_after_delay = wait_for_ambiguous_connection_release(
                    delay,
                    shutdown,
                    &mut preferences_rx,
                    disable_fallback_deadline,
                )
                .await;
                if restore_after_delay {
                    if let Err(error) = stop_spotify_takeover(takeover) {
                        control.set_last_error(Some(error.clone()));
                        log_jam_source(&format!(
                            "[jam-source] Spotify route restore failed while closing connection: {}",
                            error
                        ));
                        cleanup_error = Some(error);
                    }
                } else {
                    log_jam_source(&format!(
                        "[jam-source] exit requested during release grace for generation {}; preserving the Spotify route journal",
                        takeover.generation
                    ));
                    std::mem::forget(takeover);
                }
            }
        }
    }
    control.set_takeover_active(false);
    match (loop_result, cleanup_error) {
        (Err(error), _) => Err(error),
        (Ok(()), Some(error)) => Err(reconnect_error(error)),
        (Ok(()), None) => Ok(()),
    }
}

fn evaluate_local_availability(
    router: &SpotifyOutputRouter,
    config: &JamSourceConfig,
    takeover_enabled: bool,
    preference_error: Option<String>,
) -> (bool, Option<String>) {
    evaluate_local_availability_with(
        takeover_enabled,
        preference_error,
        || recover_local_spotify_route(router),
        || {
            let pid = find_spotify_root_pid()?;
            validate_store_spotify_root_pid(pid)?;
            router
                .validate_target(config.silent_output_name.trim())
                .map(|_| ())
                .map_err(|error| format!("Jam silent output is unavailable: {}", error))
        },
    )
}

fn evaluate_local_availability_with(
    takeover_enabled: bool,
    preference_error: Option<String>,
    recover_route: impl FnOnce() -> Result<(), String>,
    validate_readiness: impl FnOnce() -> Result<(), String>,
) -> (bool, Option<String>) {
    if let Err(error) = recover_route() {
        return (false, Some(error));
    }
    if !takeover_enabled {
        return (false, preference_error);
    }
    match validate_readiness() {
        Ok(()) => (true, None),
        Err(error) => (false, Some(error)),
    }
}

fn recover_local_spotify_route(router: &SpotifyOutputRouter) -> Result<(), String> {
    let current_spotify_pid = find_spotify_root_pid().ok();
    let retry_report = router.restore_active(current_spotify_pid)?;
    if !retry_report.restored_roles.is_empty()
        || !retry_report.cleared_to_default_roles.is_empty()
        || !retry_report.skipped_changed_roles.is_empty()
    {
        log_jam_source(&format!(
            "[jam-source] retried Spotify route restoration: {:?}",
            retry_report
        ));
    }
    match router.recover_startup(current_spotify_pid)? {
        StartupRecoveryOutcome::NoJournal => Ok(()),
        StartupRecoveryOutcome::OwnerStillRunning { owner_pid } => Err(format!(
            "Another Echo process (PID {}) still owns Spotify's Jam route",
            owner_pid
        )),
        StartupRecoveryOutcome::Deferred {
            owner_pid,
            retry_after,
        } => Err(format!(
            "Waiting {}ms before recovering the Spotify route from stopped Echo PID {}",
            retry_after.as_millis(),
            owner_pid
        )),
        StartupRecoveryOutcome::SpotifyNotRunning { previous_pid } => Err(format!(
            "Spotify must be opened once so Echo can recover its previous Jam route (old PID {})",
            previous_pid
        )),
        StartupRecoveryOutcome::Restored(report) => {
            log_jam_source(&format!(
                "[jam-source] recovered prior Spotify route: {:?}",
                report
            ));
            Ok(())
        }
    }
}

struct OwnedIdentityProcess(HANDLE);

impl Drop for OwnedIdentityProcess {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn validate_store_spotify_root_pid(pid: u32) -> Result<(), String> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map(OwnedIdentityProcess)
        .map_err(|error| format!("Cannot inspect Spotify PID {}: {}", pid, error))?;
    store_spotify_process_identity(pid, process.0).map(|_| ())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StoreSpotifyProcessIdentity {
    pub(crate) package_family: String,
    pub(crate) application_user_model_id: String,
}

pub(crate) fn store_spotify_process_identity(
    pid: u32,
    process: HANDLE,
) -> Result<StoreSpotifyProcessIdentity, String> {
    let package_family = read_process_app_model_string(
        |length, buffer| unsafe { GetPackageFamilyName(process, length, buffer) },
        "GetPackageFamilyName",
    )?;
    if !package_family.eq_ignore_ascii_case(SPOTIFY_STORE_PACKAGE_FAMILY) {
        return Err(format!(
            "Spotify PID {} is not the Microsoft Store Spotify app",
            pid
        ));
    }
    let application_user_model_id = read_process_app_model_string(
        |length, buffer| unsafe { GetApplicationUserModelId(process, length, buffer) },
        "GetApplicationUserModelId",
    )?;
    let expected_aumid = format!("{}{}", package_family, SPOTIFY_STORE_APP_SUFFIX);
    if !application_user_model_id.eq_ignore_ascii_case(&expected_aumid) {
        return Err(format!(
            "Spotify PID {} has an unexpected Store application identity",
            pid
        ));
    }
    Ok(StoreSpotifyProcessIdentity {
        package_family,
        application_user_model_id,
    })
}

fn read_process_app_model_string(
    mut call: impl FnMut(*mut u32, PWSTR) -> WIN32_ERROR,
    operation: &str,
) -> Result<String, String> {
    let mut length = 0_u32;
    let size_result = call(&mut length, PWSTR::null());
    if size_result != ERROR_INSUFFICIENT_BUFFER || length == 0 {
        return Err(format!(
            "{} size query failed with Win32 error {}",
            operation, size_result.0
        ));
    }

    let mut buffer = vec![0_u16; length as usize];
    let result = call(&mut length, PWSTR(buffer.as_mut_ptr()));
    if result != ERROR_SUCCESS {
        return Err(format!(
            "{} failed with Win32 error {}",
            operation, result.0
        ));
    }
    let string_length = buffer
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(length as usize);
    let value = String::from_utf16(&buffer[..string_length])
        .map_err(|error| format!("{} returned invalid UTF-16: {}", operation, error))?;
    if value.is_empty() {
        Err(format!("{} returned an empty identity", operation))
    } else {
        Ok(value)
    }
}

fn start_spotify_takeover(
    router: &SpotifyOutputRouter,
    config: &JamSourceConfig,
    generation: u64,
) -> Result<ActiveTakeover, String> {
    let pid = find_spotify_root_pid().map_err(|error| {
        format!(
            "generation {} could not bind Spotify: {}",
            generation, error
        )
    })?;
    match router.recover_startup(Some(pid))? {
        StartupRecoveryOutcome::NoJournal => {}
        StartupRecoveryOutcome::Restored(report) => log_jam_source(&format!(
            "[jam-source] generation {} recovered prior Spotify route: {:?}",
            generation, report
        )),
        StartupRecoveryOutcome::OwnerStillRunning { owner_pid } => {
            return Err(format!(
                "generation {} cannot route Spotify because Echo PID {} still owns the previous route",
                generation, owner_pid
            ));
        }
        StartupRecoveryOutcome::Deferred {
            owner_pid,
            retry_after,
        } => {
            return Err(format!(
                "generation {} is waiting {}ms before recovering the Spotify route from stopped Echo PID {}",
                generation,
                retry_after.as_millis(),
                owner_pid
            ));
        }
        StartupRecoveryOutcome::SpotifyNotRunning { previous_pid } => {
            return Err(format!(
                "generation {} could not recover Spotify route from old PID {}",
                generation, previous_pid
            ));
        }
    }
    router.validate_target(config.silent_output_name.trim())?;
    let route = router.acquire(pid, config.silent_output_name.trim())?;
    log_jam_source(&format!(
        "[jam-source] generation {} routed Spotify root PID {} to '{}'",
        generation,
        pid,
        route.info().target.name
    ));
    let capture = start_spotify_capture_for_pid(generation, pid)?;
    Ok(ActiveTakeover {
        generation,
        route,
        capture: Some(capture),
    })
}

fn start_spotify_capture_for_pid(generation: u64, pid: u32) -> Result<ActiveCapture, String> {
    let (handle, events) = start_owned_process_capture(pid).map_err(|error| {
        format!(
            "generation {} capture start failed for Spotify root PID {}: {}",
            generation, pid, error
        )
    })?;
    log_jam_source(&format!(
        "[jam-source] generation {} capturing Spotify root PID {}",
        generation, pid
    ));
    Ok(ActiveCapture {
        generation,
        _handle: handle,
        events,
    })
}

fn restart_spotify_capture(takeover: &ActiveTakeover) -> Result<ActiveCapture, String> {
    let current_pid = find_spotify_root_pid().map_err(|error| {
        format!(
            "generation {} could not rebind Spotify capture: {}",
            takeover.generation, error
        )
    })?;
    if current_pid != takeover.pid() {
        return Err(format!(
            "generation {} Spotify root changed from PID {} to {}; reconnecting to recover its route",
            takeover.generation,
            takeover.pid(),
            current_pid
        ));
    }
    start_spotify_capture_for_pid(takeover.generation, current_pid)
}

fn stop_spotify_takeover(mut takeover: ActiveTakeover) -> Result<(), String> {
    takeover.capture.take();
    let routed_pid = takeover.pid();
    let current_pid = find_spotify_root_pid().ok();
    let report = match current_pid {
        Some(pid) if pid != routed_pid => takeover.route.restore_for_spotify_pid(pid),
        _ => takeover.route.restore(),
    }?;
    log_jam_source(&format!(
        "[jam-source] generation {} restored Spotify output: {:?}",
        takeover.generation, report
    ));
    Ok(())
}

async fn next_capture_event(
    active: &mut Option<ActiveTakeover>,
) -> Option<(u64, ProcessCaptureEvent)> {
    match active
        .as_mut()
        .and_then(|takeover| takeover.capture.as_mut())
    {
        Some(capture) => capture
            .events
            .recv()
            .await
            .map(|event| (capture.generation, event)),
        None => std::future::pending().await,
    }
}

async fn wait_for_ambiguous_connection_release(
    transport_grace: Duration,
    shutdown: &AtomicBool,
    preferences: &mut watch::Receiver<JamSourceLocalPreferences>,
    initial_disable_deadline: Option<tokio::time::Instant>,
) -> bool {
    let now = tokio::time::Instant::now();
    let transport_deadline = now + transport_grace;
    let mut disable_deadline = next_disable_fallback_deadline(
        initial_disable_deadline,
        preferences.borrow().takeover_enabled,
        true,
        now,
    );
    let mut preferences_open = true;

    loop {
        let release_deadline = disable_deadline
            .map(|deadline| deadline.min(transport_deadline))
            .unwrap_or(transport_deadline);
        tokio::select! {
            _ = tokio::time::sleep_until(release_deadline) => return true,
            _ = wait_for_shutdown(shutdown) => return false,
            changed = preferences.changed(), if preferences_open => {
                if changed.is_err() {
                    preferences_open = false;
                    continue;
                }
                disable_deadline = next_disable_fallback_deadline(
                    disable_deadline,
                    preferences.borrow().takeover_enabled,
                    true,
                    tokio::time::Instant::now(),
                );
            }
        }
    }
}

async fn send_source_message<S>(
    writer: &mut S,
    message: &SourceMessage<'_>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    send_ws_message(writer, Message::Text(serde_json::to_string(message)?)).await?;
    Ok(())
}

async fn send_ws_message<S>(
    writer: &mut S,
    message: Message,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    send_ws_message_with_timeout(writer, message, WEBSOCKET_SEND_TIMEOUT).await
}

async fn send_ws_message_with_timeout<S>(
    writer: &mut S,
    message: Message,
    timeout: Duration,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    tokio::time::timeout(timeout, writer.send(message))
        .await
        .map_err(|_| {
            reconnect_error(format!(
                "WebSocket send timed out after {}ms",
                timeout.as_millis()
            ))
        })??;
    Ok(())
}

async fn wait_or_shutdown(duration: Duration, shutdown: &AtomicBool) -> bool {
    let deadline = tokio::time::sleep(duration);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return shutdown.load(Ordering::SeqCst),
            _ = tokio::time::sleep(SHUTDOWN_POLL_INTERVAL) => {
                if shutdown.load(Ordering::SeqCst) {
                    return true;
                }
            }
        }
    }
}

async fn wait_for_shutdown(shutdown: &AtomicBool) {
    while !shutdown.load(Ordering::SeqCst) {
        tokio::time::sleep(SHUTDOWN_POLL_INTERVAL).await;
    }
}

async fn wait_for_optional_deadline(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

fn next_disable_fallback_deadline(
    current: Option<tokio::time::Instant>,
    takeover_enabled: bool,
    active: bool,
    now: tokio::time::Instant,
) -> Option<tokio::time::Instant> {
    if takeover_enabled || !active {
        None
    } else {
        current.or(Some(now + TAKEOVER_DISABLE_FALLBACK))
    }
}

fn disable_fallback_deadline_after_stop(
    current: Option<tokio::time::Instant>,
    stop_accepted: bool,
) -> Option<tokio::time::Instant> {
    if stop_accepted {
        None
    } else {
        current
    }
}

fn parse_server_command(text: &str) -> Result<ServerCommand, String> {
    serde_json::from_str(text).map_err(|error| format!("invalid source command: {}", error))
}

fn terminal_capture_reconnect_reason(event: &ProcessCaptureEvent) -> Option<String> {
    match event {
        ProcessCaptureEvent::Error(message) => {
            Some(format!("Spotify audio capture failed: {}", message))
        }
        ProcessCaptureEvent::Stopped => Some("Spotify audio capture stopped".to_string()),
        _ => None,
    }
}

fn reconnect_error(message: String) -> Box<dyn std::error::Error + Send + Sync> {
    std::io::Error::other(message).into()
}

fn frame_payload(generation: u64, pcm_f32_le: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(8 + pcm_f32_le.len());
    payload.extend_from_slice(&generation.to_le_bytes());
    payload.extend_from_slice(pcm_f32_le);
    payload
}

fn next_reconnect_delay(current_secs: u64) -> u64 {
    current_secs.saturating_mul(2).min(MAX_RECONNECT_DELAY_SECS)
}

fn build_source_ws_url(server: &str, source_id: &str) -> Result<String, String> {
    let base = server.trim().trim_end_matches('/');
    let ws_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{}", rest)
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{}", rest)
    } else if base.starts_with("wss://") || base.starts_with("ws://") {
        base.to_string()
    } else {
        return Err("Jam source server must use http, https, ws, or wss".to_string());
    };

    Ok(format!(
        "{}/api/jam/source?source_id={}&protocol={}",
        ws_base,
        percent_encode_component(source_id),
        PROTOCOL_VERSION
    ))
}

fn percent_encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn source_config() -> JamSourceConfig {
        JamSourceConfig {
            id: "sam-pc".into(),
            token: "secret".into(),
            silent_output_name: default_silent_output_name(),
        }
    }

    fn temporary_settings_path(test_name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "echo-jam-source-test-{}-{}",
                std::process::id(),
                nonce
            ))
            .join(format!("{}.json", test_name))
    }

    #[test]
    fn builds_authenticated_source_endpoint_without_token_in_url() {
        let url = build_source_ws_url("https://echo.example:9443/", "SAM PC/source").unwrap();
        assert_eq!(
            url,
            "wss://echo.example:9443/api/jam/source?source_id=SAM%20PC%2Fsource&protocol=3"
        );
        assert!(!url.contains("token"));
    }

    #[test]
    fn parses_generation_commands() {
        assert_eq!(
            parse_server_command(r#"{"type":"start","generation":42}"#).unwrap(),
            ServerCommand::Start { generation: 42 }
        );
        assert_eq!(
            parse_server_command(r#"{"type":"stop","generation":43}"#).unwrap(),
            ServerCommand::Stop { generation: 43 }
        );
        assert_eq!(
            parse_server_command(r#"{"type":"restart","generation":42}"#).unwrap(),
            ServerCommand::Restart { generation: 42 }
        );
        assert_eq!(
            parse_server_command(
                r#"{"type":"spotify_connect_repair","request_id":7,"action":"activate"}"#
            )
            .unwrap(),
            ServerCommand::SpotifyConnectRepair {
                request_id: 7,
                action: SpotifyConnectRepairAction::Activate,
            }
        );
        assert_eq!(
            parse_server_command(r#"{"type":"spotify_connect_repair_cancel","request_id":7}"#)
                .unwrap(),
            ServerCommand::SpotifyConnectRepairCancel { request_id: 7 }
        );
    }

    #[test]
    fn spotify_connect_restart_is_single_flight_and_cooled_down() {
        let path = temporary_settings_path("spotify-connect-repair-state");
        let control = JamSourceLocalControl::load(Some(&source_config()), path);

        let guard = control
            .begin_spotify_connect_repair(SpotifyConnectRepairAction::Restart)
            .unwrap();
        assert!(control.spotify_connect_repair_active());
        let concurrent = control.begin_spotify_connect_repair(SpotifyConnectRepairAction::Activate);
        assert!(concurrent
            .err()
            .expect("concurrent repair must fail")
            .contains("already running"));
        drop(guard);
        assert!(!control.spotify_connect_repair_active());

        let cooled_down = control.begin_spotify_connect_repair(SpotifyConnectRepairAction::Restart);
        assert!(cooled_down
            .err()
            .expect("restart cooldown must fail")
            .contains("cooling down"));
        let activation = control
            .begin_spotify_connect_repair(SpotifyConnectRepairAction::Activate)
            .unwrap();
        drop(activation);
    }

    #[test]
    fn binary_frame_prefix_is_little_endian_generation() {
        let pcm = [0_u8, 0, 128, 63];
        let payload = frame_payload(0x0102_0304_0506_0708, &pcm);
        assert_eq!(&payload[..8], &[8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(&payload[8..], &pcm);
    }

    #[test]
    fn reconnect_backoff_is_bounded() {
        assert_eq!(next_reconnect_delay(1), 2);
        assert_eq!(next_reconnect_delay(16), 30);
        assert_eq!(next_reconnect_delay(30), 30);
    }

    #[test]
    fn established_connection_resets_backoff_even_after_later_error() {
        let mut attempt = ConnectionAttemptState::default();
        assert_eq!(attempt.retry_delay_secs(30), 30);

        attempt.mark_websocket_established();
        let later_session_result: Result<(), &str> = Err("Spotify capture stopped");

        assert!(later_session_result.is_err());
        assert_eq!(attempt.retry_delay_secs(30), 1);
    }

    #[test]
    fn source_config_rejects_missing_binding_values() {
        assert!(JamSourceConfig {
            id: "".into(),
            token: "secret".into(),
            silent_output_name: default_silent_output_name(),
        }
        .validate()
        .is_err());
        assert!(JamSourceConfig {
            id: "sam-pc".into(),
            token: "".into(),
            silent_output_name: default_silent_output_name(),
        }
        .validate()
        .is_err());
        assert!(JamSourceConfig {
            id: "sam-pc".into(),
            token: "secret".into(),
            silent_output_name: "".into(),
        }
        .validate()
        .is_err());
    }

    #[test]
    fn source_start_validation_error_is_latched_in_native_snapshot() {
        let path = temporary_settings_path("invalid-source-start");
        let control = JamSourceLocalControl::load(Some(&source_config()), path.clone());
        let error = JamSourceAgent::start(
            "https://echo.invalid".to_string(),
            JamSourceConfig {
                id: "sam-pc".to_string(),
                token: String::new(),
                silent_output_name: default_silent_output_name(),
            },
            control.clone(),
        )
        .err()
        .expect("missing source token must reject startup");

        assert!(error.contains("jam_source.token cannot be empty"));
        assert_eq!(
            control.snapshot().last_error.as_deref(),
            Some(error.as_str())
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn local_source_preferences_default_armed_and_persist_changes() {
        let path = temporary_settings_path("preferences");
        let control = JamSourceLocalControl::load(Some(&source_config()), path.clone());
        assert_eq!(
            control.snapshot(),
            JamSourceLocalControlSnapshot {
                is_source_host: true,
                takeover_enabled: true,
                monitor_enabled: false,
                takeover_active: false,
                agent_running: false,
                target_device_name: DEFAULT_SPOTIFY_ROUTE_TARGET.to_string(),
                last_error: None,
            }
        );

        control.set_takeover_enabled(false).unwrap();
        control.set_monitor_enabled(true).unwrap();
        drop(control);

        let reloaded = JamSourceLocalControl::load(Some(&source_config()), path.clone());
        assert!(!reloaded.snapshot().takeover_enabled);
        assert!(reloaded.snapshot().monitor_enabled);

        let _ = std::fs::remove_file(&path);
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }

    #[test]
    fn corrupt_preferences_fail_closed_and_surface_the_error_until_repaired() {
        let path = temporary_settings_path("corrupt-preferences");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, br#"{"takeover_enabled": "#).unwrap();

        let control = JamSourceLocalControl::load(Some(&source_config()), path.clone());
        let snapshot = control.snapshot();
        assert!(!snapshot.takeover_enabled);
        assert!(!snapshot.monitor_enabled);
        assert!(snapshot
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("Could not parse Jam source settings"));

        control.set_takeover_enabled(true).unwrap();
        let repaired = control.snapshot();
        assert!(repaired.takeover_enabled);
        assert!(repaired.last_error.is_none());
        assert!(load_local_preferences(&path).unwrap().is_some());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn unreadable_preferences_fail_closed_instead_of_using_upgrade_defaults() {
        let path = temporary_settings_path("unreadable-preferences");
        std::fs::create_dir_all(&path).unwrap();

        let control = JamSourceLocalControl::load(Some(&source_config()), path.clone());
        let snapshot = control.snapshot();
        assert!(!snapshot.takeover_enabled);
        assert!(snapshot
            .last_error
            .as_deref()
            .unwrap_or_default()
            .contains("Could not read Jam source settings"));

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn failed_preference_write_does_not_mutate_memory_or_notify_watchers() {
        let path = temporary_settings_path("failed-preference-write");
        let control = JamSourceLocalControl::load(Some(&source_config()), path.clone());
        let preferences_rx = control.subscribe();
        assert!(control.snapshot().takeover_enabled);

        // A directory at the destination makes the atomic replacement fail.
        std::fs::create_dir_all(&path).unwrap();
        let error = control.set_takeover_enabled(false).unwrap_err();
        assert!(error.contains("Could not atomically save Jam source settings"));
        assert!(control.snapshot().takeover_enabled);
        assert!(!preferences_rx.has_changed().unwrap());
        assert_eq!(
            control.snapshot().last_error.as_deref(),
            Some(error.as_str())
        );

        // Once the destination is writable again, a successful durable save
        // clears the latched persistence error and publishes the preference.
        std::fs::remove_dir(&path).unwrap();
        control.set_takeover_enabled(false).unwrap();
        assert!(!control.snapshot().takeover_enabled);
        assert!(control.snapshot().last_error.is_none());
        assert!(preferences_rx.has_changed().unwrap());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn disabled_availability_runs_recovery_but_skips_readiness_validation() {
        let recovery_calls = Cell::new(0);
        let validation_calls = Cell::new(0);
        let result = evaluate_local_availability_with(
            false,
            Some("preferences are corrupt".to_string()),
            || {
                recovery_calls.set(recovery_calls.get() + 1);
                Ok(())
            },
            || {
                validation_calls.set(validation_calls.get() + 1);
                Ok(())
            },
        );

        assert_eq!(result, (false, Some("preferences are corrupt".to_string())));
        assert_eq!(recovery_calls.get(), 1);
        assert_eq!(validation_calls.get(), 0);
    }

    #[test]
    fn recovery_failure_blocks_availability_even_when_takeover_is_disabled() {
        let validation_calls = Cell::new(0);
        let result = evaluate_local_availability_with(
            false,
            None,
            || Err("route recovery failed".to_string()),
            || {
                validation_calls.set(validation_calls.get() + 1);
                Ok(())
            },
        );

        assert_eq!(result, (false, Some("route recovery failed".to_string())));
        assert_eq!(validation_calls.get(), 0);
    }

    #[test]
    fn disable_fallback_is_non_extending_and_clears_on_reenable_or_stop() {
        let now = tokio::time::Instant::now();
        let first = next_disable_fallback_deadline(None, false, true, now).unwrap();
        assert_eq!(first, now + TAKEOVER_DISABLE_FALLBACK);

        let repeated =
            next_disable_fallback_deadline(Some(first), false, true, now + Duration::from_secs(1));
        assert_eq!(repeated, Some(first));
        assert_eq!(
            next_disable_fallback_deadline(Some(first), true, true, now),
            None
        );
        assert_eq!(
            next_disable_fallback_deadline(Some(first), false, false, now),
            None
        );

        assert_eq!(
            disable_fallback_deadline_after_stop(Some(first), false),
            Some(first)
        );
        assert_eq!(
            disable_fallback_deadline_after_stop(Some(first), true),
            None
        );
    }

    #[test]
    fn active_connection_exit_policy_never_restores_before_pause_timeout() {
        assert!(SHUTDOWN_STOP_ACK_TIMEOUT >= Duration::from_secs(16));
        assert_eq!(
            active_connection_exit_policy(false),
            ActiveConnectionExitPolicy::RestoreAfter(Duration::from_secs(36))
        );
        assert_eq!(
            active_connection_exit_policy(true),
            ActiveConnectionExitPolicy::PreserveJournal
        );
    }

    #[tokio::test]
    async fn ambiguous_release_honors_local_reclaim_and_shutdown_preservation() {
        let (_preferences_tx, mut preferences_rx) = watch::channel(JamSourceLocalPreferences {
            takeover_enabled: false,
            monitor_enabled: false,
        });
        let shutdown = AtomicBool::new(false);
        assert!(
            wait_for_ambiguous_connection_release(
                Duration::from_secs(36),
                &shutdown,
                &mut preferences_rx,
                Some(tokio::time::Instant::now()),
            )
            .await
        );

        let (_preferences_tx, mut preferences_rx) = watch::channel(JamSourceLocalPreferences {
            takeover_enabled: true,
            monitor_enabled: false,
        });
        shutdown.store(true, Ordering::SeqCst);
        assert!(
            !wait_for_ambiguous_connection_release(
                Duration::from_secs(36),
                &shutdown,
                &mut preferences_rx,
                None,
            )
            .await
        );
    }

    #[test]
    fn unconfigured_install_cannot_enable_source_controls() {
        let control = JamSourceLocalControl::load(None, temporary_settings_path("unconfigured"));
        let snapshot = control.snapshot();
        assert!(!snapshot.is_source_host);
        assert!(!snapshot.takeover_enabled);
        assert!(control.set_takeover_enabled(true).is_err());
        assert!(control.set_monitor_enabled(true).is_err());
    }

    #[test]
    fn generation_fence_ignores_stale_start_after_stop() {
        let mut fence = GenerationFence::default();
        assert!(fence.accept_start(7, None));
        assert!(fence.accept_stop(7));
        assert!(!fence.accept_start(7, None));
        assert!(!fence.accept_start(6, None));
        assert!(fence.accept_start(8, None));
    }

    #[test]
    fn capture_restart_requires_the_exact_active_unstopped_generation() {
        let mut fence = GenerationFence::default();
        assert!(!fence.accept_restart(7, Some(7)));
        assert!(fence.accept_start(7, None));
        assert!(fence.accept_restart(7, Some(7)));
        assert!(!fence.accept_restart(6, Some(7)));
        assert!(!fence.accept_restart(7, None));
        assert!(fence.accept_stop(7));
        assert!(!fence.accept_restart(7, Some(7)));
        assert!(fence.accept_start(8, None));
        assert!(!fence.accept_restart(7, Some(8)));
        assert!(fence.accept_restart(8, Some(8)));
    }

    #[test]
    fn terminal_capture_events_require_connection_replay() {
        assert!(
            terminal_capture_reconnect_reason(&ProcessCaptureEvent::Error(
                "device invalidated".into()
            ))
            .is_some()
        );
        assert!(terminal_capture_reconnect_reason(&ProcessCaptureEvent::Stopped).is_some());
        assert!(
            terminal_capture_reconnect_reason(&ProcessCaptureEvent::Data(vec![0; 4])).is_none()
        );
    }

    #[tokio::test]
    async fn websocket_send_timeout_breaks_a_stalled_sink() {
        let mut stalled_sink = Box::pin(futures_util::sink::unfold(
            (),
            |(), _message: Message| async move {
                std::future::pending::<Result<(), tokio_tungstenite::tungstenite::Error>>().await
            },
        ));

        let error = send_ws_message_with_timeout(
            &mut stalled_sink,
            Message::Text("heartbeat".into()),
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();

        assert!(error.to_string().contains("WebSocket send timed out"));
    }
}
