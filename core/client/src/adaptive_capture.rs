//! Frame admission for the experimental high-motion WGC window share.

use std::time::{Duration, Instant};

use crate::capture_pipeline::should_push_frame_at_deadline;

pub(crate) const MAX_FPS: u32 = 60;
pub(crate) const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const BASE_FPS: u32 = 30;
const SOFTWARE_FPS: u32 = 20;
// Leave time in each 16.7 ms frame for the publisher and encoder.
const CONVERSION_BUDGET: Duration = Duration::from_millis(12);
const GPU_SATURATION_PERCENT: u32 = 95;
const GAME_BASELINE_SAMPLES: u8 = 3;
const GAME_ACTIVE_FPS: f64 = 20.0;
const GAME_BASELINE_MIN_FPS: f64 = 55.0;
const GAME_SLOWDOWN_RATIO: f64 = 0.75;
const GAME_PRESSURE_MAX_FPS: f64 = 80.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    WarmingUp,
    HighMotion,
    Limited,
    Software,
}

pub(crate) struct SenderSample {
    pub hardware: bool,
    pub supports_high_motion: bool,
    pub fps: f64,
    pub cpu_limited: bool,
    pub bandwidth_limited: bool,
}

#[derive(Debug)]
pub(crate) struct RateChange {
    pub from: u32,
    pub to: u32,
    pub reason: &'static str,
    pub game_pressure: Option<GamePressure>,
}

#[derive(Debug)]
pub(crate) struct GamePressure {
    pub source_fps: f64,
    pub baseline_fps: f64,
    pub gpu_busy_percent: u32,
}

#[derive(Default)]
struct GameCadence {
    previous_sample: Option<(Instant, u64)>,
    baseline_fps: f64,
    baseline_samples: u8,
    slow_samples: u8,
}

impl GameCadence {
    fn observe(
        &mut self,
        now: Instant,
        total_source_frames: u64,
        foreground_gpu_busy: Option<u32>,
    ) -> Option<GamePressure> {
        let Some(gpu_busy_percent) = foreground_gpu_busy else {
            *self = Self::default();
            return None;
        };
        let (previous_at, previous_frames) =
            self.previous_sample.replace((now, total_source_frames))?;
        let elapsed = now.duration_since(previous_at);
        if elapsed.is_zero() || elapsed >= 2 * SAMPLE_INTERVAL {
            self.slow_samples = 0;
            return None;
        }
        let source_fps = (total_source_frames - previous_frames) as f64 / elapsed.as_secs_f64();
        if source_fps < GAME_ACTIVE_FPS {
            self.baseline_samples = 0;
            self.slow_samples = 0;
            return None;
        }
        let slow = self.baseline_samples >= GAME_BASELINE_SAMPLES
            && source_fps <= GAME_PRESSURE_MAX_FPS
            && source_fps <= self.baseline_fps * GAME_SLOWDOWN_RATIO
            && gpu_busy_percent >= GPU_SATURATION_PERCENT;
        if slow {
            self.slow_samples += 1;
            return (self.slow_samples >= 2).then_some(GamePressure {
                source_fps,
                baseline_fps: self.baseline_fps,
                gpu_busy_percent,
            });
        }

        self.slow_samples = 0;
        if source_fps >= GAME_BASELINE_MIN_FPS
            && (self.baseline_samples < GAME_BASELINE_SAMPLES
                || source_fps > self.baseline_fps * GAME_SLOWDOWN_RATIO)
        {
            if self.baseline_samples == 0 {
                self.baseline_fps = source_fps;
            } else {
                self.baseline_fps += (source_fps - self.baseline_fps) * 0.25;
            }
            self.baseline_samples = (self.baseline_samples + 1).min(GAME_BASELINE_SAMPLES);
        }
        None
    }
}

pub(crate) struct AdaptiveCapturePacer {
    mode: Mode,
    next_frame_at: Option<Instant>,
    last_frame_at: Option<Instant>,
    window_started: Instant,
    source_frames: u32,
    total_source_frames: u64,
    converted_frames: u32,
    dropped_frames: u32,
    conversion_time: Duration,
    healthy_capture_at: Option<Instant>,
    overloaded_capture_windows: u8,
    overloaded_sender_samples: u8,
    missing_sender_samples: u8,
    game_cadence: GameCadence,
}

