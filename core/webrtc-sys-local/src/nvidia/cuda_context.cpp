#include "cuda_context.h"

#include "rtc_base/checks.h"
#include "rtc_base/logging.h"

#include <fstream>

#if defined(WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#include <cstdlib>
#include <iostream>
#include <iterator>
#include <optional>
#include <string>

#if defined(WIN32)
static const char CUDA_DYNAMIC_LIBRARY[] = "nvcuda.dll";
#else
static const char CUDA_DYNAMIC_LIBRARY[] = "libcuda.so.1";
#endif

static bool ReadForceSoftwareEncoderFlagFromConfig(
    const std::string& config_path) {
  std::ifstream in(config_path, std::ios::binary);
  if (!in.is_open()) {
    return false;
  }

  std::string contents((std::istreambuf_iterator<char>(in)),
                       std::istreambuf_iterator<char>());
  const auto key_pos = contents.find("\"force_software_encoder\"");
  if (key_pos == std::string::npos) {
    return false;
  }

  const auto colon_pos = contents.find(':', key_pos);
  if (colon_pos == std::string::npos) {
    return false;
  }

  const auto true_pos = contents.find("true", colon_pos);
  const auto false_pos = contents.find("false", colon_pos);
  return true_pos != std::string::npos &&
         (false_pos == std::string::npos || true_pos < false_pos);
}

static std::optional<bool> ReadForceSoftwareEncoderOverrideFromConfig(
    const std::string& config_path) {
  std::ifstream in(config_path, std::ios::binary);
  if (!in.is_open()) {
    return std::nullopt;
  }

  std::string contents((std::istreambuf_iterator<char>(in)),
                       std::istreambuf_iterator<char>());
  const auto key_pos = contents.find("\"force_software_encoder\"");
  if (key_pos == std::string::npos) {
    return std::nullopt;
  }

  const auto colon_pos = contents.find(':', key_pos);
  if (colon_pos == std::string::npos) {
    return std::nullopt;
  }

  const auto true_pos = contents.find("true", colon_pos);
  const auto false_pos = contents.find("false", colon_pos);
  if (true_pos != std::string::npos &&
      (false_pos == std::string::npos || true_pos < false_pos)) {
    return true;
  }
  if (false_pos != std::string::npos &&
      (true_pos == std::string::npos || false_pos < true_pos)) {
    return false;
  }

  return std::nullopt;
}

static bool ReadForceSoftwareEncoderFlagFromInstalledConfig() {
#if defined(WIN32)
  char exe_path[MAX_PATH] = {0};
  const DWORD len = GetModuleFileNameA(nullptr, exe_path, MAX_PATH);
  if (len > 0 && len < MAX_PATH) {
    std::string config_path(exe_path, len);
    const auto slash_pos = config_path.find_last_of("\\/");
    if (slash_pos != std::string::npos) {
      config_path.resize(slash_pos + 1);
      config_path += "config.json";
      if (ReadForceSoftwareEncoderFlagFromConfig(config_path)) {
        return true;
      }
    }
  }

  const char* local_appdata = std::getenv("LOCALAPPDATA");
  if (local_appdata && *local_appdata) {
    const std::string local_config =
        std::string(local_appdata) + "\\Echo Chamber\\config.json";
    if (ReadForceSoftwareEncoderFlagFromConfig(local_config)) {
      return true;
    }
  }
#endif

  return false;
}

static std::optional<bool> ReadForceSoftwareEncoderOverrideFromInstalledConfig() {
#if defined(WIN32)
  char exe_path[MAX_PATH] = {0};
  const DWORD len = GetModuleFileNameA(nullptr, exe_path, MAX_PATH);
  if (len > 0 && len < MAX_PATH) {
    std::string config_path(exe_path, len);
    const auto slash_pos = config_path.find_last_of("\\/");
    if (slash_pos != std::string::npos) {
      config_path.resize(slash_pos + 1);
      config_path += "config.json";
      if (auto override_value =
              ReadForceSoftwareEncoderOverrideFromConfig(config_path)) {
        return override_value;
      }
    }
  }

  const char* local_appdata = std::getenv("LOCALAPPDATA");
  if (local_appdata && *local_appdata) {
    const std::string local_config =
        std::string(local_appdata) + "\\Echo Chamber\\config.json";
    if (auto override_value =
            ReadForceSoftwareEncoderOverrideFromConfig(local_config)) {
      return override_value;
    }
  }
#endif

  return std::nullopt;
}

