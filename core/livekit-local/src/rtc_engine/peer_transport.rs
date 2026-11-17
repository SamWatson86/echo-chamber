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

use std::{
    fmt::{Debug, Formatter},
    sync::Arc,
};

use libwebrtc::prelude::*;
use livekit_protocol as proto;
use parking_lot::Mutex;
use tokio::sync::Mutex as AsyncMutex;

use super::EngineResult;

pub type OnOfferCreated = Box<dyn FnMut(SessionDescription) + Send + Sync>;

#[derive(Clone, Copy, Debug)]
pub(crate) enum H264ScreenShareLevel {
    Level4,
    Level4_2,
}

impl H264ScreenShareLevel {
    fn profile_id(self) -> &'static str {
        match self {
            Self::Level4 => "profile-level-id=42e028",
            Self::Level4_2 => "profile-level-id=42e02a",
        }
    }
}

struct TransportInner {
    pending_candidates: Vec<IceCandidate>,
    renegotiate: bool,
    restarting_ice: bool,
    single_pc_mode: bool,
    // Publish-side bitrate bounds (bps) for offer munging.
    max_send_bitrate_bps: Option<u64>,
    min_send_bitrate_bps: Option<u64>,
    h264_screen_share_level: Option<H264ScreenShareLevel>,
}

pub struct PeerTransport {
    signal_target: proto::SignalTarget,
    peer_connection: PeerConnection,
    on_offer_handler: Mutex<Option<OnOfferCreated>>,
    inner: Arc<AsyncMutex<TransportInner>>,
}

impl Debug for PeerTransport {
    fn fmt(&self, f: &mut Formatter) -> std::fmt::Result {
        f.debug_struct("PeerTransport").field("target", &self.signal_target).finish()
    }
}

impl PeerTransport {
    pub fn new(
        peer_connection: PeerConnection,
        signal_target: proto::SignalTarget,
        single_pc_mode: bool,
    ) -> Self {
        Self {
            signal_target,
            peer_connection,
            on_offer_handler: Mutex::new(None),
            inner: Arc::new(AsyncMutex::new(TransportInner {
                pending_candidates: Vec::default(),
                renegotiate: false,
                restarting_ice: false,
                single_pc_mode,
                max_send_bitrate_bps: None,
                min_send_bitrate_bps: None,
                h264_screen_share_level: None,
            })),
        }
    }

    pub fn is_connected(&self) -> bool {
        self.peer_connection.connection_state() == PeerConnectionState::Connected
    }

    pub fn peer_connection(&self) -> PeerConnection {
        self.peer_connection.clone()
    }

    pub fn signal_target(&self) -> proto::SignalTarget {
        self.signal_target
    }

    pub fn on_offer(&self, handler: Option<OnOfferCreated>) {
        *self.on_offer_handler.lock() = handler;
    }

    pub fn close(&self) {
        self.peer_connection.close();
    }

    pub async fn add_ice_candidate(&self, ice_candidate: IceCandidate) -> EngineResult<()> {
        let mut inner = self.inner.lock().await;

        if self.peer_connection.current_remote_description().is_some() && !inner.restarting_ice {
            drop(inner);
            self.peer_connection.add_ice_candidate(ice_candidate).await?;

            return Ok(());
        }

        inner.pending_candidates.push(ice_candidate);
        Ok(())
    }

    pub async fn set_remote_description(
        &self,
        remote_description: SessionDescription,
    ) -> EngineResult<()> {
        let mut inner = self.inner.lock().await;

        self.peer_connection.set_remote_description(remote_description).await?;

        for ic in inner.pending_candidates.drain(..) {
            self.peer_connection.add_ice_candidate(ic).await?;
        }

        inner.restarting_ice = false;

        if inner.renegotiate {
            inner.renegotiate = false;
            self.create_and_send_offer(OfferOptions::default()).await?;
        }

        Ok(())
    }

    pub async fn create_anwser(
        &self,
        offer: SessionDescription,
        options: AnswerOptions,
    ) -> EngineResult<SessionDescription> {
        self.set_remote_description(offer).await?;
        let answer = self.peer_connection().create_answer(options).await?;
        self.peer_connection().set_local_description(answer.clone()).await?;

        Ok(answer)
    }

