//! Hook IDXGISwapChain::Present (DX11 + DX12).
//!
//! DX11: GetBuffer → ID3D11Texture2D → CopyResource → shared texture
//! DX12: GetBuffer → CopyTextureRegion on game's queue → CPU readback → shared texture

use std::ptr::{self, addr_of, addr_of_mut};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use minhook::MinHook;
use windows::core::{Interface, HRESULT};
use windows::Win32::Foundation::{BOOL, HANDLE};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BOX, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_WRITE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11_CPU_ACCESS_WRITE,
    ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D,
};
use windows::Win32::Graphics::Direct3D12::*;
use windows::Win32::Graphics::Dxgi::IDXGISwapChain;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R10G10B10A2_UNORM};
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcessId, OpenEventW, SetEvent, WaitForSingleObject,
};

use crate::control_block::{frame_event_name, ControlBlockHandle};
use crate::format_convert::FormatConverter;
use crate::shared_texture::SharedTextureWriter;

// ── Globals ──

static mut ORIGINAL_PRESENT: *mut std::ffi::c_void = ptr::null_mut();
static HOOKS_ACTIVE: AtomicBool = AtomicBool::new(false);
static LAST_CAPTURE_US: AtomicU64 = AtomicU64::new(0);
static PRESENT_CALL_COUNT: AtomicU64 = AtomicU64::new(0);
static mut HOOK_STATE: Option<HookState> = None;

static mut DX12_STATE: Option<Dx12State> = None;
static DX12_DETECTED: AtomicBool = AtomicBool::new(false);
static DX12_INIT_ATTEMPTED: AtomicBool = AtomicBool::new(false);

static mut GAME_QUEUE: Option<ID3D12CommandQueue> = None;
static mut GPU_FENCE: Option<ID3D12Fence> = None;
static mut FENCE_EVENT: HANDLE = HANDLE(ptr::null_mut());
static FENCE_VALUE: AtomicU64 = AtomicU64::new(0);
static mut ORIGINAL_EXECUTE_CMD_LISTS: *mut std::ffi::c_void = ptr::null_mut();

// ── Types ──

struct HookState {
    control: ControlBlockHandle,
    texture_writer: SharedTextureWriter,
    frame_event: HANDLE,
    d3d11_converter: Option<FormatConverter>,
}
unsafe impl Send for HookState {}
unsafe impl Sync for HookState {}

/// DX12 capture state: pure D3D12 readback (no D3D11On12).
struct Dx12State {
    d3d12_device: ID3D12Device,
    our_queue: ID3D12CommandQueue,
    cmd_alloc: ID3D12CommandAllocator,
    cmd_list: ID3D12GraphicsCommandList,
    /// Fence for our copy queue completion tracking.
    copy_fence: ID3D12Fence,
    readback: ID3D12Resource,
    staging_tex: Option<ID3D11Texture2D>,
    staging_device: Option<ID3D11Device>,
    staging_context: Option<ID3D11DeviceContext>,
    rb_row_pitch: u32,
    rb_width: u32,
    rb_height: u32,
    bb_format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
    /// Fence value of the in-flight copy on our queue. 0 = no copy pending.
    pending_fence: u64,
}
unsafe impl Send for Dx12State {}
unsafe impl Sync for Dx12State {}

fn needs_format_conversion(format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT) -> bool {
    format != DXGI_FORMAT_R8G8B8A8_UNORM
}

// ── Hook signatures ──

type PresentFn = unsafe extern "system" fn(*mut std::ffi::c_void, u32, u32) -> HRESULT;
type ExecuteCommandListsFn = unsafe extern "system" fn(*mut std::ffi::c_void, u32, *const *mut std::ffi::c_void);

