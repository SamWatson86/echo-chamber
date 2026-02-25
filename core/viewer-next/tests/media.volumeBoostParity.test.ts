import { describe, expect, it, vi } from 'vitest';
import { ParticipantVolumeBoostManager } from '@/features/media/participantVolumeBoost';

describe('participant volume boost parity', () => {
  it('uses gain pipeline when volume exceeds 100%', () => {
    const gainNode = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as GainNode;

    const sourceNode = {
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaStreamAudioSourceNode;

    const context = {
      state: 'running',
      destination: {},
      createGain: vi.fn(() => gainNode),
      createMediaStreamSource: vi.fn(() => sourceNode),
      resume: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as AudioContext;

    const manager = new ParticipantVolumeBoostManager(() => context as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> });

    const audio = document.createElement('audio');
    audio.srcObject = ({}) as MediaStream;

    manager.applyVolume(audio, 2.2, false);

    expect(manager.hasGainNode(audio)).toBe(true);
    expect(gainNode.gain.value).toBe(2.2);
    expect(audio.volume).toBe(0);

    manager.cleanup(audio);
    expect(manager.hasGainNode(audio)).toBe(false);
  });

  it('falls back to element volume for <=100%', () => {
    const manager = new ParticipantVolumeBoostManager(() => {
      throw new Error('should not build context for <=100%');
    });

    const audio = document.createElement('audio');
    manager.applyVolume(audio, 0.65, false);

    expect(audio.volume).toBeCloseTo(0.65, 3);
    expect(manager.hasGainNode(audio)).toBe(false);
  });
});
