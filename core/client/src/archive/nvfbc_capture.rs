//! NVFBC (NVIDIA Frame Buffer Capture) + LiveKit publishing.
//!
//! Captures the GPU scanout buffer — works with every game regardless of
//! DX11/DX12/Vulkan, DLSS Frame Generation, HDR, anti-cheat.
//! The composited GPU output is grabbed to system memory as ARGB,
//! converted to I420 via libyuv, and published through NativeVideoSource.
//!
//! Pipeline:
//!   NVFBC ToSys (GPU scanout → ARGB system memory)
//!     → libyuv ARGB→I420
//!       → NativeVideoSource::capture_frame
//!         → libwebrtc H264 encoder (NVENC on NVIDIA GPUs)
//!           → RTP → SFU

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::AppHandle;
use tauri::Emitter;

use livekit::prelude::*;
use livekit::webrtc::prelude::*;
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::native::yuv_helper;
use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};

// ── NvFBC FFI Types ──

/// NvFBC uses a legacy COM-style interface on Windows.
/// Entry points: NvFBC_SetGlobalFlags, NvFBC_GetStatusEx, NvFBC_CreateEx.
/// CreateEx returns an INvFBCToSys interface pointer with virtual methods.
mod ffi {
    use std::ffi::c_void;

    // Version macro: sizeof(struct) | (version << 16)
    pub const fn struct_version<T>(ver: u32) -> u32 {
        (std::mem::size_of::<T>() as u32) | (ver << 16)
    }

    // ── Status ──

    #[repr(C)]
    pub struct NvFBCStatusEx {
        pub dw_version: u32,
        pub b_is_capture_possible: u32,
        pub b_currently_capturing: u32,
        pub b_can_create_now: u32,
        pub dw_input_width: u32,
        pub dw_input_height: u32,
    }

    impl NvFBCStatusEx {
        pub fn new() -> Self {
            let mut s = Self {
                dw_version: 0,
                b_is_capture_possible: 0,
                b_currently_capturing: 0,
                b_can_create_now: 0,
                dw_input_width: 0,
                dw_input_height: 0,
            };
            s.dw_version = struct_version::<Self>(1);
            s
        }
    }

    // ── Create Parameters ──

    /// Interface type for NvFBC_CreateEx.
    pub const NVFBC_TO_SYS: u32 = 0;
    #[allow(dead_code)]
    pub const NVFBC_SHARED_CUDA: u32 = 1;
    #[allow(dead_code)]
    pub const NVFBC_TO_HW_ENCODER: u32 = 2;

    #[repr(C)]
    pub struct NvFBCCreateParams {
        pub dw_version: u32,
        pub dw_interface_type: u32,
        pub dw_max_display_width: u32,
        pub dw_max_display_height: u32,
        pub p_device: *mut c_void,
        pub p_private_data: *mut c_void,
        pub dw_private_data_size: u32,
        pub dw_interface_version: u32,
        pub p_nvfbc: *mut c_void,             // OUT: interface pointer
        pub dw_nvfbc_version: u32,            // OUT
        _pad1: u32,
        pub p_nvfbc_extended_caps: *mut c_void, // OUT
        pub dw_adapter_idx: u32,
        pub dw_output_id: u32,
        pub p_external_context: *mut c_void,
    }

    impl NvFBCCreateParams {
        pub fn new_tosys() -> Self {
            let mut s = unsafe { std::mem::zeroed::<Self>() };
            s.dw_version = struct_version::<Self>(1);
            s.dw_interface_type = NVFBC_TO_SYS;
            s
        }
    }

    // ── ToSys Setup Parameters ──

    /// Buffer format for ToSys capture.
    pub const NVFBC_TOSYS_ARGB: u32 = 0;
    #[allow(dead_code)]
    pub const NVFBC_TOSYS_RGB: u32 = 1;
    /// YUV 4:2:0 planar (I420-like).
    #[allow(dead_code)]
    pub const NVFBC_TOSYS_YYYYUV420P: u32 = 2;
    #[allow(dead_code)]
    pub const NVFBC_TOSYS_ARGB10: u32 = 6;

