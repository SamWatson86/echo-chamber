/*
 * Copyright 2025 LiveKit, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "livekit/video_encoder_factory.h"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include "api/environment/environment_factory.h"
#include "api/video_codecs/sdp_video_format.h"
#include "api/video_codecs/video_encoder.h"
#include "api/video_codecs/video_encoder_factory_template.h"
#include "livekit/objc_video_factory.h"
#include "media/base/media_constants.h"
#include "media/engine/simulcast_encoder_adapter.h"
#include "rtc_base/logging.h"
#if defined(RTC_USE_LIBAOM_AV1_ENCODER)
#include "api/video_codecs/video_encoder_factory_template_libaom_av1_adapter.h"
#endif
#if defined(WEBRTC_USE_H264)
#include "api/video_codecs/video_encoder_factory_template_open_h264_adapter.h"
#endif
#include "api/video_codecs/video_encoder_factory_template_libvpx_vp8_adapter.h"
#include "api/video_codecs/video_encoder_factory_template_libvpx_vp9_adapter.h"

#ifdef WEBRTC_ANDROID
#include "livekit/android.h"
#endif

#if defined(USE_NVIDIA_VIDEO_CODEC)
#include "nvidia/nvidia_encoder_factory.h"
#endif

#if defined(USE_VAAPI_VIDEO_CODEC)
#include "vaapi/vaapi_encoder_factory.h"
#endif

namespace livekit_ffi {

namespace {

std::string FormatVideoFormat(const webrtc::SdpVideoFormat& format) {
  std::ostringstream out;
  out << format.name;
  for (const auto& param : format.parameters) {
    out << " " << param.first << "=" << param.second;
  }
  return out.str();
}

void AppendEncoderFactoryDebug(const std::string& line) {
#if defined(WIN32)
  static std::mutex debug_mutex;
  std::lock_guard<std::mutex> lock(debug_mutex);
  const char* local_appdata = std::getenv("LOCALAPPDATA");
  if (!local_appdata || !*local_appdata) {
    return;
  }
  std::ofstream out(
      std::string(local_appdata) + "\\Echo Chamber\\encoder-factory-debug.log",
      std::ios::app);
  if (!out.is_open()) {
    return;
  }
  out << line << std::endl;
#else
  (void)line;
#endif
}

int H264PacketizationPreference(const webrtc::SdpVideoFormat& format) {
  if (format.name != webrtc::kH264CodecName) {
    return 0;
  }

  auto it = format.parameters.find("packetization-mode");
  return (it != format.parameters.end() && it->second == "1") ? 0 : 1;
}

void AppendPreferredFormats(
    std::vector<webrtc::SdpVideoFormat>* target,
    std::vector<webrtc::SdpVideoFormat> formats) {
  // Browser subscribers are happiest on packetization-mode=1, and our direct
  // H26x path should prefer hardware/browser-friendly H264 variants before the
  // raw OpenH264 mode=0 fallback formats.
  std::stable_sort(
      formats.begin(), formats.end(),
      [](const webrtc::SdpVideoFormat& lhs,
         const webrtc::SdpVideoFormat& rhs) {
        return H264PacketizationPreference(lhs) <
               H264PacketizationPreference(rhs);
      });
  target->insert(target->end(), formats.begin(), formats.end());
}

}  // namespace

using Factory = webrtc::VideoEncoderFactoryTemplate<
    webrtc::LibvpxVp8EncoderTemplateAdapter,
#if defined(WEBRTC_USE_H264)
    webrtc::OpenH264EncoderTemplateAdapter,
#endif
#if defined(RTC_USE_LIBAOM_AV1_ENCODER)
    webrtc::LibaomAv1EncoderTemplateAdapter,
#endif
    webrtc::LibvpxVp9EncoderTemplateAdapter>;

webrtc::SdpVideoFormat NormalizeSoftwareH264Format(
    webrtc::SdpVideoFormat format) {
  if (format.name == webrtc::kH264CodecName) {
    // The working NVENC/VAAPI paths negotiate packetization-mode=1. Keep the
    // software OpenH264 fallback on that same wire contract so subscribers do
    // not get stuck on a mode=0-only stream after the direct H26x bypass.
    format.parameters["packetization-mode"] = "1";
  }
  return format;
}

std::vector<webrtc::SdpVideoFormat> GetSoftwareSupportedFormats() {
  auto formats = Factory().GetSupportedFormats();
  for (auto& format : formats) {
    format = NormalizeSoftwareH264Format(std::move(format));
  }
  return formats;
}

VideoEncoderFactory::InternalFactory::InternalFactory() {
#ifdef __APPLE__
  factories_.push_back(livekit_ffi::CreateObjCVideoEncoderFactory());
#endif

#ifdef WEBRTC_ANDROID
  factories_.push_back(CreateAndroidVideoEncoderFactory());
#endif

#if defined(USE_NVIDIA_VIDEO_CODEC)
  if (webrtc::NvidiaVideoEncoderFactory::IsSupported()) {
    factories_.push_back(std::make_unique<webrtc::NvidiaVideoEncoderFactory>());
  } else {
#endif

#if defined(USE_VAAPI_VIDEO_CODEC)
    if (webrtc::VAAPIVideoEncoderFactory::IsSupported()) {
      factories_.push_back(std::make_unique<webrtc::VAAPIVideoEncoderFactory>());
    }
#endif

#if defined(USE_NVIDIA_VIDEO_CODEC)
  }
#endif

  std::ostringstream line;
  line << "[encoder-factory] ctor hw_factories=" << factories_.size();
  line << " force_software="
       << (livekit_ffi::IsSoftwareEncoderForced() ? "1" : "0");
  AppendEncoderFactoryDebug(line.str());
}

std::vector<webrtc::SdpVideoFormat>
VideoEncoderFactory::InternalFactory::GetSupportedFormats() const {
  std::vector<webrtc::SdpVideoFormat> formats;
  for (const auto& factory : factories_) {
    AppendPreferredFormats(&formats, factory->GetSupportedFormats());
  }
  AppendPreferredFormats(&formats, GetSoftwareSupportedFormats());
  return formats;
}

VideoEncoderFactory::CodecSupport
VideoEncoderFactory::InternalFactory::QueryCodecSupport(
    const webrtc::SdpVideoFormat& format,
    std::optional<std::string> scalability_mode) const {
  for (const auto& factory : factories_) {
    auto codec_support =
        factory->QueryCodecSupport(format, scalability_mode);
    if (codec_support.is_supported) {
      return codec_support;
    }
  }

  auto software_format = NormalizeSoftwareH264Format(format);
  auto original_format =
      webrtc::FuzzyMatchSdpVideoFormat(GetSoftwareSupportedFormats(),
                                       software_format);
  return original_format
             ? Factory().QueryCodecSupport(*original_format, scalability_mode)
             : webrtc::VideoEncoderFactory::CodecSupport{.is_supported = false};
}

std::unique_ptr<webrtc::VideoEncoder>
VideoEncoderFactory::InternalFactory::Create(
    const webrtc::Environment& env,
    const webrtc::SdpVideoFormat& format) {
  std::cout << "[encoder-factory] InternalFactory::Create for: " << format.name;
  for (const auto& p : format.parameters) {
    std::cout << " " << p.first << "=" << p.second;
  }
  std::cout << " (hw_factories=" << factories_.size() << ")" << std::endl;
  AppendEncoderFactoryDebug(
      "[encoder-factory] internal-create request=" + FormatVideoFormat(format) +
      " hw_factories=" + std::to_string(factories_.size()));

  for (const auto& factory : factories_) {
    for (const auto& supported_format : factory->GetSupportedFormats()) {
      if (supported_format.IsSameCodec(format)) {
        std::cout << "[encoder-factory] HW factory matched! Delegating." << std::endl;
        AppendEncoderFactoryDebug(
            "[encoder-factory] hw-match request=" + FormatVideoFormat(format) +
            " matched=" + FormatVideoFormat(supported_format));
        return factory->Create(env, format);
      }
    }
  }

  std::cout << "[encoder-factory] No HW match, falling back to SOFTWARE" << std::endl;
  AppendEncoderFactoryDebug(
      "[encoder-factory] no-hw-match request=" + FormatVideoFormat(format));
  auto software_format = NormalizeSoftwareH264Format(format);
  auto original_format =
      webrtc::FuzzyMatchSdpVideoFormat(GetSoftwareSupportedFormats(),
                                       software_format);

  if (original_format) {
    std::cout << "[encoder-factory] Software match: " << original_format->name;
    for (const auto& p : original_format->parameters) {
      std::cout << " " << p.first << "=" << p.second;
    }
    std::cout << std::endl;
    AppendEncoderFactoryDebug(
        "[encoder-factory] software-match request=" + FormatVideoFormat(format) +
        " normalized=" + FormatVideoFormat(software_format) +
        " matched=" + FormatVideoFormat(*original_format));
    return Factory().Create(env, *original_format);
  }

  std::cout << "[encoder-factory] ERROR: No encoder found at all!" << std::endl;
  AppendEncoderFactoryDebug(
      "[encoder-factory] no-encoder request=" + FormatVideoFormat(format));
  return nullptr;
}

VideoEncoderFactory::VideoEncoderFactory() {
  internal_factory_ = std::make_unique<InternalFactory>();
}

std::vector<webrtc::SdpVideoFormat> VideoEncoderFactory::GetSupportedFormats()
    const {
  return internal_factory_->GetSupportedFormats();
}

VideoEncoderFactory::CodecSupport VideoEncoderFactory::QueryCodecSupport(
    const webrtc::SdpVideoFormat& format,
    std::optional<std::string> scalability_mode) const {
  return internal_factory_->QueryCodecSupport(format, scalability_mode);
}

std::unique_ptr<webrtc::VideoEncoder> VideoEncoderFactory::Create(
    const webrtc::Environment& env,
    const webrtc::SdpVideoFormat& format) {
  std::unique_ptr<webrtc::VideoEncoder> encoder;
  const bool is_h26x =
      format.name == "H264" || format.name == "H265" || format.name == "HEVC";

  if (is_h26x) {
    std::cout
        << "[encoder-factory] bypassing SimulcastEncoderAdapter for H26x path"
        << std::endl;
    AppendEncoderFactoryDebug(
        "[encoder-factory] direct-h26x request=" + FormatVideoFormat(format));
    encoder = internal_factory_->Create(env, format);
  } else if (format.IsCodecInList(internal_factory_->GetSupportedFormats())) {
    AppendEncoderFactoryDebug(
        "[encoder-factory] simulcast-adapter request=" + FormatVideoFormat(format));
    encoder = std::make_unique<webrtc::SimulcastEncoderAdapter>(
        env, internal_factory_.get(), nullptr, format);
  }

  return encoder;
}

}  // namespace livekit_ffi