    pub async fn set_send_bitrate_bounds_bps(&self, max_bps: Option<u64>, min_bps: Option<u64>) {
        let mut inner = self.inner.lock().await;
        inner.max_send_bitrate_bps = max_bps;
        inner.min_send_bitrate_bps = min_bps;
    }

    pub(crate) async fn set_h264_screen_share_level(&self, level: Option<H264ScreenShareLevel>) {
        self.inner.lock().await.h264_screen_share_level = level;
    }

    /// Restore the selected hardware level when libwebrtc normalizes the
    /// capability to its default Level 3.1. Only touch a lone send-only track.
    fn offer_h264_screen_share_level(sdp: &str, level: H264ScreenShareLevel) -> Option<String> {
        let mut lines: Vec<&str> = sdp.split_inclusive('\n').collect();
        let mut sections = lines.iter().enumerate()
            .filter(|(_, line)| line.starts_with("m=video "));
        let (start, _) = sections.next()?;
        if sections.next().is_some() {
            return None;
        }
        let end = lines[start + 1..].iter().position(|line| line.starts_with("m="))
            .map_or(lines.len(), |offset| start + 1 + offset);
        let video = &lines[start + 1..end];
        if !video.iter().any(|line| line.trim_end() == "a=sendonly") {
            return None;
        }
        let (offset, old_profile) = video.iter().enumerate().find_map(|(offset, line)| {
            let (payload, params) =
                line.trim_end().strip_prefix("a=fmtp:")?.split_once(' ')?;
            let mut parameters = params.split(';').map(str::trim);
            let old_profile = parameters.clone().find(|param| {
                matches!(*param, "profile-level-id=42e01f" | "profile-level-id=42e028" | "profile-level-id=42e02a")
            })?;
            (parameters.any(|param| param == "packetization-mode=1")
                && video.iter().any(|rtp| {
                    rtp.trim_end().strip_prefix("a=rtpmap:")
                        .and_then(|rtp| rtp.split_once(' '))
                        == Some((payload, "H264/90000"))
                }))
                .then_some((offset, old_profile))
        })?;
        let new_profile = level.profile_id();
        if old_profile == new_profile {
            return None;
        }
        let fmtp_line = start + 1 + offset;
        let upgraded = lines[fmtp_line].replacen(old_profile, new_profile, 1);
        lines[fmtp_line] = &upgraded;
        Some(lines.concat())
    }

    fn compute_start_bitrate_kbps(ultimate_bps: Option<u64>) -> Option<u32> {
        let ultimate_kbps = (ultimate_bps? / 1000) as u32;
        if ultimate_kbps == 0 {
            return None;
        }
        // JS / Flutter uses ~70% of ultimate; 100% is also reasonable per feedback.
        let start_kbps = (ultimate_kbps as f64 * 0.7).round() as u32;

        // A low start-bitrate hint is more likely to hurt than help for VP9/AV1.
        // If the max is too low, don't inject a start-bitrate hint at all.
        if ultimate_kbps < 300 {
            return None;
        }

        Some(start_kbps.min(ultimate_kbps))
    }

    /// Munge SDP to change a=inactive to a=recvonly for RTP media m-lines in single PC mode.
    /// This is needed because WebRTC can generate inactive direction even when transceivers
    /// were configured as recvonly.
    ///
    /// We intentionally limit this to RTP m-sections, so non-RTP sections (for example
    /// data-channel `m=application` sections) are not rewritten.
    fn munge_inactive_to_recvonly_for_media(sdp: &str) -> String {
        // Detect what line ending the original SDP uses
        let uses_crlf = sdp.contains("\r\n");
        let eol = if uses_crlf { "\r\n" } else { "\n" };

        let lines: Vec<&str> =
            if uses_crlf { sdp.split("\r\n").collect() } else { sdp.split('\n').collect() };

        let mut out: Vec<String> = Vec::with_capacity(lines.len());
        let mut in_rtp_media_section = false;

        for line in lines {
            let l = line.trim();

            // Track whether the current m-section is RTP-based.
            if l.starts_with("m=") {
                // Example RTP m-line:
                //   m=audio 9 UDP/TLS/RTP/SAVPF 111
                // Example data channel m-line:
                //   m=application 9 UDP/DTLS/SCTP webrtc-datachannel
                in_rtp_media_section = l.contains("RTP/");
            }

            // Change inactive to recvonly for RTP media m-sections.
            if in_rtp_media_section && l == "a=inactive" {
                out.push("a=recvonly".to_string());
            } else {
                out.push(line.to_string());
            }
        }

        let mut munged = out.join(eol);
        if !munged.ends_with(eol) {
            munged.push_str(eol);
        }
        munged
    }