unsafe extern "system" fn hooked_execute_command_lists(
    this: *mut std::ffi::c_void,
    num: u32,
    lists: *const *mut std::ffi::c_void,
) {
    // Log ALL unique queues we see
    static QUEUE_COUNT: AtomicU64 = AtomicU64::new(0);
    let qc = QUEUE_COUNT.fetch_add(1, Ordering::Relaxed);
    if qc < 20 {
        crate::hook_log(&format!("[echo-hook] ECL call #{qc} queue={this:?} lists={num}"));
    }
    if GAME_QUEUE.is_none() {
        let queue = ID3D12CommandQueue::from_raw(this);
        crate::hook_log(&format!("[echo-hook] captured game queue: {this:?}"));
        GAME_QUEUE = Some(queue.clone());
        std::mem::forget(queue);
    }
    let original: ExecuteCommandListsFn =
        std::mem::transmute(addr_of!(ORIGINAL_EXECUTE_CMD_LISTS).read());
    original(this, num, lists);
}

unsafe extern "system" fn hooked_present(
    this: *mut std::ffi::c_void,
    sync_interval: u32,
    flags: u32,
) -> HRESULT {
    let count = PRESENT_CALL_COUNT.fetch_add(1, Ordering::Relaxed);
    if count == 0 {
        crate::hook_log(&format!("[echo-hook] FIRST Present() swapchain={this:?}"));
    } else if count % 300 == 0 {
        crate::hook_log(&format!("[echo-hook] Present #{count}"));
    }
    // For DX11: capture BEFORE Present (works fine)
    if !DX12_DETECTED.load(Ordering::Relaxed) {
        capture_frame(this);
    }
    let original: PresentFn = std::mem::transmute(addr_of!(ORIGINAL_PRESENT).read());
    let result = original(this, sync_interval, flags);
    // For DX12: capture AFTER Present — DXGI guarantees ALL GPU work is done.
    // This avoids needing to fence-sync with multiple game queues (async compute, etc).
    if DX12_DETECTED.load(Ordering::Relaxed) {
        capture_frame(this);
    }
    result
}

// ── Capture ──

unsafe fn capture_frame(swapchain_ptr: *mut std::ffi::c_void) {
    let state = match &mut *addr_of_mut!(HOOK_STATE) {
        Some(s) => s,
        None => return,
    };
    let cb = state.control.block();
    if cb.running == 0 {
        if HOOKS_ACTIVE.load(Ordering::SeqCst) {
            crate::hook_log("[echo-hook] running=0, self-unloading...");
            shutdown();
            let dll = crate::DLL_MODULE.0 as usize;
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let k32 = windows::Win32::System::LibraryLoader::GetModuleHandleW(
                    windows::core::w!("kernel32.dll")).unwrap();
                let proc = windows::Win32::System::LibraryLoader::GetProcAddress(
                    k32, windows::core::s!("FreeLibraryAndExitThread")).unwrap();
                type F = unsafe extern "system" fn(windows::Win32::Foundation::HMODULE, u32) -> !;
                let f: F = std::mem::transmute(proc);
                f(windows::Win32::Foundation::HMODULE(dll as *mut _), 0);
            });
        }
        return;
    }

    // Throttle
    let target_fps = cb.target_fps.max(1);
    let interval_us = 1_000_000u64 / target_fps as u64;
    let now_us = {
        let mut freq = 0i64;
        let mut count = 0i64;
        let _ = windows::Win32::System::Performance::QueryPerformanceFrequency(&mut freq);
        let _ = windows::Win32::System::Performance::QueryPerformanceCounter(&mut count);
        (count as u64 * 1_000_000) / freq as u64
    };
    let last = LAST_CAPTURE_US.load(Ordering::Relaxed);
    if now_us.saturating_sub(last) < interval_us {
        return;
    }
    LAST_CAPTURE_US.store(now_us, Ordering::Relaxed);

    let swapchain = IDXGISwapChain::from_raw(swapchain_ptr);

    if DX12_DETECTED.load(Ordering::Relaxed) {
        capture_dx12(&swapchain, state);
    } else {
        capture_d3d11(&swapchain, state);
    }

    std::mem::forget(swapchain);
}

// ── D3D11 capture (unchanged) ──

