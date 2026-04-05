//! DLL injector -- loads echo_game_hook.dll into a target game process.
//!
//! Uses CreateRemoteThread + LoadLibraryW for precise, per-process injection.
//! Creates shared resources (control block, shared texture, frame event) before injection.

use std::path::PathBuf;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, WAIT_OBJECT_0};
use windows::Win32::Foundation::TRUE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, D3D11CreateDeviceAndSwapChain,
    D3D11_BIND_SHADER_RESOURCE, D3D11_CREATE_DEVICE_FLAG,
    D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_MODE_DESC, DXGI_SAMPLE_DESC,
};
use windows::Win32::Graphics::Dxgi::{
    IDXGIResource1, IDXGISwapChain, DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE,
    DXGI_SWAP_CHAIN_DESC, DXGI_SWAP_EFFECT_DISCARD, DXGI_USAGE_RENDER_TARGET_OUTPUT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{
    MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE, VirtualAllocEx, VirtualFreeEx,
};
use windows::Win32::System::Threading::{
    CreateEventW, CreateRemoteThread, OpenProcess,
    WaitForSingleObject, PROCESS_ALL_ACCESS,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

use crate::control_block_client::{ControlBlockHandle, frame_event_name};

/// Active injection state. Owns all shared resources and cleans up on drop.
pub struct InjectionHandle {
    pub control: ControlBlockHandle,
    pub frame_event: HANDLE,
    pub shared_texture: ID3D11Texture2D,
    pub shared_texture_handle: HANDLE,
    pub d3d_device: ID3D11Device,
    pub target_pid: u32,
    remote_thread: HANDLE,
    process_handle: HANDLE,
    remote_dll_path: *mut std::ffi::c_void,
    remote_dll_path_size: usize,
}

unsafe impl Send for InjectionHandle {}
unsafe impl Sync for InjectionHandle {}

impl Drop for InjectionHandle {
    fn drop(&mut self) {
        unsafe {
            // Signal DLL to stop
            self.control.block_mut().running = 0;
            // Give the hook a moment to see the stop signal
            std::thread::sleep(std::time::Duration::from_millis(100));
            // Free the remote memory we allocated for the DLL path
            if !self.remote_dll_path.is_null() {
                let _ = VirtualFreeEx(
                    self.process_handle,
                    self.remote_dll_path,
                    0,
                    MEM_RELEASE,
                );
            }
            let _ = CloseHandle(self.remote_thread);
            let _ = CloseHandle(self.process_handle);
            let _ = CloseHandle(self.frame_event);
            let _ = CloseHandle(self.shared_texture_handle);
        }
    }
}

/// Inject the hook DLL into the game process that owns `hwnd`.
///
/// 1. Creates shared memory control block
/// 2. Creates shared D3D11 texture
/// 3. Creates frame-ready event
/// 4. Opens target process, allocates memory, writes DLL path
/// 5. Creates remote thread calling LoadLibraryW in the target process
pub fn inject(hwnd: u64, target_fps: u32) -> Result<InjectionHandle, String> {
    let hwnd = HWND(hwnd as _);

    // Get target process ID
    let mut target_pid = 0u32;
    let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut target_pid)) };
    if thread_id == 0 || target_pid == 0 {
        return Err("GetWindowThreadProcessId failed".into());
    }

    eprintln!("[injector] target PID={target_pid} TID={thread_id}");

    // 0. Open the target process (needed for DuplicateHandle and CreateRemoteThread)
    let process_handle = unsafe {
        OpenProcess(PROCESS_ALL_ACCESS, false, target_pid)
            .map_err(|e| format!("OpenProcess(PID={target_pid}): {e}"))?
    };

    // 1. Create control block in named shared memory
    let control = ControlBlockHandle::create(target_pid)?;

    // 2. Create D3D11 device + shared texture (match game window size)
    let (tex_w, tex_h) = unsafe {
        let mut rect = windows::Win32::Foundation::RECT::default();
        let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rect);
        let w = (rect.right - rect.left) as u32;
        let h = (rect.bottom - rect.top) as u32;
        if w > 0 && h > 0 { (w, h) } else { (3840, 2160) } // fallback to 4K
    };
    eprintln!("[injector] shared texture size: {tex_w}x{tex_h}");
    let (device, texture, tex_handle) = create_shared_texture(tex_w, tex_h)?;

    // 3. Create frame-ready event
    let event_name = frame_event_name(target_pid);
    let frame_event = unsafe {
        CreateEventW(None, false, false, PCWSTR(event_name.as_ptr()))
            .map_err(|e| format!("CreateEvent: {e}"))?
    };

    // 4. Resolve Present vtable address from a dummy swapchain (works in client process)
    let present_addr = find_present_address()?;
    eprintln!("[injector] Present vtable addr: {present_addr:#x}");

    // 5. Duplicate the shared texture handle into the target process.
    // NT handles are per-process — the handle from CreateSharedHandle is only
    // valid in our process. DuplicateHandle copies it into the game's handle table.
    let target_tex_handle = unsafe {
        let mut dup_handle = HANDLE::default();
        windows::Win32::Foundation::DuplicateHandle(
            windows::Win32::System::Threading::GetCurrentProcess(), // source process
            tex_handle,                                              // source handle
            process_handle,                                          // target process
            &mut dup_handle,                                         // duplicated handle
            0,                                                       // desired access (ignored with SAME_ACCESS)
            false,                                                   // not inheritable
            windows::Win32::Foundation::DUPLICATE_SAME_ACCESS,
        ).map_err(|e| format!("DuplicateHandle: {e}"))?;
        eprintln!("[injector] duplicated texture handle {:#x} → {:#x} in target", tex_handle.0 as u64, dup_handle.0 as u64);
        dup_handle
    };

    // 6. Fill control block (including Present address and duplicated texture handle)
    {
        let cb = control.block_mut();
        cb.target_fps = target_fps;
        cb.running = 1;
        cb.texture_handle = target_tex_handle.0 as u64; // handle valid in GAME process
        cb.present_addr = present_addr as u64;
    }

    // 5. Inject DLL via CreateRemoteThread + LoadLibraryW
    let dll_path = find_hook_dll()?;
    eprintln!("[injector] DLL path: {:?}", dll_path);

    // Encode DLL path as wide string (UTF-16)
    let dll_path_str = dll_path.to_string_lossy();
    let dll_path_wide: Vec<u16> = dll_path_str.encode_utf16().chain(std::iter::once(0)).collect();
    let dll_path_bytes = dll_path_wide.len() * 2; // size in bytes

    // Allocate memory in the target process for the DLL path
    let remote_mem = unsafe {
        VirtualAllocEx(
            process_handle,
            None,
            dll_path_bytes,
            MEM_COMMIT | MEM_RESERVE,
            PAGE_READWRITE,
        )
    };
    if remote_mem.is_null() {
        unsafe { let _ = CloseHandle(process_handle); }
        return Err("VirtualAllocEx failed — couldn't allocate in target process".into());
    }

    // Write the DLL path into the target process memory
    let write_ok = unsafe {
        windows::Win32::System::Diagnostics::Debug::WriteProcessMemory(
            process_handle,
            remote_mem,
            dll_path_wide.as_ptr() as *const _,
            dll_path_bytes,
            None,
        )
    };
    if write_ok.is_err() {
        unsafe {
            let _ = VirtualFreeEx(process_handle, remote_mem, 0, MEM_RELEASE);
            let _ = CloseHandle(process_handle);
        }
        return Err("WriteProcessMemory failed".into());
    }

    // Get LoadLibraryW address from kernel32.dll (same address in all processes)
    let kernel32 = unsafe {
        GetModuleHandleW(windows::core::w!("kernel32.dll"))
            .map_err(|e| format!("GetModuleHandle(kernel32): {e}"))?
    };
    let load_library_addr = unsafe {
        windows::Win32::System::LibraryLoader::GetProcAddress(
            kernel32,
            windows::core::s!("LoadLibraryW"),
        )
        .ok_or("GetProcAddress(LoadLibraryW) failed")?
    };

    // Create a remote thread in the target process that calls LoadLibraryW(dll_path)
    let remote_thread = unsafe {
        CreateRemoteThread(
            process_handle,
            None,                               // default security
            0,                                  // default stack size
            Some(std::mem::transmute(load_library_addr)), // thread proc = LoadLibraryW
            Some(remote_mem),                   // argument = pointer to DLL path
            0,                                  // run immediately
            None,                               // don't need thread ID
        )
        .map_err(|e| format!("CreateRemoteThread: {e}"))?
    };

    // Wait for LoadLibraryW to complete (up to 10 seconds)
    let wait_result = unsafe { WaitForSingleObject(remote_thread, 10_000) };
    if wait_result != WAIT_OBJECT_0 {
        eprintln!("[injector] WARNING: LoadLibraryW didn't complete within 10s");
    } else {
        eprintln!("[injector] DLL loaded into PID {target_pid} successfully");
    }

    // Give the DLL a moment to initialize hooks
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Verify the hook initialized by checking if control block was modified
    let cb = control.block();
    if cb.frame_number == 0 && cb.width == 0 {
        eprintln!("[injector] WARNING: hook may not have initialized yet (frame_number=0, width=0)");
        eprintln!("[injector] this is normal — frames will start on next Present() call");
    }

    Ok(InjectionHandle {
        control,
        frame_event,
        shared_texture: texture,
        shared_texture_handle: tex_handle,
        d3d_device: device,
        target_pid,
        remote_thread,
        process_handle,
        remote_dll_path: remote_mem,
        remote_dll_path_size: dll_path_bytes,
    })
}

