type CameraPublicationLike = {
  setSubscribed?: (value: boolean) => void;
  videoTrack?: { requestKeyFrame?: () => void } | null;
};

type CameraTrackLike = {
  requestKeyFrame?: () => void;
};

export type CameraRecoveryState = {
  mountedAtMs: number;
  firstFrameAtMs: number;
  lastFrameAtMs: number;
  lastKeyframeRequestAtMs: number;
  lastResubscribeAtMs: number;
  recoveryCount: number;
  consecutiveBlackTicks: number;
};

export type CameraRecoverySample = {
  nowMs: number;
  hasVideoSize: boolean;
  isBlackFrame: boolean;
};

export type CameraRecoveryDecision = {
  shouldRequestKeyframe: boolean;
  shouldResubscribe: boolean;
  reason: string | null;
};

export const CAMERA_RECOVERY_DEFAULTS = {
  monitorIntervalMs: 800,
  stallThresholdMs: 1_200,
  keyframeCooldownMs: 1_500,
  resubscribeCooldownMs: 8_000,
  forceResubscribeAfterMs: 12_000,
  maxRecoveryAttempts: 3,
  blackTickThreshold: 2,
} as const;

export function evaluateCameraRecovery(
  state: CameraRecoveryState,
  sample: CameraRecoverySample,
): CameraRecoveryDecision {
  const ageSinceFrame = sample.nowMs - state.lastFrameAtMs;
  const ageSinceMount = sample.nowMs - state.mountedAtMs;
  const stalled = state.lastFrameAtMs > 0 ? ageSinceFrame > CAMERA_RECOVERY_DEFAULTS.stallThresholdMs : ageSinceMount > 2_000;

  const blackTickCount = sample.isBlackFrame ? state.consecutiveBlackTicks : 0;
  const blackAndStalled = stalled && sample.hasVideoSize && blackTickCount >= CAMERA_RECOVERY_DEFAULTS.blackTickThreshold;
  const noFramesYet = state.firstFrameAtMs <= 0;
  const noFramesTooLong = noFramesYet && ageSinceMount > 2_500;

  const canKeyframe =
    sample.nowMs - state.lastKeyframeRequestAtMs >= CAMERA_RECOVERY_DEFAULTS.keyframeCooldownMs;
  const canResubscribe =
    sample.nowMs - state.lastResubscribeAtMs >= CAMERA_RECOVERY_DEFAULTS.resubscribeCooldownMs &&
    state.recoveryCount < CAMERA_RECOVERY_DEFAULTS.maxRecoveryAttempts;

  if ((blackAndStalled || noFramesTooLong || stalled) && canKeyframe) {
    const reason = blackAndStalled ? 'black-stall-keyframe' : noFramesTooLong ? 'no-frame-keyframe' : 'stall-keyframe';
    const severeStall = ageSinceFrame > CAMERA_RECOVERY_DEFAULTS.forceResubscribeAfterMs || blackAndStalled || noFramesTooLong;

    return {
      shouldRequestKeyframe: true,
      shouldResubscribe: severeStall && canResubscribe,
      reason,
    };
  }

  if ((blackAndStalled || noFramesTooLong) && canResubscribe) {
    return {
      shouldRequestKeyframe: false,
      shouldResubscribe: true,
      reason: blackAndStalled ? 'black-stall-resubscribe' : 'no-frame-resubscribe',
    };
  }

  return {
    shouldRequestKeyframe: false,
    shouldResubscribe: false,
    reason: null,
  };
}

export type AttachCameraRecoveryInput = {
  key: string;
  video: HTMLVideoElement;
  publication?: CameraPublicationLike | null;
  track?: CameraTrackLike | null;
  onDebug?: (text: string) => void;
};

function detectMostlyBlack(video: HTMLVideoElement): boolean {
  try {
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return false;
    const sampleSize = 8;
    const canvas = document.createElement('canvas');
    canvas.width = sampleSize;
    canvas.height = sampleSize;
    const ctx = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, sampleSize, sampleSize);
    const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;

    let dark = 0;
    const pixels = sampleSize * sampleSize;
    for (let i = 0; i < data.length; i += 4) {
      const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (luminance < 10) dark += 1;
    }

    return dark / pixels >= 0.97;
  } catch {
    return false;
  }
}

