import { createActor, waitFor } from 'xstate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionMachine } from '@/features/connection/connectionMachine';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  it('restarts provisioning when CONNECT arrives during provisioning and keeps the latest request', async () => {
    const firstToken = deferred<Response>();
    let firstTokenPending = true;

    vi.spyOn(globalThis, 'fetch' as any).mockImplementation(async (...args: any[]) => {
      const [input, init] = args as [RequestInfo | URL, RequestInit?];
      const url = String(input);
      if (url.endsWith('/v1/auth/login')) {
        return jsonResponse({ token: 'admin-token' });
      }
      if (url.endsWith('/v1/rooms')) {
        return jsonResponse({ ok: true });
      }
      if (url.endsWith('/v1/auth/token')) {
        const payload = JSON.parse(String(init?.body ?? '{}')) as { room?: string };
        if (payload.room === 'main' && firstTokenPending) {
          firstTokenPending = false;
          return firstToken.promise;
        }
        return jsonResponse({ token: `room-token-${payload.room}` });
      }
      return new Response('{}', { status: 404 });
    });

    const actor = createActor(connectionMachine).start();
    actor.send({ type: 'CONNECT', request: { ...request, room: 'main' } });

    await waitFor(actor, (state) => state.matches('provisioning'));
    actor.send({ type: 'CONNECT', request: { ...request, room: 'breakout-2' } });

    await waitFor(actor, (state) => state.matches('connected'));

    const session = actor.getSnapshot().context.session;
    expect(session?.request.room).toBe('breakout-2');
    expect(session?.roomToken).toBe('room-token-breakout-2');

    firstToken.resolve(jsonResponse({ token: 'room-token-main-stale' }));
  });
});
