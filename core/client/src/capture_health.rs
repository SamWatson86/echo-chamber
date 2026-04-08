//! Capture pipeline health monitor.
//!
//! Atomic counters fed by capture loops (desktop_capture, screen_capture,
//! capture_pipeline, gpu_converter). A pure-function classifier turns the
//! current snapshot into a Green / Yellow / Red health level with reasons.
//!
//! Designed for the warn-only v1 of the capture-health-monitor feature.
//! Spec: docs/superpowers/specs/2026-04-08-capture-health-monitor-design.md

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};

// ── Tunable thresholds ──────────────────────────────────────────────
// Easy to retune from one place. Phase 3 of the plan tunes these
// against real-session data.

const ROLLING_WINDOW: Duration = Duration::from_secs(300); // 5 minutes

const YELLOW_REINITS_5M: u32 = 1;
const RED_REINITS_5M: u32 = 3;

const YELLOW_CONSECUTIVE_TIMEOUTS: u32 = 5;
const RED_CONSECUTIVE_TIMEOUTS: u32 = 10;

const YELLOW_FPS_FRACTION: f32 = 0.80;
const RED_FPS_FRACTION: f32 = 0.50;

const YELLOW_SKIP_RATE_PCT: f32 = 2.0;
const RED_SKIP_RATE_PCT: f32 = 10.0;

// ── Public types ────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum HealthLevel {
    Green,
    Yellow,
    Red,
}

