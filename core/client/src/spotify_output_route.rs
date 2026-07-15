//! Spotify-only Windows audio output routing for the Jam source host.
//!
//! Windows exposes its per-application output preference through the internal
//! `Windows.Media.Internal.AudioPolicyConfig` WinRT factory. This module keeps
//! that undocumented surface isolated on a dedicated MTA thread and wraps it in
//! a transactional lease:
//!
//! 1. Resolve one exact, active render endpoint by friendly name.
//! 2. Snapshot Spotify's role-specific persisted routes.
//! 3. Durably journal the snapshot before changing either role.
//! 4. Set and verify only Spotify's console and multimedia routes.
//! 5. Restore only values that still point at Echo's target (compare-and-swap).
//!
//! It never changes the Windows system default endpoint.
//! A forced process termination cannot run RAII cleanup; in that case the
//! durable journal is recovered by `recover_startup` on the next Echo launch.

use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows::core::{Interface, GUID, HRESULT, HSTRING, PROPVARIANT, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, FILETIME, HANDLE, WAIT_ABANDONED,
    WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT, WIN32_ERROR,
};
use windows::Win32::Media::Audio::{
    eConsole, eMultimedia, eRender, ERole, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::Storage::Packaging::Appx::{GetApplicationUserModelId, GetPackageFamilyName};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{
    CreateMutexW, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, ReleaseMutex,
    WaitForSingleObject, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::WinRT::{
    RoGetActivationFactory, RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED,
};

pub const DEFAULT_SPOTIFY_ROUTE_TARGET: &str = "CABLE Input (VB-Audio Virtual Cable)";

const JOURNAL_VERSION: u32 = 2;
const AUDIO_POLICY_RUNTIME_CLASS: &str = "Windows.Media.Internal.AudioPolicyConfig";
const SPOTIFY_STORE_PACKAGE_PREFIX: &str = "SpotifyAB.SpotifyMusic_";
const SPOTIFY_STORE_APP_SUFFIX: &str = "!Spotify";
const HRESULT_FROM_ERROR_NOT_FOUND: HRESULT = HRESULT(0x8007_0490_u32 as i32);
const DEAD_OWNER_RECOVERY_GRACE: Duration = Duration::from_secs(36);
const ROUTE_TRANSACTION_MUTEX_NAME: &str = r"Local\EchoChamber.SpotifyOutputRoute.Transaction.v1";
const ROUTE_TRANSACTION_MUTEX_WAIT: Duration = Duration::from_secs(5);
const MMDEVAPI_INTERFACE_PREFIX: &str = r"\\?\SWD#MMDEVAPI#";
const AUDIO_RENDER_INTERFACE_SUFFIX: &str = "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PersistedEndpointGetResult {
    Value,
    NoOverride,
}

fn classify_persisted_endpoint_get_result(
    result: HRESULT,
) -> windows_core::Result<PersistedEndpointGetResult> {
    if result == HRESULT_FROM_ERROR_NOT_FOUND {
        Ok(PersistedEndpointGetResult::NoOverride)
    } else {
        result.ok()?;
        Ok(PersistedEndpointGetResult::Value)
    }
}

/// A successfully and uniquely resolved active render endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetEndpoint {
    /// The raw MMDevice endpoint ID returned by `IMMDevice::GetId`.
    pub id: String,
    pub name: String,
}

/// The two application roles Echo changes for Spotify.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteRole {
    Console,
    Multimedia,
}

impl RouteRole {
    const ALL: [Self; 2] = [Self::Console, Self::Multimedia];

    fn windows_role(self) -> ERole {
        match self {
            Self::Console => eConsole,
            Self::Multimedia => eMultimedia,
        }
    }
}

/// What a compare-and-swap restoration did for each role.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RestoreReport {
    /// Roles restored to their exact pre-Echo value.
    pub restored_roles: Vec<RouteRole>,
    /// Roles whose recorded endpoint was unavailable and were safely cleared
    /// to follow the Windows default instead of remaining trapped on CABLE.
    pub cleared_to_default_roles: Vec<RouteRole>,
    /// Roles left alone because another actor changed them after Echo took over.
    pub skipped_changed_roles: Vec<RouteRole>,
}

/// Result of checking for a route journal left by an earlier Echo process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartupRecoveryOutcome {
    NoJournal,
    /// Another Echo process still owns the journal, so recovery did not touch it.
    OwnerStillRunning {
        owner_pid: u32,
    },
    /// The exact journal owner was first observed dead less than the pause
    /// safety window ago. The route and journal remain untouched for retry.
    Deferred {
        owner_pid: u32,
        retry_after: Duration,
    },
    /// Spotify is not currently running. The journal remains for a later retry.
    SpotifyNotRunning {
        previous_pid: u32,
    },
    Restored(RestoreReport),
}

/// Read-only details about an active route lease.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpotifyRouteInfo {
    pub spotify_pid: u32,
    pub target: TargetEndpoint,
}

/// Synchronous handle to the dedicated audio-policy MTA worker.
///
/// Cloning this handle is cheap. The final handle drop synchronously asks the
/// worker to restore any active lease and then joins the worker thread.
#[derive(Clone)]
pub struct SpotifyOutputRouter {
    inner: Arc<RouterInner>,
}

impl SpotifyOutputRouter {
    /// Start the dedicated MTA worker.
    ///
    /// `journal_path` must be a local path owned by Echo (normally under the
    /// Tauri app-data directory). A pre-existing journal is never overwritten.
    pub fn new(journal_path: impl Into<PathBuf>) -> Result<Self, String> {
        let journal_path = journal_path.into();
        let (command_tx, command_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);

        let worker = thread::Builder::new()
            .name("echo-spotify-audio-policy".to_string())
            .spawn(move || worker_main(journal_path, command_rx, ready_tx))
            .map_err(|error| format!("Cannot start Spotify audio-policy worker: {error}"))?;

        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                inner: Arc::new(RouterInner {
                    command_tx,
                    worker: Mutex::new(Some(worker)),
                }),
            }),
            Ok(Err(error)) => {
                let _ = worker.join();
                Err(error)
            }
            Err(error) => {
                let _ = worker.join();
                Err(format!(
                    "Spotify audio-policy worker exited during startup: {error}"
                ))
            }
        }
    }

    /// Resolve `target_name` using an exact, case-sensitive friendly-name
    /// match among active render endpoints. Zero or multiple matches are errors.
    pub fn validate_target(
        &self,
        target_name: impl Into<String>,
    ) -> Result<TargetEndpoint, String> {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.send(WorkerCommand::ValidateTarget {
            target_name: target_name.into(),
            reply: reply_tx,
        })?;
        recv_reply(reply_rx)
    }

    /// Recover a durable journal left by a dead Echo process.
    ///
    /// Pass the currently selected Spotify root PID when available. If it is
    /// `None`, recovery uses the journaled PID only when that process still
    /// exists. A live previous Echo owner always blocks recovery.
    pub fn recover_startup(
        &self,
        current_spotify_root_pid: Option<u32>,
    ) -> Result<StartupRecoveryOutcome, String> {
        validate_optional_pid(current_spotify_root_pid)?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.send(WorkerCommand::RecoverStartup {
            current_spotify_root_pid,
            reply: reply_tx,
        })?;
        recv_reply(reply_rx)
    }

    /// Route one Spotify root process to one exact active render endpoint.
    ///
    /// The returned lease owns restoration. Keep it alive across capture-only
    /// restarts; restore or drop it only when the Jam route should end.
    pub fn acquire(
        &self,
        spotify_root_pid: u32,
        target_name: impl Into<String>,
    ) -> Result<SpotifyOutputRouteLease, String> {
        validate_pid(spotify_root_pid)?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.send(WorkerCommand::Acquire {
            spotify_root_pid,
            target_name: target_name.into(),
            reply: reply_tx,
        })?;
        let active = recv_reply(reply_rx)?;
        Ok(SpotifyOutputRouteLease {
            router: self.clone(),
            lease_id: active.lease_id,
            info: active.info,
            active: true,
        })
    }

    /// Synchronously restore whichever lease is active on this worker.
    ///
    /// `current_spotify_root_pid` supports Spotify process replacement. With
    /// `None`, the journaled PID must still be running.
    pub fn restore_active(
        &self,
        current_spotify_root_pid: Option<u32>,
    ) -> Result<RestoreReport, String> {
        validate_optional_pid(current_spotify_root_pid)?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.send(WorkerCommand::RestoreActive {
            current_spotify_root_pid,
            reply: reply_tx,
        })?;
        recv_reply(reply_rx)
    }

    fn restore_lease(
        &self,
        lease_id: u64,
        current_spotify_root_pid: Option<u32>,
    ) -> Result<RestoreReport, String> {
        validate_optional_pid(current_spotify_root_pid)?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.send(WorkerCommand::RestoreLease {
            lease_id,
            current_spotify_root_pid,
            reply: reply_tx,
        })?;
        recv_reply(reply_rx)
    }

    fn send(&self, command: WorkerCommand) -> Result<(), String> {
        self.inner
            .command_tx
            .send(command)
            .map_err(|_| "Spotify audio-policy worker is not running".to_string())
    }
}