    /// Munge SDP to add stereo=1 to opus audio fmtp lines for single PC mode
    /// As per the doc: "In single peer connection mode, the receiver sends the offer,
    /// hence does not know if the sender will send stereo. Therefore, stereo=1 is not set
    /// in the offer. Always set stereo=1 in the offer - This method works."
    fn munge_stereo_for_audio(sdp: &str) -> String {
        // Detect what line ending the original SDP uses
        let uses_crlf = sdp.contains("\r\n");
        let eol = if uses_crlf { "\r\n" } else { "\n" };

        // Split preserving the intended line ending style
        let lines: Vec<&str> =
            if uses_crlf { sdp.split("\r\n").collect() } else { sdp.split('\n').collect() };

        // Find opus payload type (usually 111, but be flexible)
        let mut opus_pts: Vec<&str> = Vec::new();
        for line in &lines {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("a=rtpmap:") {
                let mut it = rest.split_whitespace();
                let pt = it.next().unwrap_or("");
                let codec = it.next().unwrap_or("");
                // Match opus/48000/2 (stereo opus)
                if codec.starts_with("opus/48000") && !pt.is_empty() {
                    opus_pts.push(pt);
                }
            }
        }

        if opus_pts.is_empty() {
            return sdp.to_string();
        }

        // Rewrite fmtp lines to add stereo=1 if not present
        let mut out: Vec<String> = Vec::with_capacity(lines.len());
        for line in lines {
            let mut rewritten = line.to_string();

            for pt in &opus_pts {
                let prefix = format!("a=fmtp:{pt} ");
                if rewritten.starts_with(&prefix) {
                    // Check if stereo= already exists
                    if !rewritten.contains("stereo=") {
                        // Append stereo=1
                        rewritten.push_str(";stereo=1");
                    }
                    break;
                }
            }

            out.push(rewritten);
        }

        // Re-join using same EOL
        let mut munged = out.join(eol);
        if !munged.ends_with(eol) {
            munged.push_str(eol);
        }
        munged
    }

    /// Munge SDP to add x-google-min-bitrate and x-google-start-bitrate to H264 fmtp lines.
    /// This prevents TWCC BWE from pushing the encoder bitrate below the minimum,
    /// which is critical for localhost publisher → SFU scenarios where BWE estimates are wrong.
    fn munge_h264_bitrate_hints(sdp: &str, min_bitrate_kbps: u32, start_bitrate_kbps: u32) -> String {
        let uses_crlf = sdp.contains("\r\n");
        let eol = if uses_crlf { "\r\n" } else { "\n" };
        let lines: Vec<&str> =
            if uses_crlf { sdp.split("\r\n").collect() } else { sdp.split('\n').collect() };

        // Find H264 payload types
        let mut h264_pts: Vec<&str> = Vec::new();
        for line in &lines {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("a=rtpmap:") {
                let mut it = rest.split_whitespace();
                let pt = it.next().unwrap_or("");
                let codec = it.next().unwrap_or("");
                if codec.starts_with("H264/90000") && !pt.is_empty() {
                    h264_pts.push(pt);
                }
            }
        }

        if h264_pts.is_empty() {
            return sdp.to_string();
        }

        let mut out: Vec<String> = Vec::with_capacity(lines.len());
        for line in lines {
            let mut rewritten = line.to_string();

            for pt in &h264_pts {
                let prefix = format!("a=fmtp:{pt} ");
                if rewritten.starts_with(&prefix) {
                    // Add/replace x-google-min-bitrate
                    if let Some(pos) = rewritten.find("x-google-min-bitrate=") {
                        let after = &rewritten[pos..];
                        let end = after.find(';').map(|i| pos + i).unwrap_or_else(|| rewritten.len());
                        rewritten.replace_range(pos..end, &format!("x-google-min-bitrate={min_bitrate_kbps}"));
                    } else {
                        rewritten.push_str(&format!(";x-google-min-bitrate={min_bitrate_kbps}"));
                    }

                    // Add/replace x-google-start-bitrate
                    if let Some(pos) = rewritten.find("x-google-start-bitrate=") {
                        let after = &rewritten[pos..];
                        let end = after.find(';').map(|i| pos + i).unwrap_or_else(|| rewritten.len());
                        rewritten.replace_range(pos..end, &format!("x-google-start-bitrate={start_bitrate_kbps}"));
                    } else {
                        rewritten.push_str(&format!(";x-google-start-bitrate={start_bitrate_kbps}"));
                    }
                    break;
                }
            }

            out.push(rewritten);
        }

        let mut munged = out.join(eol);
        if !munged.ends_with(eol) {
            munged.push_str(eol);
        }
        munged
    }

