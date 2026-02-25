import { describe, expect, it } from 'vitest';
import {
  buildSoundboardBroadcastPayloads,
  formatSoundboardHint,
  parseSoundboardPlayMessage,
  sortSoundboardByOrder,
} from '@/features/media/soundboardParity';

describe('soundboard data-message parity helpers', () => {
  it('parses both legacy and viewer-next message shapes with sender metadata', () => {
    const legacy = parseSoundboardPlayMessage({
      type: 'sound-play',
      soundId: 'airhorn',
      senderName: 'Sam',
      soundName: 'Airhorn',
    });

    const viewerNext = parseSoundboardPlayMessage({
      type: 'soundboard-play',
      soundId: 'applause',
      name: 'Alex',
      text: 'Applause',
    });

    expect(legacy).toEqual({
      wireType: 'sound-play',
      soundId: 'airhorn',
      senderName: 'Sam',
      soundName: 'Airhorn',
    });

    expect(viewerNext).toEqual({
      wireType: 'soundboard-play',
      soundId: 'applause',
      senderName: 'Alex',
      soundName: 'Applause',
    });
  });

  it('builds dual-wire payloads for mixed client compatibility', () => {
    const payloads = buildSoundboardBroadcastPayloads({
      room: 'main',
      soundId: 'clip-1',
      senderName: 'Parity Viewer',
      soundName: 'Airhorn',
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0].type).toBe('sound-play');
    expect(payloads[1].type).toBe('soundboard-play');
    expect(payloads[1].text).toBe('Airhorn');
    expect(payloads[1].senderName).toBe('Parity Viewer');
  });

  it('keeps favorites first while honoring custom order', () => {
    const sorted = sortSoundboardByOrder(
      [
        { id: 'b', favorite: false },
        { id: 'a', favorite: true },
        { id: 'c', favorite: true },
      ],
      ['c', 'a', 'b'],
    );

    expect(sorted.map((entry) => entry.id)).toEqual(['c', 'a', 'b']);
  });

  it('formats user-facing hint text with fallback values', () => {
    expect(formatSoundboardHint('Sam', 'Airhorn')).toBe('Sam played Airhorn.');
    expect(formatSoundboardHint('', '')).toBe('Someone played a sound.');
  });
});
