import { describe, expect, it, vi } from 'vitest';
import {
  PublisherBitrateCapManager,
  ReceiverAimdController,
} from '@/features/media/aimdBitrateControl';
import { BITRATE_DEFAULT_HIGH } from '@/features/media/screenShareParity';

describe('AIMD bitrate-control parity', () => {
  it('backs off during congestion and restores after clean ticks', () => {
    const controller = new ReceiverAimdController();

    const severe = controller.update({
      deltaLost: 40,
      receivedKbps: 3_000,
      localIdentity: 'viewer-a',
      nowMs: 10_000,
    });

    expect(severe.capped).toBe(true);
    expect(severe.currentCapHigh).toBeLessThan(BITRATE_DEFAULT_HIGH);

    const noLoss1 = controller.update({
      deltaLost: 0,
      receivedKbps: 3_200,
      localIdentity: 'viewer-a',
      nowMs: 12_500,
    });
    const noLoss2 = controller.update({
      deltaLost: 0,
      receivedKbps: 3_300,
      localIdentity: 'viewer-a',
      nowMs: 15_000,
    });

    expect(noLoss2.capped).toBe(false);
    expect(noLoss2.currentCapHigh).toBe(BITRATE_DEFAULT_HIGH);
    const reasons = [noLoss1.outboundMessage?.reason, noLoss2.outboundMessage?.reason].filter(Boolean);
    expect(reasons).toContain('restore');
  });

  it('falls back to receiver-side layer controls when cap ACK never arrives', () => {
    const controller = new ReceiverAimdController();

    controller.update({
      deltaLost: 20,
      receivedKbps: 2_000,
      localIdentity: 'viewer-b',
      nowMs: 3_000,
    });

    const stale = controller.update({
      deltaLost: 10,
      receivedKbps: 2_000,
      localIdentity: 'viewer-b',
      nowMs: 14_100,
    });

    expect(stale.capped).toBe(true);
    expect(stale.fallbackToLayers).toBe(true);
  });

  it('applies most restrictive publisher cap and sends ACK', async () => {
    const setParameters = vi.fn(async () => undefined);
    const sender = {
      getParameters: vi.fn(
        () =>
          ({
            transactionId: 'tx',
            codecs: [],
            headerExtensions: [],
            rtcp: { cname: '' },
            encodings: [
              { rid: 'f', maxBitrate: 15_000_000 },
              { rid: 'h', maxBitrate: 5_000_000 },
              { rid: 'q', maxBitrate: 1_500_000 },
            ],
          } as RTCRtpSendParameters),
      ),
      setParameters,
    };

    const sendData = vi.fn(async () => undefined);

    const manager = new PublisherBitrateCapManager({
      localIdentity: 'publisher-1',
      senderProvider: () => sender,
      sendData,
      nowMs: () => 1_000,
    });

    await manager.handleCapRequest(
      {
        targetBitrateHigh: 6_000_000,
        targetBitrateMed: 2_000_000,
        targetBitrateLow: 700_000,
        reason: 'congestion',
      },
      'receiver-1',
    );

    expect(setParameters).toHaveBeenCalled();
    expect(manager.getAppliedCap()?.high).toBe(6_000_000);
    expect(sendData).toHaveBeenCalledTimes(1);

    await manager.handleCapRequest(
      {
        targetBitrateHigh: 4_500_000,
        targetBitrateMed: 1_500_000,
        targetBitrateLow: 500_000,
        reason: 'severe',
      },
      'receiver-2',
    );

    expect(manager.getAppliedCap()?.high).toBe(4_500_000);
  });
});