static uint32_t DetectWindowsBuildNumber() {
#if defined(WIN32)
  typedef struct _OSVERSIONINFOEXW_FFI {
    uint32_t dwOSVersionInfoSize;
    uint32_t dwMajorVersion;
    uint32_t dwMinorVersion;
    uint32_t dwBuildNumber;
    uint32_t dwPlatformId;
    wchar_t szCSDVersion[128];
    uint16_t wServicePackMajor;
    uint16_t wServicePackMinor;
    uint16_t wSuiteMask;
    uint8_t wProductType;
    uint8_t wReserved;
  } OSVERSIONINFOEXW_FFI;

  HMODULE ntdll = LoadLibraryW(L"ntdll.dll");
  if (!ntdll) {
    return 0;
  }

  using RtlGetVersionFn = LONG(WINAPI*)(OSVERSIONINFOEXW_FFI*);
  auto rtl_get_version =
      reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
  if (!rtl_get_version) {
    return 0;
  }

  OSVERSIONINFOEXW_FFI info = {};
  info.dwOSVersionInfoSize = sizeof(info);
  if (rtl_get_version(&info) != 0) {
    return 0;
  }
  return info.dwBuildNumber;
#else
  return 0;
#endif
}

namespace livekit_ffi {

bool IsSoftwareEncoderForced() {
  const char* raw = std::getenv("ECHO_FORCE_SOFTWARE_ENCODER");
  if (raw && std::string(raw) == "1") {
    return true;
  }

  if (auto override_value = ReadForceSoftwareEncoderOverrideFromInstalledConfig()) {
    return *override_value;
  }

#if defined(WIN32)
  const uint32_t build = DetectWindowsBuildNumber();
  if (build > 0 && build < 22000) {
    return true;
  }
#endif

  return ReadForceSoftwareEncoderFlagFromInstalledConfig();
}

#define __CUCTX_CUDA_CALL(call, ret)                        \
  CUresult err__ = call;                                    \
  if (err__ != CUDA_SUCCESS) {                              \
    const char* szErrName = NULL;                           \
    cuGetErrorName(err__, &szErrName);                      \
    RTC_LOG(LS_ERROR) << "CudaContext error " << szErrName; \
    return ret;                                             \
  }

#define CUCTX_CUDA_CALL_ERROR(call) \
  do {                              \
    __CUCTX_CUDA_CALL(call, err__); \
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
  if (IsSoftwareEncoderForced()) {
    RTC_LOG(LS_INFO) << "ECHO_FORCE_SOFTWARE_ENCODER=1 — skipping CUDA context initialization";
    return false;
  }

  // Initialize CUDA context

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

  CUresult result = cuInit(0);
  if (result != CUDA_SUCCESS) {
    RTC_LOG(LS_ERROR) << "Failed to initialize CUDA.";
    return false;
  }

  result = cuDeviceGetCount(&num_devices);
  if (result != CUDA_SUCCESS) {
    RTC_LOG(LS_ERROR) << "Failed to get CUDA device count.";
    return false;
  }

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

  return true;
}

CUcontext CudaContext::GetContext() const {
  RTC_DCHECK(cu_context_ != nullptr);
  // Ensure the context is current
  CUcontext current;
  if (cuCtxGetCurrent(&current) != CUDA_SUCCESS) {
    throw;
  }
  if (cu_context_ == current) {
    return cu_context_;
  }
  if (cuCtxSetCurrent(cu_context_) != CUDA_SUCCESS) {
    throw;
  }
  return cu_context_;
}

void CudaContext::Shutdown() {
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