impl HealthLevel {
    fn rank(self) -> u8 {
        match self { HealthLevel::Green => 0, HealthLevel::Yellow => 1, HealthLevel::Red => 2 }
    }
    fn max(self, other: HealthLevel) -> HealthLevel {
        if self.rank() >= other.rank() { self } else { other }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum CaptureMode {
    #[default] None,
    Wgc,
    DxgiDd,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum EncoderType {
    #[default] None,
    Nvenc,
    OpenH264,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CaptureHealthSnapshot {
    pub level: HealthLevel,
    pub reasons: Vec<String>,
    pub capture_active: bool,
    pub capture_mode: String,        // "WGC" | "DXGI-DD" | "None"
    pub encoder_type: String,        // "NVENC" | "OpenH264" | "None"
    pub current_fps: u32,
    pub target_fps: u32,
    pub reinit_count_5m: u32,
    pub consecutive_timeouts: u32,
    pub consecutive_timeouts_max_5m: u32,
    pub encoder_skip_rate_pct: f32,
    pub shader_errors_5m: u32,
}

// ── State ───────────────────────────────────────────────────────────

pub struct CaptureHealthState {
    consecutive_timeouts: AtomicU32,
    consecutive_timeouts_max_5m: AtomicU32,
    encoder_skipped_total: AtomicU64,
    encoder_sent_total: AtomicU64,
    last_capture_fps: AtomicU32,
    target_fps: AtomicU32,
    capture_active: AtomicBool,
    capture_mode: RwLock<CaptureMode>,
    encoder_type: RwLock<EncoderType>,

    // Rolling 5-min event windows
    reinit_events: Mutex<Vec<Instant>>,
    shader_error_events: Mutex<Vec<Instant>>,
    timeout_max_events: Mutex<Vec<(Instant, u32)>>,
}

impl CaptureHealthState {
    pub fn new() -> Self {
        Self {
            consecutive_timeouts: AtomicU32::new(0),
            consecutive_timeouts_max_5m: AtomicU32::new(0),
            encoder_skipped_total: AtomicU64::new(0),
            encoder_sent_total: AtomicU64::new(0),
            last_capture_fps: AtomicU32::new(0),
            target_fps: AtomicU32::new(0),
            capture_active: AtomicBool::new(false),
            capture_mode: RwLock::new(CaptureMode::None),
            encoder_type: RwLock::new(EncoderType::None),
            reinit_events: Mutex::new(Vec::new()),
            shader_error_events: Mutex::new(Vec::new()),
            timeout_max_events: Mutex::new(Vec::new()),
        }
    }

    fn prune(events: &mut Vec<Instant>, now: Instant) {
        let cutoff = now - ROLLING_WINDOW;
        events.retain(|t| *t >= cutoff);
    }

    fn prune_pairs(events: &mut Vec<(Instant, u32)>, now: Instant) {
        let cutoff = now - ROLLING_WINDOW;
        events.retain(|(t, _)| *t >= cutoff);
    }

    pub fn record_reinit(&self) {
        let now = Instant::now();
        let mut e = self.reinit_events.lock();
        Self::prune(&mut e, now);
        e.push(now);
    }

    pub fn record_consecutive_timeout(&self, current: u32) {
        self.consecutive_timeouts.store(current, Ordering::Relaxed);
        let now = Instant::now();
        let mut e = self.timeout_max_events.lock();
        Self::prune_pairs(&mut e, now);
        e.push((now, current));
        let max = e.iter().map(|(_, n)| *n).max().unwrap_or(0);
        self.consecutive_timeouts_max_5m.store(max, Ordering::Relaxed);
    }

    pub fn reset_consecutive_timeouts(&self) {
        self.consecutive_timeouts.store(0, Ordering::Relaxed);
    }

    pub fn record_encoder_status(&self, skipped_total: u64, sent_total: u64) {
        self.encoder_skipped_total.store(skipped_total, Ordering::Relaxed);
        self.encoder_sent_total.store(sent_total, Ordering::Relaxed);
    }

    pub fn record_shader_error(&self) {
        let now = Instant::now();
        let mut e = self.shader_error_events.lock();
        Self::prune(&mut e, now);
        e.push(now);
    }

    pub fn record_capture_fps(&self, fps: u32) {
        self.last_capture_fps.store(fps, Ordering::Relaxed);
    }

    pub fn set_active(&self, active: bool, mode: CaptureMode, encoder: EncoderType, target: u32) {
        self.capture_active.store(active, Ordering::Relaxed);
        *self.capture_mode.write() = mode;
        *self.encoder_type.write() = encoder;
        self.target_fps.store(target, Ordering::Relaxed);
        if !active {
            self.last_capture_fps.store(0, Ordering::Relaxed);
            self.consecutive_timeouts.store(0, Ordering::Relaxed);
        }
    }

    pub fn snapshot(&self) -> CaptureHealthSnapshot {
        let now = Instant::now();
        let reinit_count_5m = {
            let mut e = self.reinit_events.lock();
            Self::prune(&mut e, now);
            e.len() as u32
        };
        let shader_errors_5m = {
            let mut e = self.shader_error_events.lock();
            Self::prune(&mut e, now);
            e.len() as u32
        };
        let consecutive_timeouts_max_5m = {
            let mut e = self.timeout_max_events.lock();
            Self::prune_pairs(&mut e, now);
            e.iter().map(|(_, n)| *n).max().unwrap_or(0)
        };

        let skipped = self.encoder_skipped_total.load(Ordering::Relaxed);
        let sent = self.encoder_sent_total.load(Ordering::Relaxed);
        let total = skipped + sent;
        let encoder_skip_rate_pct = if total > 0 {
            (skipped as f32 / total as f32) * 100.0
        } else { 0.0 };

        let mode = self.capture_mode.read().clone();
        let encoder = self.encoder_type.read().clone();

        let mut snap = CaptureHealthSnapshot {
            level: HealthLevel::Green,
            reasons: Vec::new(),
            capture_active: self.capture_active.load(Ordering::Relaxed),
            capture_mode: match mode {
                CaptureMode::None => "None".into(),
                CaptureMode::Wgc => "WGC".into(),
                CaptureMode::DxgiDd => "DXGI-DD".into(),
            },
            encoder_type: match encoder {
                EncoderType::None => "None".into(),
                EncoderType::Nvenc => "NVENC".into(),
                EncoderType::OpenH264 => "OpenH264".into(),
            },
            current_fps: self.last_capture_fps.load(Ordering::Relaxed),
            target_fps: self.target_fps.load(Ordering::Relaxed),
            reinit_count_5m,
            consecutive_timeouts: self.consecutive_timeouts.load(Ordering::Relaxed),
            consecutive_timeouts_max_5m,
            encoder_skip_rate_pct,
            shader_errors_5m,
        };
        let (level, reasons) = classify(&snap);
        snap.level = level;
        snap.reasons = reasons;
        snap
    }
}

// ── Classifier (pure function — see Task 1.2 for tests) ────────────

pub fn classify(snap: &CaptureHealthSnapshot) -> (HealthLevel, Vec<String>) {
    let mut level = HealthLevel::Green;
    let mut reasons: Vec<String> = Vec::new();

    if !snap.capture_active {
        // No active capture → no judgement to make. Stay Green with no reason.
        return (HealthLevel::Green, reasons);
    }

    // Reinits
    if snap.reinit_count_5m >= RED_REINITS_5M {
        level = level.max(HealthLevel::Red);
        reasons.push(format!("{} reinits in 5min (>= {})", snap.reinit_count_5m, RED_REINITS_5M));
    } else if snap.reinit_count_5m >= YELLOW_REINITS_5M {
        level = level.max(HealthLevel::Yellow);
        reasons.push(format!("{} reinit in 5min", snap.reinit_count_5m));
    }

    // Consecutive timeouts (current run)
    if snap.consecutive_timeouts >= RED_CONSECUTIVE_TIMEOUTS {
        level = level.max(HealthLevel::Red);
        reasons.push(format!("{} consecutive capture timeouts", snap.consecutive_timeouts));
    } else if snap.consecutive_timeouts >= YELLOW_CONSECUTIVE_TIMEOUTS {
        level = level.max(HealthLevel::Yellow);
        reasons.push(format!("{} consecutive capture timeouts", snap.consecutive_timeouts));
    }

    // FPS vs target
    if snap.target_fps > 0 {
        let frac = snap.current_fps as f32 / snap.target_fps as f32;
        if frac < RED_FPS_FRACTION {
            level = level.max(HealthLevel::Red);
            reasons.push(format!(
                "capture fps {}/{} ({:.0}%, < {:.0}%)",
                snap.current_fps, snap.target_fps, frac * 100.0, RED_FPS_FRACTION * 100.0
            ));
        } else if frac < YELLOW_FPS_FRACTION {
            level = level.max(HealthLevel::Yellow);
            reasons.push(format!(
                "capture fps {}/{} ({:.0}%)",
                snap.current_fps, snap.target_fps, frac * 100.0
            ));
        }
    }

    // Encoder skip rate
    if snap.encoder_skip_rate_pct >= RED_SKIP_RATE_PCT {
        level = level.max(HealthLevel::Red);
        reasons.push(format!("encoder skip rate {:.1}%", snap.encoder_skip_rate_pct));
    } else if snap.encoder_skip_rate_pct >= YELLOW_SKIP_RATE_PCT {
        level = level.max(HealthLevel::Yellow);
        reasons.push(format!("encoder skip rate {:.1}%", snap.encoder_skip_rate_pct));
    }

    // Encoder fallback to OpenH264 — automatic Red
    if snap.encoder_type == "OpenH264" {
        level = level.max(HealthLevel::Red);
        reasons.push("encoder fell back to OpenH264".to_string());
    }

    // Shader errors — automatic Red
    if snap.shader_errors_5m > 0 {
        level = level.max(HealthLevel::Red);
        reasons.push(format!("{} shader error(s) in 5min", snap.shader_errors_5m));
    }

    (level, reasons)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nominal() -> CaptureHealthSnapshot {
        CaptureHealthSnapshot {
            level: HealthLevel::Green,
            reasons: vec![],
            capture_active: true,
            capture_mode: "DXGI-DD".into(),
            encoder_type: "NVENC".into(),
            current_fps: 60,
            target_fps: 60,
            reinit_count_5m: 0,
            consecutive_timeouts: 0,
            consecutive_timeouts_max_5m: 0,
            encoder_skip_rate_pct: 0.0,
            shader_errors_5m: 0,
        }
    }

    #[test]
    fn nominal_is_green() {
        let (lvl, reasons) = classify(&nominal());
        assert_eq!(lvl, HealthLevel::Green);
        assert!(reasons.is_empty());
    }

    #[test]
    fn inactive_capture_is_always_green() {
        let mut s = nominal();
        s.capture_active = false;
        s.reinit_count_5m = 99;
        s.encoder_type = "OpenH264".into();
        let (lvl, reasons) = classify(&s);
        assert_eq!(lvl, HealthLevel::Green);
        assert!(reasons.is_empty());
    }

    #[test]
    fn one_reinit_is_yellow() {
        let mut s = nominal();
        s.reinit_count_5m = 1;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Yellow);
    }

    #[test]
    fn three_reinits_is_red() {
        let mut s = nominal();
        s.reinit_count_5m = 3;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn five_consecutive_timeouts_is_yellow() {
        let mut s = nominal();
        s.consecutive_timeouts = 5;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Yellow);
    }

    #[test]
    fn ten_consecutive_timeouts_is_red() {
        let mut s = nominal();
        s.consecutive_timeouts = 10;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn fps_47_of_60_is_yellow() {
        let mut s = nominal();
        s.current_fps = 47;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Yellow);
    }

    #[test]
    fn fps_28_of_60_is_red() {
        let mut s = nominal();
        s.current_fps = 28;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn openh264_fallback_is_always_red() {
        let mut s = nominal();
        s.encoder_type = "OpenH264".into();
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn shader_error_is_red() {
        let mut s = nominal();
        s.shader_errors_5m = 1;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn skip_rate_3pct_is_yellow() {
        let mut s = nominal();
        s.encoder_skip_rate_pct = 3.0;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Yellow);
    }

    #[test]
    fn skip_rate_15pct_is_red() {
        let mut s = nominal();
        s.encoder_skip_rate_pct = 15.0;
        let (lvl, _) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
    }

    #[test]
    fn multiple_signals_take_max_level_and_list_all_reasons() {
        let mut s = nominal();
        s.reinit_count_5m = 1;             // yellow
        s.consecutive_timeouts = 10;       // red
        s.encoder_skip_rate_pct = 3.0;     // yellow
        let (lvl, reasons) = classify(&s);
        assert_eq!(lvl, HealthLevel::Red);
        assert!(reasons.len() >= 3);
    }
}
