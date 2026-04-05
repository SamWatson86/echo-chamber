//! GPU-accelerated frame conversion pipeline (D3D11 compute shader).
//!
//! Shared between desktop_capture (DXGI DD) and screen_capture (WGC).
//! Reads a source texture in any format (BGRA8, RGBA16F/HDR, etc.),
//! applies HDR→SDR tonemap + downscale via compute shader, outputs
//! BGRA8 at the target encode resolution.

use windows::core::PCSTR;
use windows::Win32::Graphics::Direct3D::ID3DBlob;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11_USAGE_DEFAULT,
    D3D11_BIND_SHADER_RESOURCE, D3D11_BIND_UNORDERED_ACCESS,
    D3D11_CPU_ACCESS_READ,
    ID3D11Device, ID3D11Texture2D, ID3D11ComputeShader,
    ID3D11ShaderResourceView, ID3D11UnorderedAccessView,
    D3D11_SHADER_RESOURCE_VIEW_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC_0,
    D3D11_TEX2D_SRV, D3D11_UNORDERED_ACCESS_VIEW_DESC,
    D3D11_UNORDERED_ACCESS_VIEW_DESC_0, D3D11_TEX2D_UAV,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_SAMPLE_DESC,
};

/// HLSL compute shader: reads source texture, writes SDR BGRA8 at encode resolution.
/// Nearest-neighbor sampling with saturate() for HDR→SDR tonemap.
/// For SDR input (BGRA8), saturate() is a no-op — works universally.
const HDR_TO_SDR_HLSL: &[u8] = b"
Texture2D<float4> src : register(t0);
RWTexture2D<unorm float4> dst : register(u0);

cbuffer Params : register(b0) {
    uint src_w, src_h, dst_w, dst_h;
    uint crop_x, crop_y, crop_w, crop_h;
};

[numthreads(16, 16, 1)]
void main(uint3 id : SV_DispatchThreadID) {
    if (id.x >= dst_w || id.y >= dst_h) return;
    uint sx = crop_x + id.x * crop_w / dst_w;
    uint sy = crop_y + id.y * crop_h / dst_h;
    float4 hdr = src[uint2(sx, sy)];
    // Output as BGRA memory layout via R8G8B8A8 UAV (swap R and B in shader)
    dst[id.xy] = float4(saturate(hdr.b), saturate(hdr.g), saturate(hdr.r), 1.0);
}
\0";

pub struct GpuConverter {
    shader: ID3D11ComputeShader,
    pub gpu_src: ID3D11Texture2D,
    gpu_src_srv: ID3D11ShaderResourceView,
    gpu_dst: ID3D11Texture2D,
    gpu_dst_uav: ID3D11UnorderedAccessView,
    staging: ID3D11Texture2D,
    cb_buf: windows::Win32::Graphics::Direct3D11::ID3D11Buffer,
    pub src_w: u32,
    pub src_h: u32,
    pub dst_w: u32,
    pub dst_h: u32,
}

impl GpuConverter {
    pub fn new(
        device: &ID3D11Device,
        src_w: u32, src_h: u32,
        src_fmt: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
        dst_w: u32, dst_h: u32,
    ) -> Result<Self, String> {
        // Compile compute shader
        let mut blob: Option<ID3DBlob> = None;
        let mut err_blob: Option<ID3DBlob> = None;
        unsafe {
            D3DCompile(
                HDR_TO_SDR_HLSL.as_ptr() as _,
                HDR_TO_SDR_HLSL.len() - 1,
                PCSTR::null(),
                None,
                None,
                PCSTR(b"main\0".as_ptr()),
                PCSTR(b"cs_5_0\0".as_ptr()),
                0, 0,
                &mut blob,
                Some(&mut err_blob),
            ).map_err(|e| {
                let msg = err_blob.as_ref().map(|b| {
                    let ptr = b.GetBufferPointer() as *const u8;
                    let len = b.GetBufferSize();
                    String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).to_string()
                }).unwrap_or_default();
                format!("shader compile failed: {e} — {msg}")
            })?;
        }
        let blob = blob.ok_or("D3DCompile returned null blob")?;
        let shader: ID3D11ComputeShader = unsafe {
            let ptr = blob.GetBufferPointer();
            let len = blob.GetBufferSize();
            let bytecode = std::slice::from_raw_parts(ptr as *const u8, len);
            let mut cs: Option<ID3D11ComputeShader> = None;
            device.CreateComputeShader(bytecode, None, Some(&mut cs))
                .map_err(|e| format!("CreateComputeShader: {e}"))?;
            cs.ok_or("CreateComputeShader returned null")?
        };