/// RAII ownership of Spotify's temporary per-application route.
///
/// A lease is intentionally not cloneable. `Drop` performs a synchronous,
/// best-effort restoration through the MTA worker.
pub struct SpotifyOutputRouteLease {
    router: SpotifyOutputRouter,
    lease_id: u64,
    info: SpotifyRouteInfo,
    active: bool,
}

impl SpotifyOutputRouteLease {
    pub fn info(&self) -> &SpotifyRouteInfo {
        &self.info
    }

    /// Restore using the originally routed Spotify PID.
    pub fn restore(&mut self) -> Result<RestoreReport, String> {
        self.restore_with_spotify_pid(None)
    }

    /// Restore using a newly selected live Spotify root PID.
    pub fn restore_for_spotify_pid(
        &mut self,
        spotify_root_pid: u32,
    ) -> Result<RestoreReport, String> {
        validate_pid(spotify_root_pid)?;
        self.restore_with_spotify_pid(Some(spotify_root_pid))
    }

    fn restore_with_spotify_pid(
        &mut self,
        spotify_root_pid: Option<u32>,
    ) -> Result<RestoreReport, String> {
        if !self.active {
            return Ok(RestoreReport::default());
        }
        let report = self.router.restore_lease(self.lease_id, spotify_root_pid)?;
        self.active = false;
        Ok(report)
    }
}

impl Drop for SpotifyOutputRouteLease {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        match self.router.restore_lease(self.lease_id, None) {
            Ok(_) => self.active = false,
            Err(error) => {
                eprintln!("[spotify-route] lease drop could not restore Spotify output: {error}")
            }
        }
    }
}

struct RouterInner {
    command_tx: mpsc::Sender<WorkerCommand>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for RouterInner {
    fn drop(&mut self) {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        if self
            .command_tx
            .send(WorkerCommand::Shutdown { reply: reply_tx })
            .is_ok()
        {
            if let Ok(Err(error)) = reply_rx.recv() {
                eprintln!(
                    "[spotify-route] worker shutdown could not restore Spotify output: {error}"
                );
            }
        }

        let worker = self.worker.get_mut().ok().and_then(Option::take);
        if let Some(worker) = worker {
            if worker.join().is_err() {
                eprintln!("[spotify-route] audio-policy worker panicked");
            }
        }
    }
}

fn validate_pid(pid: u32) -> Result<(), String> {
    if pid == 0 {
        Err("Spotify root PID cannot be zero".to_string())
    } else {
        Ok(())
    }
}

fn validate_optional_pid(pid: Option<u32>) -> Result<(), String> {
    match pid {
        Some(pid) => validate_pid(pid),
        None => Ok(()),
    }
}

fn recv_reply<T>(receiver: mpsc::Receiver<Result<T, String>>) -> Result<T, String> {
    receiver
        .recv()
        .map_err(|_| "Spotify audio-policy worker stopped before replying".to_string())?
}

enum WorkerCommand {
    ValidateTarget {
        target_name: String,
        reply: mpsc::SyncSender<Result<TargetEndpoint, String>>,
    },
    RecoverStartup {
        current_spotify_root_pid: Option<u32>,
        reply: mpsc::SyncSender<Result<StartupRecoveryOutcome, String>>,
    },
    Acquire {
        spotify_root_pid: u32,
        target_name: String,
        reply: mpsc::SyncSender<Result<ActiveRoute, String>>,
    },
    RestoreLease {
        lease_id: u64,
        current_spotify_root_pid: Option<u32>,
        reply: mpsc::SyncSender<Result<RestoreReport, String>>,
    },
    RestoreActive {
        current_spotify_root_pid: Option<u32>,
        reply: mpsc::SyncSender<Result<RestoreReport, String>>,
    },
    Shutdown {
        reply: mpsc::SyncSender<Result<(), String>>,
    },
}

#[derive(Clone, Debug)]
struct ActiveRoute {
    lease_id: u64,
    info: SpotifyRouteInfo,
}

fn worker_main(
    journal_path: PathBuf,
    command_rx: mpsc::Receiver<WorkerCommand>,
    ready_tx: mpsc::SyncSender<Result<(), String>>,
) {
    if let Err(error) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        let _ = ready_tx.send(Err(format!(
            "RoInitialize(RO_INIT_MULTITHREADED) failed: {error}"
        )));
        return;
    }

    let backend = match WindowsAudioPolicyBackend::new() {
        Ok(backend) => backend,
        Err(error) => {
            let _ = ready_tx.send(Err(error));
            unsafe { RoUninitialize() };
            return;
        }
    };

    let transaction_mutex = match RouteTransactionMutex::new() {
        Ok(transaction_mutex) => transaction_mutex,
        Err(error) => {
            let _ = ready_tx.send(Err(error));
            drop(backend);
            unsafe { RoUninitialize() };
            return;
        }
    };

    let journal = FileJournalStore::new(journal_path);
    let mut engine = RouteEngine::new(backend, journal);
    let mut active: Option<ActiveRoute> = None;
    let mut next_lease_id = 1_u64;

    if ready_tx.send(Ok(())).is_err() {
        drop(engine);
        unsafe { RoUninitialize() };
        return;
    }

    while let Ok(command) = command_rx.recv() {
        match command {
            WorkerCommand::ValidateTarget { target_name, reply } => {
                let _ = reply.send(engine.validate_target(&target_name));
            }
            WorkerCommand::RecoverStartup {
                current_spotify_root_pid,
                reply,
            } => {
                let result = transaction_mutex.run(|| {
                    if active.is_some() {
                        Err("Cannot run startup recovery while a route lease is active".to_string())
                    } else {
                        engine.recover_startup(current_spotify_root_pid)
                    }
                });
                let _ = reply.send(result);
            }
            WorkerCommand::Acquire {
                spotify_root_pid,
                target_name,
                reply,
            } => {
                let result = transaction_mutex.run(|| {
                    if active.is_some() {
                        Err("A Spotify output route lease is already active".to_string())
                    } else {
                        engine
                            .acquire(std::process::id(), spotify_root_pid, &target_name)
                            .map(|info| {
                                let route = ActiveRoute {
                                    lease_id: next_lease_id,
                                    info,
                                };
                                next_lease_id = next_lease_id.wrapping_add(1).max(1);
                                active = Some(route.clone());
                                route
                            })
                    }
                });
                let _ = reply.send(result);
            }
            WorkerCommand::RestoreLease {
                lease_id,
                current_spotify_root_pid,
                reply,
            } => {
                let result = transaction_mutex.run(|| match active.as_ref() {
                    Some(route) if route.lease_id == lease_id => {
                        engine.restore_active(current_spotify_root_pid)
                    }
                    Some(_) => Err("Spotify output route lease is stale".to_string()),
                    None => Ok(RestoreReport::default()),
                });
                if result.is_ok() && active.as_ref().map(|route| route.lease_id) == Some(lease_id) {
                    active = None;
                }
                let _ = reply.send(result);
            }
            WorkerCommand::RestoreActive {
                current_spotify_root_pid,
                reply,
            } => {
                let result = transaction_mutex.run(|| {
                    if active.is_some() {
                        engine.restore_active(current_spotify_root_pid)
                    } else {
                        Ok(RestoreReport::default())
                    }
                });
                if result.is_ok() {
                    active = None;
                }
                let _ = reply.send(result);
            }
            WorkerCommand::Shutdown { reply } => {
                let result = transaction_mutex.run(|| {
                    if active.is_some() {
                        engine.restore_active(None).map(|_| ())
                    } else {
                        Ok(())
                    }
                });
                // Shutdown has made its one synchronous restoration attempt.
                // A failure keeps the durable journal for startup recovery.
                active = None;
                let _ = reply.send(result);
                break;
            }
        }
    }

    // A disconnected command channel must still make a best-effort restoration.
    if active.is_some() {
        if let Err(error) = transaction_mutex.run(|| engine.restore_active(None).map(|_| ())) {
            eprintln!("[spotify-route] worker exit could not restore Spotify output: {error}");
        }
    }

    drop(engine);
    unsafe { RoUninitialize() };
}

/// Cross-process serialization for the complete journal + audio-policy
/// transaction. Journal publication alone cannot protect against a stale
/// recovery deleting or undoing a newer takeover that reused the same target.
struct RouteTransactionMutex {
    handle: HANDLE,
}

impl RouteTransactionMutex {
    fn new() -> Result<Self, String> {
        Self::open_named(ROUTE_TRANSACTION_MUTEX_NAME)
    }

    fn open_named(name: &str) -> Result<Self, String> {
        let name = HSTRING::from(name);
        let handle = unsafe { CreateMutexW(None, false, &name) }
            .map_err(|error| format!("Cannot open Spotify route transaction mutex: {error}"))?;
        Ok(Self { handle })
    }

    fn run<T>(&self, operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let _guard = self.lock_for(ROUTE_TRANSACTION_MUTEX_WAIT)?;
        operation()
    }

    fn lock_for(&self, timeout: Duration) -> Result<RouteTransactionGuard<'_>, String> {
        let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;
        let wait = unsafe { WaitForSingleObject(self.handle, timeout_ms) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            Ok(RouteTransactionGuard { mutex: self })
        } else if wait == WAIT_TIMEOUT {
            Err(format!(
                "Timed out after {}ms waiting for another Echo process to finish a Spotify route transaction",
                timeout.as_millis()
            ))
        } else if wait == WAIT_FAILED {
            Err(format!(
                "Cannot wait for Spotify route transaction mutex: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Err(format!(
                "Spotify route transaction mutex returned unexpected wait status {}",
                wait.0
            ))
        }
    }
}