export class CameraRecoveryMonitor {
  private readonly stateByKey = new Map<string, CameraRecoveryState>();

  private readonly timerByKey = new Map<string, number>();

  attach(input: AttachCameraRecoveryInput): () => void {
    const { key, video, publication, track, onDebug } = input;
    if (!key || !video) return () => undefined;

    this.detach(key);

    const now = performance.now();
    const state: CameraRecoveryState = {
      mountedAtMs: now,
      firstFrameAtMs: 0,
      lastFrameAtMs: 0,
      lastKeyframeRequestAtMs: 0,
      lastResubscribeAtMs: 0,
      recoveryCount: 0,
      consecutiveBlackTicks: 0,
    };
    this.stateByKey.set(key, state);

    const markFrame = () => {
      const ts = performance.now();
      if (!state.firstFrameAtMs) state.firstFrameAtMs = ts;
      state.lastFrameAtMs = ts;
    };

    const rvfcVideo = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };

    let rvfcHandle: number | null = null;
    let rvfcStopped = false;
    if (typeof rvfcVideo.requestVideoFrameCallback === 'function') {
      const loop = () => {
        if (rvfcStopped) return;
        markFrame();
        rvfcHandle = rvfcVideo.requestVideoFrameCallback?.(loop) ?? null;
      };
      rvfcHandle = rvfcVideo.requestVideoFrameCallback(loop);
    }

    const timer = window.setInterval(() => {
      const nowMs = performance.now();
      const hasVideoSize = video.videoWidth > 0 && video.videoHeight > 0;
      const sampledBlack = hasVideoSize ? detectMostlyBlack(video) : false;
      const isBlackFrame = Boolean((video as HTMLVideoElement & { _isBlack?: boolean })._isBlack) || sampledBlack;
      (video as HTMLVideoElement & { _isBlack?: boolean })._isBlack = isBlackFrame;
      if (!isBlackFrame && hasVideoSize && !video.paused) {
        markFrame();
      }

      state.consecutiveBlackTicks = isBlackFrame ? state.consecutiveBlackTicks + 1 : 0;

      const decision = evaluateCameraRecovery(state, {
        nowMs,
        hasVideoSize,
        isBlackFrame,
      });

      if (decision.shouldRequestKeyframe) {
        const candidateTrack = publication?.videoTrack ?? track;
        if (typeof candidateTrack?.requestKeyFrame === 'function') {
          candidateTrack.requestKeyFrame();
          state.lastKeyframeRequestAtMs = nowMs;
          onDebug?.(`[camera-recovery] ${key}: ${decision.reason}`);
        }
      }

      if (decision.shouldResubscribe && typeof publication?.setSubscribed === 'function') {
        publication.setSubscribed(false);
        window.setTimeout(() => {
          publication.setSubscribed?.(true);
        }, 300);
        state.lastResubscribeAtMs = nowMs;
        state.recoveryCount += 1;
        onDebug?.(`[camera-recovery] ${key}: resubscribe (${decision.reason ?? 'unknown'})`);
      }

      if (!isBlackFrame && state.lastFrameAtMs > 0) {
        state.recoveryCount = 0;
      }
    }, CAMERA_RECOVERY_DEFAULTS.monitorIntervalMs);

    this.timerByKey.set(key, timer);

    return () => {
      this.detach(key);
      rvfcStopped = true;
      if (rvfcHandle != null && typeof rvfcVideo.cancelVideoFrameCallback === 'function') {
        rvfcVideo.cancelVideoFrameCallback(rvfcHandle);
      }
    };
  }

  detach(key: string): void {
    const timer = this.timerByKey.get(key);
    if (timer != null) {
      window.clearInterval(timer);
      this.timerByKey.delete(key);
    }
    this.stateByKey.delete(key);
  }

  reset(): void {
    Array.from(this.timerByKey.keys()).forEach((key) => this.detach(key));
  }
}
