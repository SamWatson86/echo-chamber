//! WASAPI per-process audio capture for Windows 10 build 20348+
//!
//! Captures audio output from a specific process using the
//! AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK API and sends
//! float32 PCM chunks through a tokio mpsc channel.

#[cfg(windows)]
mod platform {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use windows::core::*;
    use windows::Win32::Foundation::*;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Registry::*;
    use windows::Win32::System::Threading::*;
    use windows::Win32::UI::WindowsAndMessaging::*;

    // --- Process loopback constants ---

    const ACTIVATION_TYPE_PROCESS_LOOPBACK: u32 = 1;
    const LOOPBACK_MODE_INCLUDE_TREE: u32 = 0;
    const VT_BLOB: u16 = 65;
    const BITS_PER_BYTE: u16 = 8;

    #[repr(C)]
    struct ProcessLoopbackParams {
        target_process_id: u32,
        process_loopback_mode: u32,
    }

    #[repr(C)]
    struct AudioClientActivationParams {
        activation_type: u32,
        loopback_params: ProcessLoopbackParams,
    }

    // --- Public types ---

    #[derive(Clone, Debug)]
    struct WindowInfo {
        pid: u32,
        title: String,
        exe_name: String,
    }

    /// A chunk of captured audio data.
    pub struct AudioChunk {
        /// Interleaved float32 PCM samples.
        pub samples: Vec<f32>,
        /// Sample rate in Hz (e.g. 48000).
        pub sample_rate: u32,
        /// Number of channels (e.g. 2 for stereo).
        pub channels: u32,
    }

    /// Handle to a running capture thread.
    pub struct CaptureHandle {
        running: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    // --- Window enumeration ---

    fn list_capturable_windows() -> Vec<WindowInfo> {
        let mut windows: Vec<WindowInfo> = Vec::new();
        let windows_ptr = &mut windows as *mut Vec<WindowInfo>;

        unsafe {
            let _ = EnumWindows(Some(enum_window_cb), LPARAM(windows_ptr as isize));
        }

        // Deduplicate by PID — keep entry with longest title
        let mut by_pid = std::collections::HashMap::<u32, WindowInfo>::new();
        for w in windows {
            let entry = by_pid.entry(w.pid).or_insert_with(|| w.clone());
            if w.title.len() > entry.title.len() {
                *entry = w;
            }
        }

        let mut result: Vec<WindowInfo> = by_pid.into_values().collect();
        result.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
        result
    }

    unsafe extern "system" fn enum_window_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }

        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len == 0 {
            return TRUE;
        }
        let title = String::from_utf16_lossy(&buf[..len as usize]);

        if title.is_empty()
            || title == "Program Manager"
            || title == "Windows Input Experience"
            || title == "MSCTFIME UI"
            || title == "Default IME"
        {
            return TRUE;
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return TRUE;
        }

        let exe_name = get_exe_name(pid).unwrap_or_default();

        let list = &mut *(lparam.0 as *mut Vec<WindowInfo>);
        list.push(WindowInfo {
            pid,
            title,
            exe_name,
        });

