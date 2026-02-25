import {
  BITRATE_DEFAULT_HIGH,
  BITRATE_DEFAULT_LOW,
  BITRATE_DEFAULT_MED,
} from '@/features/media/screenShareParity';

export type BitrateCapReason =
  | 'congestion'
  | 'severe'
  | 'probe'
  | 'hold'
  | 'restore'
  | 'unknown';

export type BitrateCapMessage = {
  type: 'bitrate-cap';
  version: 1;
  targetBitrateHigh: number;
  targetBitrateMed: number;
  targetBitrateLow: number;
  reason: BitrateCapReason;
  lossRate: number;
  senderIdentity: string;
};

export type BitrateCapAckMessage = {
  type: 'bitrate-cap-ack';
  version: 1;
  appliedBitrateHigh: number;
  identity: string;
};

export type AimdProbePhase = 'idle' | 'backing-off' | 'probing';

type ReceiverControllerState = {
  lossHistory: number[];
  kbpsHistory: number[];
  currentCapHigh: number;
  capped: boolean;
  probePhase: AimdProbePhase;
  probeBitrate: number;
  probeCleanTicks: number;
  lastCapSendTime: number;
  lastLossTime: number;
  cleanTicksSinceLoss: number;
  ackReceived: boolean;
  firstCapSendTime: number;
  fallbackToLayers: boolean;
};

export type ReceiverAimdInput = {
  deltaLost: number;
  receivedKbps: number;
  localIdentity: string;
  nowMs?: number;
};

export type ReceiverAimdResult = {
  outboundMessage: BitrateCapMessage | null;
  lockHighLayer: boolean;
  fallbackToLayers: boolean;
  currentCapHigh: number;
  capped: boolean;
};

export class ReceiverAimdController {
  private readonly state: ReceiverControllerState = {
    lossHistory: [],
    kbpsHistory: [],
    currentCapHigh: BITRATE_DEFAULT_HIGH,
    capped: false,
    probePhase: 'idle',
    probeBitrate: 0,
    probeCleanTicks: 0,
    lastCapSendTime: 0,
    lastLossTime: 0,
    cleanTicksSinceLoss: 0,
    ackReceived: false,
    firstCapSendTime: 0,
    fallbackToLayers: false,
  };

  markAckReceived() {
    this.state.ackReceived = true;
  }

