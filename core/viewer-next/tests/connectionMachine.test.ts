import { createActor, waitFor } from 'xstate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionMachine } from '@/features/connection/connectionMachine';

const request = {
  controlUrl: 'https://127.0.0.1:9443',
  sfuUrl: 'ws://127.0.0.1:7880',
  room: 'main',
  name: 'Viewer',
  identity: 'viewer-abc123',
  adminPassword: 'pw',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('connectionMachine', () => {
  it('moves to connected when provisioning succeeds', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as any);

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'admin-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'room-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const actor = createActor(connectionMachine).start();
    actor.send({ type: 'CONNECT', request });

    await waitFor(actor, (state) => state.matches('connected'));
    expect(actor.getSnapshot().context.session?.adminToken).toBe('admin-token');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('moves to failed when login fails', async () => {
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValueOnce(new Response('{}', { status: 401 }));

    const actor = createActor(connectionMachine).start();
    actor.send({ type: 'CONNECT', request });

    await waitFor(actor, (state) => state.matches('failed'));
    expect(actor.getSnapshot().context.lastError).toContain('Login failed (401)');
  });
});