        TRUE
    }

    fn get_exe_name(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 260];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(handle);
            ok.ok()?;
            let path = String::from_utf16_lossy(&buf[..size as usize]);
            path.rsplit('\\').next().map(|s| s.to_string())
        }
    }

    // --- Windows build check ---

    fn check_process_loopback_support() -> std::result::Result<(), String> {
        unsafe {
            let key_path = w!("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
            let mut hkey = HKEY::default();
            let status = RegOpenKeyExW(HKEY_LOCAL_MACHINE, key_path, 0, KEY_READ, &mut hkey);
            if status.is_err() {
                return Err("Cannot read Windows version from registry".to_string());
            }

            let value_name = w!("CurrentBuildNumber");
            let mut buf = [0u8; 64];
            let mut buf_size = buf.len() as u32;
            let mut kind = REG_VALUE_TYPE::default();
            let result = RegQueryValueExW(
                hkey,
                value_name,
                None,
                Some(&mut kind),
                Some(buf.as_mut_ptr()),
                Some(&mut buf_size),
            );
            let _ = RegCloseKey(hkey);

            if result.is_err() {
                return Err("Cannot read CurrentBuildNumber".to_string());
            }

            let chars = buf_size as usize / 2;
            let wide = std::slice::from_raw_parts(buf.as_ptr() as *const u16, chars);
            let build_str = String::from_utf16_lossy(wide)
                .trim_matches('\0')
                .to_string();

            let build_num: u32 = build_str.parse().unwrap_or(0);
            eprintln!(
                "[audio-capture] Windows build: {} ({})",
                build_str, build_num
            );

            if build_num < 20348 {
                return Err(format!(
                    "Per-process audio capture requires Windows 10 build 20348+. This PC has build {}.",
                    build_num
                ));
            }

            Ok(())
        }
    }

    // --- COM completion handler ---

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct ActivationHandler {
        tx: std::sync::mpsc::SyncSender<windows::core::Result<IAudioClient>>,
    }

    impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
        fn ActivateCompleted(
            &self,
            operation: Option<&IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            let result = (|| unsafe {
                let op = operation.ok_or(Error::from(E_POINTER))?;
                let mut hr = HRESULT::default();
                let mut punk: Option<IUnknown> = None;
                op.GetActivateResult(&mut hr, &mut punk)?;
                hr.ok()?;
                let client: IAudioClient = punk.ok_or(Error::from(E_POINTER))?.cast()?;
                Ok(client)
            })();
            let _ = self.tx.send(result);
            Ok(())
        }
    }

    // --- Find Spotify ---

    fn process_entry_name(entry: &PROCESSENTRY32W) -> String {
        let len = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        String::from_utf16_lossy(&entry.szExeFile[..len])
    }

    fn find_processes_by_name(exe_name: &str) -> Vec<(u32, u32)> {
        let mut processes = Vec::new();

        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return processes;
            };

            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };

            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let name = process_entry_name(&entry);
                    if name.eq_ignore_ascii_case(exe_name) {
                        processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
                    }

                    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }

            let _ = CloseHandle(snapshot);
        }

        processes
    }

    pub(super) fn select_root_process_pid(processes: &[(u32, u32)]) -> Option<u32> {
        let pids: std::collections::HashSet<u32> = processes.iter().map(|(pid, _)| *pid).collect();
        processes
            .iter()
            .find(|(_, parent_pid)| !pids.contains(parent_pid))
            .or_else(|| processes.first())
            .map(|(pid, _)| *pid)
    }

    /// Search running processes for Spotify.exe and return its root PID.
    ///
    /// The control plane normally runs as a Windows service in session 0, so it
    /// cannot reliably enumerate the interactive user's visible Spotify window.
    /// Process snapshot lookup works across sessions and the WASAPI process
    /// loopback uses INCLUDE_TREE to capture child renderer/audio processes.
    pub fn find_spotify_pid() -> Option<u32> {
        select_root_process_pid(&find_processes_by_name("Spotify.exe")).or_else(|| {
            list_capturable_windows()
                .into_iter()
                .find(|w| w.exe_name.eq_ignore_ascii_case("Spotify.exe"))
                .map(|w| w.pid)
        })
    }

    pub(super) fn process_loopback_initialize_flags(use_autoconvert: bool) -> u32 {
        let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_LOOPBACK;
        if use_autoconvert {
            flags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        } else {
            flags
        }
    }

    pub(super) fn process_loopback_fallback_format() -> WAVEFORMATEX {
        let channels = 2_u16;
        let sample_rate = 44_100_u32;
        let bits = 16_u16;
        let block_align = channels * bits / BITS_PER_BYTE;

        WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: channels,
            nSamplesPerSec: sample_rate,
            nAvgBytesPerSec: sample_rate * block_align as u32,
            nBlockAlign: block_align,
            wBitsPerSample: bits,
            cbSize: 0,
        }
    }

    // --- Start / Stop ---

    /// Start capturing audio from the given PID. Captured float32 PCM chunks
    /// are sent through the provided tokio mpsc channel.
    pub fn start_capture(
        pid: u32,
        tx: tokio::sync::mpsc::Sender<AudioChunk>,
    ) -> std::result::Result<CaptureHandle, String> {
        if let Err(msg) = check_process_loopback_support() {
            return Err(msg);
        }

        let running = Arc::new(AtomicBool::new(true));
        let r2 = running.clone();

        let thread = std::thread::spawn(move || {
            if let Err(e) = capture_loop(pid, &tx, &r2) {
                eprintln!("[audio-capture] error: {}", e);
            }
            eprintln!("[audio-capture] thread exited");
        });

        Ok(CaptureHandle {
            running,
            thread: Some(thread),
        })
    }

    /// Stop the capture thread and wait for it to exit.
    pub fn stop_capture(handle: &mut CaptureHandle) {
        handle.running.store(false, Ordering::SeqCst);
        if let Some(t) = handle.thread.take() {
            let _ = t.join();
        }
    }

    // --- Main capture loop ---

    fn capture_loop(
        pid: u32,
        tx: &tokio::sync::mpsc::Sender<AudioChunk>,
        running: &AtomicBool,
    ) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
        unsafe {
            eprintln!("[audio-capture] capture_loop starting for PID {}", pid);
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;

            // Build activation params
            let params = AudioClientActivationParams {
                activation_type: ACTIVATION_TYPE_PROCESS_LOOPBACK,
                loopback_params: ProcessLoopbackParams {
                    target_process_id: pid,
                    process_loopback_mode: LOOPBACK_MODE_INCLUDE_TREE,
                },
            };
            let params_size = std::mem::size_of::<AudioClientActivationParams>() as u32;

            // Build PROPVARIANT with VT_BLOB
            let mut pv = [0u8; 24];
            *(pv.as_mut_ptr() as *mut u16) = VT_BLOB;
            *(pv.as_mut_ptr().add(8) as *mut u32) = params_size;
            *(pv.as_mut_ptr().add(16) as *mut *const u8) =
                &params as *const AudioClientActivationParams as *const u8;
            let propvariant = &pv as *const _ as *const PROPVARIANT;

            // Completion handler
            let (com_tx, com_rx) = std::sync::mpsc::sync_channel(1);
            let handler: IActivateAudioInterfaceCompletionHandler =
                ActivationHandler { tx: com_tx }.into();

            eprintln!(
                "[audio-capture] activating process loopback for PID {}",
                pid
            );
            let _operation = ActivateAudioInterfaceAsync(
                w!("VAD\\Process_Loopback"),
                &IAudioClient::IID,
                Some(propvariant),
                &handler,
            )?;

            let client = com_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|e| format!("activation timeout: {}", e))?
                .map_err(|e| format!("activation failed: {}", e))?;
            eprintln!("[audio-capture] got IAudioClient");

            // Get mix format
            let (sample_rate, channels, bits, block_align, is_float);
            match client.GetMixFormat() {
                Ok(ptr) => {
                    let fmt = &*ptr;
                    sample_rate = fmt.nSamplesPerSec;
                    channels = fmt.nChannels as u32;
                    bits = fmt.wBitsPerSample;
                    block_align = fmt.nBlockAlign as usize;
                    let format_tag = fmt.wFormatTag;

                    is_float = if format_tag == 3 {
                        true
                    } else if format_tag == 0xFFFE_u16 {
                        let ext_ptr = ptr as *const u8;
                        let sub_format_offset = std::mem::size_of::<WAVEFORMATEX>();
                        let guid_offset = sub_format_offset + 2 + 4;
                        let guid_bytes = std::slice::from_raw_parts(ext_ptr.add(guid_offset), 16);
                        let first_u32 = u32::from_le_bytes([
                            guid_bytes[0],
                            guid_bytes[1],
                            guid_bytes[2],
                            guid_bytes[3],
                        ]);
                        first_u32 == 3
                    } else {
                        false
                    };

                    eprintln!(
                        "[audio-capture] format: {}Hz {}ch {}bit blockAlign={} isFloat={}",
                        sample_rate, channels, bits, block_align, is_float
                    );

                    let buffer_duration: i64 = 200_000;
                    client.Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        process_loopback_initialize_flags(false),
                        buffer_duration,
                        0,
                        ptr,
                        None,
                    )?;
                }
                Err(e) => {
                    eprintln!(
                        "[audio-capture] GetMixFormat failed: {} — using default 44.1kHz stereo PCM16",
                        e
                    );

                    let default_fmt = process_loopback_fallback_format();
                    sample_rate = default_fmt.nSamplesPerSec;
                    channels = default_fmt.nChannels as u32;
                    bits = default_fmt.wBitsPerSample;
                    block_align = channels as usize * bits as usize / 8;
                    is_float = false;

                    let buffer_duration: i64 = 200_000;
                    client.Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        process_loopback_initialize_flags(true),
                        buffer_duration,
                        0,
                        &default_fmt as *const WAVEFORMATEX,
                        None,
                    )?;
                }
            }

            // Event-driven capture
            let event = CreateEventW(None, false, false, None)?;
            client.SetEventHandle(event)?;

            let capture: IAudioCaptureClient = client.GetService()?;
            client.Start()?;
            eprintln!("[audio-capture] capturing PID {}", pid);

            let mut frame_count: u64 = 0;
            while running.load(Ordering::SeqCst) {
                let wait = WaitForSingleObject(event, 100);
                if wait == WAIT_TIMEOUT {
                    continue;
                }

                // Drain all available packets
                loop {
                    let mut buf_ptr: *mut u8 = std::ptr::null_mut();
                    let mut frames: u32 = 0;
                    let mut flags: u32 = 0;

                    let hr = capture.GetBuffer(&mut buf_ptr, &mut frames, &mut flags, None, None);

                    if hr.is_err() || frames == 0 {
                        break;
                    }

                    let data_len = frames as usize * block_align;
                    let silent = (flags & 0x2) != 0; // AUDCLNT_BUFFERFLAGS_SILENT

                    if !silent && !buf_ptr.is_null() && data_len > 0 {
                        let slice = std::slice::from_raw_parts(buf_ptr, data_len);

                        frame_count += 1;
                        if frame_count <= 3 {
                            let preview = std::cmp::min(slice.len(), 32);
                            eprintln!(
                                "[audio-capture] frame #{} len={} first_bytes={:?}",
                                frame_count,
                                data_len,
                                &slice[..preview]
                            );
                        }

                        // Convert to float32 samples
                        let float_samples: Vec<f32> = if is_float {
                            // Already float32 — reinterpret bytes
                            let f32_slice =
                                std::slice::from_raw_parts(buf_ptr as *const f32, data_len / 4);
                            f32_slice.to_vec()
                        } else if bits == 16 {
                            let sample_count = data_len / 2;
                            let samples =
                                std::slice::from_raw_parts(buf_ptr as *const i16, sample_count);
                            samples.iter().map(|&s| s as f32 / 32768.0).collect()
                        } else if bits == 24 {
                            let sample_count = data_len / 3;
                            let mut out = Vec::with_capacity(sample_count);
                            for i in 0..sample_count {
                                let b0 = slice[i * 3] as i32;
                                let b1 = slice[i * 3 + 1] as i32;
                                let b2 = slice[i * 3 + 2] as i32;
                                let raw = b0 | (b1 << 8) | (b2 << 16);
                                let signed = if raw & 0x800000 != 0 {
                                    raw | !0xFFFFFF_i32
                                } else {
                                    raw
                                };
                                out.push(signed as f32 / 8388608.0);
                            }
                            out
                        } else {
                            // Unknown — interpret as float32 anyway
                            let f32_slice =
                                std::slice::from_raw_parts(buf_ptr as *const f32, data_len / 4);
                            f32_slice.to_vec()
                        };

                        let chunk = AudioChunk {
                            samples: float_samples,
                            sample_rate,
                            channels,
                        };

                        if tx.blocking_send(chunk).is_err() {
                            eprintln!("[audio-capture] channel closed, stopping");
                            capture.ReleaseBuffer(frames)?;
                            break;
                        }
                    }

                    capture.ReleaseBuffer(frames)?;
                }

                // Check if channel was closed
                if tx.is_closed() {
                    break;
                }
            }

            client.Stop()?;
            let _ = CloseHandle(event);
            CoUninitialize();

            eprintln!("[audio-capture] stopped for PID {}", pid);
            Ok(())
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::platform::{
        process_loopback_fallback_format, process_loopback_initialize_flags,
        select_root_process_pid,
    };
    use windows::Win32::Media::Audio::{
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        AUDCLNT_STREAMFLAGS_LOOPBACK,
    };

    #[test]
    fn selects_root_spotify_process_for_include_tree_capture() {
        let processes = vec![(19836, 2360), (29512, 19836), (30340, 19836)];

        assert_eq!(select_root_process_pid(&processes), Some(19836));
    }

    #[test]
    fn falls_back_to_first_process_when_all_parents_are_spotify() {
        let processes = vec![(10, 11), (11, 10)];

        assert_eq!(select_root_process_pid(&processes), Some(10));
    }

    #[test]
    fn process_loopback_fallback_uses_pcm16_format() {
        let format = process_loopback_fallback_format();
        let format_tag = format.wFormatTag;
        let channels = format.nChannels;
        let sample_rate = format.nSamplesPerSec;
        let bits = format.wBitsPerSample;
        let block_align = format.nBlockAlign;
        let avg_bytes_per_sec = format.nAvgBytesPerSec;
        let cb_size = format.cbSize;

        assert_eq!(format_tag, 1);
        assert_eq!(channels, 2);
        assert_eq!(sample_rate, 44_100);
        assert_eq!(bits, 16);
        assert_eq!(block_align, 4);
        assert_eq!(avg_bytes_per_sec, 176_400);
        assert_eq!(cb_size, 0);
    }

    #[test]
    fn process_loopback_fallback_enables_autoconvertpcm() {
        let flags = process_loopback_initialize_flags(true);

        assert_ne!(flags & AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0);
        assert_ne!(flags & AUDCLNT_STREAMFLAGS_LOOPBACK, 0);
        assert_ne!(flags & AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 0);
    }
}

// Re-export platform types
#[cfg(windows)]
pub use platform::{find_spotify_pid, start_capture, stop_capture, AudioChunk, CaptureHandle};

// Stub for non-Windows (won't be used, but allows compilation)
#[cfg(not(windows))]
pub struct AudioChunk {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub channels: u32,
}

#[cfg(not(windows))]
pub struct CaptureHandle;

#[cfg(not(windows))]
pub fn find_spotify_pid() -> Option<u32> {
    None
}

#[cfg(not(windows))]
pub fn start_capture(
    _pid: u32,
    _tx: tokio::sync::mpsc::Sender<AudioChunk>,
) -> Result<CaptureHandle, String> {
    Err("WASAPI capture is only supported on Windows".to_string())
}

#[cfg(not(windows))]
pub fn stop_capture(_handle: &mut CaptureHandle) {}
