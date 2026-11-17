#include "amd_mf_encoder.h"

#include <windows.h>
#include <codecapi.h>
#include <dxgi1_2.h>
#include <icodecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <deque>
#include <optional>
#include <string>
#include <vector>

#include "api/video/i420_buffer.h"
#include "api/video_codecs/h264_profile_level_id.h"
#include "api/video_codecs/sdp_video_format.h"
#include "common_video/h264/h264_common.h"
#include "livekit/adaptive_screen_share.h"
#include "livekit/codec_debug_log.h"
#include "modules/video_coding/include/video_codec_interface.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "libyuv/convert_from.h"
#include "libyuv/scale.h"

namespace livekit_ffi {
namespace {

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

constexpr UINT kAmdVendorId = 0x1002;
constexpr size_t kMaxPending = 4;
constexpr auto kOutputTimeout = 750ms;

// Windows N can lack Media Foundation. Resolve the API lazily so the desktop
// process can launch and use OpenH264 on those systems.
struct MfApi {
  HMODULE dll = LoadLibraryExW(L"mfplat.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  decltype(&MFStartup) startup = Load<decltype(startup)>("MFStartup");
  decltype(&MFShutdown) shutdown = Load<decltype(shutdown)>("MFShutdown");
  decltype(&MFTEnum2) enumerate = Load<decltype(enumerate)>("MFTEnum2");
  decltype(&MFCreateAttributes) create_attributes = Load<decltype(create_attributes)>("MFCreateAttributes");
  decltype(&MFCreateMediaType) create_type = Load<decltype(create_type)>("MFCreateMediaType");
  decltype(&MFCreateMemoryBuffer) create_buffer = Load<decltype(create_buffer)>("MFCreateMemoryBuffer");
  decltype(&MFCreateAlignedMemoryBuffer) create_aligned_buffer = Load<decltype(create_aligned_buffer)>("MFCreateAlignedMemoryBuffer");
  decltype(&MFCreateSample) create_sample = Load<decltype(create_sample)>("MFCreateSample");

  template <typename T>
  T Load(const char* name) const {
    return dll ? reinterpret_cast<T>(GetProcAddress(dll, name)) : nullptr;
  }

  bool Available() const {
    return startup && shutdown && enumerate && create_attributes && create_type &&
           create_buffer && create_aligned_buffer && create_sample;
  }

  ~MfApi() {
    if (dll) FreeLibrary(dll);
  }
};

const MfApi& Api() {
  static const MfApi api;
  return api;
}

// The libwebrtc encoder queue owns initialization, pumping and teardown.
class MfSession {
 public:
  HRESULT Start() {
    if (!Api().Available()) return HRESULT_FROM_WIN32(ERROR_MOD_NOT_FOUND);
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) return hr;
    com_initialized_ = SUCCEEDED(hr);
    hr = Api().startup(MF_VERSION, MFSTARTUP_LITE);
    started_ = SUCCEEDED(hr);
    return hr;
  }

  ~MfSession() {
    if (started_) Api().shutdown();
    if (com_initialized_) CoUninitialize();
  }

