import { describe, expect, it, vi } from 'vitest';
import { RnnoiseMicProcessor, detectSimdSupport } from '@/features/media/rnnoiseParity';

describe('RNNoise mic parity path', () => {
  it('no-ops safely when sender or source track is missing', async () => {
    const processor = new RnnoiseMicProcessor();

    await expect(processor.enableForSender(null, null)).resolves.toBeUndefined();
    expect(processor.isEnabled()).toBe(false);

    await expect(processor.disable()).resolves.toBeUndefined();
  });

  it('runs enable/disable with mocked audio graph and restores track', async () => {
    const replaceTrack = vi.fn(async () => undefined);
    const sender = {
      replaceTrack,
    } as unknown as RTCRtpSender;

    const sourceTrack = {
      kind: 'audio',
      getSettings: () => ({ sampleRate: 48_000 }),
    } as MediaStreamTrack;

    const gainNode = {
      gain: {
        value: 1,
        setTargetAtTime: vi.fn(),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as GainNode;

    const analyserNode = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 8,
      getByteFrequencyData: vi.fn((buffer: Uint8Array) => buffer.fill(0)),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as AnalyserNode;

    const sourceNode = { connect: vi.fn(), disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode;
    const destinationTrack = { kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack;
    const destinationNode = {
      stream: { getAudioTracks: () => [destinationTrack] } as unknown as MediaStream,
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as MediaStreamAudioDestinationNode;

    const rnnoiseNode = {
      parameters: new Map([
        ['vadThreshold', { setValueAtTime: vi.fn() }],
      ]) as unknown as AudioParamMap,
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as AudioWorkletNode;

    const context = {
      audioWorklet: { addModule: vi.fn(async () => undefined) },
      currentTime: 0,
      createMediaStreamSource: vi.fn(() => sourceNode),
      createMediaStreamDestination: vi.fn(() => destinationNode),
      createAnalyser: vi.fn(() => analyserNode),
      createGain: vi.fn(() => gainNode),
      close: vi.fn(async () => undefined),
    } as unknown as AudioContext;

    const originalAudioWorkletNode = globalThis.AudioWorkletNode;
    (globalThis as unknown as { AudioWorkletNode: typeof AudioWorkletNode }).AudioWorkletNode =
      vi.fn(() => rnnoiseNode) as unknown as typeof AudioWorkletNode;

    const OriginalMediaStream = globalThis.MediaStream;
    (globalThis as unknown as { MediaStream: typeof MediaStream }).MediaStream = class {
      constructor(public readonly tracks: MediaStreamTrack[]) {}
      getAudioTracks() {
        return this.tracks;
      }
    } as unknown as typeof MediaStream;

    const processor = new RnnoiseMicProcessor();

    await processor.enableForSender(sender, sourceTrack, {
      detectSimdSupportFn: async () => false,
      fetchFn: async () =>
        ({
          arrayBuffer: async () => new ArrayBuffer(16),
        } as Response),
      createAudioContext: () => context,
      suppressionLevel: 1,
    });

    expect(processor.isEnabled()).toBe(true);
    expect(replaceTrack).toHaveBeenCalled();

    await processor.disable();
    expect(processor.isEnabled()).toBe(false);

    (globalThis as unknown as { AudioWorkletNode: typeof AudioWorkletNode }).AudioWorkletNode =
      originalAudioWorkletNode;
    (globalThis as unknown as { MediaStream: typeof MediaStream }).MediaStream = OriginalMediaStream;
  });

  it('exposes SIMD detection helper', async () => {
    const result = await detectSimdSupport();
    expect(typeof result).toBe('boolean');
  });
});
