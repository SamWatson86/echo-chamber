import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_ID_STORAGE_KEY,
  ensureLocalDeviceId,
  resolveChimeIdentity,
} from '@/features/media/deviceProfileParity';

describe('device-profile parity helpers', () => {
  it('reuses existing local device id when present', () => {
    const storage = {
      getItem: vi.fn((key: string) => (key === DEVICE_ID_STORAGE_KEY ? 'device-123' : null)),
      setItem: vi.fn(),
    };

    const id = ensureLocalDeviceId(storage as unknown as Storage, undefined);

    expect(id).toBe('device-123');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('creates and persists a new local device id when missing', () => {
    const storageMap = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageMap.set(key, value);
      },
    };

    const id = ensureLocalDeviceId(storage as unknown as Storage, undefined);

    expect(id).toMatch(/[0-9a-f-]{36}/i);
    expect(storageMap.get(DEVICE_ID_STORAGE_KEY)).toBe(id);
  });

  it('maps participant chime lookups through identityBase -> deviceId when known', () => {
    const map = new Map<string, string>([['sam', 'device-sam']]);
    const baseFn = (identity: string) => identity.replace(/-\d+$/, '');

    expect(resolveChimeIdentity('sam-1000', baseFn, map)).toBe('device-sam');
    expect(resolveChimeIdentity('alex-1001', baseFn, map)).toBe('alex');
  });
});