/// Find the hook DLL next to the client exe.
fn find_hook_dll() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe.parent().ok_or("no parent dir")?;

    let candidates = [
        dir.join("echo_game_hook.dll"),
        dir.join("resources").join("echo_game_hook.dll"),
    ];

    for path in &candidates {
        if path.exists() {
            eprintln!("[injector] found DLL at {:?}", path);
            return Ok(path.clone());
        }
    }

    Err(format!("echo_game_hook.dll not found in {:?}", dir))
}

/// Create a D3D11 device and shared texture for cross-process frame transport.
fn create_shared_texture(
    width: u32,
    height: u32,
) -> Result<(ID3D11Device, ID3D11Texture2D, HANDLE), String> {
    unsafe {
        let mut device: Option<ID3D11Device> = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            None,
            D3D11_CREATE_DEVICE_FLAG(0),
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )
        .map_err(|e| format!("D3D11CreateDevice: {e}"))?;

        let device = device.ok_or("D3D11CreateDevice returned no device")?;

        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
                | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32,
            CPUAccessFlags: 0,
        };

        let mut texture: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut texture))
            .map_err(|e| format!("CreateTexture2D: {e}"))?;

        let texture = texture.ok_or("CreateTexture2D returned no texture")?;

        let resource: IDXGIResource1 = texture
            .cast()
            .map_err(|e| format!("cast IDXGIResource1: {e}"))?;

        let handle = resource
            .CreateSharedHandle(
                None,
                (DXGI_SHARED_RESOURCE_READ.0 | DXGI_SHARED_RESOURCE_WRITE.0) as u32,
                None,
            )
            .map_err(|e| format!("CreateSharedHandle: {e}"))?;

        Ok((device, texture, handle))
    }
}