  update(input: ReceiverAimdInput): ReceiverAimdResult {
    const now = input.nowMs ?? Date.now();
    const deltaLost = Math.max(0, input.deltaLost);
    const kbps = Math.max(0, input.receivedKbps);

    this.state.lossHistory.push(deltaLost);
    if (this.state.lossHistory.length > 10) this.state.lossHistory.shift();

    this.state.kbpsHistory.push(kbps);
    if (this.state.kbpsHistory.length > 10) this.state.kbpsHistory.shift();

    const ewmaLoss = calculateLossEwma(this.state.lossHistory);
    const avgKbps = average(this.state.kbpsHistory);

    let lossRate = 0;
    if (avgKbps > 0 && ewmaLoss > 0) {
      const estTotalPkts = (avgKbps * 1000 / 8 / 1200) * 3 + ewmaLoss;
      lossRate = ewmaLoss / Math.max(1, estTotalPkts);
    }

    const estPktsPerTick = Math.max(100, (avgKbps * 1000 / 8 / 1200) * 3);
    const tickLossRate = deltaLost / estPktsPerTick;
    const congestion = tickLossRate > 0.005;
    const severeCongestion = tickLossRate > 0.02;

    let targetHigh = this.state.currentCapHigh;

    if (congestion) {
      this.state.lastLossTime = now;
      this.state.cleanTicksSinceLoss = 0;
      this.state.probePhase = 'backing-off';
      this.state.probeCleanTicks = 0;

      if (!this.state.capped) {
        targetHigh = Math.round(avgKbps * 1000 * 0.7);
      } else {
        targetHigh = Math.round(this.state.currentCapHigh * 0.7);
      }

      if (severeCongestion) {
        targetHigh = Math.round(avgKbps * 1000 * 0.5);
      }

      targetHigh = clamp(targetHigh, 1_000_000, BITRATE_DEFAULT_HIGH);
      this.state.currentCapHigh = targetHigh;
      this.state.capped = true;
    } else {
      this.state.cleanTicksSinceLoss += 1;

      if (this.state.capped && this.state.cleanTicksSinceLoss === 1 && this.state.probePhase === 'backing-off') {
        this.resetToDefaultBitrate();
      } else if (this.state.capped && this.state.cleanTicksSinceLoss >= 3) {
        this.resetToDefaultBitrate();
      } else if (
        this.state.capped
        && this.state.probePhase === 'backing-off'
        && this.state.cleanTicksSinceLoss >= 2
      ) {
        this.state.probePhase = 'probing';
        this.state.probeCleanTicks = 0;
        this.state.probeBitrate = Math.min(this.state.currentCapHigh + 3_000_000, BITRATE_DEFAULT_HIGH);
        this.state.currentCapHigh = this.state.probeBitrate;
      } else if (this.state.probePhase === 'probing') {
        this.state.probeCleanTicks += 1;
        if (this.state.probeCleanTicks >= 1) {
          this.state.probeCleanTicks = 0;
          this.state.probeBitrate = this.state.currentCapHigh + 3_000_000;
          if (this.state.probeBitrate >= BITRATE_DEFAULT_HIGH) {
            this.resetToDefaultBitrate();
          } else {
            this.state.currentCapHigh = this.state.probeBitrate;
          }
        }
      }

      targetHigh = this.state.currentCapHigh;
    }

    let outboundMessage: BitrateCapMessage | null = null;

    if (this.state.capped && now - this.state.lastCapSendTime >= 2000) {
      this.state.lastCapSendTime = now;
      if (!this.state.firstCapSendTime) this.state.firstCapSendTime = now;

      outboundMessage = {
        type: 'bitrate-cap',
        version: 1,
        targetBitrateHigh: targetHigh,
        targetBitrateMed: Math.round(targetHigh * 0.33),
        targetBitrateLow: Math.round(targetHigh * 0.1),
        reason: severeCongestion ? 'severe' : congestion ? 'congestion' : this.state.probePhase === 'probing' ? 'probe' : 'hold',
        lossRate: Math.round(lossRate * 1000) / 1000,
        senderIdentity: input.localIdentity,
      };
    }

    if (!this.state.capped && this.state.lastCapSendTime > 0) {
      outboundMessage = {
        type: 'bitrate-cap',
        version: 1,
        targetBitrateHigh: BITRATE_DEFAULT_HIGH,
        targetBitrateMed: BITRATE_DEFAULT_MED,
        targetBitrateLow: BITRATE_DEFAULT_LOW,
        reason: 'restore',
        lossRate: 0,
        senderIdentity: input.localIdentity,
      };
      this.state.lastCapSendTime = 0;
      this.state.firstCapSendTime = 0;
    }

    if (
      this.state.capped
      && this.state.firstCapSendTime > 0
      && !this.state.ackReceived
      && now - this.state.firstCapSendTime > 10_000
    ) {
      this.state.fallbackToLayers = true;
    }

    return {
      outboundMessage,
      lockHighLayer: this.state.capped,
      fallbackToLayers: this.state.fallbackToLayers,
      currentCapHigh: this.state.currentCapHigh,
      capped: this.state.capped,
    };
  }

  private resetToDefaultBitrate() {
    this.state.currentCapHigh = BITRATE_DEFAULT_HIGH;
    this.state.capped = false;
    this.state.probePhase = 'idle';
    this.state.lossHistory = [];
    this.state.kbpsHistory = [];
  }
}

export type SenderLike = {
  getParameters: () => RTCRtpSendParameters;
  setParameters: (params: RTCRtpSendParameters) => Promise<void>;
};

type PublisherCapEntry = {
  high: number;
  med: number;
  low: number;
  timestamp: number;
  reason: string;
};

type PublisherManagerOptions = {
  localIdentity: string;
  senderProvider: () => SenderLike | null | undefined;
  sendData: (payload: Uint8Array, destinationIdentity: string) => Promise<void> | void;
  nowMs?: () => number;
  ttlMs?: number;
};

export class PublisherBitrateCapManager {
  private readonly localIdentity: string;
  private readonly senderProvider: () => SenderLike | null | undefined;
  private readonly sendData: (payload: Uint8Array, destinationIdentity: string) => Promise<void> | void;
  private readonly nowMs: () => number;
  private readonly ttlMs: number;

  private readonly caps = new Map<string, PublisherCapEntry>();
  private currentAppliedCap: { high: number; med: number; low: number } | null = null;

  constructor(options: PublisherManagerOptions) {
    this.localIdentity = options.localIdentity;
    this.senderProvider = options.senderProvider;
    this.sendData = options.sendData;
    this.nowMs = options.nowMs ?? Date.now;
    this.ttlMs = options.ttlMs ?? 15_000;
  }