        // GPU source texture (SRV-bindable, same format as captured frame)
        let gpu_src: ID3D11Texture2D = unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: src_w,
                Height: src_h,
                MipLevels: 1,
                ArraySize: 1,
                Format: src_fmt,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                ..Default::default()
            };
            let mut tex: Option<ID3D11Texture2D> = None;
            device.CreateTexture2D(&desc, None, Some(&mut tex))
                .map_err(|e| format!("gpu_src: {e}"))?;
            tex.ok_or("gpu_src null")?
        };
        let gpu_src_srv: ID3D11ShaderResourceView = unsafe {
            let desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
                Format: src_fmt,
                ViewDimension: windows::Win32::Graphics::Direct3D::D3D_SRV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_SRV { MostDetailedMip: 0, MipLevels: 1 },
                },
            };
            let mut srv: Option<ID3D11ShaderResourceView> = None;
            device.CreateShaderResourceView(&gpu_src, Some(&desc), Some(&mut srv))
                .map_err(|e| format!("gpu_src SRV: {e}"))?;
            srv.ok_or("SRV null")?
        };

        // GPU destination texture (UAV-bindable, R8G8B8A8 — BGRA8 doesn't support typed UAV)
        let gpu_dst: ID3D11Texture2D = unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: dst_w,
                Height: dst_h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_UNORDERED_ACCESS.0 as u32,
                ..Default::default()
            };
            let mut tex: Option<ID3D11Texture2D> = None;
            device.CreateTexture2D(&desc, None, Some(&mut tex))
                .map_err(|e| format!("gpu_dst: {e}"))?;
            tex.ok_or("gpu_dst null")?
        };
        let gpu_dst_uav: ID3D11UnorderedAccessView = unsafe {
            let desc = D3D11_UNORDERED_ACCESS_VIEW_DESC {
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                ViewDimension: windows::Win32::Graphics::Direct3D11::D3D11_UAV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_UNORDERED_ACCESS_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_UAV { MipSlice: 0 },
                },
            };
            let mut uav: Option<ID3D11UnorderedAccessView> = None;
            device.CreateUnorderedAccessView(&gpu_dst, Some(&desc), Some(&mut uav))
                .map_err(|e| format!("gpu_dst UAV: {e}"))?;
            uav.ok_or("UAV null")?
        };

        // CPU-readable staging at encode resolution (small — ~8MB for 1920x1080)
        let staging: ID3D11Texture2D = unsafe {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: dst_w,
                Height: dst_h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_R8G8B8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                ..Default::default()
            };
            let mut tex: Option<ID3D11Texture2D> = None;
            device.CreateTexture2D(&desc, None, Some(&mut tex))
                .map_err(|e| format!("staging: {e}"))?;
            tex.ok_or("staging null")?
        };

        // Constant buffer for shader params
        let cb_buf = unsafe {
            let desc = windows::Win32::Graphics::Direct3D11::D3D11_BUFFER_DESC {
                ByteWidth: 32, // 8 x uint32
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: windows::Win32::Graphics::Direct3D11::D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                ..Default::default()
            };
            let mut buf: Option<windows::Win32::Graphics::Direct3D11::ID3D11Buffer> = None;
            device.CreateBuffer(&desc, None, Some(&mut buf))
                .map_err(|e| format!("cbuffer: {e}"))?;
            buf.ok_or("cbuffer null")?
        };

        eprintln!("[gpu-converter] initialized: {}x{} {:?} → {}x{} BGRA8",
            src_w, src_h, src_fmt, dst_w, dst_h);

        Ok(Self { shader, gpu_src, gpu_src_srv, gpu_dst, gpu_dst_uav, staging, cb_buf, src_w, src_h, dst_w, dst_h })
    }

    /// Run GPU conversion: copy frame → shader → staging → map.
    /// Returns (data_ptr, row_pitch, width, height). Call `unmap()` when done reading.
    pub unsafe fn convert(
        &self,
        context: &windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
        frame_texture: &ID3D11Texture2D,
        crop_x: u32, crop_y: u32, crop_w: u32, crop_h: u32,
    ) -> Result<(*const u8, u32, u32, u32), String> {
        // 1. Copy captured frame → gpu_src (GPU→GPU, preserves format)
        context.CopyResource(&self.gpu_src, frame_texture);

        // 2. Update constant buffer with crop/scale params
        let params: [u32; 8] = [
            self.src_w, self.src_h, self.dst_w, self.dst_h,
            crop_x, crop_y, crop_w, crop_h,
        ];
        context.UpdateSubresource(
            &self.cb_buf,
            0, None,
            params.as_ptr() as *const _,
            0, 0,
        );

        // 3. Dispatch compute shader
        context.CSSetShader(&self.shader, None);
        let srvs = [Some(self.gpu_src_srv.clone())];
        context.CSSetShaderResources(0, Some(&srvs));
        let uav_clone = Some(self.gpu_dst_uav.clone());
        let uav_arr: [Option<ID3D11UnorderedAccessView>; 1] = [uav_clone];
        let initial_counts: [u32; 1] = [0];
        context.CSSetUnorderedAccessViews(
            0, 1,
            Some(uav_arr.as_ptr() as *const _),
            Some(initial_counts.as_ptr()),
        );
        let cbs = [Some(self.cb_buf.clone())];
        context.CSSetConstantBuffers(0, Some(&cbs));

        let gx = (self.dst_w + 15) / 16;
        let gy = (self.dst_h + 15) / 16;
        context.Dispatch(gx, gy, 1);

        // Unbind
        let empty_srv: [Option<ID3D11ShaderResourceView>; 1] = [None];
        context.CSSetShaderResources(0, Some(&empty_srv));
        let empty_uav: [Option<ID3D11UnorderedAccessView>; 1] = [None];
        context.CSSetUnorderedAccessViews(
            0, 1,
            Some(empty_uav.as_ptr() as *const _),
            None,
        );

        // 4. Copy result → staging (GPU→CPU, only ~8MB)
        context.CopyResource(&self.staging, &self.gpu_dst);

        // 5. Map staging for CPU read
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .map_err(|e| format!("map staging: {e}"))?;

        Ok((mapped.pData as *const u8, mapped.RowPitch, self.dst_w, self.dst_h))
    }

    pub unsafe fn unmap(&self, context: &windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext) {
        context.Unmap(&self.staging, 0);
    }
}
