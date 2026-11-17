#pragma once

#include <cstdlib>
#include <string_view>

#if defined(WIN32)
#include <windows.h>

#include <fstream>
#include <iterator>
#include <optional>
#include <string>
#endif

namespace livekit_ffi {

#if defined(WIN32)
namespace detail {

inline std::optional<bool> ReadSoftwareEncoderOverride(const std::string& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file.is_open()) return std::nullopt;
  const std::string contents((std::istreambuf_iterator<char>(file)), {});
  auto key = contents.find("\"force_software_encoder\"");
  if (key == std::string::npos) return std::nullopt;
  const auto colon = contents.find(':', key);
  if (colon == std::string::npos) return std::nullopt;
  const auto value = contents.find_first_not_of(" \r\n\t", colon + 1);
  if (value == std::string::npos) return std::nullopt;
  const auto field = std::string_view(contents).substr(value);
  if (field.starts_with("true")) return true;
  if (field.starts_with("false")) return false;
  return std::nullopt;
}

inline DWORD WindowsBuildNumber() {
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (!ntdll) return 0;
  using RealGetVersion = LONG(WINAPI*)(OSVERSIONINFOW*);
  auto get_version = reinterpret_cast<RealGetVersion>(GetProcAddress(ntdll, "RtlGetVersion"));
  OSVERSIONINFOW version{};
  version.dwOSVersionInfoSize = sizeof(version);
  return get_version && get_version(&version) == 0 ? version.dwBuildNumber : 0;
}

}  // namespace detail
#endif

inline bool IsSoftwareEncoderForced() {
  const char* env = std::getenv("ECHO_FORCE_SOFTWARE_ENCODER");
  if (env && std::string_view(env) == "1") return true;
#if defined(WIN32)
  char executable[MAX_PATH]{};
  const auto length = GetModuleFileNameA(nullptr, executable, MAX_PATH);
  if (length > 0 && length < MAX_PATH) {
    const std::string path(executable, length);
    const auto separator = path.find_last_of("\\/");
    if (separator != std::string::npos) {
      if (auto force = detail::ReadSoftwareEncoderOverride(path.substr(0, separator + 1) + "config.json")) {
        return *force;
      }
    }
  }
  const char* app_data = std::getenv("LOCALAPPDATA");
  if (app_data && *app_data) {
    if (auto force = detail::ReadSoftwareEncoderOverride(std::string(app_data) + "\\Echo Chamber\\config.json")) {
      return *force;
    }
  }
  const auto build = detail::WindowsBuildNumber();
  return build > 0 && build < 22000;
#else
  return false;
#endif
}

}  // namespace livekit_ffi
