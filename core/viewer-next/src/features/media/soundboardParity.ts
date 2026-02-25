export type SoundboardDataMessage = {
  type?: string;
  room?: string;
  soundId?: string;
  text?: string;
  name?: string;
  senderName?: string;
  soundName?: string;
};

export type ParsedSoundboardPlay = {
  wireType: 'sound-play' | 'soundboard-play';
  soundId: string | null;
  senderName: string;
  soundName: string;
};

export function parseSoundboardPlayMessage(message: SoundboardDataMessage): ParsedSoundboardPlay | null {
  if (!message || (message.type !== 'sound-play' && message.type !== 'soundboard-play')) {
    return null;
  }

  const senderName = String(message.senderName || message.name || 'Someone').trim() || 'Someone';
  const soundName = String(message.soundName || message.text || 'a sound').trim() || 'a sound';

  const rawSoundId = typeof message.soundId === 'string' ? message.soundId.trim() : '';
  return {
    wireType: message.type,
    soundId: rawSoundId || null,
    senderName,
    soundName,
  };
}

export function formatSoundboardHint(senderName: string, soundName: string): string {
  const safeSender = senderName.trim() || 'Someone';
  const safeSound = soundName.trim() || 'a sound';
  return `${safeSender} played ${safeSound}.`;
}

export function buildSoundboardBroadcastPayloads(input: {
  room: string;
  soundId: string;
  senderName: string;
  soundName: string;
}) {
  const room = input.room;
  const soundId = input.soundId.trim();
  const senderName = input.senderName.trim() || 'Viewer';
  const soundName = input.soundName.trim() || 'Sound';

  return [
    {
      type: 'sound-play',
      room,
      soundId,
      senderName,
      soundName,
    },
    {
      type: 'soundboard-play',
      room,
      soundId,
      senderName,
      soundName,
      name: senderName,
      text: soundName,
    },
  ] as const;
}

export function sortSoundboardByOrder<T extends { id: string; favorite?: boolean }>(
  sounds: T[],
  customOrder: string[],
): T[] {
  const orderMap = new Map<string, number>();
  customOrder.forEach((id, idx) => {
    if (!orderMap.has(id)) orderMap.set(id, idx);
  });

  const rank = (item: T) => orderMap.get(item.id) ?? Number.MAX_SAFE_INTEGER;

  const favorites: T[] = [];
  const others: T[] = [];
  sounds.forEach((sound) => {
    if (sound.favorite) favorites.push(sound);
    else others.push(sound);
  });

  const sorter = (a: T, b: T) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  };

  favorites.sort(sorter);
  others.sort(sorter);
  return [...favorites, ...others];
}