impl Drop for RouteTransactionMutex {
    fn drop(&mut self) {
        if let Err(error) = unsafe { CloseHandle(self.handle) } {
            eprintln!("[spotify-route] cannot close route transaction mutex: {error}");
        }
    }
}

struct RouteTransactionGuard<'a> {
    mutex: &'a RouteTransactionMutex,
}

impl Drop for RouteTransactionGuard<'_> {
    fn drop(&mut self) {
        if let Err(error) = unsafe { ReleaseMutex(self.mutex.handle) } {
            eprintln!("[spotify-route] cannot release route transaction mutex: {error}");
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct RouteJournal {
    version: u32,
    owner_pid: u32,
    owner_started_at: u64,
    spotify_pid: u32,
    spotify_identity: SpotifyProcessIdentity,
    target: JournalTarget,
    previous: RoleRoutes,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct SpotifyProcessIdentity {
    package_family: String,
    application_user_model_id: String,
    /// Diagnostic metadata for the session that created the journal. A later
    /// Echo launch still independently requires Spotify to share its current
    /// interactive session, but this historical value is not a stable app ID.
    session_id: u32,
}

impl SpotifyProcessIdentity {
    fn same_store_application_as(&self, other: &Self) -> bool {
        self.package_family
            .eq_ignore_ascii_case(&other.package_family)
            && self
                .application_user_model_id
                .eq_ignore_ascii_case(&other.application_user_model_id)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct JournalTarget {
    endpoint_id: String,
    endpoint_name: String,
    policy_device_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct RoleRoutes {
    console: Option<String>,
    multimedia: Option<String>,
}

impl RoleRoutes {
    fn get(&self, role: RouteRole) -> &Option<String> {
        match role {
            RouteRole::Console => &self.console,
            RouteRole::Multimedia => &self.multimedia,
        }
    }
}

trait AudioPolicyBackend {
    fn find_unique_active_render_endpoint(
        &mut self,
        target_name: &str,
    ) -> Result<TargetEndpoint, String>;

    fn get_persisted_route(
        &mut self,
        spotify_pid: u32,
        role: RouteRole,
    ) -> Result<Option<String>, String>;

    fn set_persisted_route(
        &mut self,
        spotify_pid: u32,
        role: RouteRole,
        policy_device_id: Option<&str>,
    ) -> Result<(), String>;

    /// Returns the process creation timestamp, or `None` when the PID is not
    /// running. The timestamp fences PID reuse during crash recovery.
    fn process_started_at(&mut self, pid: u32) -> Result<Option<u64>, String>;

    /// Validate that `pid` is the same-session Microsoft Store Spotify app and
    /// return the stable package identity used to fence replacement PIDs.
    fn spotify_process_identity(
        &mut self,
        pid: u32,
    ) -> Result<Option<SpotifyProcessIdentity>, String>;
}

trait JournalStore {
    fn load(&self) -> Result<Option<RouteJournal>, String>;
    fn create(&mut self, journal: &RouteJournal) -> Result<(), String>;
    fn remove(&mut self) -> Result<(), String>;
}

struct RouteEngine<B, J> {
    backend: B,
    journal: J,
    pending_dead_owner: Option<DeadOwnerObservation>,
}

struct DeadOwnerObservation {
    owner_pid: u32,
    owner_started_at: u64,
    first_observed_dead: Instant,
}

impl<B: AudioPolicyBackend, J: JournalStore> RouteEngine<B, J> {
    fn new(backend: B, journal: J) -> Self {
        Self {
            backend,
            journal,
            pending_dead_owner: None,
        }
    }

    fn validate_target(&mut self, target_name: &str) -> Result<TargetEndpoint, String> {
        if target_name.is_empty() {
            return Err("Spotify output target name cannot be empty".to_string());
        }
        self.backend.find_unique_active_render_endpoint(target_name)
    }

    fn acquire(
        &mut self,
        owner_pid: u32,
        spotify_pid: u32,
        target_name: &str,
    ) -> Result<SpotifyRouteInfo, String> {
        if self.journal.load()?.is_some() {
            return Err(
                "A Spotify route recovery journal already exists; recover it before acquiring a new route"
                    .to_string(),
            );
        }
        let owner_started_at = self
            .backend
            .process_started_at(owner_pid)?
            .ok_or_else(|| format!("Echo owner PID {owner_pid} is not running"))?;
        let spotify_identity = self
            .backend
            .spotify_process_identity(spotify_pid)?
            .ok_or_else(|| format!("Spotify root PID {spotify_pid} is not running"))?;

        let target = self.validate_target(target_name)?;
        let policy_device_id = pack_render_policy_device_id(&target.id);
        let previous = RoleRoutes {
            console: self
                .backend
                .get_persisted_route(spotify_pid, RouteRole::Console)?,
            multimedia: self
                .backend
                .get_persisted_route(spotify_pid, RouteRole::Multimedia)?,
        };
        let journal = RouteJournal {
            version: JOURNAL_VERSION,
            owner_pid,
            owner_started_at,
            spotify_pid,
            spotify_identity,
            target: JournalTarget {
                endpoint_id: target.id.clone(),
                endpoint_name: target.name.clone(),
                policy_device_id: policy_device_id.clone(),
            },
            previous,
        };

        // This durable write must complete before the first policy mutation.
        self.journal.create(&journal)?;

        for role in RouteRole::ALL {
            let apply_result = self
                .ensure_spotify_identity(spotify_pid, &journal.spotify_identity)
                .and_then(|_| {
                    self.backend
                        .set_persisted_route(spotify_pid, role, Some(&policy_device_id))
                })
                .and_then(|_| {
                    let actual = self.backend.get_persisted_route(spotify_pid, role)?;
                    if route_value_eq(&actual, &Some(policy_device_id.clone())) {
                        Ok(())
                    } else {
                        Err(format!(
                            "Spotify {role:?} route verification failed: expected {policy_device_id:?}, got {actual:?}"
                        ))
                    }
                });

            if let Err(apply_error) = apply_result {
                let rollback_result = self.restore_journal(&journal, spotify_pid);
                return match rollback_result {
                    Ok(_) => Err(format!(
                        "Could not apply Spotify {role:?} route: {apply_error}; partial changes were rolled back"
                    )),
                    Err(rollback_error) => Err(format!(
                        "Could not apply Spotify {role:?} route: {apply_error}; rollback also failed: {rollback_error}"
                    )),
                };
            }
        }

        Ok(SpotifyRouteInfo {
            spotify_pid,
            target,
        })
    }

    fn recover_startup(
        &mut self,
        current_spotify_root_pid: Option<u32>,
    ) -> Result<StartupRecoveryOutcome, String> {
        let journal = match self.load_valid_journal() {
            Ok(Some(journal)) => journal,
            Ok(None) => {
                self.pending_dead_owner = None;
                return Ok(StartupRecoveryOutcome::NoJournal);
            }
            Err(error) => {
                // An unreadable or invalid journal breaks the continuity of
                // the dead-owner observation. Start a fresh safety window
                // after the journal can be validated again.
                self.pending_dead_owner = None;
                return Err(error);
            }
        };

        let owner_started_at = match self.backend.process_started_at(journal.owner_pid) {
            Ok(owner_started_at) => owner_started_at,
            Err(error) => {
                // Unknown is not dead. A failed liveness probe must not count
                // toward the continuously-dead recovery grace.
                self.pending_dead_owner = None;
                return Err(error);
            }
        };
        if owner_started_at == Some(journal.owner_started_at) {
            self.pending_dead_owner = None;
            return Ok(StartupRecoveryOutcome::OwnerStillRunning {
                owner_pid: journal.owner_pid,
            });
        }

        let now = Instant::now();
        let elapsed = match self.pending_dead_owner.as_ref() {
            Some(pending)
                if pending.owner_pid == journal.owner_pid
                    && pending.owner_started_at == journal.owner_started_at =>
            {
                now.saturating_duration_since(pending.first_observed_dead)
            }
            _ => {
                self.pending_dead_owner = Some(DeadOwnerObservation {
                    owner_pid: journal.owner_pid,
                    owner_started_at: journal.owner_started_at,
                    first_observed_dead: now,
                });
                Duration::ZERO
            }
        };
        if elapsed < DEAD_OWNER_RECOVERY_GRACE {
            return Ok(StartupRecoveryOutcome::Deferred {
                owner_pid: journal.owner_pid,
                retry_after: DEAD_OWNER_RECOVERY_GRACE.saturating_sub(elapsed),
            });
        }

        let Some(spotify_pid) = self.select_restore_pid(&journal, current_spotify_root_pid)? else {
            return Ok(StartupRecoveryOutcome::SpotifyNotRunning {
                previous_pid: journal.spotify_pid,
            });
        };

        let report = self.restore_journal(&journal, spotify_pid)?;
        self.pending_dead_owner = None;
        Ok(StartupRecoveryOutcome::Restored(report))
    }

    fn restore_active(
        &mut self,
        current_spotify_root_pid: Option<u32>,
    ) -> Result<RestoreReport, String> {
        let journal = self.load_valid_journal()?.ok_or_else(|| {
            "Active Spotify route has no recovery journal; refusing an unsafe restoration"
                .to_string()
        })?;
        let spotify_pid = self
            .select_restore_pid(&journal, current_spotify_root_pid)?
            .ok_or_else(|| {
                format!(
                    "Spotify is not running; retained route journal for PID {}",
                    journal.spotify_pid
                )
            })?;
        self.restore_journal(&journal, spotify_pid)
    }

    fn select_restore_pid(
        &mut self,
        journal: &RouteJournal,
        current_spotify_root_pid: Option<u32>,
    ) -> Result<Option<u32>, String> {
        let pid = current_spotify_root_pid.unwrap_or(journal.spotify_pid);
        let Some(identity) = self.backend.spotify_process_identity(pid)? else {
            return if current_spotify_root_pid.is_some() {
                Err(format!("Current Spotify root PID {pid} is not running"))
            } else {
                Ok(None)
            };
        };
        if !identity.same_store_application_as(&journal.spotify_identity) {
            return Err(format!(
                "PID {pid} is not the Store Spotify application recorded in Echo's route journal"
            ));
        }
        Ok(Some(pid))
    }

    fn restore_journal(
        &mut self,
        journal: &RouteJournal,
        spotify_pid: u32,
    ) -> Result<RestoreReport, String> {
        self.ensure_spotify_identity(spotify_pid, &journal.spotify_identity)?;
        let mut report = RestoreReport::default();
        let mut failures = Vec::new();
        let target = Some(journal.target.policy_device_id.clone());

        for role in RouteRole::ALL {
            if let Err(error) = self.ensure_spotify_identity(spotify_pid, &journal.spotify_identity)
            {
                failures.push(format!("validate Spotify before {role:?}: {error}"));
                continue;
            }
            let current = match self.backend.get_persisted_route(spotify_pid, role) {
                Ok(current) => current,
                Err(error) => {
                    failures.push(format!("read {role:?}: {error}"));
                    continue;
                }
            };

            if !route_value_eq(&current, &target) {
                report.skipped_changed_roles.push(role);
                continue;
            }

            let previous = journal.previous.get(role);
            let exact_restore = self
                .backend
                .set_persisted_route(spotify_pid, role, previous.as_deref())
                .and_then(|_| {
                    let actual = self.backend.get_persisted_route(spotify_pid, role)?;
                    if route_value_eq(&actual, previous) {
                        Ok(())
                    } else {
                        Err(format!("expected {previous:?}, got {actual:?}"))
                    }
                });

            match exact_restore {
                Ok(()) => report.restored_roles.push(role),
                Err(exact_error) => {
                    // A disconnected pre-Jam endpoint can reject restoration.
                    // The safe degraded state is "follow Windows default", not
                    // leaving Spotify silently pinned to Echo's CABLE target.
                    let clear_result = self
                        .backend
                        .set_persisted_route(spotify_pid, role, None)
                        .and_then(|_| {
                            let actual = self.backend.get_persisted_route(spotify_pid, role)?;
                            if actual.is_none() {
                                Ok(())
                            } else {
                                Err(format!("expected None, got {actual:?}"))
                            }
                        });
                    match clear_result {
                        Ok(()) => report.cleared_to_default_roles.push(role),
                        Err(clear_error) => failures.push(format!(
                            "restore {role:?}: {exact_error}; clear-to-default fallback failed: {clear_error}"
                        )),
                    }
                }
            }
        }

        if failures.is_empty() {
            self.journal.remove()?;
            Ok(report)
        } else {
            Err(format!(
                "Spotify output restoration incomplete (journal retained): {}",
                failures.join("; ")
            ))
        }
    }

    fn ensure_spotify_identity(
        &mut self,
        pid: u32,
        expected: &SpotifyProcessIdentity,
    ) -> Result<(), String> {
        let current = self
            .backend
            .spotify_process_identity(pid)?
            .ok_or_else(|| format!("Spotify PID {pid} is no longer running"))?;
        if current.same_store_application_as(expected) {
            Ok(())
        } else {
            Err(format!(
                "PID {pid} no longer identifies the Store Spotify app recorded in the route journal"
            ))
        }
    }

    fn load_valid_journal(&self) -> Result<Option<RouteJournal>, String> {
        let Some(journal) = self.journal.load()? else {
            return Ok(None);
        };
        if journal.version != JOURNAL_VERSION {
            return Err(format!(
                "Unsupported Spotify route journal version {} (expected {})",
                journal.version, JOURNAL_VERSION
            ));
        }
        if journal.owner_pid == 0 || journal.owner_started_at == 0 || journal.spotify_pid == 0 {
            return Err(
                "Spotify route journal contains an invalid owner/process identity".to_string(),
            );
        }
        if journal.spotify_identity.package_family.is_empty()
            || journal
                .spotify_identity
                .application_user_model_id
                .is_empty()
        {
            return Err("Spotify route journal has an empty app identity".to_string());
        }
        let expected_aumid = format!(
            "{}{}",
            journal.spotify_identity.package_family, SPOTIFY_STORE_APP_SUFFIX
        );
        if !journal
            .spotify_identity
            .package_family
            .get(..SPOTIFY_STORE_PACKAGE_PREFIX.len())
            .map(|prefix| prefix.eq_ignore_ascii_case(SPOTIFY_STORE_PACKAGE_PREFIX))
            .unwrap_or(false)
            || !journal
                .spotify_identity
                .application_user_model_id
                .eq_ignore_ascii_case(&expected_aumid)
        {
            return Err("Spotify route journal has an unexpected Store app identity".to_string());
        }
        let expected_policy_id = pack_render_policy_device_id(&journal.target.endpoint_id);
        if journal.target.endpoint_id.is_empty()
            || journal.target.endpoint_name.is_empty()
            || !journal
                .target
                .policy_device_id
                .eq_ignore_ascii_case(&expected_policy_id)
        {
            return Err("Spotify route journal has an invalid policy endpoint ID".to_string());
        }
        Ok(Some(journal))
    }
}

fn route_value_eq(left: &Option<String>, right: &Option<String>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.eq_ignore_ascii_case(right),
        _ => false,
    }
}

fn pack_render_policy_device_id(endpoint_id: &str) -> String {
    format!("{MMDEVAPI_INTERFACE_PREFIX}{endpoint_id}{AUDIO_RENDER_INTERFACE_SUFFIX}")
}

struct FileJournalStore {
    path: PathBuf,
}

impl FileJournalStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn temporary_path(&self) -> Result<PathBuf, String> {
        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Spotify route journal path has no valid file name".to_string())?;
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        Ok(self.path.with_file_name(format!(
            ".{file_name}.tmp-{}-{sequence}",
            std::process::id()
        )))
    }
}

impl JournalStore for FileJournalStore {
    fn load(&self) -> Result<Option<RouteJournal>, String> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "Cannot read Spotify route journal {}: {error}",
                    self.path.display()
                ))
            }
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|error| {
            format!(
                "Cannot parse Spotify route journal {}: {error}",
                self.path.display()
            )
        })
    }

    fn create(&mut self, journal: &RouteJournal) -> Result<(), String> {
        if self.path.exists() {
            return Err(format!(
                "Spotify route journal already exists at {}",
                self.path.display()
            ));
        }
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create Spotify route journal directory {}: {error}",
                    parent.display()
                )
            })?;
        }

        let bytes = serde_json::to_vec_pretty(journal)
            .map_err(|error| format!("Cannot serialize Spotify route journal: {error}"))?;
        let temporary_path = self.temporary_path()?;
        let write_result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
                .map_err(|error| {
                    format!(
                        "Cannot create temporary Spotify route journal {}: {error}",
                        temporary_path.display()
                    )
                })?;
            file.write_all(&bytes).map_err(|error| {
                format!(
                    "Cannot write temporary Spotify route journal {}: {error}",
                    temporary_path.display()
                )
            })?;
            file.sync_all().map_err(|error| {
                format!(
                    "Cannot flush temporary Spotify route journal {}: {error}",
                    temporary_path.display()
                )
            })?;
            drop(file);

            // Publishing a hard link is atomic and fails when the destination
            // already exists. Unlike `rename`, it cannot clobber a journal won
            // concurrently by another Echo process. Both paths are on the same
            // app-data volume by construction.
            fs::hard_link(&temporary_path, &self.path).map_err(|error| {
                format!(
                    "Cannot exclusively publish Spotify route journal {}: {error}",
                    self.path.display()
                )
            })?;
            Ok(())
        })();

        // After a successful hard-link publication the temporary path is just
        // a second name for the already-synced journal contents.
        let _ = fs::remove_file(&temporary_path);
        write_result
    }

    fn remove(&mut self) -> Result<(), String> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Cannot remove Spotify route journal {}: {error}",
                self.path.display()
            )),
        }
    }
}

