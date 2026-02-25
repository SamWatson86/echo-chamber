import { describe, expect, it } from 'vitest';
import {
  CAMERA_RECOVERY_DEFAULTS,
  evaluateCameraRecovery,
  type CameraRecoveryState,
} from '@/features/media/cameraRecoveryParity';

function baseState(overrides?: Partial<CameraRecoveryState>): CameraRecoveryState {
  return {
    mountedAtMs: 0,
    firstFrameAtMs: 100,
    lastFrameAtMs: 100,
    lastKeyframeRequestAtMs: 0,
    lastResubscribeAtMs: 0,
    recoveryCount: 0,
    consecutiveBlackTicks: 0,
    ...overrides,
  };
}

describe('camera black-frame/stall recovery parity policy', () => {
  it('requests keyframe on stalled camera stream', () => {
    const state = baseState({
      lastFrameAtMs: 100,
      lastKeyframeRequestAtMs: 0,
    });

    const decision = evaluateCameraRecovery(state, {
      nowMs: 2_000,
      hasVideoSize: true,
      isBlackFrame: false,
    });

    expect(decision.shouldRequestKeyframe).toBe(true);
    expect(decision.reason).toBe('stall-keyframe');
  });

  it('escalates to resubscribe on persistent black stalled frames', () => {
    const state = baseState({
      lastFrameAtMs: 100,
      lastKeyframeRequestAtMs: 0,
      lastResubscribeAtMs: 0,
      consecutiveBlackTicks: CAMERA_RECOVERY_DEFAULTS.blackTickThreshold,
    });

    const decision = evaluateCameraRecovery(state, {
      nowMs: 9_000,
      hasVideoSize: true,
      isBlackFrame: true,
    });

    expect(decision.shouldRequestKeyframe).toBe(true);
    expect(decision.shouldResubscribe).toBe(true);
    expect(decision.reason).toBe('black-stall-keyframe');
  });

  it('throttles repeated recovery attempts via cooldowns and max attempt cap', () => {
    const state = baseState({
      lastFrameAtMs: 100,
      lastKeyframeRequestAtMs: 1_900,
      lastResubscribeAtMs: 1_900,
      recoveryCount: CAMERA_RECOVERY_DEFAULTS.maxRecoveryAttempts,
      consecutiveBlackTicks: CAMERA_RECOVERY_DEFAULTS.blackTickThreshold,
    });

    const decision = evaluateCameraRecovery(state, {
      nowMs: 2_000,
      hasVideoSize: true,
      isBlackFrame: true,
    });

    expect(decision.shouldRequestKeyframe).toBe(false);
    expect(decision.shouldResubscribe).toBe(false);
    expect(decision.reason).toBeNull();
  });
});
