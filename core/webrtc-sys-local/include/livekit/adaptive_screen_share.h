#pragma once

#if defined(_WIN32)
#include <windows.h>
#endif

namespace livekit_ffi {

inline bool AdaptiveScreenShareEnabled() {
#if defined(_WIN32)
  wchar_t value[2]{};
  return GetEnvironmentVariableW(L"ECHO_EXPERIMENTAL_ADAPTIVE_FPS", value, 2) != 1 ||
         value[0] != L'0';
#else
  return false;
#endif
}

}  // namespace livekit_ffi