// The two interface variants have an identical IInspectable vtable and differ
// only by IID. This is a call-only definition: Echo never implements it.
#[repr(C)]
pub struct AudioPolicyConfigFactoryVtable {
    base: windows_core::IInspectable_Vtbl,
    incomplete_01: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_02: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_03: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_04: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_05: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_06: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_07: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_08: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_09: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_10: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_11: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_12: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_13: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_14: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_15: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_16: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_17: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_18: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    incomplete_19: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    set_persisted_default_audio_endpoint:
        unsafe extern "system" fn(*mut c_void, u32, i32, i32, *mut c_void) -> HRESULT,
    get_persisted_default_audio_endpoint:
        unsafe extern "system" fn(*mut c_void, u32, i32, i32, *mut *mut c_void) -> HRESULT,
    clear_all_persisted_application_default_endpoints:
        unsafe extern "system" fn(*mut c_void) -> HRESULT,
}

windows_core::imp::define_interface!(
    IAudioPolicyConfigFactory21H2,
    AudioPolicyConfigFactoryVtable,
    0xab3d4648_e242_459f_b02f_541c70306324
);
windows_core::imp::define_interface!(
    IAudioPolicyConfigFactoryDownlevel,
    AudioPolicyConfigFactoryVtable,
    0x2a59116d_6c4f_45e0_a74f_707e3fef9258
);

