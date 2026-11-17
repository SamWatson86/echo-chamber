#pragma once

#include <memory>

#include "api/video_codecs/video_encoder.h"
#include "api/video_codecs/sdp_video_format.h"

namespace livekit_ffi {

bool HasAmdMediaFoundationEncoder();
webrtc::SdpVideoFormat AmdMediaFoundationFormat();
bool MatchesAmdMediaFoundationFormat(const webrtc::SdpVideoFormat& format);
std::unique_ptr<webrtc::VideoEncoder> CreateAmdMediaFoundationEncoder(
    const webrtc::SdpVideoFormat& format);

}  // namespace livekit_ffi