  getAppliedCap() {
    return this.currentAppliedCap;
  }

  async clear() {
    this.caps.clear();
    this.currentAppliedCap = null;
    await this.applyBitrateToSender(BITRATE_DEFAULT_HIGH, BITRATE_DEFAULT_MED, BITRATE_DEFAULT_LOW);
  }

  async tickCleanup() {
    const now = this.nowMs();
    const expired: string[] = [];

    this.caps.forEach((entry, identity) => {
      if (now - entry.timestamp > this.ttlMs) {
        expired.push(identity);
      }
    });

    expired.forEach((identity) => this.caps.delete(identity));

    if (this.caps.size === 0 && this.currentAppliedCap) {
      this.currentAppliedCap = null;
      await this.applyBitrateToSender(BITRATE_DEFAULT_HIGH, BITRATE_DEFAULT_MED, BITRATE_DEFAULT_LOW);
      return;
    }

    if (this.caps.size > 0) {
      await this.applyMostRestrictiveCap();
    }
  }

  async handleCapRequest(message: Partial<BitrateCapMessage>, participantIdentity?: string) {
    const sender = this.senderProvider();
    if (!sender) return false;

    const senderIdentity = message.senderIdentity || participantIdentity || 'unknown';

    let high = clamp(message.targetBitrateHigh ?? BITRATE_DEFAULT_HIGH, 500_000, BITRATE_DEFAULT_HIGH);
    let med = clamp(message.targetBitrateMed ?? Math.round(high * 0.33), 300_000, BITRATE_DEFAULT_MED);
    let low = clamp(message.targetBitrateLow ?? Math.round(high * 0.1), 200_000, BITRATE_DEFAULT_LOW);

    if (med >= high) med = Math.round(high * 0.6);
    if (low >= med) low = Math.round(med * 0.5);

    this.caps.set(senderIdentity, {
      high,
      med,
      low,
      timestamp: this.nowMs(),
      reason: String(message.reason ?? 'unknown'),
    });

    await this.applyMostRestrictiveCap();
    await this.sendAck(senderIdentity, high);

    return true;
  }

  private async sendAck(destinationIdentity: string, appliedHigh: number) {
    const payload: BitrateCapAckMessage = {
      type: 'bitrate-cap-ack',
      version: 1,
      appliedBitrateHigh: appliedHigh,
      identity: this.localIdentity,
    };

    try {
      await this.sendData(new TextEncoder().encode(JSON.stringify(payload)), destinationIdentity);
    } catch {
      // best effort ack
    }
  }

  private async applyMostRestrictiveCap() {
    let high = BITRATE_DEFAULT_HIGH;
    let med = BITRATE_DEFAULT_MED;
    let low = BITRATE_DEFAULT_LOW;

    this.caps.forEach((entry) => {
      if (entry.high < high) high = entry.high;
      if (entry.med < med) med = entry.med;
      if (entry.low < low) low = entry.low;
    });

    if (
      this.currentAppliedCap
      && this.currentAppliedCap.high === high
      && this.currentAppliedCap.med === med
      && this.currentAppliedCap.low === low
    ) {
      return;
    }

    this.currentAppliedCap = { high, med, low };
    await this.applyBitrateToSender(high, med, low);
  }

  private async applyBitrateToSender(highBps: number, medBps: number, lowBps: number) {
    const sender = this.senderProvider();
    if (!sender) return;

    try {
      const params = sender.getParameters();
      const encodings = params.encodings;
      if (!encodings || encodings.length === 0) return;

      encodings.forEach((encoding) => {
        if (encoding.rid === 'f' || (!encoding.rid && encodings.length === 1)) {
          encoding.maxBitrate = highBps;
          return;
        }
        if (encoding.rid === 'h') {
          encoding.maxBitrate = medBps;
          return;
        }
        if (encoding.rid === 'q') {
          encoding.maxBitrate = lowBps;
        }
      });

      await sender.setParameters(params);
    } catch {
      // best effort setParameters
    }
  }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateLossEwma(values: number[]) {
  if (values.length === 0) return 0;

  let weighted = 0;
  let weightSum = 0;

  for (let index = 0; index < values.length; index += 1) {
    const weight = Math.pow(0.7, values.length - 1 - index);
    weighted += values[index] * weight;
    weightSum += weight;
  }

  return weightSum > 0 ? weighted / weightSum : 0;
}
