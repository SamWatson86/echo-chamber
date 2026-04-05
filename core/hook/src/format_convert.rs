//! GPU format conversion via fullscreen shader blit.
//!
//! Samples any DXGI backbuffer format (R10G10B10A2, B8G8R8A8, R16G16B16A16_FLOAT, etc.)
//! and writes to an R8G8B8A8_UNORM render target. The GPU texture sampler handles
//! the format conversion automatically.

use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::Graphics::Direct3D::D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_FILTER_MIN_MAG_MIP_POINT,
    D3D11_SAMPLER_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC, D3D11_SHADER_RESOURCE_VIEW_DESC_0,
    D3D11_TEX2D_SRV, D3D11_TEXTURE2D_DESC,
    D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_VIEWPORT,
    ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader, ID3D11RenderTargetView,
    ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader,
};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_R8G8B8A8_UNORM;

/// Pre-compiled shader blobs will be cached here after first compilation.
static SHADERS_COMPILED: AtomicBool = AtomicBool::new(false);
static mut VS_BLOB: Option<Vec<u8>> = None;
static mut PS_BLOB: Option<Vec<u8>> = None;

/// HLSL source for the fullscreen triangle vertex shader.
/// Generates a fullscreen triangle from SV_VertexID — no vertex buffer needed.
const VS_SOURCE: &[u8] = b"
struct VS_OUT { float4 pos : SV_Position; float2 uv : TEXCOORD; };
VS_OUT main(uint id : SV_VertexID) {
    VS_OUT o;
    o.uv = float2((id << 1) & 2, id & 2);
    o.pos = float4(o.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return o;
}
\0";

/// HLSL source for the passthrough pixel shader.
/// Samples source texture — GPU sampler auto-converts any format to render target format.
const PS_SOURCE: &[u8] = b"
Texture2D src : register(t0);
SamplerState samp : register(s0);
float4 main(float2 uv : TEXCOORD) : SV_Target {
    return src.Sample(samp, uv);
}
\0";

/// Holds the D3D11 resources needed for format conversion.
pub struct FormatConverter {
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    /// R8G8B8A8_UNORM render target (output of conversion).
    rt_texture: Option<ID3D11Texture2D>,
    rt_view: Option<ID3D11RenderTargetView>,
    rt_width: u32,
    rt_height: u32,
}

impl FormatConverter {
    /// Create a new format converter on the given D3D11 device.
    /// Compiles shaders on first call (cached for subsequent devices).
    pub fn new(device: &ID3D11Device) -> Result<Self, String> {
        let (vs_bytes, ps_bytes) = compile_shaders()?;

        unsafe {
            // CreateVertexShader: (bytecode, class_linkage, out_shader)
            let mut vs: Option<ID3D11VertexShader> = None;
            device.CreateVertexShader(&vs_bytes, None, Some(&mut vs))
                .map_err(|e| format!("CreateVertexShader: {e}"))?;
            let vs = vs.ok_or("CreateVertexShader returned None")?;

            let mut ps: Option<ID3D11PixelShader> = None;
            device.CreatePixelShader(&ps_bytes, None, Some(&mut ps))
                .map_err(|e| format!("CreatePixelShader: {e}"))?;
            let ps = ps.ok_or("CreatePixelShader returned None")?;

            let sampler_desc = D3D11_SAMPLER_DESC {
                Filter: D3D11_FILTER_MIN_MAG_MIP_POINT,
                AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                MaxLOD: f32::MAX,
                ..Default::default()
            };
            let mut sampler: Option<ID3D11SamplerState> = None;
            device.CreateSamplerState(&sampler_desc, Some(&mut sampler))
                .map_err(|e| format!("CreateSamplerState: {e}"))?;
            let sampler = sampler.ok_or("CreateSamplerState returned None")?;

            Ok(Self {
                vs,
                ps,
                sampler,
                rt_texture: None,
                rt_view: None,
                rt_width: 0,
                rt_height: 0,
            })
        }
    }

    /// Convert a source texture (any format) to an R8G8B8A8_UNORM texture.
    /// Returns the R8G8B8A8 texture that can be CopyResource'd to the shared texture.
    pub fn convert(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        source: &ID3D11Texture2D,
        source_desc: &D3D11_TEXTURE2D_DESC,
    ) -> Option<&ID3D11Texture2D> {
        let w = source_desc.Width;
        let h = source_desc.Height;

        // Ensure render target exists and matches dimensions
        if self.rt_texture.is_none() || self.rt_width != w || self.rt_height != h {
            if !self.create_render_target(device, w, h) {
                return None;
            }
        }

        let rt_view = self.rt_view.as_ref()?;
        let rt_tex = self.rt_texture.as_ref()?;

        unsafe {
            // Create SRV for the source texture
            let srv_desc = D3D11_SHADER_RESOURCE_VIEW_DESC {
                Format: source_desc.Format,
                ViewDimension: windows::Win32::Graphics::Direct3D::D3D_SRV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_SHADER_RESOURCE_VIEW_DESC_0 {
                    Texture2D: D3D11_TEX2D_SRV {
                        MostDetailedMip: 0,
                        MipLevels: 1,
                    },
                },
            };
            let mut srv: Option<ID3D11ShaderResourceView> = None;
            if let Err(e) = device.CreateShaderResourceView(source, Some(&srv_desc), Some(&mut srv)) {
                static LOGGED: AtomicBool = AtomicBool::new(false);
                if !LOGGED.swap(true, Ordering::Relaxed) {
                    crate::hook_log(&format!(
                        "[echo-hook] format_convert: CreateSRV failed: {e} fmt={}",
                        source_desc.Format.0
                    ));
                }
                return None;
            }
            let srv = srv?;

            // Set render target
            context.OMSetRenderTargets(Some(&[Some(rt_view.clone())]), None);

            // Set viewport
            let viewport = D3D11_VIEWPORT {
                TopLeftX: 0.0,
                TopLeftY: 0.0,
                Width: w as f32,
                Height: h as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
            };
            context.RSSetViewports(Some(&[viewport]));

            // Bind shaders
            context.VSSetShader(&self.vs, None);
            context.PSSetShader(&self.ps, None);

            // Bind source texture + sampler
            context.PSSetShaderResources(0, Some(&[Some(srv.clone())]));
            context.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));

            // Set topology and draw fullscreen triangle
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            context.IASetInputLayout(None);
            context.Draw(3, 0);

            // Unbind SRV to release reference to source texture
            let null_srv: [Option<ID3D11ShaderResourceView>; 1] = [None];
            context.PSSetShaderResources(0, Some(&null_srv));

            // Unbind render target
            let null_rtv: [Option<ID3D11RenderTargetView>; 1] = [None];
            context.OMSetRenderTargets(Some(&null_rtv), None);

            static LOGGED_FIRST: AtomicBool = AtomicBool::new(false);
            if !LOGGED_FIRST.swap(true, Ordering::Relaxed) {
                crate::hook_log(&format!(
                    "[echo-hook] format_convert: FIRST blit {}x{} fmt={} → R8G8B8A8",
                    w, h, source_desc.Format.0
                ));
            }
        }

        Some(rt_tex)
    }

    /// Create or recreate the R8G8B8A8_UNORM render target.
    fn create_render_target(&mut self, device: &ID3D11Device, width: u32, height: u32) -> bool {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_R8G8B8A8_UNORM,
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };

        unsafe {
            let mut tex: Option<ID3D11Texture2D> = None;
            if let Err(e) = device.CreateTexture2D(&desc, None, Some(&mut tex)) {
                crate::hook_log(&format!(
                    "[echo-hook] format_convert: CreateTexture2D failed: {e}"
                ));
                return false;
            }
            let tex = match tex {
                Some(t) => t,
                None => return false,
            };

            let mut rtv: Option<ID3D11RenderTargetView> = None;
            if let Err(e) = device.CreateRenderTargetView(&tex, None, Some(&mut rtv)) {
                crate::hook_log(&format!(
                    "[echo-hook] format_convert: CreateRTV failed: {e}"
                ));
                return false;
            }
            let rtv = match rtv {
                Some(r) => r,
                None => return false,
            };

            crate::hook_log(&format!(
                "[echo-hook] format_convert: created RT {}x{} R8G8B8A8",
                width, height
            ));
            self.rt_texture = Some(tex);
            self.rt_view = Some(rtv);
            self.rt_width = width;
            self.rt_height = height;
            true
        }
    }
}

