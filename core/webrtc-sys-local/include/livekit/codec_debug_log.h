#pragma once

#include <chrono>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <string>

namespace livekit_ffi {

// Installed GUI applications do not normally retain stdout/stderr. Keep native
// codec failures alongside the existing encoder-factory diagnostics.
inline void AppendCodecDebug(const std::string& message) {
#if defined(WIN32)
  static std::mutex mutex;
  std::lock_guard<std::mutex> lock(mutex);
  const char* local_appdata = std::getenv("LOCALAPPDATA");
  if (!local_appdata || !*local_appdata) return;
  std::ofstream out(std::string(local_appdata) +
                        "\\Echo Chamber\\encoder-factory-debug.log",
                    std::ios::app);
  if (!out.is_open()) return;
  const auto now = std::chrono::duration_cast<std::chrono::seconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  out << "[" << now << "] " << message << std::endl;
#else
  (void)message;
#endif
}

}  // namespace livekit_ffi