macro_rules! impl_audio_policy_calls {
    ($name:ident) => {
        impl $name {
            unsafe fn set_persisted_default_audio_endpoint(
                &self,
                process_id: u32,
                flow: i32,
                role: i32,
                device_id: *mut c_void,
            ) -> HRESULT {
                (Interface::vtable(self).set_persisted_default_audio_endpoint)(
                    Interface::as_raw(self),
                    process_id,
                    flow,
                    role,
                    device_id,
                )
            }

            unsafe fn get_persisted_default_audio_endpoint(
                &self,
                process_id: u32,
                flow: i32,
                role: i32,
                device_id: *mut *mut c_void,
            ) -> HRESULT {
                (Interface::vtable(self).get_persisted_default_audio_endpoint)(
                    Interface::as_raw(self),
                    process_id,
                    flow,
                    role,
                    device_id,
                )
            }
        }
    };
}

impl_audio_policy_calls!(IAudioPolicyConfigFactory21H2);
impl_audio_policy_calls!(IAudioPolicyConfigFactoryDownlevel);

enum AudioPolicyFactory {
    Windows11(IAudioPolicyConfigFactory21H2),
    Downlevel(IAudioPolicyConfigFactoryDownlevel),
}

impl AudioPolicyFactory {
    fn activate() -> Result<Self, String> {
        let class_name = HSTRING::from(AUDIO_POLICY_RUNTIME_CLASS);
        let windows_11 =
            unsafe { RoGetActivationFactory::<IAudioPolicyConfigFactory21H2>(&class_name) };
        match windows_11 {
            Ok(factory) => Ok(Self::Windows11(factory)),
            Err(windows_11_error) => unsafe {
                RoGetActivationFactory::<IAudioPolicyConfigFactoryDownlevel>(&class_name)
                    .map(Self::Downlevel)
                    .map_err(|downlevel_error| {
                        format!(
                            "Cannot activate {AUDIO_POLICY_RUNTIME_CLASS}: Windows 11 interface failed ({windows_11_error}); downlevel fallback failed ({downlevel_error})"
                        )
                    })
            },
        }
    }

    fn set(&self, process_id: u32, role: ERole, device_id: Option<&str>) -> Result<(), String> {
        let hstring = device_id.map(HSTRING::from);
        let raw_hstring = hstring
            .as_ref()
            .map(|value| unsafe { std::mem::transmute_copy::<HSTRING, *mut c_void>(value) })
            .unwrap_or(std::ptr::null_mut());
        let result = unsafe {
            match self {
                Self::Windows11(factory) => factory.set_persisted_default_audio_endpoint(
                    process_id,
                    eRender.0,
                    role.0,
                    raw_hstring,
                ),
                Self::Downlevel(factory) => factory.set_persisted_default_audio_endpoint(
                    process_id,
                    eRender.0,
                    role.0,
                    raw_hstring,
                ),
            }
        };
        result.ok().map_err(|error| {
            format!(
                "SetPersistedDefaultAudioEndpoint(pid={process_id}, role={}) failed: {error}",
                role.0
            )
        })
    }

    fn get(&self, process_id: u32, role: ERole) -> Result<Option<String>, String> {
        let mut raw_hstring: *mut c_void = std::ptr::null_mut();
        let result = unsafe {
            match self {
                Self::Windows11(factory) => factory.get_persisted_default_audio_endpoint(
                    process_id,
                    eRender.0,
                    role.0,
                    &mut raw_hstring,
                ),
                Self::Downlevel(factory) => factory.get_persisted_default_audio_endpoint(
                    process_id,
                    eRender.0,
                    role.0,
                    &mut raw_hstring,
                ),
            }
        };
        match classify_persisted_endpoint_get_result(result).map_err(|error| {
            format!(
                "GetPersistedDefaultAudioEndpoint(pid={process_id}, role={}) failed: {error}",
                role.0
            )
        })? {
            PersistedEndpointGetResult::NoOverride => return Ok(None),
            PersistedEndpointGetResult::Value => {}
        }

        if raw_hstring.is_null() {
            return Ok(None);
        }
        let value = unsafe { std::mem::transmute::<*mut c_void, HSTRING>(raw_hstring) };
        if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value.to_string_lossy()))
        }
    }
}

struct WindowsAudioPolicyBackend {
    factory: AudioPolicyFactory,
}

impl WindowsAudioPolicyBackend {
    fn new() -> Result<Self, String> {
        AudioPolicyFactory::activate().map(|factory| Self { factory })
    }
}

impl AudioPolicyBackend for WindowsAudioPolicyBackend {
    fn find_unique_active_render_endpoint(
        &mut self,
        target_name: &str,
    ) -> Result<TargetEndpoint, String> {
        enumerate_active_render_endpoints().and_then(|endpoints| {
            let matches = endpoints
                .iter()
                .filter(|endpoint| endpoint.name == target_name)
                .cloned()
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [endpoint] => Ok(endpoint.clone()),
                [] => {
                    let available = endpoints
                        .iter()
                        .map(|endpoint| endpoint.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    Err(format!(
                        "No active render endpoint exactly named {target_name:?}; active endpoints: [{available}]"
                    ))
                }
                _ => Err(format!(
                    "Multiple active render endpoints are exactly named {target_name:?}; refusing an ambiguous Spotify route"
                )),
            }
        })
    }

    fn get_persisted_route(
        &mut self,
        spotify_pid: u32,
        role: RouteRole,
    ) -> Result<Option<String>, String> {
        self.factory.get(spotify_pid, role.windows_role())
    }

    fn set_persisted_route(
        &mut self,
        spotify_pid: u32,
        role: RouteRole,
        policy_device_id: Option<&str>,
    ) -> Result<(), String> {
        self.factory
            .set(spotify_pid, role.windows_role(), policy_device_id)
    }

    fn process_started_at(&mut self, pid: u32) -> Result<Option<u64>, String> {
        let Some(process) = open_process_for_identity(pid)? else {
            return Ok(None);
        };
        process_started_at(&process).map(Some)
    }

    fn spotify_process_identity(
        &mut self,
        pid: u32,
    ) -> Result<Option<SpotifyProcessIdentity>, String> {
        read_store_spotify_identity(pid)
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
struct PropertyKey {
    fmtid: GUID,
    pid: u32,
}

const PKEY_DEVICE_FRIENDLY_NAME: PropertyKey = PropertyKey {
    fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
    pid: 14,
};

fn enumerate_active_render_endpoints() -> Result<Vec<TargetEndpoint>, String> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|error| format!("CoCreateInstance(MMDeviceEnumerator) failed: {error}"))?;
        let collection = enumerator
            .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
            .map_err(|error| format!("EnumAudioEndpoints(eRender) failed: {error}"))?;
        let count = collection
            .GetCount()
            .map_err(|error| format!("Audio endpoint GetCount failed: {error}"))?;
        let mut endpoints = Vec::with_capacity(count as usize);

        for index in 0..count {
            let device = collection
                .Item(index)
                .map_err(|error| format!("Audio endpoint Item({index}) failed: {error}"))?;
            let id_pointer = device
                .GetId()
                .map_err(|error| format!("Audio endpoint GetId({index}) failed: {error}"))?;
            let id = id_pointer
                .to_string()
                .map_err(|error| format!("Audio endpoint ID {index} is invalid UTF-16: {error}"))?;
            CoTaskMemFree(Some(id_pointer.0.cast()));
            let name = get_device_friendly_name(&device).map_err(|error| {
                format!("Cannot read friendly name for audio endpoint {id:?}: {error}")
            })?;
            endpoints.push(TargetEndpoint { id, name });
        }

        Ok(endpoints)
    }
}

fn get_device_friendly_name(device: &IMMDevice) -> Result<String, String> {
    unsafe {
        let device_pointer = Interface::as_raw(device);
        let device_vtable = *(device_pointer as *const *const usize);
        let open_property_store: unsafe extern "system" fn(
            *mut c_void,
            i32,
            *mut *mut c_void,
        ) -> HRESULT = std::mem::transmute(*(device_vtable.add(4)));

        let mut property_store: *mut c_void = std::ptr::null_mut();
        let result = open_property_store(device_pointer, 0, &mut property_store);
        result
            .ok()
            .map_err(|error| format!("IMMDevice::OpenPropertyStore failed: {error}"))?;
        if property_store.is_null() {
            return Err("IMMDevice::OpenPropertyStore returned a null store".to_string());
        }

        let store_vtable = *(property_store as *const *const usize);
        let get_value: unsafe extern "system" fn(
            *mut c_void,
            *const PropertyKey,
            *mut PROPVARIANT,
        ) -> HRESULT = std::mem::transmute(*(store_vtable.add(5)));
        let release: unsafe extern "system" fn(*mut c_void) -> u32 =
            std::mem::transmute(*(store_vtable.add(2)));

        let mut value = PROPVARIANT::new();
        let result = get_value(property_store, &PKEY_DEVICE_FRIENDLY_NAME, &mut value);
        release(property_store);
        result
            .ok()
            .map_err(|error| format!("IPropertyStore::GetValue failed: {error}"))?;

        let name = value.to_string();
        if name.is_empty() {
            Err("PKEY_Device_FriendlyName was empty".to_string())
        } else {
            Ok(name)
        }
    }
}

