//! Relay for audio uploaded by the configured interactive-session Jam source.

use crate::jam_source::{JamSourceRegistry, SourceEvent};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::broadcast;
use tracing::{info, warn};

const TARGET_RATE: u32 = 48_000;
const TARGET_CHANNELS: u32 = 2;
const FRAME_DURATION_MS: u32 = 20;
const SAMPLES_PER_CHANNEL: u32 = TARGET_RATE * FRAME_DURATION_MS / 1000;
const FRAME_SAMPLES: usize = (SAMPLES_PER_CHANNEL * TARGET_CHANNELS) as usize;

#[derive(Clone)]
pub struct AudioFrame {
    pub data: Vec<f32>,
}

pub struct JamBot {
    generation: u64,
    source: JamSourceRegistry,
    publish_task: Option<tokio::task::JoinHandle<()>>,
    audio_tx: broadcast::Sender<AudioFrame>,
    healthy: Arc<AtomicBool>,
}

impl JamBot {
    /// Ask the configured user-session source to capture Spotify, then wait for
    /// its WASAPI-ready acknowledgement. PCM health is measured independently:
    /// a paused Spotify process is allowed to produce no frames at startup.
    pub async fn start(
        generation: u64,
        source: JamSourceRegistry,
        timeout: Duration,
    ) -> Result<Self, String> {
        let mut source_rx = source.subscribe();
        source.start(generation).await?;

        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let event = match tokio::time::timeout_at(deadline, source_rx.recv()).await {
                Ok(Ok(event)) => event,
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => {
                    source.stop(generation).await;
                    return Err("Jam source event channel closed".to_string());
                }
                Err(_) => {
                    let snapshot = source.snapshot().await;
                    source.stop(generation).await;
                    return Err(format!(
                        "Jam source did not become ready before timeout (status: {})",
                        snapshot.status
                    ));
                }
            };

            match event {
                SourceEvent::Ready {
                    generation: event_generation,
                    pid,
                } if event_generation == generation => {
                    info!(
                        "[jam-bot] source ready generation={} pid={}",
                        generation, pid
                    );
                    break;
                }
                SourceEvent::Format {
                    generation: event_generation,
                    sample_rate,
                    channels,
                } if event_generation == generation => {
                    info!(
                        "[jam-bot] source format generation={} {}Hz {}ch",
                        generation, sample_rate, channels
                    );
                }
                SourceEvent::Error {
                    generation: event_generation,
                    message,
                } if event_generation == generation => {
                    source.stop(generation).await;
                    return Err(format!("Jam source error: {}", message));
                }
                SourceEvent::AvailabilityChanged {
                    enabled: false,
                    generation: event_generation,
                    error,
                } if event_generation.is_none() || event_generation == Some(generation) => {
                    source.stop(generation).await;
                    return Err(match error {
                        Some(error) => format!("Jam source was disabled during startup: {error}"),
                        None => "Jam source was disabled during startup".to_string(),
                    });
                }
                SourceEvent::Disconnected {
                    generation: event_generation,
                } if event_generation.is_none() || event_generation == Some(generation) => {
                    source.stop(generation).await;
                    return Err("Jam source disconnected during startup".to_string());
                }
                SourceEvent::ConnectionReplaced {
                    generation: event_generation,
                } if event_generation.is_none() || event_generation == Some(generation) => {
                    source.stop(generation).await;
                    return Err("Jam source connection was replaced during startup".to_string());
                }
                _ => {}
            }
        }

        let (audio_tx, _) = broadcast::channel::<AudioFrame>(64);
        let healthy = Arc::new(AtomicBool::new(true));
        let publish_task = tokio::spawn(broadcast_loop(
            generation,
            audio_tx.clone(),
            source_rx,
            healthy.clone(),
        ));