impl AdaptiveCapturePacer {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            mode: Mode::WarmingUp,
            next_frame_at: None,
            last_frame_at: None,
            window_started: now,
            source_frames: 0,
            total_source_frames: 0,
            converted_frames: 0,
            dropped_frames: 0,
            conversion_time: Duration::ZERO,
            healthy_capture_at: None,
            overloaded_capture_windows: 0,
            overloaded_sender_samples: 0,
            missing_sender_samples: 0,
            game_cadence: GameCadence::default(),
        }
    }

    pub(crate) fn fps(&self) -> u32 {
        match self.mode {
            Mode::WarmingUp | Mode::Limited => BASE_FPS,
            Mode::HighMotion => MAX_FPS,
            Mode::Software => SOFTWARE_FPS,
        }
    }

    fn interval(&self) -> Duration {
        Duration::from_nanos(1_000_000_000 / u64::from(self.fps()))
    }

    fn change_mode(&mut self, mode: Mode, reason: &'static str) -> Option<RateChange> {
        let from = self.fps();
        self.mode = mode;
        let to = self.fps();
        if from == to {
            return None;
        }
        self.next_frame_at = self.last_frame_at.map(|last| last + self.interval());
        self.overloaded_capture_windows = 0;
        self.overloaded_sender_samples = 0;
        Some(RateChange {
            from,
            to,
            reason,
            game_pressure: None,
        })
    }

    /// Call for fresh callbacks only. Heartbeats use their own 200 ms cadence.
    pub(crate) fn admit(&mut self, now: Instant) -> (bool, Option<RateChange>) {
        let change = self.finish_capture_window(now);
        self.source_frames += 1;
        self.total_source_frames += 1;
        let interval = self.interval();
        let admit = should_push_frame_at_deadline(now, &mut self.next_frame_at, interval);
        if admit {
            self.last_frame_at = Some(now);
        }
        (admit, change)
    }

    pub(crate) fn observe_game_load(
        &mut self,
        now: Instant,
        foreground_gpu_busy: Option<u32>,
    ) -> Option<RateChange> {
        if self.mode != Mode::HighMotion {
            return None;
        }
        let game_pressure =
            self.game_cadence
                .observe(now, self.total_source_frames, foreground_gpu_busy)?;
        let mut change = self.change_mode(Mode::Limited, "game-gpu-pressure")?;
        change.game_pressure = Some(game_pressure);
        Some(change)
    }

    pub(crate) fn needs_game_load_monitor(&self) -> bool {
        matches!(self.mode, Mode::WarmingUp | Mode::HighMotion)
    }

    pub(crate) fn record_conversion(&mut self, elapsed: Duration, channel_full: bool) {
        self.conversion_time += elapsed;
        self.converted_frames += 1;
        self.record_dropped_frames(u32::from(channel_full));
    }

    pub(crate) fn record_dropped_frames(&mut self, count: u32) {
        self.dropped_frames += count;
    }

    fn finish_capture_window(&mut self, now: Instant) -> Option<RateChange> {
        let elapsed = now.duration_since(self.window_started);
        if elapsed < SAMPLE_INTERVAL {
            return None;
        }
        let overloaded = elapsed < 2 * SAMPLE_INTERVAL
            && self.converted_frames >= 5
            && (self.conversion_time > CONVERSION_BUDGET * self.converted_frames
                || self.dropped_frames >= self.converted_frames.div_ceil(10));
        let healthy = !overloaded
            && f64::from(self.source_frames) / elapsed.as_secs_f64() >= 50.0
            && f64::from(self.converted_frames) / elapsed.as_secs_f64() >= 25.0;
        self.window_started = now;
        self.source_frames = 0;
        self.converted_frames = 0;
        self.dropped_frames = 0;
        self.conversion_time = Duration::ZERO;
        self.healthy_capture_at = healthy.then_some(now);

        if self.mode == Mode::HighMotion {
            self.overloaded_capture_windows = if overloaded {
                self.overloaded_capture_windows + 1
            } else {
                0
            };
            if self.overloaded_capture_windows >= 2 {
                return self.change_mode(Mode::Limited, "capture-overload");
            }
        }
        None
    }

    pub(crate) fn observe_sender(
        &mut self,
        now: Instant,
        sample: Option<SenderSample>,
    ) -> Option<RateChange> {
        if self.mode == Mode::Software {
            return None;
        }
        let Some(sample) = sample else {
            self.overloaded_sender_samples = 0;
            if self.mode == Mode::HighMotion {
                self.missing_sender_samples += 1;
                if self.missing_sender_samples >= 2 {
                    return self.change_mode(Mode::Limited, "sender-stats-unavailable");
                }
            }
            return None;
        };
        self.missing_sender_samples = 0;
        if !sample.hardware {
            return self.change_mode(Mode::Software, "software-encoder");
        }
        if !sample.supports_high_motion {
            return self.change_mode(Mode::Limited, "encoder-or-codec-limit");
        }
        if self.mode == Mode::WarmingUp
            && sample.fps >= 25.0
            && !sample.cpu_limited
            && !sample.bandwidth_limited
            && self
                .healthy_capture_at
                .is_some_and(|healthy_at| now.duration_since(healthy_at) < SAMPLE_INTERVAL)
        {
            return self.change_mode(Mode::HighMotion, "capture-and-encoder-ready");
        }
        if self.mode == Mode::HighMotion {
            self.overloaded_sender_samples = if sample.cpu_limited && sample.fps >= 10.0 {
                self.overloaded_sender_samples + 1
            } else {
                0
            };
            if self.overloaded_sender_samples >= 2 {
                return self.change_mode(Mode::Limited, "sender-cpu-overload");
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hardware_sample() -> SenderSample {
        SenderSample {
            hardware: true,
            supports_high_motion: true,
            fps: 29.0,
            cpu_limited: false,
            bandwidth_limited: false,
        }
    }

    fn simulate_second(
        pacer: &mut AdaptiveCapturePacer,
        start: Instant,
        source_fps: u32,
        conversion_ms: u64,
        queue_full: bool,
    ) -> u32 {
        let mut converted = 0;
        for i in 0..source_fps {
            let now = start + SAMPLE_INTERVAL * i / source_fps;
            if pacer.admit(now).0 {
                pacer.record_conversion(Duration::from_millis(conversion_ms), queue_full);
                converted += 1;
            }
        }
        converted
    }

    fn warmed_up(start: Instant) -> AdaptiveCapturePacer {
        let mut pacer = AdaptiveCapturePacer::new(start);
        assert_eq!(simulate_second(&mut pacer, start, 120, 2, false), 30);
        let now = start + SAMPLE_INTERVAL;
        pacer.admit(now);
        assert_eq!(
            pacer
                .observe_sender(now, Some(hardware_sample()))
                .unwrap()
                .to,
            60
        );
        pacer
    }

    #[test]
    fn only_active_capture_with_verified_hardware_can_promote() {
        let start = Instant::now();
        let mut pacer = AdaptiveCapturePacer::new(start);
        assert!(pacer
            .observe_sender(start, Some(hardware_sample()))
            .is_none());
        simulate_second(&mut pacer, start, 10, 2, false);
        let now = start + SAMPLE_INTERVAL;
        pacer.admit(now);
        assert!(pacer.observe_sender(now, Some(hardware_sample())).is_none());
        assert_eq!(pacer.fps(), 30);
        assert_eq!(warmed_up(start).fps(), 60);
    }

    #[test]
    fn sustained_capture_overload_reduces_expensive_conversions() {
        let start = Instant::now();
        let mut pacer = warmed_up(start);
        let high_rate_frames = simulate_second(&mut pacer, start + SAMPLE_INTERVAL, 144, 13, false);
        assert!(high_rate_frames >= 58);
        simulate_second(&mut pacer, start + 2 * SAMPLE_INTERVAL, 144, 13, false);
        assert_eq!(pacer.fps(), 60);
        let now = start + 3 * SAMPLE_INTERVAL;
        let (_, change) = pacer.admit(now);
        assert_eq!(change.unwrap().reason, "capture-overload");
        let low_rate_frames = simulate_second(&mut pacer, now, 144, 2, false);
        assert!((29..=30).contains(&low_rate_frames));
        let now = now + SAMPLE_INTERVAL;
        pacer.admit(now);
        assert!(pacer.observe_sender(now, Some(hardware_sample())).is_none());
        assert_eq!(pacer.fps(), 30);
    }

    #[test]
    fn sustained_full_channel_also_triggers_capture_overload() {
        let start = Instant::now();
        let mut pacer = warmed_up(start);
        simulate_second(&mut pacer, start + SAMPLE_INTERVAL, 120, 2, true);
        simulate_second(&mut pacer, start + 2 * SAMPLE_INTERVAL, 120, 2, true);
        let (_, change) = pacer.admit(start + 3 * SAMPLE_INTERVAL);
        assert_eq!(change.unwrap().to, 30);
    }

    #[test]
    fn sustained_game_slowdown_reduces_conversion_before_the_source_hits_30() {
        let start = Instant::now();
        let mut pacer = warmed_up(start);
        let mut now = start + SAMPLE_INTERVAL;
        assert!(pacer.observe_game_load(now, Some(98)).is_none());
        for _ in 0..3 {
            simulate_second(&mut pacer, now, 120, 2, false);
            now += SAMPLE_INTERVAL;
            assert!(pacer.observe_game_load(now, Some(98)).is_none());
        }
        let frames_at_60 = simulate_second(&mut pacer, now, 72, 2, false);
        now += SAMPLE_INTERVAL;
        assert!(pacer.observe_game_load(now, Some(99)).is_none());
        simulate_second(&mut pacer, now, 72, 2, false);
        now += SAMPLE_INTERVAL;
        let change = pacer.observe_game_load(now, Some(99)).unwrap();
        assert_eq!(
            (change.from, change.to, change.reason),
            (60, 30, "game-gpu-pressure")
        );
        let load = change.game_pressure.unwrap();
        assert_eq!(load.source_fps, 72.0);
        assert!(load.baseline_fps > 110.0);
        assert!(frames_at_60 >= 58);
        assert!((29..=30).contains(&simulate_second(&mut pacer, now, 72, 2, false)));
        assert!(!pacer.needs_game_load_monitor());
    }

    #[test]
    fn game_cadence_ignores_lower_fps_without_pressure_or_foreground_motion() {
        let start = Instant::now();
        let mut game = GameCadence::default();
        let mut frames = 0;
        let mut observe = |second, new_frames, gpu| {
            frames += new_frames;
            game.observe(start + SAMPLE_INTERVAL * second, frames, gpu)
        };
        for second in 0..4 {
            assert!(observe(second, 120, Some(99)).is_none());
        }
        assert!(observe(4, 95, Some(99)).is_none());
        assert!(observe(5, 72, Some(60)).is_none());
        assert!(observe(6, 72, Some(99)).is_none());
        assert!(observe(7, 30, None).is_none());
        assert!(observe(8, 30, Some(99)).is_none());
        assert!(observe(9, 30, Some(99)).is_none());
        assert!(observe(10, 30, Some(99)).is_none());
    }

    #[test]
    fn static_game_window_clears_the_previous_active_baseline() {
        let start = Instant::now();
        let mut game = GameCadence::default();
        for second in 0..4 {
            assert!(game
                .observe(
                    start + SAMPLE_INTERVAL * second,
                    u64::from(second) * 120,
                    Some(99)
                )
                .is_none());
        }
        assert!(game
            .observe(start + SAMPLE_INTERVAL * 4, 360, Some(99))
            .is_none());
        assert!(game
            .observe(start + SAMPLE_INTERVAL * 5, 390, Some(99))
            .is_none());
        assert!(game
            .observe(start + SAMPLE_INTERVAL * 6, 420, Some(99))
            .is_none());
    }

    #[test]
    fn cpu_pressure_requires_two_consecutive_active_samples() {
        let start = Instant::now();
        let mut pacer = warmed_up(start);
        let cpu = || {
            Some(SenderSample {
                cpu_limited: true,
                ..hardware_sample()
            })
        };
        assert!(pacer
            .observe_sender(start + 2 * SAMPLE_INTERVAL, cpu())
            .is_none());
        let bandwidth = Some(SenderSample {
            bandwidth_limited: true,
            ..hardware_sample()
        });
        assert!(pacer
            .observe_sender(start + 3 * SAMPLE_INTERVAL, bandwidth)
            .is_none());
        let idle = Some(SenderSample {
            fps: 5.0,
            cpu_limited: true,
            ..hardware_sample()
        });
        assert!(pacer
            .observe_sender(start + 4 * SAMPLE_INTERVAL, idle)
            .is_none());
        assert!(pacer
            .observe_sender(start + 5 * SAMPLE_INTERVAL, cpu())
            .is_none());
        let change = pacer
            .observe_sender(start + 6 * SAMPLE_INTERVAL, cpu())
            .unwrap();
        assert_eq!(change.to, 30);
        assert_eq!(change.reason, "sender-cpu-overload");
    }

    #[test]
    fn missing_telemetry_and_codec_downgrade_fail_back_to_30() {
        let start = Instant::now();
        let mut pacer = warmed_up(start);
        assert!(pacer
            .observe_sender(start + 2 * SAMPLE_INTERVAL, None)
            .is_none());
        assert_eq!(
            pacer
                .observe_sender(start + 3 * SAMPLE_INTERVAL, None)
                .unwrap()
                .to,
            30
        );
        let mut pacer = warmed_up(start);
        let lower_level = Some(SenderSample {
            supports_high_motion: false,
            ..hardware_sample()
        });
        assert_eq!(
            pacer
                .observe_sender(start + 2 * SAMPLE_INTERVAL, lower_level)
                .unwrap()
                .to,
            30
        );
    }

    #[test]
    fn software_fallback_immediately_caps_capture_at_20_fps() {
        let start = Instant::now();
        let mut pacer = warmed_up(start);
        let now = start + 2 * SAMPLE_INTERVAL;
        let software = Some(SenderSample {
            hardware: false,
            ..hardware_sample()
        });
        let change = pacer.observe_sender(now, software).unwrap();
        assert_eq!(change.to, 20);
        assert_eq!(simulate_second(&mut pacer, now, 120, 2, false), 20);
        assert!(pacer
            .observe_sender(now + SAMPLE_INTERVAL, Some(hardware_sample()))
            .is_none());
        assert_eq!(pacer.fps(), 20);
    }
}
