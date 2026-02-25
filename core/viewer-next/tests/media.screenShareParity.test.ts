import { describe, expect, it } from 'vitest';
import {
  BITRATE_DEFAULT_HIGH,
  BITRATE_DEFAULT_LOW,
  BITRATE_DEFAULT_MED,
  SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS,
  buildScreenSharePublishOptions,
  capCanvasResolution,
} from '@/features/media/screenShareParity';

describe('screen-share parity helpers', () => {
  it('caps 4k sources to legacy max width/pixels', () => {
    const capped = capCanvasResolution(3840, 2160);

    expect(capped.scaled).toBe(true);
    expect(capped.width).toBeLessThanOrEqual(1920);
    expect(capped.width * capped.height).toBeLessThanOrEqual(2_100_000);
    expect(capped.width % 2).toBe(0);
    expect(capped.height % 2).toBe(0);
  });

  it('builds simulcast screen-share publish options with parity bitrates', () => {
    const options = buildScreenSharePublishOptions(1920, 1080);

    expect(options.simulcast).toBe(true);
    expect(options.videoCodec).toBe('h264');
    expect(options.screenShareEncoding.maxBitrate).toBe(BITRATE_DEFAULT_HIGH);

    expect(options.screenShareSimulcastLayers).toHaveLength(2);
    expect(options.screenShareSimulcastLayers[0].encoding.maxBitrate).toBe(BITRATE_DEFAULT_MED);
    expect(options.screenShareSimulcastLayers[1].encoding.maxBitrate).toBe(BITRATE_DEFAULT_LOW);
  });

  it('keeps explicit screen-share audio publish tuning parity', () => {
    expect(SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS).toEqual({
      dtx: false,
      red: false,
      audioBitrate: 128_000,
    });
  });
});