    #[repr(C)]
    pub struct NvFBCToSysSetUpParams {
        pub dw_version: u32,
        pub e_mode: u32,             // buffer format
        pub b_with_hw_cursor: u32,
        pub b_diff_map: u32,
        pub pp_buffer: *mut *mut u8, // OUT: pointer to frame buffer pointer
        pub pp_diff_map: *mut *mut u8,
        pub dw_diff_map_scaling_factor: u32,
        _pad1: u32,
    }

    impl NvFBCToSysSetUpParams {
        pub fn new(format: u32, buffer_ptr: *mut *mut u8) -> Self {
            let mut s = unsafe { std::mem::zeroed::<Self>() };
            s.dw_version = struct_version::<Self>(3);
            s.e_mode = format;
            s.b_with_hw_cursor = 1; // include hardware cursor
            s.pp_buffer = buffer_ptr;
            s
        }
    }

    // ── ToSys Grab Frame Parameters ──

    /// Grab mode.
    pub const NVFBC_TOSYS_SOURCEMODE_FULL: u32 = 0;
    #[allow(dead_code)]
    pub const NVFBC_TOSYS_SOURCEMODE_SCALE: u32 = 1;
    pub const NVFBC_TOSYS_SOURCEMODE_CROP: u32 = 2;

    /// Grab flags.
    pub const NVFBC_TOSYS_NOFLAGS: u32 = 0;
    /// Wait for a new frame (don't return stale).
    pub const NVFBC_TOSYS_WAIT_WITH_TIMEOUT: u32 = 1;
    /// Don't wait, grab immediately.
    #[allow(dead_code)]
    pub const NVFBC_TOSYS_NOWAIT: u32 = 2;

    #[repr(C)]
    pub struct NvFBCFrameGrabInfo {
        pub dw_width: u32,
        pub dw_height: u32,
        pub dw_current_frame: u32,
        pub b_is_new_frame: u32,
        pub i64_timestamp: i64,
    }

    #[repr(C)]
    pub struct NvFBCToSysGrabFrameParams {
        pub dw_version: u32,
        pub dw_flags: u32,
        pub e_g_mode: u32,
        pub dw_start_x: u32,
        pub dw_start_y: u32,
        pub dw_target_width: u32,
        pub dw_target_height: u32,
        _pad1: u32,
        pub p_frame_grab_info: *mut NvFBCFrameGrabInfo,
        pub dw_wait_time: u32,
        _pad2: u32,
    }

    impl NvFBCToSysGrabFrameParams {
        pub fn new_full(info: *mut NvFBCFrameGrabInfo, wait_ms: u32) -> Self {
            let mut s = unsafe { std::mem::zeroed::<Self>() };
            s.dw_version = struct_version::<Self>(2);
            s.dw_flags = NVFBC_TOSYS_WAIT_WITH_TIMEOUT;
            s.e_g_mode = NVFBC_TOSYS_SOURCEMODE_FULL;
            s.p_frame_grab_info = info;
            s.dw_wait_time = wait_ms;
            s
        }

        pub fn new_crop(
            x: u32, y: u32, w: u32, h: u32,
            info: *mut NvFBCFrameGrabInfo, wait_ms: u32,
        ) -> Self {
            let mut s = unsafe { std::mem::zeroed::<Self>() };
            s.dw_version = struct_version::<Self>(2);
            s.dw_flags = NVFBC_TOSYS_WAIT_WITH_TIMEOUT;
            s.e_g_mode = NVFBC_TOSYS_SOURCEMODE_CROP;
            s.dw_start_x = x;
            s.dw_start_y = y;
            s.dw_target_width = w;
            s.dw_target_height = h;
            s.p_frame_grab_info = info;
            s.dw_wait_time = wait_ms;
            s
        }
    }

    // ── INvFBCToSys vtable ──
    //
    // The COM-style interface returned by NvFBC_CreateEx has a vtable pointer
    // at offset 0. Vtable layout:
    //   [0] NvFBCToSysSetUp(this, params) -> i32
    //   [1] NvFBCToSysGrabFrame(this, params) -> i32
    //   [2] NvFBCToSysGPUBasedCPUCap (deprecated)
    //   [3] NvFBCToSysRelease(this) -> i32

