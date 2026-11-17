//! Frame admission for the experimental high-motion WGC window share.

use std::fmt;
use std::time::{Duration, Instant};

use crate::capture_pipeline::should_push_frame_at_deadline;

pub(crate) const MAX_FPS: u32 = 60;
pub(crate) const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const BASE_FPS: u32 = 30;
const SOFTWARE_FPS: u32 = 20;
// Leave time in each frame for the publisher and encoder.
const HIGH_FPS_CONVERSION_BUDGET: Duration = Duration::from_millis(12);
const BASE_FPS_CONVERSION_BUDGET: Duration = Duration::from_millis(24);
const GPU_SATURATION_PERCENT: u32 = 95;
const GAME_BASELINE_SAMPLES: u8 = 3;
const GAME_ACTIVE_FPS: f64 = 20.0;
const GAME_BASELINE_MIN_FPS: f64 = 55.0;
const GAME_SLOWDOWN_RATIO: f64 = 0.75;
const GAME_PRESSURE_MAX_FPS: f64 = 80.0;
const GAME_PRESSURE_AT_30_FPS: f64 = 35.0;
const RECOVERY_CAPTURE_HOLD: Duration = Duration::from_secs(10);
const RECOVERY_SENDER_HOLD: Duration = Duration::from_secs(3);
const RECOVERY_CAPTURE_FRESHNESS: Duration = Duration::from_millis(1250);
const RECOVERY_CONVERSION_BUDGET: Duration = Duration::from_millis(8);
const RECOVERY_MIN_SOURCE_FPS: f64 = 45.0;
const RECOVERY_BASELINE_RATIO: f64 = 0.9;
const RECOVERY_GPU_HEADROOM_PERCENT: u32 = 85;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CaptureResolution {
    FullHd,
    Hd,
}

impl CaptureResolution {
    pub(crate) fn bounds(self) -> (u32, u32) {
        match self {
            Self::FullHd => (1920, 1080),
            Self::Hd => (1280, 720),
        }
    }

    pub(crate) fn from_dimensions(width: u32, height: u32) -> Self {
        if width > 1280 || height > 720 {
            Self::FullHd
        } else {
            Self::Hd
        }
    }
}

impl fmt::Display for CaptureResolution {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (_, height) = self.bounds();
        write!(f, "{height}p")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    WarmingUp,
    HighMotion,
    Limited,
    Software,
}

pub(crate) struct SenderSample {
    pub hardware: bool,
    pub active: bool,
    pub supports_full_hd: Option<bool>,
    pub resolution: CaptureResolution,
    pub supports_high_motion: bool,
    pub fps: f64,
    pub cpu_limited: bool,
    pub bandwidth_limited: bool,
}