/// Compile the VS and PS shaders (cached after first call).
fn compile_shaders() -> Result<(Vec<u8>, Vec<u8>), String> {
    unsafe {
        if SHADERS_COMPILED.load(Ordering::Relaxed) {
            let vs = VS_BLOB.as_ref().unwrap().clone();
            let ps = PS_BLOB.as_ref().unwrap().clone();
            return Ok((vs, ps));
        }

        crate::hook_log("[echo-hook] format_convert: compiling shaders...");

        // Compile vertex shader
        let mut vs_blob = None;
        let mut vs_errors = None;
        let hr = D3DCompile(
            VS_SOURCE.as_ptr() as _,
            VS_SOURCE.len() - 1, // exclude null terminator from length
            None,
            None,
            None,
            windows::core::s!("main"),
            windows::core::s!("vs_4_0"),
            0,
            0,
            &mut vs_blob,
            Some(&mut vs_errors),
        );
        if hr.is_err() {
            let err_msg = if let Some(ref errors) = vs_errors {
                let ptr = errors.GetBufferPointer() as *const u8;
                let len = errors.GetBufferSize();
                String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).to_string()
            } else {
                format!("{hr:?}")
            };
            return Err(format!("VS compile failed: {err_msg}"));
        }
        let vs_blob = vs_blob.unwrap();
        let vs_bytes: Vec<u8> = {
            let ptr = vs_blob.GetBufferPointer() as *const u8;
            let len = vs_blob.GetBufferSize();
            std::slice::from_raw_parts(ptr, len).to_vec()
        };

        // Compile pixel shader
        let mut ps_blob = None;
        let mut ps_errors = None;
        let hr = D3DCompile(
            PS_SOURCE.as_ptr() as _,
            PS_SOURCE.len() - 1,
            None,
            None,
            None,
            windows::core::s!("main"),
            windows::core::s!("ps_4_0"),
            0,
            0,
            &mut ps_blob,
            Some(&mut ps_errors),
        );
        if hr.is_err() {
            let err_msg = if let Some(ref errors) = ps_errors {
                let ptr = errors.GetBufferPointer() as *const u8;
                let len = errors.GetBufferSize();
                String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).to_string()
            } else {
                format!("{hr:?}")
            };
            return Err(format!("PS compile failed: {err_msg}"));
        }
        let ps_blob = ps_blob.unwrap();
        let ps_bytes: Vec<u8> = {
            let ptr = ps_blob.GetBufferPointer() as *const u8;
            let len = ps_blob.GetBufferSize();
            std::slice::from_raw_parts(ptr, len).to_vec()
        };

        crate::hook_log("[echo-hook] format_convert: shaders compiled OK");

        VS_BLOB = Some(vs_bytes.clone());
        PS_BLOB = Some(ps_bytes.clone());
        SHADERS_COMPILED.store(true, Ordering::Relaxed);

        Ok((vs_bytes, ps_bytes))
    }
}
