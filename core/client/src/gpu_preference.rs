use std::collections::HashSet;
use std::path::{Path, PathBuf};

use windows::core::PCWSTR;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    REG_OPTION_NON_VOLATILE, REG_SZ,
};

pub(crate) const HIGH_PERFORMANCE_GPU_PREFERENCE: &str = "GpuPreference=2;";

const GPU_PREFERENCE_REGISTRY_KEY: &str = r"Software\Microsoft\DirectX\UserGpuPreferences";
const WEBVIEW2_EXE_NAME: &str = "msedgewebview2.exe";

const WEBVIEW2_BROWSER_ARGUMENTS: &str = "--ignore-certificate-errors --enable-features=AcceleratedVideoEncoder,MediaFoundationVideoEncoding --ignore-gpu-blocklist --force_high_performance_gpu --webrtc-max-cpu-consumption-percentage=100 --force-fieldtrials=WebRTC-Bwe-AllocationProbing/Enabled/";

#[derive(Debug, Default)]
pub(crate) struct GpuPreferenceStartupReport {
    pub(crate) applied: Vec<PathBuf>,
    pub(crate) failed: Vec<(PathBuf, String)>,
}

impl GpuPreferenceStartupReport {
    pub(crate) fn summary(&self) -> String {
        format!(
            "applied={} failed={}",
            self.applied.len(),
            self.failed.len()
        )
    }
}

pub(crate) fn webview2_additional_browser_arguments() -> &'static str {
    WEBVIEW2_BROWSER_ARGUMENTS
}

pub(crate) fn ensure_startup_gpu_preferences() -> GpuPreferenceStartupReport {
    let mut report = GpuPreferenceStartupReport::default();
    let current_exe = match std::env::current_exe() {
        Ok(path) => path,
        Err(e) => {
            report
                .failed
                .push((PathBuf::from("<current_exe>"), e.to_string()));
            return report;
        }
    };

    let targets = collect_gpu_preference_targets(&current_exe, discover_webview2_runtime_dirs());
    for target in targets {
        match set_high_performance_gpu_preference(&target) {
            Ok(()) => report.applied.push(target),
            Err(e) => report.failed.push((target, e)),
        }
    }

    report
}

fn collect_gpu_preference_targets<I, P>(current_exe: &Path, webview2_roots: I) -> Vec<PathBuf>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let mut seen = HashSet::new();
    let mut targets = Vec::new();

    push_unique_target(&mut targets, &mut seen, current_exe.to_path_buf());
    for root in webview2_roots {
        let candidate = root.as_ref().join(WEBVIEW2_EXE_NAME);
        push_unique_target(&mut targets, &mut seen, candidate);
    }

    targets
}

fn push_unique_target(targets: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf) {
    let key = path.to_string_lossy().to_ascii_lowercase();
    if seen.insert(key) {
        targets.push(path);
    }
}

fn discover_webview2_runtime_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut roots = Vec::new();

    for var in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(base) = std::env::var_os(var) {
            roots.push(PathBuf::from(base).join(r"Microsoft\EdgeWebView\Application"));
        }
    }
    roots.push(PathBuf::from(
        r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application",
    ));
    roots.push(PathBuf::from(
        r"C:\Program Files\Microsoft\EdgeWebView\Application",
    ));

    let mut seen = HashSet::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.join(WEBVIEW2_EXE_NAME).is_file() {
                let key = path.to_string_lossy().to_ascii_lowercase();
                if seen.insert(key) {
                    dirs.push(path);
                }
            }
        }
    }

    dirs.sort();
    dirs
}

fn set_high_performance_gpu_preference(path: &Path) -> Result<(), String> {
    let subkey = wide_null(GPU_PREFERENCE_REGISTRY_KEY);
    let value_name = wide_null_os(path.as_os_str());
    let data = wide_null(HIGH_PERFORMANCE_GPU_PREFERENCE);
    let data_bytes =
        unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2) };

    let mut hkey = HKEY::default();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        )
    };
    if status.is_err() {
        return Err(format!("RegCreateKeyExW failed: {:?}", status));
    }

    let status = unsafe {
        RegSetValueExW(
            hkey,
            PCWSTR(value_name.as_ptr()),
            0,
            REG_SZ,
            Some(data_bytes),
        )
    };
    let _ = unsafe { RegCloseKey(hkey) };

    if status.is_err() {
        return Err(format!("RegSetValueExW failed: {:?}", status));
    }

    Ok(())
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_null_os(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn high_performance_value_matches_windows_gpu_preference_format() {
        assert_eq!(HIGH_PERFORMANCE_GPU_PREFERENCE, "GpuPreference=2;");
    }

    #[test]
    fn startup_targets_include_current_exe_and_all_webview2_runtimes() {
        let current_exe = Path::new(r"F:\Echo\echo-core-client.exe");
        let roots = vec![
            PathBuf::from(
                r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\147.0.3912.72",
            ),
            PathBuf::from(
                r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\147.0.3912.98",
            ),
        ];

        let targets = collect_gpu_preference_targets(current_exe, roots.iter());

        assert_eq!(
            targets,
            vec![
                PathBuf::from(r"F:\Echo\echo-core-client.exe"),
                PathBuf::from(
                    r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\147.0.3912.72\msedgewebview2.exe"
                ),
                PathBuf::from(
                    r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\147.0.3912.98\msedgewebview2.exe"
                ),
            ]
        );
    }

    #[test]
    fn startup_targets_are_deduplicated_without_losing_order() {
        let current_exe = Path::new(r"F:\Echo\echo-core-client.exe");
        let roots = vec![
            PathBuf::from(r"C:\Runtime"),
            PathBuf::from(r"C:\Runtime"),
            PathBuf::from(r"C:\Runtime"),
        ];

        let targets = collect_gpu_preference_targets(current_exe, roots.iter());

        assert_eq!(
            targets,
            vec![
                PathBuf::from(r"F:\Echo\echo-core-client.exe"),
                PathBuf::from(r"C:\Runtime\msedgewebview2.exe"),
            ]
        );
    }

    #[test]
    fn webview2_arguments_request_high_performance_gpu_once() {
        let args = webview2_additional_browser_arguments();

        assert!(args.contains("--force_high_performance_gpu"));
        assert_eq!(args.matches("--force_high_performance_gpu").count(), 1);
        assert!(args.contains("--ignore-gpu-blocklist"));
        assert!(args.contains("AcceleratedVideoEncoder"));
    }
}