    pub type SetUpFn = unsafe extern "system" fn(
        this: *mut c_void,
        params: *mut NvFBCToSysSetUpParams,
    ) -> i32;

    pub type GrabFrameFn = unsafe extern "system" fn(
        this: *mut c_void,
        params: *mut NvFBCToSysGrabFrameParams,
    ) -> i32;

    pub type ReleaseFn = unsafe extern "system" fn(this: *mut c_void) -> i32;

    /// Function pointer types for the DLL entry points.
    pub type SetGlobalFlagsFn = unsafe extern "system" fn(flags: u32) -> i32;
    pub type GetStatusExFn = unsafe extern "system" fn(params: *mut NvFBCStatusEx) -> i32;
    pub type CreateExFn = unsafe extern "system" fn(params: *mut NvFBCCreateParams) -> i32;
}

// ── NvFBC Session Wrapper ──

struct NvFbcLib {
    _lib: windows::Win32::Foundation::HMODULE,
    set_global_flags: ffi::SetGlobalFlagsFn,
    get_status_ex: ffi::GetStatusExFn,
    create_ex: ffi::CreateExFn,
}

impl NvFbcLib {
    fn load() -> Result<Self, String> {
        use windows::Win32::System::LibraryLoader::{LoadLibraryW, GetProcAddress};
        use windows::core::w;

        unsafe {
            let lib = LoadLibraryW(w!("NvFBC64.dll"))
                .map_err(|e| format!("Failed to load NvFBC64.dll: {e}"))?;

            let set_global_flags = GetProcAddress(lib, windows::core::s!("NvFBC_SetGlobalFlags"))
                .ok_or("NvFBC_SetGlobalFlags not found")?;
            let get_status_ex = GetProcAddress(lib, windows::core::s!("NvFBC_GetStatusEx"))
                .ok_or("NvFBC_GetStatusEx not found")?;
            let create_ex = GetProcAddress(lib, windows::core::s!("NvFBC_CreateEx"))
                .ok_or("NvFBC_CreateEx not found")?;

            Ok(Self {
                _lib: lib,
                set_global_flags: std::mem::transmute(set_global_flags),
                get_status_ex: std::mem::transmute(get_status_ex),
                create_ex: std::mem::transmute(create_ex),
            })
        }
    }

    fn get_status(&self) -> Result<ffi::NvFBCStatusEx, String> {
        unsafe {
            (self.set_global_flags)(0);
        }
        let mut status = ffi::NvFBCStatusEx::new();
        let r = unsafe { (self.get_status_ex)(&mut status) };
        if r != 0 {
            return Err(format!("NvFBC_GetStatusEx failed: error {r}"));
        }
        Ok(status)
    }

    fn create_tosys(&self) -> Result<NvFbcToSys, String> {
        let status = self.get_status()?;
        eprintln!(
            "[nvfbc] status: capture_possible={} currently_capturing={} can_create={} display={}x{}",
            status.b_is_capture_possible,
            status.b_currently_capturing,
            status.b_can_create_now,
            status.dw_input_width,
            status.dw_input_height,
        );

        if status.b_is_capture_possible == 0 {
            return Err(
                "NVFBC capture not possible. Ensure NvFBCEnable=1 in registry and REBOOT. \
                 Key: HKLM\\SYSTEM\\CurrentControlSet\\Services\\nvlddmkm\\FTS\\NvFBCEnable"
                    .into(),
            );
        }

        let mut params = ffi::NvFBCCreateParams::new_tosys();
        let r = unsafe { (self.create_ex)(&mut params) };
        if r != 0 {
            return Err(format!(
                "NvFBC_CreateEx failed: error {r} (version=0x{:08x}, size={})",
                params.dw_version,
                std::mem::size_of::<ffi::NvFBCCreateParams>(),
            ));
        }

        if params.p_nvfbc.is_null() {
            return Err("NvFBC_CreateEx returned null interface".into());
        }

        eprintln!(
            "[nvfbc] created ToSys interface, NvFBC version=0x{:08x}",
            params.dw_nvfbc_version
        );

        Ok(NvFbcToSys {
            iface: params.p_nvfbc,
            frame_buffer: std::ptr::null_mut(),
        })
    }
}

