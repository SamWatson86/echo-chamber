import {
  BITRATE_DEFAULT_HIGH,
  BITRATE_DEFAULT_LOW,
  BITRATE_DEFAULT_MED,
} from '@/features/media/screenShareParity';

export type OutboundLayerSnapshot = {
  rid: string;
  fps: number;
  limit: string;
};

export type BweSample = {
  bweKbps: number | null;
  totalSendKbps: number;
  layers: OutboundLayerSnapshot[];
};

export type BweActionKind = 'kick' | 'rescue' | 'hard-rescue' | 'restore-low';

export type BweAction = {
  kind: BweActionKind;
  highBps: number;
  medBps: number;
  lowBps: number;
};

export type BweCaps = {
  high: number;
  med: number;
  low: number;
} | null;

export class BweWatchdog {
  private bweLowTicks = 0;
  private bweKickAttempted = false;
  private highPausedTicks = 0;
  private lowLayerDisabled = false;
  private lowRestoreChecks = 0;

  reset() {
    this.bweLowTicks = 0;
    this.bweKickAttempted = false;
    this.highPausedTicks = 0;
    this.lowLayerDisabled = false;
    this.lowRestoreChecks = 0;
  }

  evaluate(sample: BweSample, caps: BweCaps): BweAction[] {
    const actions: BweAction[] = [];
    const applied = caps ?? {
      high: BITRATE_DEFAULT_HIGH,
      med: BITRATE_DEFAULT_MED,
      low: BITRATE_DEFAULT_LOW,
    };

    const bwe = sample.bweKbps;
    const total = sample.totalSendKbps;

    if (!this.bweKickAttempted && bwe != null && bwe < 2000 && total < 1000) {
      this.bweLowTicks += 1;
      if (this.bweLowTicks >= 5) {
        this.bweKickAttempted = true;
        actions.push({ kind: 'kick', highBps: applied.high, medBps: applied.med, lowBps: applied.low });
      }
    } else {
      this.bweLowTicks = Math.max(0, this.bweLowTicks - 1);
    }

    const highLayer = sample.layers.find((layer) => layer.rid === 'f' || layer.rid === 'single') ?? sample.layers[0];
    const highPaused = Boolean(highLayer) && highLayer.fps === 0 && highLayer.limit === 'bandwidth' && sample.layers.length > 1;

    if (highPaused) {
      this.highPausedTicks += 1;
    } else {
      this.highPausedTicks = 0;
    }

    if (this.highPausedTicks === 3) {
      this.lowLayerDisabled = true;
      this.lowRestoreChecks = 0;
      actions.push({ kind: 'rescue', highBps: applied.high, medBps: applied.med, lowBps: applied.low });
    }

    if (this.highPausedTicks === 15) {
      actions.push({ kind: 'hard-rescue', highBps: applied.high, medBps: applied.med, lowBps: applied.low });
      this.highPausedTicks = 0;
    }

    if (this.lowLayerDisabled) {
      this.lowRestoreChecks += 1;
      if ((bwe ?? 0) >= 10_000 || this.lowRestoreChecks >= 10) {
        this.lowLayerDisabled = false;
        this.lowRestoreChecks = 0;
        actions.push({ kind: 'restore-low', highBps: applied.high, medBps: applied.med, lowBps: applied.low });
      }
    }

    return actions;
  }
}

export type SenderLike = {
  getParameters: () => RTCRtpSendParameters;
  setParameters: (params: RTCRtpSendParameters) => Promise<void>;
};

export async function applyBweActionToSender(sender: SenderLike, action: BweAction) {
  try {
    const params = sender.getParameters();
    const encodings = params.encodings;
    if (!encodings || encodings.length === 0) return;

    if (action.kind === 'kick') {
      encodings.forEach((encoding) => {
        if (encoding.rid === 'f' || (!encoding.rid && encodings.length === 1)) {
          encoding.maxBitrate = action.highBps;
        } else if (encoding.rid === 'h') {
          encoding.maxBitrate = action.medBps;
        } else if (encoding.rid === 'q') {
          encoding.maxBitrate = action.lowBps;
        }
      });
      await sender.setParameters(params);
      return;
    }

    if (action.kind === 'rescue') {
      encodings.forEach((encoding) => {
        if (encoding.rid === 'q') {
          encoding.active = false;
        }
        if (encoding.rid === 'f' || (!encoding.rid && encodings.length === 1)) {
          encoding.active = true;
          encoding.maxBitrate = action.highBps;
        }
      });
      await sender.setParameters(params);
      return;
    }

    if (action.kind === 'hard-rescue') {
      encodings.forEach((encoding) => {
        encoding.active = true;
        if (encoding.rid === 'f' || (!encoding.rid && encodings.length === 1)) {
          encoding.maxBitrate = action.highBps;
          encoding.maxFramerate = 60;
        } else if (encoding.rid === 'h') {
          encoding.maxBitrate = action.medBps;
          encoding.maxFramerate = 60;
        } else if (encoding.rid === 'q') {
          encoding.maxBitrate = action.lowBps;
          encoding.maxFramerate = 30;
        }
      });
      await sender.setParameters(params);
      return;
    }

    if (action.kind === 'restore-low') {
      encodings.forEach((encoding) => {
        if (encoding.rid === 'q') {
          encoding.active = true;
          encoding.maxBitrate = action.lowBps;
        }
      });
      await sender.setParameters(params);
    }
  } catch {
    // best effort only
  }
}
