//! WebSocket-based audio streaming for Jam Sessions.
//!
//! When a Jam starts, JamBot captures Spotify audio via WASAPI and
//! broadcasts raw f32 PCM frames over a tokio broadcast channel.
//! WebSocket clients (viewers) subscribe to receive the audio.

use crate::audio_capture::{self, AudioChunk, CaptureHandle};
use tokio::sync::{broadcast, mpsc};
use tracing::info;

/// 48 kHz stereo, 20 ms frames → 960 samples/ch × 2 ch = 1920 f32 samples per frame.
const TARGET_RATE: u32 = 48000;
const TARGET_CHANNELS: u32 = 2;
const FRAME_DURATION_MS: u32 = 20;
const SAMPLES_PER_CHANNEL: u32 = TARGET_RATE * FRAME_DURATION_MS / 1000; // 960
const FRAME_SAMPLES: usize = (SAMPLES_PER_CHANNEL * TARGET_CHANNELS) as usize; // 1920

/// A single 20 ms audio frame: 1920 f32 samples (48 kHz stereo).
/// Sent as raw little-endian bytes over WebSocket binary messages.
#[derive(Clone)]
pub struct AudioFrame {
    /// 1920 f32 samples, interleaved L/R.
    pub data: Vec<f32>,
}

/// A running JamBot instance.
pub struct JamBot {
    capture_handle: Option<CaptureHandle>,
    publish_task: Option<tokio::task::JoinHandle<()>>,
    /// Broadcast sender — WebSocket handlers subscribe to this.
    audio_tx: broadcast::Sender<AudioFrame>,
}

impl JamBot {
    /// Start the bot: find Spotify, capture audio, broadcast frames.
    pub async fn start() -> Result<Self, String> {
        // Find Spotify PID
        let pid = audio_capture::find_spotify_pid()
            .ok_or_else(|| "Spotify.exe not found — is Spotify running?".to_string())?;

        info!("[jam-bot] found Spotify PID {}", pid);

        // Broadcast channel: capacity 64 frames (~1.3 s at 20 ms/frame).
        // Slow receivers will drop oldest frames (lagged).
        let (audio_tx, _) = broadcast::channel::<AudioFrame>(64);

        // Start WASAPI capture → mpsc channel → broadcast loop
        let (cap_tx, cap_rx) = mpsc::channel::<AudioChunk>(64);
        let capture_handle = audio_capture::start_capture(pid, cap_tx)?;

        let broadcast_tx = audio_tx.clone();
        let publish_task = tokio::spawn(broadcast_loop(broadcast_tx, cap_rx));

        info!("[jam-bot] audio capture started, broadcasting frames");

        Ok(JamBot {
            capture_handle: Some(capture_handle),
            publish_task: Some(publish_task),
            audio_tx,
        })
    }

    /// Get a new broadcast receiver for a WebSocket client.
    pub fn subscribe(&self) -> broadcast::Receiver<AudioFrame> {
        self.audio_tx.subscribe()
    }

    /// Stop the bot: stop capture, abort broadcast task.
    pub async fn stop(mut self) {
        info!("[jam-bot] stopping...");

        if let Some(ref mut handle) = self.capture_handle {
            audio_capture::stop_capture(handle);
        }

        if let Some(task) = self.publish_task.take() {
            task.abort();
            let _ = task.await;
        }

        info!("[jam-bot] stopped");
    }
}

/// Async loop: read AudioChunks from WASAPI, convert to 48 kHz stereo 20 ms frames,
/// broadcast to all WebSocket subscribers.
async fn broadcast_loop(
    tx: broadcast::Sender<AudioFrame>,
    mut rx: mpsc::Receiver<AudioChunk>,
) {
    let mut accum: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 4);
    let mut frame_count: u64 = 0;

    while let Some(chunk) = rx.recv().await {
        let converted = convert_chunk(&chunk, TARGET_RATE, TARGET_CHANNELS);
        accum.extend_from_slice(&converted);

        // Drain full 20 ms frames
        while accum.len() >= FRAME_SAMPLES {
            let frame_data: Vec<f32> = accum.drain(..FRAME_SAMPLES).collect();
            let frame = AudioFrame { data: frame_data };

            // broadcast::send only fails if there are zero receivers — that's fine
            let _ = tx.send(frame);

            frame_count += 1;
            if frame_count == 1 {
                info!("[jam-bot] first audio frame broadcast");
            }
        }
    }

    info!("[jam-bot] broadcast loop ended (capture channel closed)");
}

/// Convert an AudioChunk to the target sample rate and channel count.
/// Uses simple nearest-neighbor resampling and mono↔stereo conversion.
fn convert_chunk(chunk: &AudioChunk, target_rate: u32, target_channels: u32) -> Vec<f32> {
    let src_rate = chunk.sample_rate;
    let src_ch = chunk.channels;
    let samples = &chunk.samples;

    if src_rate == target_rate && src_ch == target_channels {
        return samples.clone();
    }

    let src_frame_count = samples.len() / src_ch.max(1) as usize;
    let target_frame_count =
        (src_frame_count as u64 * target_rate as u64 / src_rate.max(1) as u64) as usize;

    let mut out = Vec::with_capacity(target_frame_count * target_channels as usize);

    for i in 0..target_frame_count {
        let src_idx = (i as u64 * src_rate as u64 / target_rate as u64) as usize;
        let src_idx = src_idx.min(src_frame_count.saturating_sub(1));

        if src_ch == target_channels {
            for ch in 0..target_channels as usize {
                let idx = src_idx * src_ch as usize + ch;
                out.push(samples.get(idx).copied().unwrap_or(0.0));
            }
        } else if src_ch == 1 && target_channels == 2 {
            let val = samples.get(src_idx).copied().unwrap_or(0.0);
            out.push(val);
            out.push(val);
        } else if src_ch == 2 && target_channels == 1 {
            let l = samples.get(src_idx * 2).copied().unwrap_or(0.0);
            let r = samples.get(src_idx * 2 + 1).copied().unwrap_or(0.0);
            out.push((l + r) * 0.5);
        } else {
            for ch in 0..target_channels as usize {
                if ch < src_ch as usize {
                    let idx = src_idx * src_ch as usize + ch;
                    out.push(samples.get(idx).copied().unwrap_or(0.0));
                } else {
                    out.push(0.0);
                }
            }
        }
    }

    out
}