 private:
  bool started_ = false;
  bool com_initialized_ = false;
};

// Activations are obtained for a specific physical adapter, with no software
// transforms and no dependency on the capture adapter's D3D device.
template <typename Visitor>
bool VisitTransforms(Visitor visit) {
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return false;
  for (UINT index = 0;; ++index) {
    ComPtr<IDXGIAdapter1> adapter;
    if (FAILED(factory->EnumAdapters1(index, &adapter))) break;
    DXGI_ADAPTER_DESC1 desc{};
    if (FAILED(adapter->GetDesc1(&desc)) || (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) continue;
#if !defined(ECHO_MF_TEST_ADAPTERS)
    if (desc.VendorId != kAmdVendorId) continue;
#endif
    ComPtr<IMFAttributes> filter;
    if (FAILED(Api().create_attributes(&filter, 1)) ||
        FAILED(filter->SetBlob(MFT_ENUM_ADAPTER_LUID,
                               reinterpret_cast<const UINT8*>(&desc.AdapterLuid), sizeof(LUID)))) continue;
    MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
    IMFActivate** activates = nullptr;
    UINT32 count = 0;
    auto hr = Api().enumerate(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE, nullptr,
                              &output, filter.Get(), &activates, &count);
    bool selected = false;
    for (UINT32 i = 0; i < count; ++i) {
      if (SUCCEEDED(hr) && !selected) selected = visit(activates[i], desc.AdapterLuid);
      activates[i]->Release();
    }
    CoTaskMemFree(activates);
    if (selected) return true;
  }
  return false;
}

HRESULT SetCodecValue(ICodecAPI* codec, const GUID& key, ULONG value) {
  VARIANT variant{};
  variant.vt = VT_UI4;
  variant.ulVal = value;
  return codec->SetValue(&key, &variant);
}

// Convert COM failures into libwebrtc's software fallback code at its interface
// boundary. Preserve the failing stage and HRESULT in the local codec log.
struct MfError {
  const char* operation;
  HRESULT hr;
};

void Require(HRESULT hr, const char* operation) {
  if (FAILED(hr)) throw MfError{operation, hr};
}

void LogFailure(const MfError& error) {
  char code[16];
  std::snprintf(code, sizeof(code), "0x%08lX", static_cast<unsigned long>(error.hr));
  AppendCodecDebug(std::string("[AMD-MF] fallback stage=") + error.operation + " hr=" + code);
}

class AmdMfEncoder final : public webrtc::VideoEncoder {
 public:
  explicit AmdMfEncoder(webrtc::H264Level negotiated_level)
      : negotiated_level_(negotiated_level) {}
  ~AmdMfEncoder() override { Release(); }

  int32_t InitEncode(const webrtc::VideoCodec* settings, const Settings&) override {
    Release();
    if (!settings || settings->width == 0 || settings->height == 0 ||
        settings->width > 1920 || settings->height > 1088 ||
        settings->width % 2 || settings->height % 2 ||
        settings->maxFramerate == 0 ||
        (settings->maxFramerate > 30 &&
         (!AdaptiveScreenShareEnabled() || settings->maxFramerate > 60 ||
          settings->height > 1080)) ||
        settings->numberOfSimulcastStreams > 1) {
      LogFailure({"unsupported dimensions, frame rate or simulcast", E_INVALIDARG});
      return WEBRTC_VIDEO_CODEC_FALLBACK_SOFTWARE;
    }
    input_width_ = settings->width;
    input_height_ = settings->height;
    width_ = input_width_;
    height_ = input_height_;
    const auto high_level = width_ <= 1280 && height_ <= 720
                                ? webrtc::H264Level::kLevel4
                                : webrtc::H264Level::kLevel4_2;
    const auto standard_level = std::min(negotiated_level_, webrtc::H264Level::kLevel4);
    const bool high_fps = settings->maxFramerate > 30 && negotiated_level_ >= high_level;
    fps_ = high_fps ? settings->maxFramerate : std::min<uint32_t>(settings->maxFramerate, 30);
    configured_level_ = high_fps ? high_level : standard_level;
    if (configured_level_ < webrtc::H264Level::kLevel4 && (width_ > 1280 || height_ > 720)) {
      // The SFU can answer with Level 3.1. Keep the hardware path usable at
      // its advertised level by scaling the input before encoding it.
      width_ = std::min(1280, input_width_ * 720 / input_height_) & ~1;
      height_ = std::min(720, input_height_ * 1280 / input_width_) & ~1;
      if (width_ < 2 || height_ < 2) {
        LogFailure({"cannot fit input dimensions within H264 Level 3.1", E_INVALIDARG});
        return WEBRTC_VIDEO_CODEC_FALLBACK_SOFTWARE;
      }
      scaled_ = webrtc::I420Buffer::Create(width_, height_);
    }
    bitrate_ = std::clamp<uint32_t>(settings->startBitrate, 1, MaxBitrate() / 1000) * 1000;
    session_ = std::make_unique<MfSession>();
    const auto hr = session_->Start();
    if (FAILED(hr)) return Fallback({"MFStartup", hr});
    if (OpenAdapter()) return WEBRTC_VIDEO_CODEC_OK;
    if (fps_ > 30) {
      AppendCodecDebug("[AMD-MF] high FPS setup rejected, retrying AMD hardware at 30 fps");
      fps_ = 30;
      configured_level_ = standard_level;
      if (OpenAdapter()) return WEBRTC_VIDEO_CODEC_OK;
    }
    return Fallback({"no usable adapter-scoped H264 transform", MF_E_TOPO_CODEC_NOT_FOUND});
  }

 private:
  bool OpenAdapter() {
    return VisitTransforms([&](IMFActivate* activate, LUID luid) {
          activate_ = activate;
          try {
            Open();
            char adapter[32];
            std::snprintf(adapter, sizeof(adapter), "%08lX:%08lX",
                          static_cast<unsigned long>(luid.HighPart), luid.LowPart);
            AppendCodecDebug(std::string("[AMD-MF] initialized adapter=") + adapter +
                             " size=" + std::to_string(width_) + "x" + std::to_string(height_) +
                             " input=" + std::to_string(input_width_) + "x" + std::to_string(input_height_) +
                             " level_idc=" + std::to_string(static_cast<int>(configured_level_)) +
                             " fps=" + std::to_string(fps_) + " bitrate=" + std::to_string(bitrate_));
            return true;
          } catch (const MfError& error) {
            LogFailure(error);
            CloseTransform();
            return false;
          }
        });
  }

 public:
  int32_t Release() override {
    CloseTransform();
    session_.reset();
    pending_.clear();
    scaled_ = nullptr;
    credits_ = 0;
    next_pts_ = 0;
    last_input_time_us_.reset();
    key_requested_ = true;
    paused_ = false;
    rate_error_ = S_OK;
    sps_.clear();
    pps_.clear();
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback* callback) override {
    callback_ = callback;
    return WEBRTC_VIDEO_CODEC_OK;
  }

  int32_t Encode(const webrtc::VideoFrame& frame,
                 const std::vector<webrtc::VideoFrameType>* frame_types) override {
    if (!encoder_ || !callback_) return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    if (frame.width() != input_width_ || frame.height() != input_height_) {
      // libwebrtc normally reinitializes on a size change. Switching backends
      // mid-format without reinitialization would use the wrong input size.
      return Fallback({"input size changed without reinitialization", E_INVALIDARG});
    }
    try {
      Require(rate_error_, "update bitrate");
      Pump();
      if (!pending_.empty() && Clock::now() - pending_.front().submitted > kOutputTimeout) {
        throw MfError{"wait for encoded output", HRESULT_FROM_WIN32(ERROR_TIMEOUT)};
      }
      if (frame_types && !frame_types->empty()) {
        key_requested_ |= frame_types->front() == webrtc::VideoFrameType::kVideoFrameKey;
        if (frame_types->front() == webrtc::VideoFrameType::kEmptyFrame) return WEBRTC_VIDEO_CODEC_OK;
      }
      if (paused_) return WEBRTC_VIDEO_CODEC_OK;
      if (!credits_ || pending_.size() >= kMaxPending) {
        // An async hardware encoder can still be opening on the first frame.
        // Subsequent frames will poll for credit and output on this queue.
        if (!credits_ && pending_.empty()) {
          if (!waiting_for_credit_) waiting_for_credit_ = Clock::now();
          if (Clock::now() - *waiting_for_credit_ > kOutputTimeout) {
            throw MfError{"wait for encoder input credit", HRESULT_FROM_WIN32(ERROR_TIMEOUT)};
          }
        }
        callback_->OnDroppedFrame(webrtc::EncodedImageCallback::DropReason::kDroppedByEncoder);
        return WEBRTC_VIDEO_CODEC_OK;
      }
      waiting_for_credit_.reset();
      const LONGLONG nominal_duration = 10'000'000 / fps_;
      LONGLONG pts = next_pts_;
      LONGLONG duration = nominal_duration;
      if (fps_ > 30 && last_input_time_us_) {
        // The MFT stays configured for 60 fps. Preserve the time between
        // admitted frames when the publisher steps down or sends a heartbeat.
        const auto delta_us = std::clamp<int64_t>(
            frame.timestamp_us() - *last_input_time_us_, 1, 1'000'000);
        duration = delta_us * 10;
        pts += duration - nominal_duration;
      }
      auto sample = Input(frame, pts, duration);
      if (key_requested_ && next_pts_ != 0) {
        Require(SetCodecValue(codec_.Get(), CODECAPI_AVEncVideoForceKeyFrame, 1), "request keyframe");
      }
      Require(encoder_->ProcessInput(input_id_, sample.Get(), 0), "submit NV12 frame");
      --credits_;
      key_requested_ = false;
      pending_.push_back({pts, frame.rtp_timestamp(), frame.ntp_time_ms(),
                          frame.render_time_ms(), frame.rotation(), frame.color_space(), Clock::now()});
      next_pts_ = pts + nominal_duration;
      if (fps_ > 30) last_input_time_us_ = frame.timestamp_us();
      Pump();
      return WEBRTC_VIDEO_CODEC_OK;
    } catch (const MfError& error) {
      return Fallback(error);
    }
  }

  void SetRates(const RateControlParameters& params) override {
    if (!codec_ || FAILED(rate_error_)) return;
    const auto requested = params.bitrate.get_sum_bps();
    if (requested == 0) {
      paused_ = true;
      return;
    }
    if (paused_) key_requested_ = true;
    paused_ = false;
    const auto bitrate = std::min(requested, MaxBitrate());
    if (bitrate != bitrate_) {
      rate_error_ = SetCodecValue(codec_.Get(), CODECAPI_AVEncCommonMeanBitRate, bitrate);
      if (SUCCEEDED(rate_error_)) bitrate_ = bitrate;
    }
  }

  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.implementation_name = fps_ > 30 ? "AMD Media Foundation H264 (60 FPS)"
                                         : "AMD Media Foundation H264";
    info.is_hardware_accelerated = true;
    info.requested_resolution_alignment = 2;
    info.preferred_pixel_formats = {webrtc::VideoFrameBuffer::Type::kI420};
    return info;
  }

 private:
  uint32_t MaxBitrate() const {
    return configured_level_ >= webrtc::H264Level::kLevel4 ? 20'000'000 : 14'000'000;
  }

  struct PendingFrame {
    LONGLONG pts;
    uint32_t rtp_timestamp;
    int64_t ntp_time_ms;
    int64_t capture_time_ms;
    webrtc::VideoRotation rotation;
    std::optional<webrtc::ColorSpace> color_space;
    Clock::time_point submitted;
  };

  int32_t Fallback(const MfError& error) {
    LogFailure(error);
    Release();
    return WEBRTC_VIDEO_CODEC_FALLBACK_SOFTWARE;
  }

  ComPtr<IMFMediaType> Type(const GUID& subtype) const {
    ComPtr<IMFMediaType> type;
    Require(Api().create_type(&type), "create media type");
    Require(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "set major type");
    Require(type->SetGUID(MF_MT_SUBTYPE, subtype), "set subtype");
    Require(type->SetUINT64(MF_MT_FRAME_SIZE, (UINT64{static_cast<uint32_t>(width_)} << 32) | height_),
            "set frame size");
    Require(type->SetUINT64(MF_MT_FRAME_RATE, (UINT64{fps_} << 32) | 1), "set frame rate");
    Require(type->SetUINT64(MF_MT_PIXEL_ASPECT_RATIO, (UINT64{1} << 32) | 1), "set aspect ratio");
    Require(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "set progressive scan");
    return type;
  }

  void Open() {
    Require(activate_->ActivateObject(IID_PPV_ARGS(&encoder_)), "activate hardware MFT");
    ComPtr<IMFAttributes> attributes;
    Require(encoder_->GetAttributes(&attributes), "get MFT attributes");
    UINT32 asynchronous = 0;
    Require(attributes->GetUINT32(MF_TRANSFORM_ASYNC, &asynchronous), "check async MFT");
    Require(asynchronous ? S_OK : E_NOTIMPL, "require async MFT");
    Require(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE), "unlock async MFT");
    attributes->SetUINT32(MF_LOW_LATENCY, TRUE);
    DWORD inputs = 0;
    DWORD outputs = 0;
    Require(encoder_->GetStreamCount(&inputs, &outputs), "get stream count");
    Require(inputs == 1 && outputs == 1 ? S_OK : E_NOTIMPL, "require one input and output");
    input_id_ = output_id_ = 0;
    const auto ids = encoder_->GetStreamIDs(1, &input_id_, 1, &output_id_);
    if (ids != E_NOTIMPL) Require(ids, "get stream IDs");
    Require(encoder_.As(&codec_), "get codec control");
    // Some drivers expose this property only after setting media types.
    SetCodecValue(codec_.Get(), CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
    auto output = Type(MFVideoFormat_H264);
    Require(output->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_ConstrainedBase), "set Constrained Baseline");
    if (fps_ > 30) {
      Require(output->SetUINT32(MF_MT_MPEG2_LEVEL, static_cast<UINT32>(configured_level_)),
              "set negotiated H264 level");
    }
    Require(output->SetUINT32(MF_MT_AVG_BITRATE, bitrate_), "set initial bitrate");
    Require(encoder_->SetOutputType(output_id_, output.Get(), 0), "set H264 type");
    auto input = Type(MFVideoFormat_NV12);
    Require(encoder_->SetInputType(input_id_, input.Get(), 0), "set NV12 type");
    Require(encoder_.As(&events_), "get encoder events");
    Require(encoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0), "begin streaming");
    streaming_ = true;
    Require(encoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0), "start stream");
  }

  void CloseTransform() {
    waiting_for_credit_.reset();
    if (streaming_) {
      encoder_->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
      encoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
      streaming_ = false;
    }
    events_.Reset();
    codec_.Reset();
    encoder_.Reset();
    if (activate_) activate_->ShutdownObject();
    activate_.Reset();
  }

  ComPtr<IMFSample> Input(const webrtc::VideoFrame& frame, LONGLONG pts,
                          LONGLONG duration) const {
    auto i420 = frame.video_frame_buffer()->ToI420();
    Require(i420 ? S_OK : E_FAIL, "convert input to I420");
    if (scaled_) {
      const int scaled = libyuv::I420Scale(
          i420->DataY(), i420->StrideY(), i420->DataU(), i420->StrideU(),
          i420->DataV(), i420->StrideV(), input_width_, input_height_,
          scaled_->MutableDataY(), scaled_->StrideY(), scaled_->MutableDataU(),
          scaled_->StrideU(), scaled_->MutableDataV(), scaled_->StrideV(),
          width_, height_, libyuv::kFilterBilinear);
      Require(scaled == 0 ? S_OK : E_FAIL, "scale input to negotiated level");
      i420 = scaled_;
    }
    const DWORD luma_size = width_ * height_;
    ComPtr<IMFMediaBuffer> buffer;
    Require(Api().create_buffer(luma_size * 3 / 2, &buffer), "allocate NV12 buffer");
    BYTE* data = nullptr;
    Require(buffer->Lock(&data, nullptr, nullptr), "lock NV12 buffer");
    const int result = libyuv::I420ToNV12(i420->DataY(), i420->StrideY(),
                                         i420->DataU(), i420->StrideU(),
                                         i420->DataV(), i420->StrideV(),
                                         data, width_, data + luma_size, width_, width_, height_);
    Require(buffer->Unlock(), "unlock NV12 buffer");
    Require(result == 0 ? S_OK : E_FAIL, "convert I420 to NV12");
    Require(buffer->SetCurrentLength(luma_size * 3 / 2), "set NV12 length");
    ComPtr<IMFSample> sample;
    Require(Api().create_sample(&sample), "create input sample");
    Require(sample->AddBuffer(buffer.Get()), "attach NV12 buffer");
    Require(sample->SetSampleTime(pts), "set input sample time");
    Require(sample->SetSampleDuration(duration), "set input sample duration");
    return sample;
  }

  void Pump() {
    for (int i = 0; i < 32; ++i) {
      ComPtr<IMFMediaEvent> event;
      const auto hr = events_->GetEvent(MF_EVENT_FLAG_NO_WAIT, &event);
      if (hr == MF_E_NO_EVENTS_AVAILABLE) return;
      Require(hr, "poll encoder event");
      HRESULT status = S_OK;
      Require(event->GetStatus(&status), "inspect encoder event");
      Require(status, "encoder event status");
      MediaEventType type{};
      Require(event->GetType(&type), "read encoder event type");
      if (type == METransformNeedInput) ++credits_;
      if (type == METransformHaveOutput) ReadOutput();
    }
  }

  void ReadOutput() {
    MFT_OUTPUT_STREAM_INFO info{};
    Require(encoder_->GetOutputStreamInfo(output_id_, &info), "get output stream info");
    ComPtr<IMFSample> owned;
    if (!(info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES))) {
      ComPtr<IMFMediaBuffer> buffer;
      const DWORD mask = info.cbAlignment ? info.cbAlignment - 1 : 0;
      Require(Api().create_aligned_buffer(info.cbSize, mask, &buffer), "allocate encoded buffer");
      Require(Api().create_sample(&owned), "create output sample");
      Require(owned->AddBuffer(buffer.Get()), "attach encoded buffer");
    }
    MFT_OUTPUT_DATA_BUFFER output{output_id_, owned.Get(), 0, nullptr};
    DWORD status = 0;
    const auto hr = encoder_->ProcessOutput(0, 1, &output, &status);
    ComPtr<IMFCollection> events;
    events.Attach(output.pEvents);
    ComPtr<IMFSample> returned;
    if (output.pSample != owned.Get()) returned.Attach(output.pSample);
    if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
      ComPtr<IMFMediaType> type;
      Require(encoder_->GetOutputAvailableType(output_id_, 0, &type), "get changed output type");
      GUID subtype{};
      Require(type->GetGUID(MF_MT_SUBTYPE, &subtype), "read changed output subtype");
      Require(subtype == MFVideoFormat_H264 ? S_OK : E_FAIL, "require H264 stream change");
      Require(encoder_->SetOutputType(output_id_, type.Get(), 0), "apply H264 stream change");
      return;
    }
    Require(hr, "receive encoded output");
    if (!output.pSample) return;
    LONGLONG pts = 0;
    Require(output.pSample->GetSampleTime(&pts), "read output sample time");
    auto frame = std::find_if(pending_.begin(), pending_.end(), [pts](const auto& entry) {
      return entry.pts == pts;
    });
    Require(frame != pending_.end() ? S_OK : E_FAIL, "match output sample time");
    ComPtr<IMFMediaBuffer> buffer;
    Require(output.pSample->ConvertToContiguousBuffer(&buffer), "get encoded data");
    BYTE* data = nullptr;
    DWORD size = 0;
    Require(buffer->Lock(&data, nullptr, &size), "lock encoded data");
    auto encoded = webrtc::EncodedImageBuffer::Create(data, size);
    Require(buffer->Unlock(), "unlock encoded data");
    Send(*frame, std::move(encoded));
    pending_.erase(frame);
  }

  void Send(const PendingFrame& frame,
            webrtc::scoped_refptr<webrtc::EncodedImageBuffer> encoded) {
    const auto* data = static_cast<const BYTE*>(encoded->data());
    const auto nals = webrtc::H264::FindNaluIndices({data, encoded->size()});
    Require(!nals.empty() ? S_OK : E_FAIL, "require Annex B output");
    bool key = false;
    bool has_sps = false;
    bool has_pps = false;
    for (const auto& nal : nals) {
      if (!nal.payload_size) continue;
      const auto* payload = data + nal.payload_start_offset;
      const auto type = webrtc::H264::ParseNaluType(*payload);
      key |= type == webrtc::H264::kIdr;
      if (type == webrtc::H264::kSps) {
        Require(nal.payload_size >= 4 ? S_OK : E_FAIL, "read H264 SPS");
        char profile[7];
        std::snprintf(profile, sizeof(profile), "%02x%02x%02x", payload[1], payload[2], payload[3]);
        auto parsed = webrtc::ParseH264ProfileLevelId(profile);
        const auto min_level = configured_level_ == webrtc::H264Level::kLevel4_2
                                   ? webrtc::H264Level::kLevel4_2
                                   : webrtc::H264Level::kLevel3_2;
        Require(parsed && parsed->profile == webrtc::H264Profile::kProfileConstrainedBaseline &&
                        parsed->level <= configured_level_ &&
                        (fps_ <= 30 || parsed->level >= min_level)
                    ? S_OK : E_FAIL,
                "verify SPS is Constrained Baseline within negotiated level");
        sps_.assign(data + nal.start_offset, payload + nal.payload_size);
        has_sps = true;
      } else if (type == webrtc::H264::kPps) {
        pps_.assign(data + nal.start_offset, payload + nal.payload_size);
        has_pps = true;
      }
    }
    Require(!sps_.empty() && !pps_.empty() ? S_OK : E_FAIL, "require SPS/PPS before the first picture");
    if (key && (!has_sps || !has_pps)) {
      auto with_headers = webrtc::EncodedImageBuffer::Create(sps_.size() + pps_.size() + encoded->size());
      auto* dest = std::copy(sps_.begin(), sps_.end(), with_headers->data());
      dest = std::copy(pps_.begin(), pps_.end(), dest);
      std::copy_n(encoded->data(), encoded->size(), dest);
      encoded = std::move(with_headers);
    }
    webrtc::EncodedImage image;
    image.SetEncodedData(encoded);
    image._encodedWidth = width_;
    image._encodedHeight = height_;
    image.SetRtpTimestamp(frame.rtp_timestamp);
    image.ntp_time_ms_ = frame.ntp_time_ms;
    image.capture_time_ms_ = frame.capture_time_ms;
    image.rotation_ = frame.rotation;
    image.SetColorSpace(frame.color_space);
    image._frameType = key ? webrtc::VideoFrameType::kVideoFrameKey : webrtc::VideoFrameType::kVideoFrameDelta;
    webrtc::CodecSpecificInfo codec{};
    codec.codecType = webrtc::kVideoCodecH264;
    codec.codecSpecific.H264.packetization_mode = webrtc::H264PacketizationMode::NonInterleaved;
    callback_->OnEncodedImage(image, &codec);
  }

  std::unique_ptr<MfSession> session_;
  const webrtc::H264Level negotiated_level_;
  webrtc::H264Level configured_level_ = webrtc::H264Level::kLevel3_1;
  ComPtr<IMFActivate> activate_;
  ComPtr<IMFTransform> encoder_;
  ComPtr<IMFMediaEventGenerator> events_;
  ComPtr<ICodecAPI> codec_;
  webrtc::EncodedImageCallback* callback_ = nullptr;
  std::deque<PendingFrame> pending_;
  std::vector<BYTE> sps_;
  std::vector<BYTE> pps_;
  std::optional<Clock::time_point> waiting_for_credit_;
  webrtc::scoped_refptr<webrtc::I420Buffer> scaled_;
  int input_width_ = 0;
  int input_height_ = 0;
  int width_ = 0;
  int height_ = 0;
  uint32_t fps_ = 0;
  uint32_t bitrate_ = 0;
  DWORD input_id_ = 0;
  DWORD output_id_ = 0;
  size_t credits_ = 0;
  LONGLONG next_pts_ = 0;
  std::optional<int64_t> last_input_time_us_;
  HRESULT rate_error_ = S_OK;
  bool streaming_ = false;
  bool key_requested_ = true;
  bool paused_ = false;
};

}  // namespace

