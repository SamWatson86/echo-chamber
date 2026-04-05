//! Shared memory control block between hook DLL and Tauri client.
//!
//! Layout: written by DLL (frame_number, width, height, format),
//! read/written by Tauri (target_fps, running, texture_handle).

use std::ptr;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE};
use windows::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    PAGE_READWRITE,
};

/// Control block stored in named shared memory.
/// Both DLL and client read/write specific fields.
#[repr(C)]
#[derive(Debug)]
pub struct CaptureControlBlock {
    /// Set by client. DLL reads this to throttle capture rate.
    pub target_fps: u32,
    /// Set by client. DLL reads this; 0 = stop, 1 = run.
    pub running: u32,
    /// Set by client. NT handle value for the shared texture.
    pub texture_handle: u64,
    /// Set by DLL. Incremented on each captured frame.
    pub frame_number: u64,
    /// Set by DLL. Backbuffer width.
    pub width: u32,
    /// Set by DLL. Backbuffer height.
    pub height: u32,
    /// Set by DLL. 0 = BGRA8, 1 = RGBA8, 2 = R10G10B10A2.
    pub format: u32,
    /// Set by client. Present vtable address (from dummy swapchain in client process).
    /// dxgi.dll is loaded at the same base address in all processes on the same boot,
    /// so the vtable address is valid across processes.
    pub present_addr: u64,
    /// Padding for future use.
    pub _reserved: [u32; 6],
}

/// Name format for the shared memory region.
pub fn control_block_name(pid: u32) -> Vec<u16> {
    let name = format!("Local\\EchoGameCapture_{pid}");
    name.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Name format for the frame-ready event.
pub fn frame_event_name(pid: u32) -> Vec<u16> {
    let name = format!("Local\\EchoFrameReady_{pid}");
    name.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Handle to a mapped control block (owns the mapping).
pub struct ControlBlockHandle {
    pub ptr: *mut CaptureControlBlock,
    map_handle: HANDLE,
    view: *mut std::ffi::c_void,
}

unsafe impl Send for ControlBlockHandle {}
unsafe impl Sync for ControlBlockHandle {}

impl ControlBlockHandle {
    /// Create a new shared memory region (called by Tauri client).
    pub fn create(pid: u32) -> Result<Self, String> {
        let name = control_block_name(pid);
        let size = std::mem::size_of::<CaptureControlBlock>() as u32;
        unsafe {
            let handle = CreateFileMappingW(
                HANDLE(-1isize as _), // INVALID_HANDLE_VALUE = page file backed
                None,
                PAGE_READWRITE,
                0,
                size,
                PCWSTR(name.as_ptr()),
            )
            .map_err(|e| format!("CreateFileMapping: {e}"))?;

            let view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, 0);
            if view.Value.is_null() {
                let _ = CloseHandle(handle);
                return Err("MapViewOfFile returned null".into());
            }

            let ptr = view.Value as *mut CaptureControlBlock;
            // Zero-initialize
            ptr::write_bytes(ptr, 0, 1);

            Ok(Self {
                ptr,
                map_handle: handle,
                view: view.Value,
            })
        }
    }

    /// Open an existing shared memory region (called by hook DLL).
    pub fn open(pid: u32) -> Result<Self, String> {
        let name = control_block_name(pid);
        unsafe {
            let handle = OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, BOOL(0), PCWSTR(name.as_ptr()))
                .map_err(|e| format!("OpenFileMapping: {e}"))?;

            let view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, 0);
            if view.Value.is_null() {
                let _ = CloseHandle(handle);
                return Err("MapViewOfFile returned null".into());
            }

            let ptr = view.Value as *mut CaptureControlBlock;
            Ok(Self {
                ptr,
                map_handle: handle,
                view: view.Value,
            })
        }
    }

    pub fn block(&self) -> &CaptureControlBlock {
        unsafe { &*self.ptr }
    }

    pub fn block_mut(&self) -> &mut CaptureControlBlock {
        unsafe { &mut *self.ptr }
    }
}

impl Drop for ControlBlockHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = UnmapViewOfFile(std::mem::transmute(self.view));
            let _ = CloseHandle(self.map_handle);
        }
    }
}