/// Wrapper around the INvFBCToSys COM-style interface.
struct NvFbcToSys {
    iface: *mut std::ffi::c_void,
    frame_buffer: *mut u8,
}

// SAFETY: The NvFBC interface is used from a single thread (the capture thread).
unsafe impl Send for NvFbcToSys {}

impl NvFbcToSys {
    /// Read a vtable function pointer at the given index.
    unsafe fn vtable_fn<T>(&self, index: usize) -> T {
        let vtable_ptr = *(self.iface as *const *const *const std::ffi::c_void);
        std::mem::transmute_copy(&*vtable_ptr.add(index))
    }

    /// Configure capture: ARGB output to system memory.
    fn setup_argb(&mut self) -> Result<(), String> {
        let mut buffer_ptr: *mut u8 = std::ptr::null_mut();
        let mut params = ffi::NvFBCToSysSetUpParams::new(
            ffi::NVFBC_TOSYS_ARGB,
            &mut buffer_ptr,
        );

        let r = unsafe {
            let set_up: ffi::SetUpFn = self.vtable_fn(0);
            set_up(self.iface, &mut params)
        };

        if r != 0 {
            // Try older version numbers
            for ver in [2u32, 1] {
                params.dw_version = ffi::struct_version::<ffi::NvFBCToSysSetUpParams>(ver);
                let r2 = unsafe {
                    let set_up: ffi::SetUpFn = self.vtable_fn(0);
                    set_up(self.iface, &mut params)
                };
                if r2 == 0 {
                    eprintln!("[nvfbc] SetUp succeeded with version {ver}");
                    self.frame_buffer = buffer_ptr;
                    return Ok(());
                }
            }
            return Err(format!(
                "NvFBCToSysSetUp failed: error {r} (version=0x{:08x})",
                params.dw_version,
            ));
        }

        self.frame_buffer = buffer_ptr;
        eprintln!("[nvfbc] SetUp OK, buffer_ptr={:?}", buffer_ptr);
        Ok(())
    }

    /// Grab a full-screen frame.
    fn grab_frame_full(
        &self,
        info: &mut ffi::NvFBCFrameGrabInfo,
        wait_ms: u32,
    ) -> Result<(), String> {
        let mut params = ffi::NvFBCToSysGrabFrameParams::new_full(info, wait_ms);
        let r = unsafe {
            let grab: ffi::GrabFrameFn = self.vtable_fn(1);
            grab(self.iface, &mut params)
        };
        if r != 0 {
            return Err(format!("GrabFrame failed: error {r}"));
        }
        Ok(())
    }

    /// Grab a cropped region (for windowed games).
    fn grab_frame_crop(
        &self,
        x: u32, y: u32, w: u32, h: u32,
        info: &mut ffi::NvFBCFrameGrabInfo,
        wait_ms: u32,
    ) -> Result<(), String> {
        let mut params = ffi::NvFBCToSysGrabFrameParams::new_crop(x, y, w, h, info, wait_ms);
        let r = unsafe {
            let grab: ffi::GrabFrameFn = self.vtable_fn(1);
            grab(self.iface, &mut params)
        };
        if r != 0 {
            return Err(format!("GrabFrame(crop) failed: error {r}"));
        }
        Ok(())
    }

    /// Release the interface.
    fn release(&self) {
        unsafe {
            let release: ffi::ReleaseFn = self.vtable_fn(3);
            release(self.iface);
        }
    }
}

impl Drop for NvFbcToSys {
    fn drop(&mut self) {
        if !self.iface.is_null() {
            self.release();
            eprintln!("[nvfbc] interface released");
        }
    }
}

// ── Global State ──

struct NvfbcShareHandle {
    running: Arc<AtomicBool>,
}