struct OwnedProcessHandle(HANDLE);

impl Drop for OwnedProcessHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn open_process_for_identity(pid: u32) -> Result<Option<OwnedProcessHandle>, String> {
    if pid == 0 {
        return Ok(None);
    }
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => Ok(Some(OwnedProcessHandle(handle))),
            Err(error) => {
                // OpenProcess reports ERROR_INVALID_PARAMETER for a PID that
                // no longer exists. Every other error is ambiguous (notably
                // access denied) and must fail closed.
                const HRESULT_FROM_ERROR_INVALID_PARAMETER: HRESULT =
                    HRESULT(0x8007_0057_u32 as i32);
                if error.code() == HRESULT_FROM_ERROR_INVALID_PARAMETER {
                    Ok(None)
                } else {
                    Err(format!(
                        "Cannot open process PID {pid} for identity validation: {error}"
                    ))
                }
            }
        }
    }
}

fn process_started_at(process: &OwnedProcessHandle) -> Result<u64, String> {
    unsafe {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user)
            .map_err(|error| format!("GetProcessTimes failed: {error}"))?;
        Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }
}

fn read_store_spotify_identity(pid: u32) -> Result<Option<SpotifyProcessIdentity>, String> {
    let Some(process) = open_process_for_identity(pid)? else {
        return Ok(None);
    };

    let executable_name = process_executable_name(&process)?;
    if !executable_name.eq_ignore_ascii_case("Spotify.exe") {
        return Err(format!(
            "PID {pid} is {executable_name:?}, not Spotify.exe; refusing per-app routing"
        ));
    }

    let package_family = read_app_model_string(
        |length, buffer| unsafe { GetPackageFamilyName(process.0, length, buffer) },
        "GetPackageFamilyName",
    )?;
    if !package_family
        .get(..SPOTIFY_STORE_PACKAGE_PREFIX.len())
        .map(|prefix| prefix.eq_ignore_ascii_case(SPOTIFY_STORE_PACKAGE_PREFIX))
        .unwrap_or(false)
    {
        return Err(format!(
            "PID {pid} has unexpected package family {package_family:?}; expected Microsoft Store Spotify"
        ));
    }

    let application_user_model_id = read_app_model_string(
        |length, buffer| unsafe { GetApplicationUserModelId(process.0, length, buffer) },
        "GetApplicationUserModelId",
    )?;
    let expected_aumid = format!("{package_family}{SPOTIFY_STORE_APP_SUFFIX}");
    if !application_user_model_id.eq_ignore_ascii_case(&expected_aumid) {
        return Err(format!(
            "PID {pid} has unexpected Spotify application ID {application_user_model_id:?}"
        ));
    }

    let current_session = process_session_id(std::process::id())?;
    let spotify_session = process_session_id(pid)?;
    if current_session != spotify_session {
        return Err(format!(
            "Spotify PID {pid} is in Windows session {spotify_session}, but Echo is in session {current_session}"
        ));
    }

    Ok(Some(SpotifyProcessIdentity {
        package_family,
        application_user_model_id,
        session_id: spotify_session,
    }))
}

fn process_executable_name(process: &OwnedProcessHandle) -> Result<String, String> {
    let mut buffer = vec![0_u16; 32_768];
    let mut length = buffer.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .map_err(|error| format!("QueryFullProcessImageNameW failed: {error}"))?;
    }
    let path = String::from_utf16_lossy(&buffer[..length as usize]);
    path.rsplit(['\\', '/'])
        .next()
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Process executable path {path:?} has no file name"))
}

fn read_app_model_string(
    mut call: impl FnMut(*mut u32, PWSTR) -> WIN32_ERROR,
    operation: &str,
) -> Result<String, String> {
    let mut length = 0_u32;
    let size_result = call(&mut length, PWSTR::null());
    if size_result != ERROR_INSUFFICIENT_BUFFER || length == 0 {
        return Err(format!(
            "{operation} size query failed with Win32 error {}",
            size_result.0
        ));
    }

    let mut buffer = vec![0_u16; length as usize];
    let result = call(&mut length, PWSTR(buffer.as_mut_ptr()));
    if result != ERROR_SUCCESS {
        return Err(format!("{operation} failed with Win32 error {}", result.0));
    }
    let string_length = buffer
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(length as usize);
    let value = String::from_utf16(&buffer[..string_length])
        .map_err(|error| format!("{operation} returned invalid UTF-16: {error}"))?;
    if value.is_empty() {
        Err(format!("{operation} returned an empty identity"))
    } else {
        Ok(value)
    }
}