unsafe fn capture_d3d11(swapchain: &IDXGISwapChain, state: &mut HookState) {
    match swapchain.GetBuffer::<ID3D11Texture2D>(0) {
        Ok(buf) => {
            static LOGGED: AtomicBool = AtomicBool::new(false);
            if !LOGGED.swap(true, Ordering::Relaxed) {
                crate::hook_log("[echo-hook] D3D11 game detected");
            }
            let device = match buf.GetDevice() { Ok(d) => d, Err(_) => return };
            let context = match device.GetImmediateContext() { Ok(c) => c, Err(_) => return };
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            buf.GetDesc(&mut desc);

            let cb_mut = state.control.block_mut();
            cb_mut.width = desc.Width;
            cb_mut.height = desc.Height;

            let copy_ok = if needs_format_conversion(desc.Format) {
                if state.d3d11_converter.is_none() {
                    match FormatConverter::new(&device) {
                        Ok(c) => state.d3d11_converter = Some(c),
                        Err(e) => { crate::hook_log(&format!("[echo-hook] converter init: {e}")); return; }
                    }
                }
                let conv = state.d3d11_converter.as_mut().unwrap();
                match conv.convert(&device, &context, &buf, &desc) {
                    Some(t) => { let mut d = D3D11_TEXTURE2D_DESC::default(); t.GetDesc(&mut d);
                        state.texture_writer.copy_frame(&device, &context, t, &d) }
                    None => false,
                }
            } else {
                state.texture_writer.copy_frame(&device, &context, &buf, &desc)
            };

            if copy_ok {
                cb_mut.frame_number = cb_mut.frame_number.wrapping_add(1);
                let _ = SetEvent(state.frame_event);
            }
        }
        Err(e) => {
            if !DX12_INIT_ATTEMPTED.swap(true, Ordering::Relaxed) {
                crate::hook_log(&format!("[echo-hook] D3D11 failed: {e} — trying DX12"));
                match init_dx12(swapchain) {
                    Ok(()) => {
                        DX12_DETECTED.store(true, Ordering::SeqCst);
                        capture_dx12(swapchain, state);
                    }
                    Err(err) => crate::hook_log(&format!("[echo-hook] DX12 init FAILED: {err}")),
                }
            }
        }
    }
}

// ── DX12 init ──