    fn compute_h264_bitrate_hints(
        max_bitrate_bps: Option<u64>,
        min_bitrate_bps: Option<u64>,
    ) -> Option<(u32, u32)> {
        let max_kbps = (max_bitrate_bps? / 1000) as u32;
        if max_kbps < 1000 {
            return None;
        }

        let fallback_min_kbps = (max_kbps as f64 * 0.125).round() as u32;
        let min_kbps = min_bitrate_bps
            .map(|bps| (bps / 1000) as u32)
            .filter(|kbps| *kbps > 0)
            .unwrap_or(fallback_min_kbps)
            .min(max_kbps);

        Some((min_kbps, max_kbps))
    }

    fn munge_x_google_start_bitrate(sdp: &str, start_bitrate_kbps: u32) -> String {
        // Detect what line ending the original SDP uses
        let uses_crlf = sdp.contains("\r\n");
        let eol = if uses_crlf { "\r\n" } else { "\n" };

        // Split preserving the intended line ending style
        let lines: Vec<&str> =
            if uses_crlf { sdp.split("\r\n").collect() } else { sdp.split('\n').collect() };

        // 1) Find VP9/AV1 payload types
        let mut target_pts: Vec<&str> = Vec::new();
        for line in &lines {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("a=rtpmap:") {
                let mut it = rest.split_whitespace();
                let pt = it.next().unwrap_or("");
                let codec = it.next().unwrap_or("");
                if (codec.starts_with("VP9/90000") || codec.starts_with("AV1/90000"))
                    && !pt.is_empty()
                {
                    target_pts.push(pt);
                }
            }
        }
        if target_pts.is_empty() {
            return sdp.to_string();
        }

        // 2) Rewrite fmtp lines (minimal mutation)
        let mut out: Vec<String> = Vec::with_capacity(lines.len());
        for line in lines {
            let mut rewritten = line.to_string();

            for pt in &target_pts {
                let prefix = format!("a=fmtp:{pt} ");
                if rewritten.starts_with(&prefix) {
                    // Replace if present; append if not present
                    if let Some(pos) = rewritten.find("x-google-start-bitrate=") {
                        // replace existing value up to next ';' or end
                        let after = &rewritten[pos..];
                        let end =
                            after.find(';').map(|i| pos + i).unwrap_or_else(|| rewritten.len());
                        rewritten.replace_range(
                            pos..end,
                            &format!("x-google-start-bitrate={start_bitrate_kbps}"),
                        );
                    } else {
                        rewritten
                            .push_str(&format!(";x-google-start-bitrate={start_bitrate_kbps}"));
                    }
                    break;
                }
            }

            out.push(rewritten);
        }

        // Re-join using same EOL, and ensure trailing EOL (some parsers are picky)
        let mut munged = out.join(eol);
        if !munged.ends_with(eol) {
            munged.push_str(eol);
        }
        munged
    }