fn process_session_id(pid: u32) -> Result<u32, String> {
    let mut session_id = 0_u32;
    unsafe {
        ProcessIdToSessionId(pid, &mut session_id)
            .map_err(|error| format!("Cannot determine Windows session for PID {pid}: {error}"))?;
    }
    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex};

    const PID: u32 = 4242;
    const OWNER_PID: u32 = 9001;
    const OWNER_STARTED_AT: u64 = 100;
    const SPOTIFY_STARTED_AT: u64 = 200;
    const TARGET_NAME: &str = DEFAULT_SPOTIFY_ROUTE_TARGET;
    const TARGET_ID: &str = "{0.0.0.00000000}.{CABLE}";
    const OLD_CONSOLE: &str = "old-console";
    const OLD_MULTIMEDIA: &str = "old-multimedia";

    #[test]
    fn persisted_endpoint_not_found_means_no_per_app_override() {
        assert_eq!(
            classify_persisted_endpoint_get_result(HRESULT_FROM_ERROR_NOT_FOUND).unwrap(),
            PersistedEndpointGetResult::NoOverride
        );
        assert_eq!(
            classify_persisted_endpoint_get_result(HRESULT(0)).unwrap(),
            PersistedEndpointGetResult::Value
        );
        assert!(classify_persisted_endpoint_get_result(HRESULT(0x8000_4005_u32 as i32)).is_err());
    }

    #[test]
    fn route_transaction_mutex_serializes_independent_threads() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            r"Local\EchoChamber.SpotifyOutputRoute.Test.{}.{sequence}",
            std::process::id()
        );
        let first = RouteTransactionMutex::open_named(&name).unwrap();
        let held = first.lock_for(Duration::from_secs(1)).unwrap();

        let competing_name = name.clone();
        let error = std::thread::spawn(move || {
            let competing = RouteTransactionMutex::open_named(&competing_name).unwrap();
            competing
                .lock_for(Duration::from_millis(25))
                .err()
                .expect("a second thread must not enter the held transaction")
        })
        .join()
        .unwrap();
        assert!(error.contains("Timed out"));

        drop(held);
        let after_release = RouteTransactionMutex::open_named(&name).unwrap();
        let _guard = after_release.lock_for(Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn recorded_session_is_audit_only_for_the_same_store_application() {
        let expected = spotify_identity();
        let mut other_session = expected.clone();
        other_session.session_id += 1;
        let mut other_package = expected.clone();
        other_package.package_family = "Different.Package_family".to_string();
        let mut other_aumid = expected.clone();
        other_aumid.application_user_model_id = "Different.Package_family!Different".to_string();

        assert!(expected.same_store_application_as(&expected));
        assert!(expected.same_store_application_as(&other_session));
        assert!(!expected.same_store_application_as(&other_package));
        assert!(!expected.same_store_application_as(&other_aumid));
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Event {
        JournalCreated,
        Set(RouteRole, Option<String>),
        JournalRemoved,
    }

    #[derive(Default)]
    struct FakeBackend {
        endpoints: Vec<TargetEndpoint>,
        routes: HashMap<(u32, RouteRole), Option<String>>,
        process_starts: HashMap<u32, u64>,
        spotify_identities: HashMap<u32, SpotifyProcessIdentity>,
        fail_set_role: Option<RouteRole>,
        fail_set_values: HashSet<(RouteRole, Option<String>)>,
        fail_process_start_once: bool,
        events: Arc<Mutex<Vec<Event>>>,
    }

    impl FakeBackend {
        fn with_target() -> Self {
            Self {
                endpoints: vec![TargetEndpoint {
                    id: TARGET_ID.to_string(),
                    name: TARGET_NAME.to_string(),
                }],
                process_starts: HashMap::from([
                    (OWNER_PID, OWNER_STARTED_AT),
                    (PID, SPOTIFY_STARTED_AT),
                ]),
                spotify_identities: HashMap::from([(PID, spotify_identity())]),
                ..Default::default()
            }
        }

        fn route(&self, pid: u32, role: RouteRole) -> Option<String> {
            self.routes.get(&(pid, role)).cloned().flatten()
        }
    }

    impl AudioPolicyBackend for FakeBackend {
        fn find_unique_active_render_endpoint(
            &mut self,
            target_name: &str,
        ) -> Result<TargetEndpoint, String> {
            let matches = self
                .endpoints
                .iter()
                .filter(|endpoint| endpoint.name == target_name)
                .cloned()
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [endpoint] => Ok(endpoint.clone()),
                [] => Err("missing target".to_string()),
                _ => Err("ambiguous target".to_string()),
            }
        }

        fn get_persisted_route(
            &mut self,
            spotify_pid: u32,
            role: RouteRole,
        ) -> Result<Option<String>, String> {
            Ok(self.routes.get(&(spotify_pid, role)).cloned().flatten())
        }

        fn set_persisted_route(
            &mut self,
            spotify_pid: u32,
            role: RouteRole,
            policy_device_id: Option<&str>,
        ) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(Event::Set(role, policy_device_id.map(ToOwned::to_owned)));
            if self.fail_set_role == Some(role) {
                self.fail_set_role = None;
                return Err("injected set failure".to_string());
            }
            let requested = policy_device_id.map(ToOwned::to_owned);
            if self.fail_set_values.remove(&(role, requested.clone())) {
                return Err("injected value-specific set failure".to_string());
            }
            self.routes.insert((spotify_pid, role), requested);
            Ok(())
        }

        fn process_started_at(&mut self, pid: u32) -> Result<Option<u64>, String> {
            if self.fail_process_start_once {
                self.fail_process_start_once = false;
                return Err("injected process liveness failure".to_string());
            }
            Ok(self.process_starts.get(&pid).copied())
        }

        fn spotify_process_identity(
            &mut self,
            pid: u32,
        ) -> Result<Option<SpotifyProcessIdentity>, String> {
            if !self.process_starts.contains_key(&pid) {
                return Ok(None);
            }
            Ok(self.spotify_identities.get(&pid).cloned())
        }
    }

    fn spotify_identity() -> SpotifyProcessIdentity {
        SpotifyProcessIdentity {
            package_family: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0".to_string(),
            application_user_model_id: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify".to_string(),
            session_id: 1,
        }
    }

    #[derive(Default)]
    struct MemoryJournal {
        value: Option<RouteJournal>,
        events: Arc<Mutex<Vec<Event>>>,
    }

    impl JournalStore for MemoryJournal {
        fn load(&self) -> Result<Option<RouteJournal>, String> {
            Ok(self.value.clone())
        }

        fn create(&mut self, journal: &RouteJournal) -> Result<(), String> {
            if self.value.is_some() {
                return Err("journal exists".to_string());
            }
            self.events.lock().unwrap().push(Event::JournalCreated);
            self.value = Some(journal.clone());
            Ok(())
        }

        fn remove(&mut self) -> Result<(), String> {
            self.events.lock().unwrap().push(Event::JournalRemoved);
            self.value = None;
            Ok(())
        }
    }

    fn engine_with_routes(
        console: Option<&str>,
        multimedia: Option<&str>,
    ) -> RouteEngine<FakeBackend, MemoryJournal> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut backend = FakeBackend::with_target();
        backend.events = events.clone();
        backend
            .routes
            .insert((PID, RouteRole::Console), console.map(ToOwned::to_owned));
        backend.routes.insert(
            (PID, RouteRole::Multimedia),
            multimedia.map(ToOwned::to_owned),
        );
        let journal = MemoryJournal {
            value: None,
            events,
        };
        RouteEngine::new(backend, journal)
    }

    fn observe_dead_owner_and_age_grace(
        engine: &mut RouteEngine<FakeBackend, MemoryJournal>,
        current_spotify_pid: Option<u32>,
    ) {
        let outcome = engine
            .recover_startup(current_spotify_pid)
            .expect("first dead-owner observation should defer");
        assert!(matches!(
            outcome,
            StartupRecoveryOutcome::Deferred {
                owner_pid: OWNER_PID,
                ..
            }
        ));
        engine
            .pending_dead_owner
            .as_mut()
            .expect("deferred recovery should record the owner")
            .first_observed_dead = Instant::now() - DEAD_OWNER_RECOVERY_GRACE;
    }

    #[test]
    fn target_resolution_fails_closed_for_missing_or_ambiguous_name() {
        let mut missing = RouteEngine::new(FakeBackend::default(), MemoryJournal::default());
        assert_eq!(
            missing.validate_target(TARGET_NAME).unwrap_err(),
            "missing target"
        );

        let endpoint = TargetEndpoint {
            id: TARGET_ID.to_string(),
            name: TARGET_NAME.to_string(),
        };
        let ambiguous_backend = FakeBackend {
            endpoints: vec![endpoint.clone(), endpoint],
            ..Default::default()
        };
        let mut ambiguous = RouteEngine::new(ambiguous_backend, MemoryJournal::default());
        assert_eq!(
            ambiguous.validate_target(TARGET_NAME).unwrap_err(),
            "ambiguous target"
        );
    }

    #[test]
    fn acquire_journals_before_mutation_and_routes_both_roles() {
        let mut engine = engine_with_routes(Some(OLD_CONSOLE), Some(OLD_MULTIMEDIA));
        let info = engine
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect("route should apply");
        let target = pack_render_policy_device_id(TARGET_ID);

        assert_eq!(info.spotify_pid, PID);
        assert_eq!(
            engine.backend.route(PID, RouteRole::Console),
            Some(target.clone())
        );
        assert_eq!(
            engine.backend.route(PID, RouteRole::Multimedia),
            Some(target.clone())
        );
        let events = engine.backend.events.lock().unwrap().clone();
        assert_eq!(events.first(), Some(&Event::JournalCreated));
        assert_eq!(
            engine.journal.value.as_ref().unwrap().previous,
            RoleRoutes {
                console: Some(OLD_CONSOLE.to_string()),
                multimedia: Some(OLD_MULTIMEDIA.to_string()),
            }
        );
    }

    #[test]
    fn partial_apply_failure_rolls_back_and_removes_journal() {
        let mut engine = engine_with_routes(Some(OLD_CONSOLE), Some(OLD_MULTIMEDIA));
        engine.backend.fail_set_role = Some(RouteRole::Multimedia);

        let error = engine
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect_err("second role should fail");

        assert!(error.contains("partial changes were rolled back"));
        assert_eq!(
            engine.backend.route(PID, RouteRole::Console),
            Some(OLD_CONSOLE.to_string())
        );
        assert_eq!(
            engine.backend.route(PID, RouteRole::Multimedia),
            Some(OLD_MULTIMEDIA.to_string())
        );
        assert!(engine.journal.value.is_none());
    }

    #[test]
    fn restore_preserves_none_and_role_specific_previous_values() {
        let mut engine = engine_with_routes(None, Some(OLD_MULTIMEDIA));
        engine
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect("route should apply");

        let report = engine.restore_active(None).expect("route should restore");

        assert_eq!(
            report.restored_roles,
            vec![RouteRole::Console, RouteRole::Multimedia]
        );
        assert_eq!(engine.backend.route(PID, RouteRole::Console), None);
        assert_eq!(
            engine.backend.route(PID, RouteRole::Multimedia),
            Some(OLD_MULTIMEDIA.to_string())
        );
        assert!(engine.journal.value.is_none());
    }

    #[test]
    fn restore_is_compare_and_swap_and_does_not_overwrite_user_change() {
        let mut engine = engine_with_routes(Some(OLD_CONSOLE), Some(OLD_MULTIMEDIA));
        engine
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect("route should apply");
        engine.backend.routes.insert(
            (PID, RouteRole::Console),
            Some("user-selected-route".to_string()),
        );

        let report = engine.restore_active(None).expect("route should restore");

        assert_eq!(report.restored_roles, vec![RouteRole::Multimedia]);
        assert_eq!(report.skipped_changed_roles, vec![RouteRole::Console]);
        assert_eq!(
            engine.backend.route(PID, RouteRole::Console),
            Some("user-selected-route".to_string())
        );
        assert_eq!(
            engine.backend.route(PID, RouteRole::Multimedia),
            Some(OLD_MULTIMEDIA.to_string())
        );
    }

    #[test]
    fn unavailable_previous_endpoint_clears_to_default_instead_of_leaving_cable() {
        let mut engine = engine_with_routes(Some(OLD_CONSOLE), Some(OLD_MULTIMEDIA));
        engine
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect("route should apply");
        engine
            .backend
            .fail_set_values
            .insert((RouteRole::Console, Some(OLD_CONSOLE.to_string())));

        let report = engine
            .restore_active(None)
            .expect("fallback should restore");

        assert_eq!(report.restored_roles, vec![RouteRole::Multimedia]);
        assert_eq!(report.cleared_to_default_roles, vec![RouteRole::Console]);
        assert_eq!(engine.backend.route(PID, RouteRole::Console), None);
        assert_eq!(
            engine.backend.route(PID, RouteRole::Multimedia),
            Some(OLD_MULTIMEDIA.to_string())
        );
        assert!(engine.journal.value.is_none());
    }

    #[test]
    fn startup_recovery_defers_while_previous_owner_is_running() {
        let mut engine = engine_with_routes(Some(OLD_CONSOLE), Some(OLD_MULTIMEDIA));
        engine
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect("route should apply");

        let outcome = engine
            .recover_startup(Some(PID))
            .expect("live owner should be a non-error outcome");

        assert_eq!(
            outcome,
            StartupRecoveryOutcome::OwnerStillRunning {
                owner_pid: OWNER_PID
            }
        );
        assert!(engine.journal.value.is_some());
    }

    #[test]
    fn failed_owner_liveness_probe_resets_the_dead_owner_grace() {
        let mut engine = engine_with_routes(Some(OLD_CONSOLE), Some(OLD_MULTIMEDIA));
        engine
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect("route should apply");
        engine.backend.process_starts.remove(&OWNER_PID);

        let first = engine
            .recover_startup(Some(PID))
            .expect("first dead-owner observation should defer");
        assert!(matches!(first, StartupRecoveryOutcome::Deferred { .. }));
        engine
            .pending_dead_owner
            .as_mut()
            .expect("deferred recovery should record the owner")
            .first_observed_dead = Instant::now() - DEAD_OWNER_RECOVERY_GRACE;

        engine.backend.fail_process_start_once = true;
        assert!(engine.recover_startup(Some(PID)).is_err());
        assert!(engine.pending_dead_owner.is_none());

        let after_unknown = engine
            .recover_startup(Some(PID))
            .expect("confirmed dead owner should begin a fresh grace");
        assert!(matches!(
            after_unknown,
            StartupRecoveryOutcome::Deferred {
                owner_pid: OWNER_PID,
                retry_after
            } if retry_after > Duration::from_secs(35)
        ));
        assert!(engine.journal.value.is_some());
    }

    #[test]
    fn startup_recovery_uses_current_spotify_after_process_and_session_replacement() {
        let replacement_pid = 5151;
        let mut engine = engine_with_routes(Some(OLD_CONSOLE), Some(OLD_MULTIMEDIA));
        engine
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect("route should apply");
        let target = pack_render_policy_device_id(TARGET_ID);
        engine.backend.process_starts.remove(&OWNER_PID);
        engine.backend.process_starts.remove(&PID);
        engine
            .backend
            .process_starts
            .insert(replacement_pid, SPOTIFY_STARTED_AT + 1);
        let mut replacement_identity = spotify_identity();
        replacement_identity.session_id += 1;
        engine
            .backend
            .spotify_identities
            .insert(replacement_pid, replacement_identity);
        engine
            .backend
            .routes
            .insert((replacement_pid, RouteRole::Console), Some(target.clone()));
        engine
            .backend
            .routes
            .insert((replacement_pid, RouteRole::Multimedia), Some(target));

        let mutation_count_before_recovery = engine.backend.events.lock().unwrap().len();
        let first_outcome = engine
            .recover_startup(Some(replacement_pid))
            .expect("first dead-owner observation should defer");
        assert!(matches!(
            first_outcome,
            StartupRecoveryOutcome::Deferred {
                owner_pid: OWNER_PID,
                ..
            }
        ));
        assert!(engine.journal.value.is_some());
        assert_eq!(
            engine.backend.events.lock().unwrap().len(),
            mutation_count_before_recovery,
            "deferred recovery must not mutate either route"
        );
        engine
            .pending_dead_owner
            .as_mut()
            .expect("deferred recovery should record the owner")
            .first_observed_dead = Instant::now() - DEAD_OWNER_RECOVERY_GRACE;

        let outcome = engine
            .recover_startup(Some(replacement_pid))
            .expect("aged dead-owner observation should recover");

        assert_eq!(
            outcome,
            StartupRecoveryOutcome::Restored(RestoreReport {
                restored_roles: vec![RouteRole::Console, RouteRole::Multimedia],
                cleared_to_default_roles: Vec::new(),
                skipped_changed_roles: Vec::new(),
            })
        );
        assert_eq!(
            engine.backend.route(replacement_pid, RouteRole::Console),
            Some(OLD_CONSOLE.to_string())
        );
        assert_eq!(
            engine.backend.route(replacement_pid, RouteRole::Multimedia),
            Some(OLD_MULTIMEDIA.to_string())
        );
        assert!(engine.journal.value.is_none());
    }

    #[test]
    fn reused_owner_pid_does_not_block_crash_recovery() {
        let mut engine = engine_with_routes(Some(OLD_CONSOLE), Some(OLD_MULTIMEDIA));
        engine
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect("route should apply");
        engine
            .backend
            .process_starts
            .insert(OWNER_PID, OWNER_STARTED_AT + 1);

        observe_dead_owner_and_age_grace(&mut engine, Some(PID));
        let outcome = engine
            .recover_startup(Some(PID))
            .expect("reused owner PID should be treated as stale");

        assert!(matches!(outcome, StartupRecoveryOutcome::Restored(_)));
        assert!(engine.journal.value.is_none());
    }

    #[test]
    fn replacement_pid_with_different_app_identity_is_rejected_and_journal_is_retained() {
        let replacement_pid = 6262;
        let mut engine = engine_with_routes(Some(OLD_CONSOLE), Some(OLD_MULTIMEDIA));
        engine
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect("route should apply");
        engine.backend.process_starts.remove(&OWNER_PID);
        engine
            .backend
            .process_starts
            .insert(replacement_pid, SPOTIFY_STARTED_AT + 1);
        let mut different_identity = spotify_identity();
        different_identity.application_user_model_id =
            "Different.Package_family!Different".to_string();
        engine
            .backend
            .spotify_identities
            .insert(replacement_pid, different_identity);

        observe_dead_owner_and_age_grace(&mut engine, Some(replacement_pid));
        let error = engine
            .recover_startup(Some(replacement_pid))
            .expect_err("unrelated replacement PID must fail closed");

        assert!(error.contains("not the Store Spotify application"));
        assert!(engine.journal.value.is_some());
    }

    #[test]
    fn journal_publication_is_exclusive_under_concurrent_creators() {
        use std::sync::Barrier;

        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "echo-spotify-journal-race-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("unique test directory should be created");
        let path = directory.join("route.json");

        let mut source = engine_with_routes(Some(OLD_CONSOLE), Some(OLD_MULTIMEDIA));
        source
            .acquire(OWNER_PID, PID, TARGET_NAME)
            .expect("sample journal should be created");
        let journal = source.journal.value.clone().unwrap();
        let barrier = Arc::new(Barrier::new(2));

        let handles = (0..2)
            .map(|_| {
                let path = path.clone();
                let journal = journal.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut store = FileJournalStore::new(path);
                    barrier.wait();
                    store.create(&journal)
                })
            })
            .collect::<Vec<_>>();
        let results = handles
            .into_iter()
            .map(|handle| handle.join().expect("journal writer should not panic"))
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        let published = FileJournalStore::new(path.clone())
            .load()
            .expect("published journal should parse")
            .expect("published journal should exist");
        assert_eq!(published, journal);

        fs::remove_file(&path).expect("published journal should be removable");
        fs::remove_dir(&directory).expect("empty test directory should be removable");
    }

    /// Manual integration test. It is both ignored and environment guarded
    /// because it temporarily changes the running Spotify app's route.
    #[test]
    #[ignore = "set ECHO_SPOTIFY_ROUTE_TEST_PID to a live Spotify root PID to run"]
    fn windows_spotify_route_round_trip() {
        let Ok(pid) = std::env::var("ECHO_SPOTIFY_ROUTE_TEST_PID") else {
            return;
        };
        let pid = pid
            .parse::<u32>()
            .expect("ECHO_SPOTIFY_ROUTE_TEST_PID must be a PID");
        let journal_path = std::env::temp_dir().join(format!(
            "echo-spotify-route-integration-{}-{pid}.json",
            std::process::id()
        ));
        assert!(
            !journal_path.exists(),
            "refusing to overwrite existing integration-test journal {}",
            journal_path.display()
        );

        let system_default_before = current_default_render_endpoint_id();
        let router = SpotifyOutputRouter::new(&journal_path).expect("worker should start");
        let target = router
            .validate_target(DEFAULT_SPOTIFY_ROUTE_TARGET)
            .expect("CABLE Input must resolve uniquely");
        let mut lease = router
            .acquire(pid, DEFAULT_SPOTIFY_ROUTE_TARGET)
            .expect("Spotify route should apply");
        assert_eq!(lease.info().target, target);
        let report = lease.restore().expect("Spotify route should restore");
        assert_eq!(
            report.restored_roles,
            vec![RouteRole::Console, RouteRole::Multimedia]
        );
        assert_eq!(
            current_default_render_endpoint_id(),
            system_default_before,
            "Spotify-only routing must never change the Windows default endpoint"
        );
        assert!(!journal_path.exists());
    }

    fn current_default_render_endpoint_id() -> String {
        use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .expect("integration-test COM initialization should succeed");
            let result = (|| {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                        .expect("default endpoint enumerator should be created");
                let device = enumerator
                    .GetDefaultAudioEndpoint(eRender, eMultimedia)
                    .expect("default render endpoint should exist");
                let id_pointer = device.GetId().expect("default endpoint should have an ID");
                let id = id_pointer
                    .to_string()
                    .expect("default endpoint ID should be valid UTF-16");
                CoTaskMemFree(Some(id_pointer.0.cast()));
                id
            })();
            CoUninitialize();
            result
        }
    }
}