unsafe fn init_dx12(swapchain: &IDXGISwapChain) -> Result<(), String> {
    let bb: ID3D12Resource = swapchain.GetBuffer(0)
        .map_err(|e| format!("GetBuffer: {e}"))?;
    let dev: ID3D12Device = {
        let mut d: Option<ID3D12Device> = None;
        bb.GetDevice(&mut d).map_err(|e| format!("GetDevice: {e}"))?;
        d.ok_or("device None")?
    };

    // Fence
    let fence: ID3D12Fence = dev.CreateFence(0, D3D12_FENCE_FLAG_NONE)
        .map_err(|e| format!("CreateFence: {e}"))?;
    let event = CreateEventW(None, BOOL(0), BOOL(0), None)
        .map_err(|e| format!("CreateEvent: {e}"))?;
    addr_of_mut!(GPU_FENCE).write(Some(fence));
    addr_of_mut!(FENCE_EVENT).write(event);

    // Hook ExecuteCommandLists to capture game's queue
    let our_queue: ID3D12CommandQueue = dev.CreateCommandQueue(&D3D12_COMMAND_QUEUE_DESC {
        Type: D3D12_COMMAND_LIST_TYPE_DIRECT, ..Default::default()
    }).map_err(|e| format!("CreateCommandQueue: {e}"))?;
    let vtable = *(our_queue.as_raw() as *const *const *const std::ffi::c_void);
    let exec_addr = *vtable.add(10);
    addr_of_mut!(ORIGINAL_EXECUTE_CMD_LISTS).write(
        MinHook::create_hook(exec_addr as *mut _, hooked_execute_command_lists as *mut _)
            .map_err(|e| format!("hook ECL: {e:?}"))?,
    );
    MinHook::enable_all_hooks().map_err(|e| format!("enable: {e:?}"))?;
    crate::hook_log(&format!("[echo-hook] hooked ExecuteCommandLists at {exec_addr:?}"));

    // Command allocator + list for our copies
    let alloc: ID3D12CommandAllocator = dev.CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT)
        .map_err(|e| format!("CreateCommandAllocator: {e}"))?;
    let cmd: ID3D12GraphicsCommandList = dev.CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, &alloc, None)
        .map_err(|e| format!("CreateCommandList: {e}"))?;
    let _ = cmd.Close(); // Start closed — we'll reset+open per frame

    // Readback buffer — sized for the backbuffer
    let bb_desc = bb.GetDesc();
    let w = bb_desc.Width as u32;
    let h = bb_desc.Height;
    let row_pitch = ((w * 4 + 255) & !255) as u32;
    let buf_size = (row_pitch as u64) * (h as u64);

    let readback: ID3D12Resource = {
        let heap = D3D12_HEAP_PROPERTIES { Type: D3D12_HEAP_TYPE_READBACK, ..Default::default() };
        let desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_BUFFER,
            Width: buf_size,
            Height: 1, DepthOrArraySize: 1, MipLevels: 1,
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Layout: D3D12_TEXTURE_LAYOUT_ROW_MAJOR,
            ..Default::default()
        };
        let mut rb: Option<ID3D12Resource> = None;
        dev.CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &desc,
            D3D12_RESOURCE_STATE_COPY_DEST, None, &mut rb)
            .map_err(|e| format!("CreateReadback: {e}"))?;
        rb.ok_or("readback None")?
    };

    // Create a D3D11 device for the staging texture (to write to shared texture)
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
    };
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    let mut d3d11_dev: Option<ID3D11Device> = None;
    let mut d3d11_ctx: Option<ID3D11DeviceContext> = None;
    D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, None,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION,
        Some(&mut d3d11_dev), None, Some(&mut d3d11_ctx))
        .map_err(|e| format!("D3D11CreateDevice: {e}"))?;

    crate::hook_log(&format!("[echo-hook] DX12 pure readback init OK — {}x{} fmt={}", w, h, bb_desc.Format.0));

    let copy_fence: ID3D12Fence = dev.CreateFence(0, D3D12_FENCE_FLAG_NONE)
        .map_err(|e| format!("CreateCopyFence: {e}"))?;

    addr_of_mut!(DX12_STATE).write(Some(Dx12State {
        d3d12_device: dev,
        our_queue,
        cmd_alloc: alloc,
        cmd_list: cmd,
        copy_fence,
        readback,
        staging_tex: None,
        staging_device: d3d11_dev,
        staging_context: d3d11_ctx,
        rb_row_pitch: row_pitch,
        rb_width: w,
        rb_height: h,
        bb_format: bb_desc.Format,
        pending_fence: 0,
    }));

    Ok(())
}

// ── DX12 capture via pure D3D12 readback ��─