fn global_state() -> &'static Mutex<Option<NvfbcShareHandle>> {
    static STATE: OnceLock<Mutex<Option<NvfbcShareHandle>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

// ── Public API ──

/// Check if NVFBC is available on this system.
/// Returns (available, reason) — reason explains why it's not available.
/// Does a full probe: load DLL → get status → try creating the ToSys interface.
/// This catches struct misalignment (garbage status values) and driver refusals.
pub fn check_available() -> (bool, String) {
    let lib = match NvFbcLib::load() {
        Ok(l) => l,
        Err(e) => return (false, format!("NvFBC64.dll not loadable: {e}")),
    };

    let status = match lib.get_status() {
        Ok(s) => s,
        Err(e) => return (false, e),
    };

    eprintln!(
        "[nvfbc] status: capture_possible={} currently_capturing={} can_create={} display={}x{}",
        status.b_is_capture_possible, status.b_currently_capturing,
        status.b_can_create_now, status.dw_input_width, status.dw_input_height,
    );

    // Sanity check: if display dimensions are 0 or impossibly large, struct is misaligned
    if status.dw_input_width == 0 || status.dw_input_height == 0
        || status.dw_input_width > 16384 || status.dw_input_height > 16384
    {
        return (false, format!(
            "NVFBC status struct misaligned (display={}x{}, capture_possible={})",
            status.dw_input_width, status.dw_input_height, status.b_is_capture_possible,
        ));
    }

    if status.b_is_capture_possible == 0 {
        return (false, "NVFBC not enabled. Set registry key NvFBCEnable=1 and reboot.".into());
    }

    // Actually try creating the interface — this catches driver refusals (error -2 on GeForce)
    match lib.create_tosys() {
        Ok(_tosys) => {
            (true, format!(
                "NVFBC available, display {}x{}",
                status.dw_input_width, status.dw_input_height,
            ))
        }
        Err(e) => {
            (false, format!("NVFBC status OK but CreateEx failed: {e}"))
        }
    }
}

/// Start NVFBC capture: grab GPU scanout, publish to SFU via LiveKit.
///
/// `hwnd` — the game window handle (used to get crop rect for windowed games).
/// `fullscreen` — if true, capture full monitor (no crop).
/// `sfu_url`, `token` — LiveKit SFU connection params ($screen identity).
pub async fn start(
    hwnd: u64,
    fullscreen: bool,
    sfu_url: String,
    token: String,
    app: AppHandle,
) -> Result<(), String> {
    stop();

    let running = Arc::new(AtomicBool::new(true));

    {
        let mut state = global_state().lock().unwrap();
        *state = Some(NvfbcShareHandle {
            running: running.clone(),
        });
    }

    // Get game PID from HWND for audio capture
    let target_pid = unsafe {
        let mut pid = 0u32;
        let hwnd_val = windows::Win32::Foundation::HWND(hwnd as *mut _);
        windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(hwnd_val, Some(&mut pid));
        pid
    };

    let _ = app.emit("nvfbc-capture-started", target_pid);

    let r2 = running.clone();
    let app2 = app.clone();
    tokio::task::spawn_blocking(move || {
        match capture_loop_blocking(&sfu_url, &token, &app2, &r2, hwnd, fullscreen) {
            Ok(()) => eprintln!("[nvfbc] stopped cleanly"),
            Err(e) => {
                eprintln!("[nvfbc] error: {e}");
                let _ = app2.emit("nvfbc-capture-error", e.to_string());
            }
        }
        let _ = app2.emit("nvfbc-capture-stopped", ());
        let mut state = global_state().lock().unwrap();
        *state = None;
    });

    Ok(())
}

/// Stop the current NVFBC capture.
pub fn stop() {
    let mut state = global_state().lock().unwrap();
    if let Some(handle) = state.take() {
        handle.running.store(false, Ordering::SeqCst);
        eprintln!("[nvfbc] stop requested");
    }
}

/// Returns true if an NVFBC capture is currently running.
pub fn is_running() -> bool {
    global_state().lock().unwrap().is_some()
}

// ── Capture + Publish Loop ──

