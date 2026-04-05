// Copyright 2025 LiveKit, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

mod plugin;
pub mod proto;
mod room;
mod rtc_engine;

pub mod webrtc {
    pub use libwebrtc::*;
}

pub use room::*;

/// `use livekit::prelude::*;` to import livekit types
pub mod prelude;

#[cfg(feature = "dispatcher")]
pub mod dispatcher {
    pub use livekit_runtime::set_dispatcher;
    pub use livekit_runtime::Dispatcher;
    pub use livekit_runtime::Runnable;
}

pub use plugin::*;

/// Pre-initialize the LiveKit runtime and PeerConnectionFactory.
/// Call this at app startup (before any game launches) so that NVENC
/// hardware encoder detection happens while CUDA is available.
pub fn ensure_runtime_initialized() {
    use webrtc::prelude::*;
    let rt = rtc_engine::lk_runtime::LkRuntime::instance();
    // Check what encoders are available by listing supported video codecs
    let caps = rt.pc_factory().get_rtp_sender_capabilities(crate::webrtc::MediaType::Video);
    let h264_codecs: Vec<_> = caps.codecs.iter()
        .filter(|c| c.mime_type.to_lowercase().contains("h264"))
        .collect();
    eprintln!("[init] H264 codec variants: {}", h264_codecs.len());
    for c in &h264_codecs {
        eprintln!("[init]   {} fmtp={:?}", c.mime_type, c.sdp_fmtp_line);
    }
}
