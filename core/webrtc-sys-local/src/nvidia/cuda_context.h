#ifndef WEBRTC_SYS_NVIDIA_CUDA_CONTEXT_H
#define WEBRTC_SYS_NVIDIA_CUDA_CONTEXT_H

#include <cuda.h>
#include <mutex>

namespace livekit_ffi {

bool IsSoftwareEncoderForced();

class CudaContext {
 public:
  CudaContext() = default;
  ~CudaContext() = default;

  static bool IsAvailable();

  static CudaContext* GetInstance();
  bool Initialize();
  bool IsInitialized() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return cu_context_ != nullptr;
  }
  CUcontext GetContext() const;

  void Shutdown();

 private:
  mutable std::mutex mutex_;
  CUdevice cu_device_ = 0;
  CUcontext cu_context_ = nullptr;
};

}  // namespace livekit_ffi

#endif  // WEBRTC_SYS_NVIDIA_CUDA_CONTEXT_H
