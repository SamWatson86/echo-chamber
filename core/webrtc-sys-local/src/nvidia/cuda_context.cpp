#include "cuda_context.h"

#include "rtc_base/checks.h"
#include "rtc_base/logging.h"
#include "livekit/codec_debug_log.h"

#if defined(WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#include <iostream>
#include <string>

#if defined(WIN32)
static const char CUDA_DYNAMIC_LIBRARY[] = "nvcuda.dll";
#else
static const char CUDA_DYNAMIC_LIBRARY[] = "libcuda.so.1";
#endif

namespace livekit_ffi {

#define __CUCTX_CUDA_CALL(call, ret)                        \
  CUresult err__ = call;                                    \
  if (err__ != CUDA_SUCCESS) {                              \
    const char* szErrName = NULL;                           \
    cuGetErrorName(err__, &szErrName);                      \
    RTC_LOG(LS_ERROR) << "CudaContext error " << szErrName; \
    AppendCodecDebug(std::string("[cuda-context] ") + #call + " failed code=" + \
                     std::to_string(static_cast<int>(err__))); \
    return ret;                                             \
  }

#define CUCTX_CUDA_CALL_ERROR(call) \
  do {                              \
    __CUCTX_CUDA_CALL(call, false); \
  } while (0)

static void* s_module_ptr = nullptr;
static const int kRequiredDriverVersion = 11000;

static bool load_cuda_modules() {
  if (s_module_ptr)
    return true;

#if defined(WIN32)
  // dll delay load
  HMODULE module = LoadLibrary(TEXT("nvcuda.dll"));
  if (!module) {
    RTC_LOG(LS_INFO) << "nvcuda.dll is not found.";
    return false;
  }
  s_module_ptr = module;
#elif defined(__linux__)
  s_module_ptr = dlopen("libcuda.so.1", RTLD_LAZY | RTLD_GLOBAL);
  if (!s_module_ptr)
    return false;

  // Close handle immediately because going to call `dlopen` again
  // in the implib module when cuda api called on Linux.
  dlclose(s_module_ptr);
  s_module_ptr = nullptr;
#endif
  return true;
}

static bool check_cuda_device() {
  int device_count = 0;
  int driver_version = 0;

  CUCTX_CUDA_CALL_ERROR(cuDriverGetVersion(&driver_version));
  if (kRequiredDriverVersion > driver_version) {
    RTC_LOG(LS_ERROR)
        << "CUDA driver version is not higher than the required version. "
        << driver_version;
    return false;
  }

  CUresult result = cuInit(0);
  if (result != CUDA_SUCCESS) {
    RTC_LOG(LS_ERROR) << "Failed to initialize CUDA.";
    return false;
  }

  result = cuDeviceGetCount(&device_count);
  if (result != CUDA_SUCCESS) {
    RTC_LOG(LS_ERROR) << "Failed to get CUDA device count.";
    return false;
  }

  if (device_count == 0) {
    RTC_LOG(LS_ERROR) << "No CUDA devices found.";
    return false;
  }

  return  true;
}

CudaContext* CudaContext::GetInstance() {
  static CudaContext instance;
  return &instance;
}

bool CudaContext::IsAvailable() {
  if (IsSoftwareEncoderForced()) {
    RTC_LOG(LS_INFO) << "ECHO_FORCE_SOFTWARE_ENCODER=1 — treating CUDA as unavailable";
    return false;
  }
  return load_cuda_modules() && check_cuda_device();
}

bool CudaContext::Initialize() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (IsSoftwareEncoderForced()) {
    RTC_LOG(LS_INFO) << "ECHO_FORCE_SOFTWARE_ENCODER=1 — skipping CUDA context initialization";
    return false;
  }

  // Factories outlive individual shares. Reuse a healthy context, but never
  // trust a cached handle after the driver has invalidated it. A retry must
  // be able to recover without restarting the entire desktop app.
  if (cu_context_) {
    unsigned int api_version = 0;
    const CUresult result = cuCtxGetApiVersion(cu_context_, &api_version);
    if (result == CUDA_SUCCESS) {
      CUCTX_CUDA_CALL_ERROR(cuCtxSetCurrent(cu_context_));
      return true;
    }
    RTC_LOG(LS_WARNING) << "Recreating stale CUDA context, cuCtxGetApiVersion="
                        << static_cast<int>(result);
    AppendCodecDebug("[cuda-context] recreating stale context code=" +
                     std::to_string(static_cast<int>(result)));
    cuCtxDestroy(cu_context_);
    cu_context_ = nullptr;
  }

  bool success = load_cuda_modules();
  if (!success) {
    RTC_LOG(LS_ERROR) << "Failed to load CUDA modules. maybe the NVIDIA driver "
                         "is not installed?";
    return false;
  }

  int num_devices = 0;
  CUdevice cu_device = 0;
  CUcontext context = nullptr;

  int driverVersion = 0;

  CUCTX_CUDA_CALL_ERROR(cuDriverGetVersion(&driverVersion));
  if (kRequiredDriverVersion > driverVersion) {
    RTC_LOG(LS_ERROR)
        << "CUDA driver version is not higher than the required version. "
        << driverVersion;
    return false;
  }

  CUCTX_CUDA_CALL_ERROR(cuInit(0));
  CUCTX_CUDA_CALL_ERROR(cuDeviceGetCount(&num_devices));

  if (num_devices == 0) {
    RTC_LOG(LS_ERROR) << "No CUDA devices found.";
    return false;
  }

  CUCTX_CUDA_CALL_ERROR(cuDeviceGet(&cu_device, 0));

  char device_name[80];
  CUCTX_CUDA_CALL_ERROR(
      cuDeviceGetName(device_name, sizeof(device_name), cu_device));
  RTC_LOG(LS_INFO) << "CUDA device name: " << device_name;

#if CUDA_VERSION >= 13000
  CUCTX_CUDA_CALL_ERROR(cuCtxCreate(&context, nullptr, 0, cu_device));
#else
  CUCTX_CUDA_CALL_ERROR(cuCtxCreate(&context, 0, cu_device));
#endif
  if (context == nullptr) {
    RTC_LOG(LS_ERROR) << "Failed to create CUDA context.";
    return false;
  }

  cu_device_ = cu_device;
  cu_context_ = context;
  AppendCodecDebug("[cuda-context] initialized");

  return true;
}

CUcontext CudaContext::GetContext() const {
  std::lock_guard<std::mutex> lock(mutex_);
  if (!cu_context_) {
    return nullptr;
  }
  // CUDA can still report a destroyed context as current, and setting it
  // current alone does not reliably validate its lifetime.
  unsigned int api_version = 0;
  if (cuCtxGetApiVersion(cu_context_, &api_version) != CUDA_SUCCESS) {
    return nullptr;
  }
  if (cuCtxSetCurrent(cu_context_) != CUDA_SUCCESS) {
    return nullptr;
  }
  return cu_context_;
}

void CudaContext::Shutdown() {
  std::lock_guard<std::mutex> lock(mutex_);
  // Shutdown CUDA context
  if (cu_context_) {
    cuCtxDestroy(cu_context_);
    cu_context_ = nullptr;
  }
  if (s_module_ptr) {
#if defined(WIN32)
    FreeLibrary((HMODULE)s_module_ptr);
#elif defined(__linux__)
    dlclose(s_module_ptr);
#endif
    s_module_ptr = nullptr;
  }
}

}  // namespace livekit_ffi
