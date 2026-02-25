type StorageLike = {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
};

type MigrationRule = {
  legacyKey: string;
  currentKey: string;
  mapValue?: (value: string) => string;
};

export const LEGACY_PREF_MIGRATIONS: MigrationRule[] = [
  {
    legacyKey: 'echo-noise-cancel',
    currentKey: 'echo-noise-cancel-enabled',
    mapValue: (value) => (value === 'true' || value === '1' ? '1' : '0'),
  },
  {
    legacyKey: 'echo-nc-level',
    currentKey: 'echo-noise-cancel-level',
  },
  {
    legacyKey: 'echo-volume-prefs',
    currentKey: 'echo-participant-volumes',
    mapValue: (value) => {
      try {
        const parsed = JSON.parse(value) as Record<string, { mic?: unknown; screen?: unknown }>;
        const next: Record<string, { mic: number; screen: number }> = {};

        Object.entries(parsed || {}).forEach(([identity, entry]) => {
          const mic = Number(entry?.mic);
          const screen = Number(entry?.screen);
          next[identity] = {
            mic: Number.isFinite(mic) ? Math.max(0, Math.min(3, mic)) : 1,
            screen: Number.isFinite(screen) ? Math.max(0, Math.min(3, screen)) : 1,
          };
        });

        return JSON.stringify(next);
      } catch {
        return '{}';
      }
    },
  },
  {
    legacyKey: 'echo-core-soundboard-clip-volume',
    currentKey: 'echo-soundboard-clip-volume',
  },
  {
    legacyKey: 'echo-soundboard-order',
    currentKey: 'echo-core-soundboard-order',
  },
];

export function migrateLegacyViewerPreferences(storage?: StorageLike | null): {
  migratedKeys: string[];
} {
  if (!storage?.getItem || !storage?.setItem) return { migratedKeys: [] };

  const migratedKeys: string[] = [];

  LEGACY_PREF_MIGRATIONS.forEach((rule) => {
    try {
      const currentValue = storage.getItem?.(rule.currentKey);
      if (currentValue != null && currentValue !== '') return;

      const legacyValue = storage.getItem?.(rule.legacyKey);
      if (legacyValue == null || legacyValue === '') return;

      const mappedValue = rule.mapValue ? rule.mapValue(legacyValue) : legacyValue;
      storage.setItem?.(rule.currentKey, mappedValue);
      migratedKeys.push(`${rule.legacyKey}->${rule.currentKey}`);
    } catch {
      // continue best-effort migration
    }
  });

  return { migratedKeys };
}