bool HasAmdMediaFoundationEncoder() {
  MfSession session;
  return SUCCEEDED(session.Start()) &&
         VisitTransforms([](IMFActivate*, LUID) { return true; });
}

webrtc::SdpVideoFormat AmdMediaFoundationFormat() {
  return webrtc::SdpVideoFormat("H264", {{"profile-level-id", AdaptiveScreenShareEnabled() ? "42e02a" : "42e028"},
                                        {"level-asymmetry-allowed", "1"},
                                        {"packetization-mode", "1"}});
}

bool MatchesAmdMediaFoundationFormat(const webrtc::SdpVideoFormat& format) {
  const auto parsed = webrtc::ParseSdpForH264ProfileLevelId(format.parameters);
  return parsed && parsed->level >= webrtc::H264Level::kLevel3_1 &&
         AmdMediaFoundationFormat().IsSameCodec(format);
}

std::unique_ptr<webrtc::VideoEncoder> CreateAmdMediaFoundationEncoder(
    const webrtc::SdpVideoFormat& format) {
  const auto parsed = webrtc::ParseSdpForH264ProfileLevelId(format.parameters);
  return std::make_unique<AmdMfEncoder>(parsed ? parsed->level : webrtc::H264Level::kLevel3_1);
}

}  // namespace livekit_ffi
