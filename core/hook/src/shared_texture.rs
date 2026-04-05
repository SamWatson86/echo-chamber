//! Shared D3D11 texture writer (runs in game process).
//!
//! Opens a shared texture via NT handle and copies the game's
//! backbuffer into it on each Present() call.

use windows::core::Interface;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Device1, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_TEXTURE2D_DESC,
};
use windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex;

pub struct SharedTextureWriter {
    texture: Option<ID3D11Texture2D>,
    mutex: Option<IDXGIKeyedMutex>,
    nt_handle: u64,
    current_width: u32,
    current_height: u32,
}

impl SharedTextureWriter {
    /// Create a writer. The texture is lazily opened on first use
    /// because we need the game's D3D11 device to open it.
    pub fn new(nt_handle: u64) -> Result<Self, String> {
        Ok(Self {
            texture: None,
            mutex: None,
            nt_handle,
            current_width: 0,
            current_height: 0,
        })
    }

    /// Copy a backbuffer frame to the shared texture.
    /// Returns true if the copy succeeded.
    pub fn copy_frame(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        backbuffer: &ID3D11Texture2D,
        desc: &D3D11_TEXTURE2D_DESC,
    ) -> bool {
        // Lazy-open the shared texture on the game's device
        if self.texture.is_none()
            || desc.Width != self.current_width
            || desc.Height != self.current_height
        {
            if !self.open_shared_texture(device, desc) {
                return false;
            }
        }

        let texture = match &self.texture {
            Some(t) => t,
            None => return false,
        };
        let mutex = match &self.mutex {
            Some(m) => m,
            None => return false,
        };

        unsafe {
            // Acquire keyed mutex (key=0, timeout=0ms — non-blocking)
            if mutex.AcquireSync(0, 0).is_err() {
                return false; // Client is reading, skip this frame
            }

            // Copy backbuffer → shared texture
            context.CopyResource(texture, backbuffer);

            // Flush to ensure GPU executes the CopyResource before releasing the mutex.
            // Critical for D3D11On12: without Flush(), commands sit in an unsubmitted
            // command list and the keyed mutex never transitions on the GPU.
            // For native D3D11 this is a no-op (commands execute immediately).
            context.Flush();

            // Release keyed mutex (key=1 — signals consumer)
            let _ = mutex.ReleaseSync(1);
        }

        true
    }

    /// Write raw pixel bytes to the shared texture via UpdateSubresource.
    /// No staging texture needed — writes CPU data directly to the DEFAULT texture.
    pub fn write_raw(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        src_data: &[u8],
        width: u32,
        height: u32,
        src_pitch: u32,
    ) -> bool {
        use windows::Win32::Graphics::Direct3D11::D3D11_BOX;

        if self.texture.is_none() || width != self.current_width || height != self.current_height {
            // Need a desc to open — create a minimal one matching dimensions
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R8G8B8A8_UNORM,
                SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                ..Default::default()
            };
            if !self.open_shared_texture(device, &desc) {
                return false;
            }
        }

        let texture = match &self.texture {
            Some(t) => t,
            None => return false,
        };
        let mutex = match &self.mutex {
            Some(m) => m,
            None => return false,
        };

        unsafe {
            if mutex.AcquireSync(0, 0).is_err() {
                return false;
            }

            let dst_box = D3D11_BOX {
                left: 0, top: 0, front: 0,
                right: width, bottom: height, back: 1,
            };
            context.UpdateSubresource(
                texture,
                0,
                Some(&dst_box),
                src_data.as_ptr() as *const _,
                src_pitch,
                0,
            );
            context.Flush();

            let _ = mutex.ReleaseSync(1);
        }
        true
    }

    /// Write pixels from a D3D11 STAGING texture to the shared texture.
    /// Used by the DX12 path where we CPU-convert pixels and write via staging.
    pub fn write_from_staging(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        staging: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> bool {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { staging.GetDesc(&mut desc); }

        if self.texture.is_none() || width != self.current_width || height != self.current_height {
            if !self.open_shared_texture(device, &desc) {
                return false;
            }
        }
        let texture = match &self.texture {
            Some(t) => t,
            None => return false,
        };
        let mutex = match &self.mutex {
            Some(m) => m,
            None => return false,
        };

        unsafe {
            if mutex.AcquireSync(0, 0).is_err() {
                return false;
            }
            // CopySubresourceRegion from staging → shared texture
            context.CopySubresourceRegion(texture, 0, 0, 0, 0, staging, 0, None);
            context.Flush();
            let _ = mutex.ReleaseSync(1);
        }
        true
    }

    fn open_shared_texture(
        &mut self,
        device: &ID3D11Device,
        desc: &D3D11_TEXTURE2D_DESC,
    ) -> bool {
        unsafe {
            // Need ID3D11Device1 for OpenSharedResource1
            let device1: ID3D11Device1 = match device.cast() {
                Ok(d) => d,
                Err(_) => return false,
            };

            let handle = HANDLE(self.nt_handle as _);
            let texture: Result<ID3D11Texture2D, _> =
                device1.OpenSharedResource1(handle);

            match texture {
                Ok(tex) => {
                    let mutex: IDXGIKeyedMutex = match tex.cast() {
                        Ok(m) => m,
                        Err(_) => return false,
                    };
                    self.texture = Some(tex);
                    self.mutex = Some(mutex);
                    self.current_width = desc.Width;
                    self.current_height = desc.Height;
                    true
                }
                Err(e) => {
                    eprintln!("[echo-hook] open shared texture: {e}");
                    false
                }
            }
        }
    }
}
