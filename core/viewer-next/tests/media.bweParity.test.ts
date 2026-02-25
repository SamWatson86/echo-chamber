import { describe, expect, it, vi } from 'vitest';
import { BweWatchdog, applyBweActionToSender } from '@/features/media/bweWatchdog';

describe('BWE watchdog/rescue parity', () => {
  it('triggers kick, rescue, hard-rescue, and low-layer restore', () => {
    const watchdog = new BweWatchdog();

    let actions = [] as ReturnType<typeof watchdog.evaluate>;
    for (let index = 0; index < 5; index += 1) {
      actions = watchdog.evaluate(
        {
          bweKbps: 1_500,
          totalSendKbps: 500,
          layers: [
            { rid: 'f', fps: 30, limit: 'none' },
            { rid: 'h', fps: 15, limit: 'none' },
            { rid: 'q', fps: 15, limit: 'none' },
          ],
        },
        null,
      );
    }

    expect(actions.some((entry) => entry.kind === 'kick')).toBe(true);

    for (let index = 0; index < 3; index += 1) {
      actions = watchdog.evaluate(
        {
          bweKbps: 2_500,
          totalSendKbps: 1_000,
          layers: [
            { rid: 'f', fps: 0, limit: 'bandwidth' },
            { rid: 'h', fps: 5, limit: 'bandwidth' },
            { rid: 'q', fps: 5, limit: 'bandwidth' },
          ],
        },
        null,
      );
    }

    expect(actions.some((entry) => entry.kind === 'rescue')).toBe(true);

    let sawRestore = false;
    for (let index = 0; index < 10; index += 1) {
      actions = watchdog.evaluate(
        {
          bweKbps: index === 9 ? 11_000 : 4_000,
          totalSendKbps: 1_200,
          layers: [
            { rid: 'f', fps: 0, limit: 'bandwidth' },
            { rid: 'h', fps: 5, limit: 'bandwidth' },
            { rid: 'q', fps: 0, limit: 'bandwidth' },
          ],
        },
        null,
      );
      if (actions.some((entry) => entry.kind === 'restore-low')) {
        sawRestore = true;
      }
    }

    expect(sawRestore).toBe(true);
  });

  it('applies sender parameters for rescue actions', async () => {
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
              { rid: 'f', active: true, maxBitrate: 1_000_000 },
              { rid: 'h', active: true, maxBitrate: 500_000 },
              { rid: 'q', active: true, maxBitrate: 250_000 },
            ],
          } as RTCRtpSendParameters),
      ),
      setParameters,
    };

    await applyBweActionToSender(sender, {
      kind: 'rescue',
      highBps: 6_000_000,
      medBps: 2_000_000,
      lowBps: 800_000,
    });

    expect(setParameters).toHaveBeenCalledTimes(1);

    const params = sender.getParameters.mock.results[0].value;
    const qLayer = params.encodings.find((entry: { rid?: string }) => entry.rid === 'q');
    expect(qLayer?.active).toBe(false);
  });
});