unsafe fn capture_dx12(swapchain: &IDXGISwapChain, state: &mut HookState) {
    let dx = match &mut *addr_of_mut!(DX12_STATE) {
        Some(d) => d,
        None => return,
    };
    let game_queue = match &*addr_of!(GAME_QUEUE) {
        Some(q) => q,
        None => return,
    };
    let fence = match &*addr_of!(GPU_FENCE) {
        Some(f) => f,
        None => return,
    };

    // ONE-TIME: probe all 4 buffers to find which has real data
    static PROBED: AtomicBool = AtomicBool::new(false);
    if !PROBED.swap(true, Ordering::Relaxed) {
        let sc_desc = swapchain.GetDesc();
        let buf_count = sc_desc.map(|d| d.BufferCount).unwrap_or(4);
        for i in 0..buf_count {
            if let Ok(probe_bb) = swapchain.GetBuffer::<ID3D12Resource>(i) {
                let desc = probe_bb.GetDesc();
                let w = desc.Width as u32;
                let h = desc.Height;
                let rp = ((w * 4 + 255) & !255) as u32;
                let sz = (rp as u64) * (h as u64);
                // Quick copy + readback of this buffer
                let heap = D3D12_HEAP_PROPERTIES { Type: D3D12_HEAP_TYPE_READBACK, ..Default::default() };
                let rd = D3D12_RESOURCE_DESC {
                    Dimension: D3D12_RESOURCE_DIMENSION_BUFFER,
                    Width: sz, Height: 1, DepthOrArraySize: 1, MipLevels: 1,
                    SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Layout: D3D12_TEXTURE_LAYOUT_ROW_MAJOR, ..Default::default()
                };
                let mut rb: Option<ID3D12Resource> = None;
                if dx.d3d12_device.CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &rd,
                    D3D12_RESOURCE_STATE_COPY_DEST, None, &mut rb).is_ok() {
                    if let Some(ref rb_res) = rb {
                        let _ = dx.cmd_alloc.Reset();
                        if dx.cmd_list.Reset(&dx.cmd_alloc, None).is_ok() {
                            let b1 = D3D12_RESOURCE_BARRIER {
                                Type: D3D12_RESOURCE_BARRIER_TYPE_TRANSITION,
                                Anonymous: D3D12_RESOURCE_BARRIER_0 {
                                    Transition: std::mem::ManuallyDrop::new(D3D12_RESOURCE_TRANSITION_BARRIER {
                                        pResource: std::mem::ManuallyDrop::new(Some(probe_bb.clone())),
                                        Subresource: D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,
                                        StateBefore: D3D12_RESOURCE_STATE_PRESENT,
                                        StateAfter: D3D12_RESOURCE_STATE_COPY_SOURCE,
                                    }),
                                }, ..Default::default()
                            };
                            dx.cmd_list.ResourceBarrier(&[b1]);
                            let dst_loc = D3D12_TEXTURE_COPY_LOCATION {
                                pResource: std::mem::ManuallyDrop::new(Some(rb_res.clone())),
                                Type: D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT,
                                Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 {
                                    PlacedFootprint: D3D12_PLACED_SUBRESOURCE_FOOTPRINT {
                                        Offset: 0, Footprint: D3D12_SUBRESOURCE_FOOTPRINT {
                                            Format: desc.Format, Width: w, Height: h, Depth: 1, RowPitch: rp,
                                        },
                                    },
                                },
                            };
                            let src_loc = D3D12_TEXTURE_COPY_LOCATION {
                                pResource: std::mem::ManuallyDrop::new(Some(probe_bb.clone())),
                                Type: D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX,
                                Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { SubresourceIndex: 0 },
                            };
                            dx.cmd_list.CopyTextureRegion(&dst_loc, 0, 0, 0, &src_loc, None);
                            let b2 = D3D12_RESOURCE_BARRIER {
                                Type: D3D12_RESOURCE_BARRIER_TYPE_TRANSITION,
                                Anonymous: D3D12_RESOURCE_BARRIER_0 {
                                    Transition: std::mem::ManuallyDrop::new(D3D12_RESOURCE_TRANSITION_BARRIER {
                                        pResource: std::mem::ManuallyDrop::new(Some(probe_bb.clone())),
                                        Subresource: D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,
                                        StateBefore: D3D12_RESOURCE_STATE_COPY_SOURCE,
                                        StateAfter: D3D12_RESOURCE_STATE_PRESENT,
                                    }),
                                }, ..Default::default()
                            };
                            dx.cmd_list.ResourceBarrier(&[b2]);
                            let _ = dx.cmd_list.Close();
                            game_queue.ExecuteCommandLists(&[Some(dx.cmd_list.cast().unwrap())]);
                            let v = FENCE_VALUE.fetch_add(1, Ordering::Relaxed) + 1;
                            let _ = game_queue.Signal(fence, v);
                            let ev = addr_of!(FENCE_EVENT).read();
                            let _ = fence.SetEventOnCompletion(v, ev);
                            WaitForSingleObject(ev, 500);
                            // Map and check
                            let range = D3D12_RANGE { Begin: 0, End: sz as usize };
                            let mut ptr: *mut std::ffi::c_void = std::ptr::null_mut();
                            if rb_res.Map(0, Some(&range), Some(&mut ptr)).is_ok() && !ptr.is_null() {
                                let data = std::slice::from_raw_parts(ptr as *const u8, sz.min(40960) as usize);
                                let sum: u64 = data.iter().take(4000).map(|&b| b as u64).sum();
                                let nz = data.iter().filter(|&&b| b != 0).count();
                                crate::hook_log(&format!(
                                    "[echo-hook] PROBE buf[{i}]: {}x{} sum={sum} nz={nz}", w, h
                                ));
                                let nr = D3D12_RANGE { Begin: 0, End: 0 };
                                rb_res.Unmap(0, Some(&nr));
                            }
                        }
                    }
                }
            }
        }
    }

    // After Present(): current index = NEXT frame's buffer.
    // The just-presented buffer = (current - 1 + count) % count.
    use windows::Win32::Graphics::Dxgi::IDXGISwapChain3;
    let buf_idx = match swapchain.cast::<IDXGISwapChain3>() {
        Ok(sc3) => {
            let current = sc3.GetCurrentBackBufferIndex();
            let count = match swapchain.GetDesc() {
                Ok(d) => d.BufferCount,
                Err(_) => 4,
            };
            let prev = if current == 0 { count - 1 } else { current - 1 };
            static LOGGED_IDX: AtomicBool = AtomicBool::new(false);
            if !LOGGED_IDX.swap(true, Ordering::Relaxed) {
                crate::hook_log(&format!(
                    "[echo-hook] post-Present: current={current} count={count} reading prev={prev}"
                ));
            }
            prev
        }
        Err(_) => 0,
    };
    let bb: ID3D12Resource = match swapchain.GetBuffer(buf_idx) {
        Ok(b) => b,
        Err(_) => return,
    };
    let bb_desc = bb.GetDesc();
    let new_w = bb_desc.Width as u32;
    let new_h = bb_desc.Height;

    // Handle resolution change
    if new_w != dx.rb_width || new_h != dx.rb_height {
        let row_pitch = ((new_w * 4 + 255) & !255) as u32;
        let buf_size = (row_pitch as u64) * (new_h as u64);
        let heap = D3D12_HEAP_PROPERTIES { Type: D3D12_HEAP_TYPE_READBACK, ..Default::default() };
        let desc = D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_BUFFER,
            Width: buf_size, Height: 1, DepthOrArraySize: 1, MipLevels: 1,
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Layout: D3D12_TEXTURE_LAYOUT_ROW_MAJOR,
            ..Default::default()
        };
        let mut rb: Option<ID3D12Resource> = None;
        if dx.d3d12_device.CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &desc,
            D3D12_RESOURCE_STATE_COPY_DEST, None, &mut rb).is_ok() {
            if let Some(new_rb) = rb {
                dx.readback = new_rb;
                dx.rb_row_pitch = row_pitch;
                dx.rb_width = new_w;
                dx.rb_height = new_h;
                dx.bb_format = bb_desc.Format;
                dx.staging_tex = None;
                crate::hook_log(&format!("[echo-hook] readback resized {}x{}", new_w, new_h));
            }
        }
    }

    // Execute copy on game's queue — serialized with rendering, guarantees real pixels.
    // Game still runs at 60fps; our capture rate is lower but functional.
    let _ = dx.cmd_alloc.Reset();
    if dx.cmd_list.Reset(&dx.cmd_alloc, None).is_err() { return; }

    // Barrier: PRESENT → COPY_SOURCE (required for correct reads at 4K)
    let barrier1 = D3D12_RESOURCE_BARRIER {
        Type: D3D12_RESOURCE_BARRIER_TYPE_TRANSITION,
        Anonymous: D3D12_RESOURCE_BARRIER_0 {
            Transition: std::mem::ManuallyDrop::new(D3D12_RESOURCE_TRANSITION_BARRIER {
                pResource: std::mem::ManuallyDrop::new(Some(bb.clone())),
                Subresource: D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,
                StateBefore: D3D12_RESOURCE_STATE_PRESENT,
                StateAfter: D3D12_RESOURCE_STATE_COPY_SOURCE,
            }),
        },
        ..Default::default()
    };
    dx.cmd_list.ResourceBarrier(&[barrier1]);

    let dst = D3D12_TEXTURE_COPY_LOCATION {
        pResource: std::mem::ManuallyDrop::new(Some(dx.readback.clone())),
        Type: D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT,
        Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 {
            PlacedFootprint: D3D12_PLACED_SUBRESOURCE_FOOTPRINT {
                Offset: 0,
                Footprint: D3D12_SUBRESOURCE_FOOTPRINT {
                    Format: bb_desc.Format,
                    Width: dx.rb_width, Height: dx.rb_height, Depth: 1,
                    RowPitch: dx.rb_row_pitch,
                },
            },
        },
    };
    let src = D3D12_TEXTURE_COPY_LOCATION {
        pResource: std::mem::ManuallyDrop::new(Some(bb.clone())),
        Type: D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX,
        Anonymous: D3D12_TEXTURE_COPY_LOCATION_0 { SubresourceIndex: 0 },
    };
    dx.cmd_list.CopyTextureRegion(&dst, 0, 0, 0, &src, None);

    // Barrier back: COPY_SOURCE → PRESENT
    let barrier2 = D3D12_RESOURCE_BARRIER {
        Type: D3D12_RESOURCE_BARRIER_TYPE_TRANSITION,
        Anonymous: D3D12_RESOURCE_BARRIER_0 {
            Transition: std::mem::ManuallyDrop::new(D3D12_RESOURCE_TRANSITION_BARRIER {
                pResource: std::mem::ManuallyDrop::new(Some(bb.clone())),
                Subresource: D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,
                StateBefore: D3D12_RESOURCE_STATE_COPY_SOURCE,
                StateAfter: D3D12_RESOURCE_STATE_PRESENT,
            }),
        },
        ..Default::default()
    };
    dx.cmd_list.ResourceBarrier(&[barrier2]);
    let _ = dx.cmd_list.Close();

    // Execute on game's queue — after Present(), no fence needed (DXGI guarantees completion).
    // But we still need to wait for OUR copy command to finish.
    game_queue.ExecuteCommandLists(&[Some(dx.cmd_list.cast().unwrap())]);
    let val = FENCE_VALUE.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = game_queue.Signal(fence, val);
    let event = addr_of!(FENCE_EVENT).read();
    let _ = fence.SetEventOnCompletion(val, event);
    WaitForSingleObject(event, 100);
    let w = dx.rb_width;
    let h = dx.rb_height;
    let buf_size = (dx.rb_row_pitch as u64) * (h as u64);
    let range = D3D12_RANGE { Begin: 0, End: buf_size as usize };
    let mut data_ptr: *mut std::ffi::c_void = ptr::null_mut();
    if dx.readback.Map(0, Some(&range), Some(&mut data_ptr)).is_err() || data_ptr.is_null() {
        return;
    }
    let pixel_data = std::slice::from_raw_parts(data_ptr as *const u8, buf_size as usize);

    static LOGGED_RB: AtomicBool = AtomicBool::new(false);
    if !LOGGED_RB.swap(true, Ordering::Relaxed) {
        let sum: u64 = pixel_data.iter().take(4000).map(|&b| b as u64).sum();
        let nz = pixel_data.iter().take(40960).filter(|&&b| b != 0).count();
        crate::hook_log(&format!(
            "[echo-hook] readback: {}x{} fmt={} sum={sum} nz={nz}", w, h, dx.bb_format.0
        ));
    }

    // Write RAW bytes to shared texture — no CPU conversion.
    // The 4 bytes/pixel are memcpy'd as-is (R10G10B10A2 raw bits or R8G8B8A8).
    // The client reads the `format` field from the control block and converts.
    let cb_mut = state.control.block_mut();
    cb_mut.width = w;
    cb_mut.height = h;
    // Signal format: 2 = R10G10B10A2 raw, 1 = R8G8B8A8
    cb_mut.format = if dx.bb_format == DXGI_FORMAT_R10G10B10A2_UNORM { 2 } else { 1 };

    // Write raw bytes to shared texture via UpdateSubresource (no staging, no conversion)
    let (dev, ctx) = match (&dx.staging_device, &dx.staging_context) {
        (Some(d), Some(c)) => (d, c),
        _ => {
            let null_range = D3D12_RANGE { Begin: 0, End: 0 };
            dx.readback.Unmap(0, Some(&null_range));
            return;
        }
    };
    let copy_ok = state.texture_writer.write_raw(
        dev, ctx, pixel_data, w, h, dx.rb_row_pitch,
    );

    let null_range = D3D12_RANGE { Begin: 0, End: 0 };
    dx.readback.Unmap(0, Some(&null_range));

    if copy_ok {
        cb_mut.frame_number = cb_mut.frame_number.wrapping_add(1);
        let _ = SetEvent(state.frame_event);
        static LOGGED: AtomicBool = AtomicBool::new(false);
        if !LOGGED.swap(true, Ordering::Relaxed) {
            crate::hook_log(&format!("[echo-hook] FIRST DX12 frame! {}x{} fmt={}", w, h, dx.bb_format.0));
        }
    }
}