#[derive(Debug)]
pub(crate) struct RateChange {
    pub from: u32,
    pub to: u32,
    pub from_resolution: CaptureResolution,
    pub to_resolution: CaptureResolution,
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
        pressure_max_fps: f64,
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
            && source_fps <= pressure_max_fps
            && source_fps <= self.baseline_fps * GAME_SLOWDOWN_RATIO
            && gpu_busy_percent >= GPU_SATURATION_PERCENT;
        if slow {
            self.slow_samples = self.slow_samples.saturating_add(1);
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

struct ResolutionRecovery {
    min_source_fps: f64,
    capture_healthy_since: Option<Instant>,
    capture_healthy_at: Option<Instant>,
    sender_healthy_since: Option<Instant>,
    last_healthy_sender_at: Option<Instant>,
}

impl ResolutionRecovery {
    fn new(game: &GameCadence) -> Self {
        let mut min_source_fps = RECOVERY_MIN_SOURCE_FPS;
        if game.baseline_samples >= GAME_BASELINE_SAMPLES {
            min_source_fps = min_source_fps.max(game.baseline_fps * RECOVERY_BASELINE_RATIO);
        }
        Self {
            min_source_fps,
            capture_healthy_since: None,
            capture_healthy_at: None,
            sender_healthy_since: None,
            last_healthy_sender_at: None,
        }
    }

    fn reset_sender_streak(&mut self) {
        self.sender_healthy_since = None;
        self.last_healthy_sender_at = None;
    }

    fn observe_capture(&mut self, now: Instant, healthy: bool) {
        if healthy {
            self.capture_healthy_since.get_or_insert(now);
            self.capture_healthy_at = Some(now);
        } else {
            self.capture_healthy_since = None;
            self.capture_healthy_at = None;
            self.reset_sender_streak();
        }
    }

    fn observe_sender(&mut self, now: Instant, healthy: bool) {
        let fresh_capture = self
            .capture_healthy_at
            .is_some_and(|at| now.duration_since(at) < RECOVERY_CAPTURE_FRESHNESS);
        if !healthy || !fresh_capture {
            self.reset_sender_streak();
            return;
        }
        let previous = self.last_healthy_sender_at.replace(now);
        if previous.is_none_or(|at| now.duration_since(at) >= 2 * SAMPLE_INTERVAL) {
            self.sender_healthy_since = Some(now);
        }
    }

    fn ready(&self, now: Instant) -> bool {
        self.capture_healthy_since
            .is_some_and(|since| now.duration_since(since) >= RECOVERY_CAPTURE_HOLD)
            && self
                .sender_healthy_since
                .is_some_and(|since| now.duration_since(since) >= RECOVERY_SENDER_HOLD)
    }
}

pub(crate) struct AdaptiveCapturePacer {
    mode: Mode,
    resolution: CaptureResolution,
    next_frame_at: Option<Instant>,
    last_frame_at: Option<Instant>,
    window_started: Instant,
    source_frames: u32,
    total_source_frames: u64,
    converted_frames: u32,
    dropped_frames: u32,
    conversion_time: Duration,
    healthy_capture_at: Option<Instant>,
    healthy_capture_windows: u8,
    active_capture_at: Option<Instant>,
    overloaded_capture_windows: u8,
    overloaded_sender_samples: u8,
    missing_sender_samples: u8,
    game_cadence: GameCadence,
    gpu_busy_sample: Option<(Instant, u32)>,
    recovery: Option<ResolutionRecovery>,
    recovery_attempted: bool,
}

impl AdaptiveCapturePacer {
    pub(crate) fn new(now: Instant, resolution: CaptureResolution) -> Self {
        Self {
            mode: Mode::WarmingUp,
            resolution,
            next_frame_at: None,
            last_frame_at: None,
            window_started: now,
            source_frames: 0,
            total_source_frames: 0,
            converted_frames: 0,
            dropped_frames: 0,
            conversion_time: Duration::ZERO,
            healthy_capture_at: None,
            healthy_capture_windows: 0,
            active_capture_at: None,
            overloaded_capture_windows: 0,
            overloaded_sender_samples: 0,
            missing_sender_samples: 0,
            game_cadence: GameCadence::default(),
            gpu_busy_sample: None,
            recovery: None,
            recovery_attempted: false,
        }
    }

    pub(crate) fn fps(&self) -> u32 {
        match self.mode {
            Mode::WarmingUp | Mode::Limited => BASE_FPS,
            Mode::HighMotion => MAX_FPS,
            Mode::Software => SOFTWARE_FPS,
        }
    }

    pub(crate) fn resolution(&self) -> CaptureResolution {
        self.resolution
    }

    fn interval(&self) -> Duration {
        Duration::from_nanos(1_000_000_000 / u64::from(self.fps()))
    }

    fn change_mode(
        &mut self,
        now: Instant,
        mode: Mode,
        resolution: CaptureResolution,
        reason: &'static str,
    ) -> Option<RateChange> {
        let from = self.fps();
        let from_resolution = self.resolution;
        self.mode = mode;
        self.resolution = resolution;
        let to = self.fps();
        if from == to && from_resolution == resolution {
            return None;
        }
        self.next_frame_at = self.last_frame_at.map(|last| last + self.interval());
        self.reset_capture_window(now);
        self.overloaded_capture_windows = 0;
        self.overloaded_sender_samples = 0;
        self.missing_sender_samples = 0;
        self.healthy_capture_at = None;
        self.healthy_capture_windows = 0;
        self.active_capture_at = None;
        self.game_cadence.slow_samples = 0;
        if let Some(recovery) = &mut self.recovery {
            recovery.observe_capture(now, false);
        }
        Some(RateChange {
            from,
            to,
            from_resolution,
            to_resolution: resolution,
            reason,
            game_pressure: None,
        })
    }

    fn reduce_load(&mut self, now: Instant, reason: &'static str) -> Option<RateChange> {
        if self.mode == Mode::HighMotion {
            self.change_mode(now, Mode::Limited, self.resolution, reason)
        } else if self.resolution == CaptureResolution::FullHd && self.mode != Mode::Software {
            // Start at 720p30 and measure again before attempting 720p60.
            if !self.recovery_attempted {
                self.recovery = Some(ResolutionRecovery::new(&self.game_cadence));
            }
            self.change_mode(now, Mode::WarmingUp, CaptureResolution::Hd, reason)
        } else {
            None
        }
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
        if !self.needs_game_load_monitor() {
            return None;
        }
        self.gpu_busy_sample = foreground_gpu_busy.map(|busy| (now, busy));
        let pressure_max_fps = if self.mode == Mode::HighMotion {
            GAME_PRESSURE_MAX_FPS
        } else {
            GAME_PRESSURE_AT_30_FPS
        };
        let game_pressure = self.game_cadence.observe(
            now,
            self.total_source_frames,
            foreground_gpu_busy,
            pressure_max_fps,
        )?;
        let mut change = self.reduce_load(now, "game-gpu-pressure")?;
        change.game_pressure = Some(game_pressure);
        Some(change)
    }

    pub(crate) fn needs_game_load_monitor(&self) -> bool {
        self.mode != Mode::Software
            && (self.resolution == CaptureResolution::FullHd
                || self.recovery.is_some()
                || matches!(self.mode, Mode::WarmingUp | Mode::HighMotion))
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
        let conversion_budget = if self.mode == Mode::HighMotion {
            HIGH_FPS_CONVERSION_BUDGET
        } else {
            BASE_FPS_CONVERSION_BUDGET
        };
        let overloaded = elapsed < 2 * SAMPLE_INTERVAL
            && self.converted_frames >= 5
            && (self.conversion_time > conversion_budget * self.converted_frames
                || self.dropped_frames >= self.converted_frames.div_ceil(10));
        let source_fps = f64::from(self.source_frames) / elapsed.as_secs_f64();
        let converted_fps = f64::from(self.converted_frames) / elapsed.as_secs_f64();
        let healthy = !overloaded
            && source_fps >= 50.0
            && converted_fps >= 25.0
            && self.conversion_time <= HIGH_FPS_CONVERSION_BUDGET * self.converted_frames;
        self.active_capture_at = (converted_fps >= 25.0).then_some(now);
        self.healthy_capture_at = healthy.then_some(now);
        self.healthy_capture_windows = if healthy {
            self.healthy_capture_windows.saturating_add(1)
        } else {
            0
        };
        let min_sender_fps = f64::from(self.fps()) * 5.0 / 6.0;
        if let Some(recovery) = &mut self.recovery {
            // A game capped at 30 fps can still show headroom through recent
            // GPU telemetry even though its source cadence cannot rise.
            let clear_gpu_headroom = self.gpu_busy_sample.is_some_and(|(at, busy)| {
                now.duration_since(at) < 2 * SAMPLE_INTERVAL
                    && busy <= RECOVERY_GPU_HEADROOM_PERCENT
                    && source_fps >= 28.0
            });
            let healthy = elapsed < 2 * SAMPLE_INTERVAL
                && (source_fps >= recovery.min_source_fps || clear_gpu_headroom)
                && converted_fps >= min_sender_fps
                && self.dropped_frames == 0
                && self.conversion_time <= RECOVERY_CONVERSION_BUDGET * self.converted_frames;
            recovery.observe_capture(now, healthy);
        }
        self.reset_capture_window(now);

        if self.mode == Mode::HighMotion
            || (self.resolution == CaptureResolution::FullHd && self.mode != Mode::Software)
        {
            self.overloaded_capture_windows = if overloaded {
                self.overloaded_capture_windows + 1
            } else {
                0
            };
            if self.overloaded_capture_windows >= 2 {
                return self.reduce_load(now, "capture-overload");
            }
        }
        None
    }

    fn reset_capture_window(&mut self, now: Instant) {
        self.window_started = now;
        self.source_frames = 0;
        self.converted_frames = 0;
        self.dropped_frames = 0;
        self.conversion_time = Duration::ZERO;
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
            if let Some(recovery) = &mut self.recovery {
                recovery.reset_sender_streak();
            }
            if self.mode == Mode::HighMotion {
                self.missing_sender_samples += 1;
                if self.missing_sender_samples >= 2 {
                    return self.reduce_load(now, "sender-stats-unavailable");
                }
            }
            return None;
        };
        self.missing_sender_samples = 0;
        if !sample.hardware {
            let resolution = if sample.supports_full_hd.unwrap_or(true) {
                self.resolution
            } else {
                CaptureResolution::Hd
            };
            self.recovery = None;
            return self.change_mode(now, Mode::Software, resolution, "software-encoder");
        }
        if self.resolution == CaptureResolution::FullHd && sample.supports_full_hd == Some(false) {
            return self.change_mode(
                now,
                Mode::WarmingUp,
                CaptureResolution::Hd,
                "codec-resolution-limit",
            );
        }
        // An outbound report can still describe the previous resolution
        // while WebRTC reinitializes the encoder on the same track.
        if sample.resolution != self.resolution {
            if let Some(recovery) = &mut self.recovery {
                recovery.reset_sender_streak();
            }
            return None;
        }
        if self.mode == Mode::HighMotion && !sample.supports_high_motion {
            return self.reduce_load(now, "encoder-or-codec-limit");
        }
        let slow_sender = sample.active
            && (if self.mode == Mode::HighMotion {
                (sample.cpu_limited && sample.fps >= 10.0)
                    || (sample.bandwidth_limited
                        && sample.fps < 50.0
                        && self.active_capture_at.is_some_and(|active_at| {
                            now.duration_since(active_at) < SAMPLE_INTERVAL
                        }))
            } else {
                self.resolution == CaptureResolution::FullHd
                    && sample.fps < 25.0
                    && (sample.cpu_limited || sample.bandwidth_limited)
                    && self
                        .active_capture_at
                        .is_some_and(|active_at| now.duration_since(active_at) < SAMPLE_INTERVAL)
            });
        self.overloaded_sender_samples = if slow_sender {
            self.overloaded_sender_samples + 1
        } else {
            0
        };
        if self.overloaded_sender_samples >= 2 {
            let reason = if sample.cpu_limited {
                "sender-cpu-overload"
            } else {
                "sender-bandwidth-limit"
            };
            return self.reduce_load(now, reason);
        }
        let min_sender_fps = f64::from(self.fps()) * 5.0 / 6.0;
        if let Some(recovery) = &mut self.recovery {
            let healthy = sample.active
                && sample.supports_full_hd == Some(true)
                && sample.fps >= min_sender_fps
                && !sample.cpu_limited
                && !sample.bandwidth_limited;
            recovery.observe_sender(now, healthy);
            if recovery.ready(now) {
                self.recovery = None;
                self.recovery_attempted = true;
                return self.change_mode(
                    now,
                    Mode::Limited,
                    CaptureResolution::FullHd,
                    "sustained-recovery-headroom",
                );
            }
            // Prefer recovering image quality while both paths show headroom.
            if recovery.sender_healthy_since.is_some() {
                return None;
            }
        }
        if self.mode == Mode::WarmingUp
            && sample.active
            && sample.supports_high_motion
            && sample.fps >= 25.0
            && !sample.cpu_limited
            && !sample.bandwidth_limited
            && self
                .healthy_capture_at
                .is_some_and(|healthy_at| now.duration_since(healthy_at) < SAMPLE_INTERVAL)
            && (self.resolution == CaptureResolution::FullHd || self.healthy_capture_windows >= 2)
        {
            return self.change_mode(
                now,
                Mode::HighMotion,
                self.resolution,
                "capture-and-encoder-ready",
            );
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
            active: true,
            supports_full_hd: Some(true),
            resolution: CaptureResolution::FullHd,
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
        let mut pacer = AdaptiveCapturePacer::new(start, CaptureResolution::FullHd);
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
        let mut pacer = AdaptiveCapturePacer::new(start, CaptureResolution::FullHd);
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
        assert!(pacer.needs_game_load_monitor());
        assert_eq!(pacer.resolution(), CaptureResolution::FullHd);
    }

    #[test]
    fn game_cadence_ignores_lower_fps_without_pressure_or_foreground_motion() {
        let start = Instant::now();
        let mut game = GameCadence::default();
        let mut frames = 0;
        let mut observe = |second, new_frames, gpu| {
            frames += new_frames;
            game.observe(
                start + SAMPLE_INTERVAL * second,
                frames,
                gpu,
                GAME_PRESSURE_MAX_FPS,
            )
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
                    Some(99),
                    GAME_PRESSURE_MAX_FPS,
                )
                .is_none());
        }
        assert!(game
            .observe(
                start + SAMPLE_INTERVAL * 4,
                360,
                Some(99),
                GAME_PRESSURE_MAX_FPS
            )
            .is_none());
        assert!(game
            .observe(
                start + SAMPLE_INTERVAL * 5,
                390,
                Some(99),
                GAME_PRESSURE_MAX_FPS
            )
            .is_none());
        assert!(game
            .observe(
                start + SAMPLE_INTERVAL * 6,
                420,
                Some(99),
                GAME_PRESSURE_MAX_FPS
            )
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
            fps: 58.0,
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

    #[test]
    fn sustained_1080p30_overload_moves_to_720p_and_requalifies_60() {
        let start = Instant::now();
        let mut pacer = warmed_up(start);
        let mut now = start + SAMPLE_INTERVAL;
        pacer.reduce_load(now, "capture-overload").unwrap();
        assert_eq!(pacer.resolution(), CaptureResolution::FullHd);
        for _ in 0..2 {
            simulate_second(&mut pacer, now, 120, 27, false);
            now += SAMPLE_INTERVAL;
        }
        let change = pacer.admit(now).1.unwrap();
        assert_eq!(change.from_resolution, CaptureResolution::FullHd);
        assert_eq!(change.to_resolution, CaptureResolution::Hd);
        assert_eq!(change.to, 30);
        let hd = || SenderSample {
            resolution: CaptureResolution::Hd,
            ..hardware_sample()
        };
        simulate_second(&mut pacer, now, 120, 10, false);
        now += SAMPLE_INTERVAL;
        pacer.admit(now);
        assert!(pacer.observe_sender(now, Some(hd())).is_none());
        simulate_second(&mut pacer, now, 120, 10, false);
        now += SAMPLE_INTERVAL;
        pacer.admit(now);
        assert!(pacer.observe_sender(now, Some(hardware_sample())).is_none());
        assert_eq!(pacer.observe_sender(now, Some(hd())).unwrap().to, 60);
        let change = pacer.reduce_load(now, "capture-overload").unwrap();
        assert_eq!(
            (change.to_resolution, change.to),
            (CaptureResolution::Hd, 30)
        );
        assert!(pacer.reduce_load(now, "capture-overload").is_none());
    }

    #[test]
    fn level_3_1_keeps_the_hardware_share_at_720p30() {
        let now = Instant::now();
        let mut pacer = AdaptiveCapturePacer::new(now, CaptureResolution::FullHd);
        let limited = SenderSample {
            resolution: CaptureResolution::Hd,
            supports_full_hd: Some(false),
            supports_high_motion: false,
            ..hardware_sample()
        };
        let change = pacer.observe_sender(now, Some(limited)).unwrap();
        assert_eq!(
            (change.to_resolution, change.to),
            (CaptureResolution::Hd, 30)
        );
    }

    fn hd_at_30() -> SenderSample {
        SenderSample {
            resolution: CaptureResolution::Hd,
            supports_high_motion: false,
            ..hardware_sample()
        }
    }

    #[test]
    fn recovery_requires_sustained_headroom_and_gets_one_attempt() {
        let mut now = Instant::now();
        let mut pacer = AdaptiveCapturePacer::new(now, CaptureResolution::FullHd);
        pacer.game_cadence.baseline_fps = 75.0;
        pacer.game_cadence.baseline_samples = GAME_BASELINE_SAMPLES;
        pacer.reduce_load(now, "capture-overload").unwrap();

        for source_fps in [60, 75] {
            for _ in 0..RECOVERY_CAPTURE_HOLD.as_secs() {
                simulate_second(&mut pacer, now, source_fps, 2, false);
                now += SAMPLE_INTERVAL;
                pacer.admit(now);
                assert!(pacer.observe_sender(now, Some(hd_at_30())).is_none());
            }
        }
        simulate_second(&mut pacer, now, 75, 2, true);
        now += SAMPLE_INTERVAL;
        pacer.admit(now);
        assert!(pacer.observe_sender(now, Some(hd_at_30())).is_none());

        for _ in 0..RECOVERY_CAPTURE_HOLD.as_secs() {
            simulate_second(&mut pacer, now, 75, 2, false);
            now += SAMPLE_INTERVAL;
            pacer.admit(now);
            assert!(pacer.observe_sender(now, Some(hd_at_30())).is_none());
        }
        simulate_second(&mut pacer, now, 75, 2, false);
        now += SAMPLE_INTERVAL;
        pacer.admit(now);
        let restored = pacer.observe_sender(now, Some(hd_at_30())).unwrap();
        assert_eq!(restored.reason, "sustained-recovery-headroom");
        assert_eq!(
            (restored.to_resolution, restored.to),
            (CaptureResolution::FullHd, 30)
        );
        assert!(pacer.mode == Mode::Limited);

        pacer.reduce_load(now, "capture-overload").unwrap();
        for _ in 0..20 {
            simulate_second(&mut pacer, now, 75, 2, false);
            now += SAMPLE_INTERVAL;
            pacer.admit(now);
            assert!(pacer.observe_sender(now, Some(hd_at_30())).is_none());
        }
        assert_eq!(pacer.resolution(), CaptureResolution::Hd);
    }

    #[test]
    fn recovery_uses_capture_headroom_accumulated_while_sender_is_bandwidth_limited() {
        let mut now = Instant::now();
        let mut pacer = AdaptiveCapturePacer::new(now, CaptureResolution::FullHd);
        pacer.reduce_load(now, "capture-overload").unwrap();
        let clear_after = 19;
        let interrupted_at = clear_after + 2;
        let restored_at = interrupted_at + 1 + RECOVERY_SENDER_HOLD.as_secs();

        for second in 1..=restored_at {
            simulate_second(&mut pacer, now, 75, 2, false);
            now += SAMPLE_INTERVAL;
            pacer.admit(now);
            let change = pacer.observe_sender(
                now,
                Some(SenderSample {
                    supports_high_motion: true,
                    bandwidth_limited: second < clear_after || second == interrupted_at,
                    ..hd_at_30()
                }),
            );
            if second < restored_at {
                assert!(change.is_none());
                assert_eq!(
                    (pacer.resolution(), pacer.fps()),
                    (CaptureResolution::Hd, 30)
                );
            } else {
                let change = change.unwrap();
                assert_eq!(change.reason, "sustained-recovery-headroom");
                assert_eq!(
                    (change.to_resolution, change.to),
                    (CaptureResolution::FullHd, 30)
                );
            }
        }
    }

    #[test]
    fn recovery_needs_confirmed_1080p_capability_and_can_use_gpu_headroom_at_30() {
        let mut now = Instant::now();
        let mut pacer = AdaptiveCapturePacer::new(now, CaptureResolution::FullHd);
        pacer.reduce_load(now, "capture-overload").unwrap();
        let codec_available_at = RECOVERY_CAPTURE_HOLD.as_secs() + 2;
        let restored_at = codec_available_at + RECOVERY_SENDER_HOLD.as_secs();
        for second in 1..=restored_at {
            pacer.observe_game_load(now, Some(75));
            simulate_second(&mut pacer, now, 30, 2, false);
            now += SAMPLE_INTERVAL;
            pacer.admit(now);
            let change = pacer.observe_sender(
                now,
                Some(SenderSample {
                    supports_full_hd: (second >= codec_available_at).then_some(true),
                    ..hd_at_30()
                }),
            );
            assert_eq!(change.is_some(), second == restored_at);
        }
        assert_eq!(pacer.resolution(), CaptureResolution::FullHd);
        assert_eq!(pacer.fps(), 30);
    }
}
