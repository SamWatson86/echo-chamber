type AudioContextWithSink = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

type GainRef = {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
};

export class ParticipantVolumeBoostManager {
  private readonly gainNodes = new Map<HTMLMediaElement, GainRef>();
  private audioContext: AudioContextWithSink | null = null;

  constructor(
    private readonly contextFactory: () => AudioContextWithSink = () => new AudioContext() as AudioContextWithSink,
  ) {}

  hasGainNode(element: HTMLMediaElement) {
    return this.gainNodes.has(element);
  }

  applyVolume(element: HTMLMediaElement, volume: number, muted = false) {
    const targetVolume = muted ? 0 : clamp(volume, 0, 3);
    const gainRef = this.gainNodes.get(element);

    if (targetVolume > 1) {
      const boostNode = gainRef ?? this.ensureGainNode(element);
      if (boostNode) {
        boostNode.gain.gain.value = targetVolume;
        element.volume = 0;
        element.muted = false;
        return;
      }
    }

    if (gainRef) {
      gainRef.gain.gain.value = targetVolume;
      element.volume = 0;
      element.muted = false;
      return;
    }

    element.volume = Math.min(1, targetVolume);
    element.muted = false;
  }

  async setSinkId(sinkId: string) {
    if (!sinkId) return;

    const context = this.getAudioContext();
    const setSinkId = context.setSinkId;
    if (typeof setSinkId !== 'function') return;

    try {
      await setSinkId.call(context, sinkId);
    } catch {
      // best effort only
    }
  }

  cleanup(element: HTMLMediaElement) {
    const gainRef = this.gainNodes.get(element);
    if (!gainRef) return;

    try {
      gainRef.source.disconnect();
      gainRef.gain.disconnect();
    } catch {
      // ignore
    }

    this.gainNodes.delete(element);
  }

  cleanupAll() {
    this.gainNodes.forEach((_value, element) => this.cleanup(element));

    if (this.audioContext) {
      const context = this.audioContext;
      this.audioContext = null;
      void context.close().catch(() => undefined);
    }
  }

  private ensureGainNode(element: HTMLMediaElement) {
    if (this.gainNodes.has(element)) {
      return this.gainNodes.get(element) ?? null;
    }

    if (!element.srcObject) {
      return null;
    }

    try {
      const context = this.getAudioContext();
      const source = context.createMediaStreamSource(element.srcObject as MediaStream);
      const gain = context.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(context.destination);

      const ref: GainRef = { source, gain };
      this.gainNodes.set(element, ref);
      element.volume = 0;
      element.muted = false;
      return ref;
    } catch {
      return null;
    }
  }

  private getAudioContext() {
    if (!this.audioContext) {
      this.audioContext = this.contextFactory();
    }

    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume().catch(() => undefined);
    }

    return this.audioContext;
  }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
