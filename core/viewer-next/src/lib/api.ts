export type RoomSummary = {
  room_id: string;
  participant_count?: number;
};

export type OnlineUser = {
  identity?: string;
  name?: string;
  room?: string;
};

export type RoomStatusParticipant = {
  identity: string;
  name?: string;
};

export type RoomStatus = {
  room_id: string;
  participants?: RoomStatusParticipant[];
};

export type HealthStatus = {
  status?: string;
  ok?: boolean;
};

export async function fetchAdminToken(baseUrl: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    throw new Error(`Login failed (${response.status})`);
  }

  const payload = (await response.json()) as { token: string };
  return payload.token;
}

export async function ensureRoomExists(baseUrl: string, adminToken: string, roomId: string): Promise<void> {
  await fetch(`${baseUrl}/v1/rooms`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ room_id: roomId }),
  }).catch(() => undefined);
}

export async function fetchRoomToken(params: {
  baseUrl: string;
  adminToken: string;
  room: string;
  identity: string;
  name: string;
}): Promise<string> {
  const { baseUrl, adminToken, room, identity, name } = params;

  const response = await fetch(`${baseUrl}/v1/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ room, identity, name }),
  });

  if (response.status === 409) {
    throw new Error('Name is already in use by another connected user.');
  }

  if (!response.ok) {
    throw new Error(`Room token failed (${response.status})`);
  }

  const payload = (await response.json()) as { token: string };
  return payload.token;
}

export async function fetchHealth(baseUrl: string): Promise<HealthStatus> {
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) {
    throw new Error(`Health check failed (${response.status})`);
  }
  return (await response.json()) as HealthStatus;
}

export async function fetchRooms(baseUrl: string, adminToken: string): Promise<RoomSummary[]> {
  const response = await fetch(`${baseUrl}/v1/rooms`, {
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Room fetch failed (${response.status})`);
  }

  return (await response.json()) as RoomSummary[];
}

export async function fetchRoomStatus(baseUrl: string, adminToken: string): Promise<RoomStatus[]> {
  const response = await fetch(`${baseUrl}/v1/room-status`, {
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Room status fetch failed (${response.status})`);
  }

  return (await response.json()) as RoomStatus[];
}

export async function fetchOnlineUsers(baseUrl: string): Promise<OnlineUser[]> {
  const response = await fetch(`${baseUrl}/api/online`);

  if (!response.ok) {
    throw new Error(`Online users fetch failed (${response.status})`);
  }

  return (await response.json()) as OnlineUser[];
}
