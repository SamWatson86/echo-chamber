// Windows/NVIDIA smoke test. Uses only a private CUDA context, never desktop
// capture or the production room. Link with cuda_context.cpp and libwebrtc.
#include "nvidia/cuda_context.h"

#include <iostream>

int main() {
  livekit_ffi::CudaContext context;
  if (!context.Initialize()) {
    std::cerr << "CUDA initialization unavailable\n";
    return 1;
  }
  const CUcontext first = context.GetContext();
  if (!first || !context.Initialize() || context.GetContext() != first) {
    std::cerr << "Repeated initialization replaced a healthy CUDA context\n";
    return 2;
  }

  // Simulate a cached handle invalidated outside the codec lifecycle. Destroy
  // only this test's own context; do not reset the GPU or its primary context.
  if (cuCtxDestroy(first) != CUDA_SUCCESS) {
    return 3;
  }
  if (context.GetContext() != nullptr) {
    std::cerr << "An invalid context was returned as usable\n";
    return 4;
  }
  if (!context.Initialize()) {
    std::cerr << "Retry did not recreate the invalid CUDA context\n";
    return 5;
  }
  const CUcontext recovered = context.GetContext();
  unsigned int version = 0;
  if (!recovered || cuCtxGetApiVersion(recovered, &version) != CUDA_SUCCESS) {
    return 6;
  }
  context.Shutdown();
  if (context.GetContext() != nullptr) {
    return 7;
  }
  std::cout << "CUDA context reuse and stale-handle recovery passed\n";
  return 0;
}