/// Get the window rect (position + size) for cropping.
fn get_window_rect(hwnd: u64) -> Option<(u32, u32, u32, u32)> {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let hwnd = HWND(hwnd as *mut _);
    let mut rect = RECT::default();
    unsafe {
        if GetWindowRect(hwnd, &mut rect).is_ok() {
            let x = rect.left.max(0) as u32;
            let y = rect.top.max(0) as u32;
            let w = (rect.right - rect.left).max(1) as u32;
            let h = (rect.bottom - rect.top).max(1) as u32;
            Some((x, y, w, h))
        } else {
            None
        }
    }
}

fn capture_loop_blocking(
    sfu_url: &str,
    token: &str,
    app: &AppHandle,
    running: &Arc<AtomicBool>,
    hwnd: u64,
    fullscreen: bool,
) -> Result<(), String> {
    eprintln!("[nvfbc] initializing NVFBC capture...");

    // 1. Load NvFBC and create ToSys interface
    let lib = NvFbcLib::load()?;
    let mut tosys = lib.create_tosys()?;
    tosys.setup_argb()?;

    // Determine capture region
    let crop = if fullscreen {
        None
    } else {
        get_window_rect(hwnd)
    };

    let (init_w, init_h) = match crop {
        Some((_, _, w, h)) => (w, h),
        None => {
            let status = lib.get_status()?;
            (status.dw_input_width, status.dw_input_height)
        }
    };

    eprintln!(
        "[nvfbc] capture region: {}x{} (fullscreen={}, crop={:?})",
        init_w, init_h, fullscreen, crop,
    );

    // 2. Connect to LiveKit SFU as $screen identity (use tokio runtime from blocking thread)
    let rt = tokio::runtime::Handle::current();
    eprintln!("[nvfbc] connecting to SFU: {}", sfu_url);
    let (room, _events) = rt
        .block_on(Room::connect(sfu_url, token, RoomOptions::default()))
        .map_err(|e| format!("SFU connect failed: {e}"))?;

    eprintln!(
        "[nvfbc] connected as {}",
        room.local_participant().identity().as_str(),
    );

    // 3. Create video source and track
    let source = NativeVideoSource::new(
        VideoResolution {
            width: init_w,
            height: init_h,
        },
        true, // is_screencast
    );
    let track = LocalVideoTrack::create_video_track(
        "screen",
        RtcVideoSource::Native(source.clone()),
    );

    // 4. Publish as screenshare with H264 (NVENC on RTX 4090)
    let max_bitrate = 20_000_000u64;
    eprintln!("[nvfbc] max_bitrate={}Mbps", max_bitrate / 1_000_000);

    let publish_options = TrackPublishOptions {
        source: TrackSource::Screenshare,
        video_codec: VideoCodec::H264,
        simulcast: false,
        video_encoding: Some(VideoEncoding {
            max_bitrate,
            max_framerate: 60.0,
        }),
        ..Default::default()
    };
    rt.block_on(
        room.local_participant()
            .publish_track(LocalTrack::Video(track), publish_options),
    )
    .map_err(|e| format!("publish failed: {e}"))?;

    eprintln!("[nvfbc] track published, waiting for negotiation...");

    // Wait for SDP+ICE+DTLS to complete before pushing frames
    std::thread::sleep(std::time::Duration::from_secs(3));

    eprintln!("[nvfbc] starting frame loop");

    // 5. Frame loop
    let mut grab_info = ffi::NvFBCFrameGrabInfo {
        dw_width: 0,
        dw_height: 0,
        dw_current_frame: 0,
        b_is_new_frame: 0,
        i64_timestamp: 0,
    };

    let mut frame_count: u64 = 0;
    let start_time = std::time::Instant::now();
    let mut consecutive_errors = 0u32;
    let target_frame_time = std::time::Duration::from_micros(16_667); // ~60fps

    while running.load(Ordering::SeqCst) {
        let frame_start = std::time::Instant::now();

        // Grab frame from GPU scanout
        let grab_result = match crop {
            Some((x, y, w, h)) => {
                // Re-read window rect each frame in case it moved
                let (cx, cy, cw, ch) = get_window_rect(hwnd).unwrap_or((x, y, w, h));
                tosys.grab_frame_crop(cx, cy, cw, ch, &mut grab_info, 100)
            }
            None => tosys.grab_frame_full(&mut grab_info, 100),
        };

        if let Err(e) = grab_result {
            consecutive_errors += 1;
            if consecutive_errors <= 3 || consecutive_errors % 60 == 0 {
                eprintln!("[nvfbc] grab error #{consecutive_errors}: {e}");
            }
            if consecutive_errors >= 300 {
                // 5 seconds of errors at 60fps
                eprintln!("[nvfbc] too many errors, stopping");
                break;
            }
            // Brief yield before retry
            std::thread::sleep(std::time::Duration::from_millis(16));
            continue;
        }
        consecutive_errors = 0;

        let width = grab_info.dw_width;
        let height = grab_info.dw_height;

        if width == 0 || height == 0 {
            continue;
        }

        // Skip duplicate frames (NVFBC tells us via b_is_new_frame)
        if grab_info.b_is_new_frame == 0 {
            // Brief sleep — no point spinning if no new frame
            std::thread::sleep(std::time::Duration::from_millis(2));
            continue;
        }

        // ARGB buffer: 4 bytes per pixel, width * height
        let frame_size = (width * height * 4) as usize;
        let frame_data = unsafe {
            if tosys.frame_buffer.is_null() {
                eprintln!("[nvfbc] null frame buffer!");
                continue;
            }
            std::slice::from_raw_parts(tosys.frame_buffer, frame_size)
        };

        // Log first few frames for diagnostics
        if frame_count < 3 || frame_count == 60 {
            let sum: u64 = frame_data.iter().take(4000).map(|&b| b as u64).sum();
            let nonzero = frame_data.iter().take(40960).filter(|&&b| b != 0).count();
            eprintln!(
                "[nvfbc] frame {frame_count}: {width}x{height} sum(4000)={sum} nonzero(40960)={nonzero}",
            );
        }

        // Convert ARGB → I420 via libyuv
        // NVFBC ARGB = B8G8R8A8 in memory (little-endian)
        // libyuv expects ARGB = A8R8G8B8 in memory
        // Actually NVFBC outputs 0xAARRGGBB = ARGB in register = BGRA in memory
        // So we use argb_to_i420 which expects ARGB in memory layout
        let stride = width * 4;
        let mut i420 = I420Buffer::new(width, height);
        let (sy, su, sv) = i420.strides();
        let (y, u, v) = i420.data_mut();

        yuv_helper::argb_to_i420(
            frame_data,
            stride,
            y, sy,
            u, su,
            v, sv,
            width as i32,
            height as i32,
        );

        // Push frame to LiveKit
        let vf = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            buffer: i420,
            timestamp_us: start_time.elapsed().as_micros() as i64,
        };
        source.capture_frame(&vf);

        frame_count += 1;

        // Stats every 60 frames
        if frame_count % 60 == 0 {
            let elapsed = start_time.elapsed().as_secs_f64();
            let fps = if elapsed > 0.0 {
                (frame_count as f64 / elapsed) as u32
            } else {
                0
            };
            eprintln!("[nvfbc] {width}x{height} @ {fps}fps ({frame_count} frames)");
            let _ = app.emit(
                "nvfbc-capture-stats",
                serde_json::json!({
                    "fps": fps,
                    "width": width,
                    "height": height,
                    "frames": frame_count,
                    "method": "nvfbc",
                }),
            );
        }

        // Frame pacing — aim for ~60fps
        let elapsed = frame_start.elapsed();
        if elapsed < target_frame_time {
            std::thread::sleep(target_frame_time - elapsed);
        }
    }

    running.store(false, Ordering::SeqCst);
    eprintln!("[nvfbc] shutting down, {} frames captured", frame_count);

    // NvFbcToSys is dropped here, releasing the interface
    drop(tosys);

    // Close the SFU Room
    rt.block_on(room.close()).ok();
    eprintln!("[nvfbc] SFU room closed");

    Ok(())
}
