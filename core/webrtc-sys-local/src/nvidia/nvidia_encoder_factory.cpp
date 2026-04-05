#include "nvidia_encoder_factory.h"

#include <memory>

#include "cuda_context.h"
#include "h264_encoder_impl.h"
#include "h265_encoder_impl.h"
#include "rtc_base/logging.h"

namespace webrtc {

NvidiaVideoEncoderFactory::NvidiaVideoEncoderFactory() {
  // Constrained Baseline (42e0) - broadest compatibility
  std::map<std::string, std::string> baselineParameters = {
      {"profile-level-id", "42e01f"},
      {"level-asymmetry-allowed", "1"},
      {"packetization-mode", "1"},
  };
  supported_formats_.push_back(SdpVideoFormat("H264", baselineParameters));

  // High profile (6400) level 5.1 - matches SDP munging for 4K@60fps
  std::map<std::string, std::string> highParameters = {
      {"profile-level-id", "640033"},
      {"level-asymmetry-allowed", "1"},
      {"packetization-mode", "1"},
  };
  supported_formats_.push_back(SdpVideoFormat("H264", highParameters));

  // Constrained High (640c) - some decoders negotiate this variant
  std::map<std::string, std::string> constrainedHighParameters = {
      {"profile-level-id", "640c33"},
      {"level-asymmetry-allowed", "1"},
      {"packetization-mode", "1"},
  };
  supported_formats_.push_back(SdpVideoFormat("H264", constrainedHighParameters));

  // Main profile (4d00) level 5.1 - intermediate compatibility
  std::map<std::string, std::string> mainParameters = {
      {"profile-level-id", "4d0033"},
      {"level-asymmetry-allowed", "1"},
      {"packetization-mode", "1"},
  };
  supported_formats_.push_back(SdpVideoFormat("H264", mainParameters));

  // Advertise HEVC/H265 with default parameters.
  supported_formats_.push_back(SdpVideoFormat("H265"));
  // Some stacks use 'HEVC' name.
  supported_formats_.push_back(SdpVideoFormat("HEVC"));
}

NvidiaVideoEncoderFactory::~NvidiaVideoEncoderFactory() {}

bool NvidiaVideoEncoderFactory::IsSupported() {
  if (!livekit_ffi::CudaContext::IsAvailable()) {
    RTC_LOG(LS_WARNING) << "Cuda Context is not available.";
    return false;
  }

  std::cout << "Nvidia Encoder is supported." << std::endl;
  return true;
}

std::unique_ptr<VideoEncoder> NvidiaVideoEncoderFactory::Create(
    const Environment& env,
    const SdpVideoFormat& format) {
  std::cout << "[NVENC-factory] Create called for: " << format.name
            << " params:";
  for (const auto& p : format.parameters) {
    std::cout << " " << p.first << "=" << p.second;
  }
  std::cout << std::endl;

  // Check if the requested format is supported.
  for (const auto& supported_format : supported_formats_) {
    bool match = format.IsSameCodec(supported_format);
    if (match) {
      std::cout << "[NVENC-factory] MATCHED format: " << supported_format.name;
      for (const auto& p : supported_format.parameters) {
        std::cout << " " << p.first << "=" << p.second;
      }
      std::cout << std::endl;

      if (!cu_context_) {
        cu_context_ = livekit_ffi::CudaContext::GetInstance();
        if (!cu_context_->Initialize()) {
          std::cout << "[NVENC-factory] ERROR: Failed to initialize CUDA context" << std::endl;
          return nullptr;
        }
      }

      if (format.name == "H264") {
        std::cout << "[NVENC-factory] >>> CREATING NVENC H264 ENCODER <<<" << std::endl;
        return std::make_unique<NvidiaH264EncoderImpl>(
            env, cu_context_->GetContext(), CU_MEMORYTYPE_DEVICE,
            NV_ENC_BUFFER_FORMAT_IYUV, format);
      }

      if (format.name == "H265" || format.name == "HEVC") {
        std::cout << "[NVENC-factory] >>> CREATING NVENC H265 ENCODER <<<" << std::endl;
        return std::make_unique<NvidiaH265EncoderImpl>(
            env, cu_context_->GetContext(), CU_MEMORYTYPE_DEVICE,
            NV_ENC_BUFFER_FORMAT_IYUV, format);
      }
    }
  }
  std::cout << "[NVENC-factory] NO MATCH — returning nullptr" << std::endl;
  return nullptr;
}
std::vector<SdpVideoFormat> NvidiaVideoEncoderFactory::GetSupportedFormats()
    const {
  return supported_formats_;
}

std::vector<SdpVideoFormat> NvidiaVideoEncoderFactory::GetImplementations()
    const {
  return supported_formats_;
}

}  // namespace webrtc