    pub async fn create_and_send_offer(&self, options: OfferOptions) -> EngineResult<()> {
        let mut inner = self.inner.lock().await;
        if options.ice_restart {
            inner.restarting_ice = true;
        }

        if self.peer_connection.signaling_state() == SignalingState::HaveLocalOffer {
            let remote_sdp = self.peer_connection.current_remote_description();
            if options.ice_restart && remote_sdp.is_some() {
                let remote_sdp = remote_sdp.unwrap();

                // Cancel the old renegotiation (Basically say the server rejected the previous
                // offer) So we can resend a new offer just after this
                self.peer_connection.set_remote_description(remote_sdp).await?;
            } else {
                inner.renegotiate = true;
                return Ok(());
            }
        } else if self.peer_connection.signaling_state() == SignalingState::Closed {
            log::warn!("peer connection is closed, cannot create offer");
            return Ok(());
        }

        let mut offer = self.peer_connection.create_offer(options).await?;
        let mut sdp = offer.to_string();

        if inner.single_pc_mode {
            // Fix inactive media m-lines to recvonly for single PC mode.
            // WebRTC can generate a=inactive even when transceivers are recvonly.
            let recvonly_munged = Self::munge_inactive_to_recvonly_for_media(&sdp);
            if recvonly_munged != sdp {
                match SessionDescription::parse(&recvonly_munged, offer.sdp_type()) {
                    Ok(parsed) => {
                        offer = parsed;
                        sdp = recvonly_munged;
                    }
                    Err(e) => {
                        log::warn!("Failed to parse recvonly-munged SDP: {e}");
                    }
                }
            }

            // Apply stereo munging for single PC mode
            let stereo_munged = Self::munge_stereo_for_audio(&sdp);
            if stereo_munged != sdp {
                match SessionDescription::parse(&stereo_munged, offer.sdp_type()) {
                    Ok(parsed) => {
                        offer = parsed;
                        sdp = stereo_munged;
                    }
                    Err(e) => {
                        log::warn!("Failed to parse stereo-munged SDP, using original: {e}");
                    }
                }
            }
        }

        let is_vp9 = sdp.contains(" VP9/90000");
        let is_av1 = sdp.contains(" AV1/90000");
        if is_vp9 || is_av1 {
            if let Some(start_kbps) = Self::compute_start_bitrate_kbps(inner.max_send_bitrate_bps) {
                log::info!(
                    "Applying x-google-start-bitrate={} kbps (ultimate_bps={:?})",
                    start_kbps,
                    inner.max_send_bitrate_bps
                );

                let munged = Self::munge_x_google_start_bitrate(&sdp, start_kbps);
                if munged != sdp {
                    log::info!("SDP munged successfully (VP9/AV1)");
                    match SessionDescription::parse(&munged, offer.sdp_type()) {
                        Ok(parsed) => {
                            offer = parsed;
                            sdp = munged;
                        }
                        Err(e) => log::warn!(
                            "Failed to parse munged SDP, falling back to original offer: {e}"
                        ),
                    }
                } else {
                    log::debug!("SDP munging produced no changes");
                }
            }
        }

        // Apply H264 bitrate hints (x-google-min-bitrate + x-google-start-bitrate).
        // This prevents TWCC BWE from starving the encoder on localhost or low-jitter links.
        let is_h264 = sdp.contains(" H264/90000");
        if is_h264 {
            if let Some((min_kbps, start_kbps)) = Self::compute_h264_bitrate_hints(
                inner.max_send_bitrate_bps,
                inner.min_send_bitrate_bps,
            ) {
                let max_kbps = (inner.max_send_bitrate_bps.unwrap_or_default() / 1000) as u32;
                log::info!(
                    "Applying H264 bitrate hints: min={}kbps start={}kbps (max={}kbps)",
                    min_kbps, start_kbps, max_kbps
                );

                let munged = Self::munge_h264_bitrate_hints(&sdp, min_kbps, start_kbps);
                if munged != sdp {
                    log::info!("SDP munged successfully (H264)");
                    match SessionDescription::parse(&munged, offer.sdp_type()) {
                        Ok(parsed) => {
                            offer = parsed;
                            // sdp = munged; // not needed, last use
                        }
                        Err(e) => log::warn!(
                            "Failed to parse H264-munged SDP, falling back: {e}"
                        ),
                    }
                }
            }
        }

        if let Some(level) = inner.h264_screen_share_level {
            if let Some(upgraded) = Self::offer_h264_screen_share_level(&offer.to_string(), level) {
                match SessionDescription::parse(&upgraded, offer.sdp_type()) {
                    Ok(parsed) => offer = parsed,
                    Err(error) => log::warn!("Could not offer H264 {level:?}: {error}"),
                }
            }
        }

        self.peer_connection.set_local_description(offer.clone()).await?;

        if let Some(handler) = self.on_offer_handler.lock().as_mut() {
            handler(offer);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{H264ScreenShareLevel, PeerTransport};

    #[test]
    fn level_4_offer_only_changes_constrained_baseline_mode_1() {
        let offer = concat!(
            "v=0\r\n",
            "m=audio 9 UDP/TLS/RTP/SAVPF 109\r\n",
            "a=fmtp:109 profile-level-id=42e01f;packetization-mode=1\r\n",
            "m=video 9 UDP/TLS/RTP/SAVPF 109 110 117\r\n",
            "a=sendonly\r\n",
            "a=rtpmap:109 H264/90000\r\n",
            "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n",
            "a=rtpmap:110 H264/90000\r\n",
            "a=fmtp:110 packetization-mode=0;profile-level-id=42e01f\r\n",
            "a=rtpmap:117 H264/90000\r\n",
            "a=fmtp:117 packetization-mode=1;profile-level-id=4d001f\r\n",
        );
        let expected = offer.replace(
            "packetization-mode=1;profile-level-id=42e01f",
            "packetization-mode=1;profile-level-id=42e028",
        );
        let level_4 = |sdp: &str| PeerTransport::offer_h264_screen_share_level(sdp, H264ScreenShareLevel::Level4);
        let level_4_2 = |sdp: &str| PeerTransport::offer_h264_screen_share_level(sdp, H264ScreenShareLevel::Level4_2);
        let expected_high = expected.replace("profile-level-id=42e028", "profile-level-id=42e02a");
        assert_eq!(level_4(offer).as_deref(), Some(expected.as_str()));
        assert_eq!(level_4_2(offer).as_deref(), Some(expected_high.as_str()));
        assert_eq!(level_4(&expected_high).as_deref(), Some(expected.as_str()));
        assert!(level_4_2(&offer.replace("a=sendonly", "a=recvonly")).is_none());
        assert!(level_4(
            &format!("{offer}m=video 9 UDP/TLS/RTP/SAVPF 120\r\n")
        ).is_none());
        assert!(level_4(&expected).is_none());
    }

    #[test]
    fn no_vp9_or_av1_is_noop() {
        let sdp = "v=0\n\
o=- 0 0 IN IP4 127.0.0.1\n\
s=-\n\
t=0 0\n\
m=video 9 UDP/TLS/RTP/SAVPF 96\n\
a=rtpmap:96 VP8/90000\n\
a=fmtp:96 some=param\n";
        let out = PeerTransport::munge_x_google_start_bitrate(sdp, 3200);
        assert_eq!(out, sdp, "should not change SDP if no VP9/AV1 present");
    }

    #[test]
    fn h264_hints_use_publish_min_floor_and_full_start_bitrate() {
        let (min_kbps, start_kbps) =
            PeerTransport::compute_h264_bitrate_hints(Some(12_000_000), Some(4_000_000))
                .expect("h264 bitrate hints");

        assert_eq!(min_kbps, 4000);
        assert_eq!(start_kbps, 12000);
    }

    #[test]
    fn vp9_with_fmtp_appends_start_bitrate_and_preserves_lf_and_trailing_eol() {
        // LF-only SDP, ends with \n already
        let sdp = "v=0\n\
o=- 0 0 IN IP4 127.0.0.1\n\
s=-\n\
t=0 0\n\
m=video 9 UDP/TLS/RTP/SAVPF 98\n\
a=rtpmap:98 VP9/90000\n\
a=fmtp:98 profile-id=0\n";
        let out = PeerTransport::munge_x_google_start_bitrate(sdp, 3200);

        assert!(out.contains("a=fmtp:98 profile-id=0;x-google-start-bitrate=3200\n"));
        assert!(!out.contains("\r\n"), "should preserve LF-only line endings");
        assert!(out.ends_with('\n'), "should end with a trailing LF");
    }

    #[test]
    fn av1_with_fmtp_replaces_existing_start_bitrate_value() {
        let sdp = "v=0\n\
o=- 0 0 IN IP4 127.0.0.1\n\
s=-\n\
t=0 0\n\
m=video 9 UDP/TLS/RTP/SAVPF 104\n\
a=rtpmap:104 AV1/90000\n\
a=fmtp:104 x-google-start-bitrate=1000;foo=bar\n";
        let out = PeerTransport::munge_x_google_start_bitrate(sdp, 2500);
        assert!(
            out.contains("a=fmtp:104 x-google-start-bitrate=2500;foo=bar\n"),
            "should replace existing x-google-start-bitrate value and keep other params"
        );
        assert!(!out.contains("x-google-start-bitrate=1000"), "old bitrate value should be gone");
    }

    #[test]
    fn vp9_without_fmtp_line_is_noop() {
        // VP9 rtpmap exists, but no fmtp: function intentionally does not insert a new fmtp line.
        let sdp = "v=0\n\
o=- 0 0 IN IP4 127.0.0.1\n\
s=-\n\
t=0 0\n\
m=video 9 UDP/TLS/RTP/SAVPF 98\n\
a=rtpmap:98 VP9/90000\n";
        let out = PeerTransport::munge_x_google_start_bitrate(sdp, 3200);
        assert_eq!(
            out, sdp,
            "should not modify SDP if there is no fmtp line for the VP9/AV1 payload type"
        );
    }

    #[test]
    fn preserves_crlf_and_adds_trailing_crlf_if_missing() {
        // CRLF SDP without trailing CRLF at the end (common edge)
        let sdp = "v=0\r\n\
o=- 0 0 IN IP4 127.0.0.1\r\n\
s=-\r\n\
t=0 0\r\n\
m=video 9 UDP/TLS/RTP/SAVPF 98\r\n\
a=rtpmap:98 VP9/90000\r\n\
a=fmtp:98 profile-id=0"; // <- no final \r\n
        let out = PeerTransport::munge_x_google_start_bitrate(sdp, 3200);
        assert!(out.contains("a=fmtp:98 profile-id=0;x-google-start-bitrate=3200\r\n"));
        assert!(out.contains("\r\n"), "should keep CRLF line endings");
        assert!(out.ends_with("\r\n"), "should ensure trailing CRLF");
        assert!(!out.contains("\n") || out.contains("\r\n"), "should not introduce lone LF");
    }

    #[test]
    fn multiple_pts_vp9_and_av1_only_mutate_matching_fmtp_lines() {
        let sdp = "v=0\n\
o=- 0 0 IN IP4 127.0.0.1\n\
s=-\n\
t=0 0\n\
m=video 9 UDP/TLS/RTP/SAVPF 96 98 104\n\
a=rtpmap:96 VP8/90000\n\
a=rtpmap:98 VP9/90000\n\
a=rtpmap:104 AV1/90000\n\
a=fmtp:96 foo=bar\n\
a=fmtp:98 profile-id=0\n\
a=fmtp:104 x-google-start-bitrate=1111;baz=qux\n";
        let out = PeerTransport::munge_x_google_start_bitrate(sdp, 2222);
        // VP8 fmtp should be unchanged
        assert!(out.contains("a=fmtp:96 foo=bar\n"));
        // VP9 fmtp should get appended
        assert!(out.contains("a=fmtp:98 profile-id=0;x-google-start-bitrate=2222\n"));
        // AV1 fmtp should get replaced
        assert!(out.contains("a=fmtp:104 x-google-start-bitrate=2222;baz=qux\n"));
        assert!(!out.contains("a=fmtp:104 x-google-start-bitrate=1111"));
    }

    #[test]
    fn does_not_duplicate_start_bitrate_when_already_present_no_semicolon_following() {
        // Existing x-google-start-bitrate at end of line (no trailing ';')
        let sdp = "v=0\n\
o=- 0 0 IN IP4 127.0.0.1\n\
s=-\n\
t=0 0\n\
m=video 9 UDP/TLS/RTP/SAVPF 98\n\
a=rtpmap:98 VP9/90000\n\
a=fmtp:98 profile-id=0;x-google-start-bitrate=1000\n";
        let out = PeerTransport::munge_x_google_start_bitrate(sdp, 3000);
        assert!(out.contains("a=fmtp:98 profile-id=0;x-google-start-bitrate=3000\n"));
        assert!(!out.contains("x-google-start-bitrate=1000"));
        // ensure only one occurrence
        assert_eq!(out.matches("x-google-start-bitrate=").count(), 1);
    }

    #[test]
    fn inactive_media_is_munged_to_recvonly_for_all_rtp_sections() {
        let sdp = "v=0\n\
o=- 0 0 IN IP4 127.0.0.1\n\
s=-\n\
t=0 0\n\
m=audio 9 UDP/TLS/RTP/SAVPF 111\n\
a=inactive\n\
a=rtpmap:111 opus/48000/2\n\
m=video 9 UDP/TLS/RTP/SAVPF 96\n\
a=inactive\n\
m=text 9 UDP/TLS/RTP/SAVPF 98\n\
a=inactive\n\
m=audio 9 UDP/TLS/RTP/SAVPF 111\n\
a=inactive\n";
        let out = PeerTransport::munge_inactive_to_recvonly_for_media(sdp);
        assert!(out.contains("m=audio 9 UDP/TLS/RTP/SAVPF 111\na=recvonly\n"));
        assert!(out.contains("m=text 9 UDP/TLS/RTP/SAVPF 98\na=recvonly\n"));
        assert_eq!(out.matches("a=recvonly").count(), 4);
        assert_eq!(out.matches("a=inactive").count(), 0);
    }

    #[test]
    fn inactive_application_section_is_not_munged() {
        let sdp = "v=0\n\
o=- 0 0 IN IP4 127.0.0.1\n\
s=-\n\
t=0 0\n\
m=audio 9 UDP/TLS/RTP/SAVPF 111\n\
a=inactive\n\
m=application 9 UDP/DTLS/SCTP webrtc-datachannel\n\
a=inactive\n";
        let out = PeerTransport::munge_inactive_to_recvonly_for_media(sdp);
        assert!(out.contains("m=audio 9 UDP/TLS/RTP/SAVPF 111\na=recvonly\n"));
        assert!(out.contains("m=application 9 UDP/DTLS/SCTP webrtc-datachannel\na=inactive\n"));
    }

    #[test]
    fn stereo_is_added_for_opus_fmtp_only_once() {
        let sdp = "v=0\n\
o=- 0 0 IN IP4 127.0.0.1\n\
s=-\n\
t=0 0\n\
m=audio 9 UDP/TLS/RTP/SAVPF 111 0\n\
a=rtpmap:111 opus/48000/2\n\
a=rtpmap:0 PCMU/8000\n\
a=fmtp:111 minptime=10;useinbandfec=1\n\
a=fmtp:0 foo=bar\n";
        let out = PeerTransport::munge_stereo_for_audio(sdp);
        assert!(out.contains("a=fmtp:111 minptime=10;useinbandfec=1;stereo=1\n"));
        assert!(out.contains("a=fmtp:0 foo=bar\n"));
        assert_eq!(out.matches("stereo=1").count(), 1);
    }

    #[test]
    fn stereo_munging_is_idempotent_when_stereo_already_present() {
        let sdp = "v=0\n\
o=- 0 0 IN IP4 127.0.0.1\n\
s=-\n\
t=0 0\n\
m=audio 9 UDP/TLS/RTP/SAVPF 111\n\
a=rtpmap:111 opus/48000/2\n\
a=fmtp:111 minptime=10;stereo=1\n";
        let out = PeerTransport::munge_stereo_for_audio(sdp);
        assert_eq!(out.matches("stereo=1").count(), 1);
    }
}