/// Convert R10G10B10A2_UNORM → R8G8B8A8_UNORM on the CPU.
fn convert_r10g10b10a2_to_r8g8b8a8(data: &[u8], w: u32, h: u32, src_pitch: u32) -> Vec<u8> {
    let dst_pitch = w * 4;
    let mut out = vec![0u8; (dst_pitch * h) as usize];
    for y in 0..h {
        let src_row = (y * src_pitch) as usize;
        let dst_row = (y * dst_pitch) as usize;
        for x in 0..w {
            let src_off = src_row + (x * 4) as usize;
            if src_off + 4 > data.len() { break; }
            let pixel = u32::from_le_bytes([data[src_off], data[src_off+1], data[src_off+2], data[src_off+3]]);
            let r10 = pixel & 0x3FF;
            let g10 = (pixel >> 10) & 0x3FF;
            let b10 = (pixel >> 20) & 0x3FF;
            let a2 = (pixel >> 30) & 0x3;
            // 10-bit → 8-bit: shift right by 2
            let r8 = (r10 >> 2) as u8;
            let g8 = (g10 >> 2) as u8;
            let b8 = (b10 >> 2) as u8;
            let a8 = (a2 * 85) as u8; // 2-bit → 8-bit: 0→0, 1→85, 2→170, 3→255
            let dst_off = dst_row + (x * 4) as usize;
            out[dst_off] = r8;
            out[dst_off+1] = g8;
            out[dst_off+2] = b8;
            out[dst_off+3] = a8;
        }
    }
    out
}

