export const NOISE_GATE_THRESHOLDS = [0, 0.006, 0.012] as const;

export type RnnoiseSuppressionLevel = 0 | 1 | 2;

type AudioContextFactory = (sampleRate: number) => AudioContext;

type FetchFn = typeof fetch;

export type RnnoiseEnableOptions = {
  workletUrl?: string;
  wasmUrl?: string;
  wasmSimdUrl?: string;
  suppressionLevel?: RnnoiseSuppressionLevel;
  detectSimdSupportFn?: () => Promise<boolean>;
  fetchFn?: FetchFn;
  createAudioContext?: AudioContextFactory;
  logger?: (message: string) => void;
};

type RnnoiseNode = AudioWorkletNode & {
  parameters: AudioParamMap;
};

const DEFAULT_WORKLET_URL = '/rnnoise-processor.js';
const DEFAULT_WASM_SIMD_URL = '/rnnoise.wasm.simd.wasm';
const DEFAULT_WASM_URL = '/rnnoise.wasm';

export class RnnoiseMicProcessor {
  private context: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;
  private rnnoiseNode: RnnoiseNode | null = null;

  private originalTrack: MediaStreamTrack | null = null;
  private replacementTrack: MediaStreamTrack | null = null;
  private sender: RTCRtpSender | null = null;

  private suppressionLevel: RnnoiseSuppressionLevel = 2;
  private gateTimer: ReturnType<typeof setInterval> | null = null;

  isEnabled() {
    return Boolean(this.replacementTrack);
  }

  setSuppressionLevel(level: RnnoiseSuppressionLevel) {
    this.suppressionLevel = level;

    if (this.rnnoiseNode) {
      this.rnnoiseNode.parameters.get('vadThreshold')?.setValueAtTime(NOISE_GATE_THRESHOLDS[level], this.context?.currentTime ?? 0);
    }

    this.stopNoiseGate();
    this.startNoiseGate();
  }

  async enableForSender(
    sender: RTCRtpSender | null | undefined,
    sourceTrack: MediaStreamTrack | null | undefined,
    options: RnnoiseEnableOptions = {},
  ) {
    if (!sender || !sourceTrack) {
      return;
    }

    await this.disable();

    const fetchFn = options.fetchFn ?? fetch;
    const detectSimdSupportFn = options.detectSimdSupportFn ?? detectSimdSupport;
    const createAudioContext = options.createAudioContext ?? ((sampleRate: number) => new AudioContext({ sampleRate }));
    const logger = options.logger;

    const sampleRate = Number(sourceTrack.getSettings?.().sampleRate ?? 48_000) || 48_000;

    const context = createAudioContext(sampleRate);
    if (!context.audioWorklet) {
      context.close().catch(() => undefined);
      throw new Error('RNNoise parity unavailable: audioWorklet unsupported');
    }

    await context.audioWorklet.addModule(options.workletUrl ?? DEFAULT_WORKLET_URL);

    const hasSimd = await detectSimdSupportFn();
    const wasmPath = hasSimd ? (options.wasmSimdUrl ?? DEFAULT_WASM_SIMD_URL) : (options.wasmUrl ?? DEFAULT_WASM_URL);
    const wasmResponse = await fetchFn(wasmPath);
    const wasmBuffer = await wasmResponse.arrayBuffer();

    const stream = new MediaStream([sourceTrack]);
    const sourceNode = context.createMediaStreamSource(stream);
    const destinationNode = context.createMediaStreamDestination();
    const analyserNode = context.createAnalyser();
    const gainNode = context.createGain();

    analyserNode.fftSize = 512;
    analyserNode.smoothingTimeConstant = 0.1;

    const rnnoiseNode = new AudioWorkletNode(context, 'rnnoise-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        wasmBuffer,
      },
    }) as RnnoiseNode;

    sourceNode.connect(rnnoiseNode);
    rnnoiseNode.connect(analyserNode);
    analyserNode.connect(gainNode);
    gainNode.connect(destinationNode);

    const replacementTrack = destinationNode.stream.getAudioTracks()[0];
    if (!replacementTrack) {
      context.close().catch(() => undefined);
      throw new Error('RNNoise parity unavailable: no processed audio track produced');
    }

    await sender.replaceTrack(replacementTrack);

    this.context = context;
    this.sourceNode = sourceNode;
    this.destinationNode = destinationNode;
    this.analyserNode = analyserNode;
    this.gainNode = gainNode;
    this.rnnoiseNode = rnnoiseNode;

    this.originalTrack = sourceTrack;
    this.replacementTrack = replacementTrack;
    this.sender = sender;

    this.setSuppressionLevel(options.suppressionLevel ?? 2);

    logger?.(`[rnnoise] enabled (${hasSimd ? 'simd' : 'scalar'}) sampleRate=${sampleRate}`);
  }

  async disable() {
    this.stopNoiseGate();

    if (this.sender && this.originalTrack) {
      try {
        await this.sender.replaceTrack(this.originalTrack);
      } catch {
        // best effort restore
      }
    }

    try {
      this.rnnoiseNode?.disconnect();
      this.sourceNode?.disconnect();
      this.analyserNode?.disconnect();
      this.gainNode?.disconnect();
      this.destinationNode?.disconnect();
    } catch {
      // ignore disconnect errors
    }

    try {
      this.replacementTrack?.stop();
    } catch {
      // ignore stop errors
    }

    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // ignore close errors
      }
    }

    this.context = null;
    this.sourceNode = null;
    this.destinationNode = null;
    this.analyserNode = null;
    this.gainNode = null;
    this.rnnoiseNode = null;
    this.originalTrack = null;
    this.replacementTrack = null;
    this.sender = null;
  }

  private startNoiseGate() {
    if (!this.gainNode || !this.analyserNode || this.suppressionLevel === 0) {
      if (this.gainNode) this.gainNode.gain.value = 1;
      return;
    }

    const threshold = NOISE_GATE_THRESHOLDS[this.suppressionLevel];
    const bins = new Uint8Array(this.analyserNode.frequencyBinCount);

    this.gateTimer = setInterval(() => {
      if (!this.analyserNode || !this.gainNode || !this.context) return;

      this.analyserNode.getByteFrequencyData(bins);
      let sum = 0;
      for (let index = 0; index < bins.length; index += 1) {
        sum += bins[index];
      }

      const level = (sum / bins.length) / 255;
      const shouldOpen = level >= threshold;
      const nextGain = shouldOpen ? 1 : 0;
      this.gainNode.gain.setTargetAtTime(nextGain, this.context.currentTime, 0.01);
    }, 50);
  }

  private stopNoiseGate() {
    if (this.gateTimer) {
      clearInterval(this.gateTimer);
      this.gateTimer = null;
    }

    if (this.gainNode) {
      this.gainNode.gain.value = 1;
    }
  }
}

export async function detectSimdSupport() {
  const moduleBytes = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96,
    0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
    65, 0, 253, 15, 11,
  ]);

  try {
    const module = await WebAssembly.compile(moduleBytes);
    return Boolean(module);
  } catch {
    return false;
  }
}
