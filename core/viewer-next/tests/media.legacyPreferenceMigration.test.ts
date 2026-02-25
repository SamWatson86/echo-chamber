import { describe, expect, it } from 'vitest';
import { migrateLegacyViewerPreferences } from '@/features/media/legacyPreferenceMigration';

function createStorage(seed: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    map,
  };
}

describe('legacy preference migration parity', () => {
  it('migrates legacy keys into current keys without deleting legacy entries', () => {
    const storage = createStorage({
      'echo-noise-cancel': 'true',
      'echo-nc-level': '1',
      'echo-core-soundboard-clip-volume': '140',
      'echo-soundboard-order': '["s1","s2"]',
      'echo-volume-prefs': JSON.stringify({
        'sam-1000': { mic: 1.2, screen: 0.8, chime: 0.5 },
      }),
    });

    const result = migrateLegacyViewerPreferences(storage as unknown as Storage);

    expect(result.migratedKeys).toContain('echo-noise-cancel->echo-noise-cancel-enabled');
    expect(storage.map.get('echo-noise-cancel')).toBe('true');
    expect(storage.map.get('echo-noise-cancel-enabled')).toBe('1');
    expect(storage.map.get('echo-noise-cancel-level')).toBe('1');
    expect(storage.map.get('echo-soundboard-clip-volume')).toBe('140');
    expect(storage.map.get('echo-core-soundboard-order')).toBe('["s1","s2"]');

    const migratedVolumes = JSON.parse(storage.map.get('echo-participant-volumes') || '{}') as Record<string, { mic: number; screen: number }>;
    expect(migratedVolumes['sam-1000']).toEqual({ mic: 1.2, screen: 0.8 });
  });

  it('does not overwrite existing current values', () => {
    const storage = createStorage({
      'echo-noise-cancel': 'true',
      'echo-noise-cancel-enabled': '0',
    });

    migrateLegacyViewerPreferences(storage as unknown as Storage);

    expect(storage.map.get('echo-noise-cancel-enabled')).toBe('0');
  });
});