/// Create a dummy D3D11 device + swapchain to read Present's vtable address.
/// This runs in the Tauri client process where it works reliably.
/// The address is valid across processes because dxgi.dll loads at the same base.
fn find_present_address() -> Result<usize, String> {
    unsafe {
        let swap_chain_desc = DXGI_SWAP_CHAIN_DESC {
            BufferDesc: DXGI_MODE_DESC {
                Width: 2,
                Height: 2,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                ..Default::default()
            },
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            BufferCount: 1,
            OutputWindow: windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow(),
            Windowed: TRUE,
            SwapEffect: DXGI_SWAP_EFFECT_DISCARD,
            ..Default::default()
        };

        let mut swapchain: Option<IDXGISwapChain> = None;
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;

        D3D11CreateDeviceAndSwapChain(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            None,
            Default::default(),
            None,
            D3D11_SDK_VERSION,
            Some(&swap_chain_desc),
            Some(&mut swapchain),
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(|e| format!("D3D11CreateDeviceAndSwapChain: {e}"))?;

        let swapchain = swapchain.ok_or("no swapchain")?;

        // Present is vtable index 8 on IDXGISwapChain
        let vtable_ptr = *(swapchain.as_raw() as *const *const usize);
        let present_addr = *vtable_ptr.add(8);

        Ok(present_addr)
    }
}