// ── Initialize / Shutdown ──

pub fn initialize() -> Result<(), String> {
    let pid = unsafe { GetCurrentProcessId() };
    crate::hook_log(&format!("[echo-hook] init PID {pid}"));
    let control = ControlBlockHandle::open(pid).map_err(|e| format!("cb: {e}"))?;
    let event_name = frame_event_name(pid);
    let frame_event = unsafe {
        use windows::Win32::System::Threading::SYNCHRONIZATION_ACCESS_RIGHTS;
        OpenEventW(SYNCHRONIZATION_ACCESS_RIGHTS(0x00100000 | 0x0002), BOOL(0),
            windows::core::PCWSTR(event_name.as_ptr()))
            .map_err(|e| format!("event: {e}"))?
    };
    let tex_handle = control.block().texture_handle;
    let texture_writer = SharedTextureWriter::new(tex_handle).map_err(|e| format!("tex: {e}"))?;
    let present_addr = control.block().present_addr;
    if present_addr == 0 { return Err("present_addr=0".into()); }
    crate::hook_log(&format!("[echo-hook] Present at {:#x}", present_addr));

    unsafe {
        addr_of_mut!(ORIGINAL_PRESENT).write(
            MinHook::create_hook(present_addr as usize as *mut _, hooked_present as *mut _)
                .map_err(|e| format!("hook: {e:?}"))?,
        );
        MinHook::enable_all_hooks().map_err(|e| format!("enable: {e:?}"))?;
        addr_of_mut!(HOOK_STATE).write(Some(HookState {
            control, texture_writer, frame_event, d3d11_converter: None,
        }));
        HOOKS_ACTIVE.store(true, Ordering::SeqCst);
    }
    crate::hook_log("[echo-hook] hooks OK");
    Ok(())
}

pub fn shutdown() {
    if !HOOKS_ACTIVE.load(Ordering::SeqCst) { return; }
    crate::hook_log("[echo-hook] shutdown");
    unsafe {
        let _ = MinHook::disable_all_hooks();
        addr_of_mut!(HOOK_STATE).write(None);
        HOOKS_ACTIVE.store(false, Ordering::SeqCst);
    }
}
