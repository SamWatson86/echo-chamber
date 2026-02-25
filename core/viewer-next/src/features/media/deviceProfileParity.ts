export const DEVICE_ID_STORAGE_KEY = 'echo-core-device-id';

type StorageLike = {
  getItem?: (key: string) => string | null;
  setItem?: (key: string, value: string) => void;
};

function fallbackUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const r = Math.floor(Math.random() * 16);
    const v = char === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

function generateUuid(cryptoLike: Crypto | undefined): string {
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID();
  if (cryptoLike?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoLike.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return fallbackUuid();
}

export function ensureLocalDeviceId(storage: StorageLike | null | undefined, cryptoLike?: Crypto): string {
  try {
    const existing = storage?.getItem?.(DEVICE_ID_STORAGE_KEY)?.trim();
    if (existing) return existing;
  } catch {
    // continue with generation
  }

  const deviceId = generateUuid(cryptoLike ?? (globalThis as { crypto?: Crypto }).crypto);

  try {
    storage?.setItem?.(DEVICE_ID_STORAGE_KEY, deviceId);
  } catch {
    // ignore persistence failures
  }

  return deviceId;
}

export function resolveChimeIdentity(
  participantIdentity: string,
  identityBaseFn: (identity: string) => string,
  byIdentityBase: Map<string, string>,
): string {
  const idBase = identityBaseFn(participantIdentity);
  return byIdentityBase.get(idBase) || idBase;
}