        Ok(Self {
            generation,
            source,
            publish_task: Some(publish_task),
            audio_tx,
            healthy,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AudioFrame> {
        self.audio_tx.subscribe()
    }

    pub fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub async fn stop(mut self) {
        info!("[jam-bot] stopping generation={}", self.generation);
        self.healthy.store(false, Ordering::Release);
        self.source.stop(self.generation).await;
        if let Some(task) = self.publish_task.take() {
            task.abort();
            let _ = task.await;
        }
        info!("[jam-bot] stopped generation={}", self.generation);
    }
}

async fn broadcast_loop(
    generation: u64,
    tx: broadcast::Sender<AudioFrame>,
    mut source_rx: broadcast::Receiver<SourceEvent>,
    healthy: Arc<AtomicBool>,
) {
    let mut accum: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 4);
    let mut frame_count = 0_u64;
    loop {
        match source_rx.recv().await {
            Ok(SourceEvent::Audio {
                generation: event_generation,
                sample_rate,
                channels,
                samples,
                ..
            }) if event_generation == generation => {
                accum.extend(convert_samples(
                    &samples,
                    sample_rate,
                    channels,
                    TARGET_RATE,
                    TARGET_CHANNELS,
                ));
                while accum.len() >= FRAME_SAMPLES {
                    frame_count += 1;
                    let data = accum.drain(..FRAME_SAMPLES).collect();
                    let _ = tx.send(AudioFrame { data });
                    if frame_count == 1 {
                        info!("[jam-bot] first listener frame generation={}", generation);
                    }
                }
            }
            Ok(SourceEvent::Error {
                generation: event_generation,
                message,
            }) if event_generation == generation => {
                warn!(
                    "[jam-bot] source failed generation={}: {}",
                    generation, message
                );
                healthy.store(false, Ordering::Release);
                accum.clear();
            }
            Ok(SourceEvent::AvailabilityChanged {
                enabled: false,
                generation: event_generation,
                error,
            }) if event_generation.is_none() || event_generation == Some(generation) => {
                if let Some(error) = error {
                    warn!(
                        "[jam-bot] source disabled generation={}: {}",
                        generation, error
                    );
                } else {
                    warn!("[jam-bot] source disabled generation={}", generation);
                }
                healthy.store(false, Ordering::Release);
                accum.clear();
            }
            Ok(SourceEvent::Disconnected {
                generation: event_generation,
            }) if event_generation.is_none() || event_generation == Some(generation) => {
                warn!("[jam-bot] source disconnected generation={}", generation);
                healthy.store(false, Ordering::Release);
                accum.clear();
            }
            Ok(SourceEvent::Connected) => {
                warn!("[jam-bot] source reconnecting generation={}", generation);
                healthy.store(false, Ordering::Release);
                accum.clear();
            }
            Ok(SourceEvent::ConnectionReplaced {
                generation: event_generation,
            }) if event_generation.is_none() || event_generation == Some(generation) => {
                warn!(
                    "[jam-bot] source connection replaced generation={}",
                    generation
                );
                healthy.store(false, Ordering::Release);
                accum.clear();
            }
            Ok(SourceEvent::Restarting {
                generation: event_generation,
            }) if event_generation == generation => {
                info!(
                    "[jam-bot] source capture restarting generation={}",
                    generation
                );
                healthy.store(false, Ordering::Release);
                accum.clear();
            }
            Ok(SourceEvent::Ready {
                generation: event_generation,
                ..
            }) if event_generation == generation => {
                healthy.store(true, Ordering::Release);
                accum.clear();
                info!("[jam-bot] source recovered generation={}", generation);
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(count)) => {
                warn!(
                    "[jam-bot] source relay lagged generation={} dropped={}",
                    generation, count
                );
            }
            Err(broadcast::error::RecvError::Closed) => {
                healthy.store(false, Ordering::Release);
                break;
            }
        }
    }
}

fn convert_samples(
    samples: &[f32],
    source_rate: u32,
    source_channels: u32,
    target_rate: u32,
    target_channels: u32,
) -> Vec<f32> {
    if source_rate == target_rate && source_channels == target_channels {
        return samples.to_vec();
    }
    let source_channels = source_channels.max(1);
    let source_frames = samples.len() / source_channels as usize;
    if source_frames == 0 {
        return Vec::new();
    }
    let target_frames =
        (source_frames as u64 * target_rate as u64 / source_rate.max(1) as u64) as usize;
    let mut output = Vec::with_capacity(target_frames * target_channels as usize);
    for target_frame in 0..target_frames {
        let source_frame = (target_frame as u64 * source_rate as u64 / target_rate as u64)
            .min(source_frames.saturating_sub(1) as u64) as usize;
        match (source_channels, target_channels) {
            (1, 2) => {
                let sample = samples[source_frame];
                output.extend_from_slice(&[sample, sample]);
            }
            (2, 1) => {
                let offset = source_frame * 2;
                output.push((samples[offset] + samples[offset + 1]) * 0.5);
            }
            _ => {
                for channel in 0..target_channels as usize {
                    output.push(
                        samples
                            .get(source_frame * source_channels as usize + channel)
                            .copied()
                            .unwrap_or(0.0),
                    );
                }
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_is_duplicated_to_stereo() {
        assert_eq!(
            convert_samples(&[0.25, -0.5], 48_000, 1, 48_000, 2),
            vec![0.25, 0.25, -0.5, -0.5]
        );
    }

    #[tokio::test]
    async fn replacement_connection_marks_relay_unhealthy_until_ready() {
        let (source_tx, source_rx) = broadcast::channel(16);
        let (audio_tx, mut audio_rx) = broadcast::channel(16);
        let healthy = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn(broadcast_loop(7, audio_tx, source_rx, healthy.clone()));

        source_tx.send(SourceEvent::Connected).unwrap();
        tokio::task::yield_now().await;
        assert!(!healthy.load(Ordering::Acquire));
        source_tx
            .send(SourceEvent::Ready {
                generation: 7,
                pid: 123,
            })
            .unwrap();
        source_tx
            .send(SourceEvent::Audio {
                generation: 7,
                sample_rate: 48_000,
                channels: 2,
                samples: vec![0.25; FRAME_SAMPLES],
            })
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(1), audio_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.data.len(), FRAME_SAMPLES);
        assert!(healthy.load(Ordering::Acquire));
        task.abort();
    }

    #[tokio::test]
    async fn existing_listener_resumes_after_capture_restart() {
        let (source_tx, source_rx) = broadcast::channel(16);
        let (audio_tx, mut existing_listener) = broadcast::channel(16);
        let healthy = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn(broadcast_loop(8, audio_tx, source_rx, healthy.clone()));

        source_tx
            .send(SourceEvent::Restarting { generation: 8 })
            .unwrap();
        tokio::task::yield_now().await;
        assert!(!healthy.load(Ordering::Acquire));

        source_tx
            .send(SourceEvent::Ready {
                generation: 8,
                pid: 456,
            })
            .unwrap();
        source_tx
            .send(SourceEvent::Audio {
                generation: 8,
                sample_rate: 48_000,
                channels: 2,
                samples: vec![0.5; FRAME_SAMPLES],
            })
            .unwrap();
        let frame = tokio::time::timeout(Duration::from_secs(1), existing_listener.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.data, vec![0.5; FRAME_SAMPLES]);
        assert!(healthy.load(Ordering::Acquire));
        task.abort();
    }

    #[tokio::test]
    async fn disabled_source_marks_an_active_relay_unhealthy() {
        let (source_tx, source_rx) = broadcast::channel(16);
        let (audio_tx, _audio_rx) = broadcast::channel(16);
        let healthy = Arc::new(AtomicBool::new(true));
        let task = tokio::spawn(broadcast_loop(9, audio_tx, source_rx, healthy.clone()));

        source_tx
            .send(SourceEvent::AvailabilityChanged {
                enabled: false,
                generation: Some(9),
                error: Some("Local Jam source is turned off".to_string()),
            })
            .unwrap();
        tokio::task::yield_now().await;
        assert!(!healthy.load(Ordering::Acquire));
        task.abort();
    }

    #[tokio::test]
    async fn startup_fails_immediately_if_the_source_becomes_disabled() {
        let source = JamSourceRegistry::new(true);
        let (command_tx, mut command_rx) = tokio::sync::mpsc::unbounded_channel();
        let connection_id = source.test_register(command_tx).await;
        source.test_availability(connection_id, true, None).await;
        let start_source = source.clone();
        let start_task =
            tokio::spawn(
                async move { JamBot::start(30, start_source, Duration::from_secs(30)).await },
            );
        command_rx.recv().await.expect("initial start command");

        source
            .test_availability(connection_id, false, Some("Local Jam source is turned off"))
            .await;
        let result = tokio::time::timeout(Duration::from_secs(1), start_task)
            .await
            .expect("startup should fail without waiting for its timeout")
            .expect("startup task");
        let error = match result {
            Ok(_) => panic!("disabled source must fail startup"),
            Err(error) => error,
        };
        assert_eq!(
            error,
            "Jam source was disabled during startup: Local Jam source is turned off"
        );
    }

    #[tokio::test]
    async fn startup_fails_immediately_if_the_source_disconnects() {
        let source = JamSourceRegistry::new(true);
        let (first_tx, mut first_rx) = tokio::sync::mpsc::unbounded_channel();
        let first_connection = source.test_register(first_tx).await;
        source.test_availability(first_connection, true, None).await;
        let start_source = source.clone();
        let start_task =
            tokio::spawn(
                async move { JamBot::start(31, start_source, Duration::from_secs(1)).await },
            );

        first_rx.recv().await.expect("initial start command");
        source.test_unregister(first_connection).await;
        let error = match start_task.await.expect("startup task") {
            Ok(_) => panic!("disconnected startup must fail closed"),
            Err(error) => error,
        };
        assert_eq!(error, "Jam source disconnected during startup");
    }
}
