import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/app/App';
import { useViewerPrefsStore } from '@/stores/viewerPrefsStore';

const livekitMock = vi.hoisted(() => ({
  state: {
    micDesiredCalls: [] as boolean[],
    camDesiredCalls: [] as boolean[],
    screenDesiredCalls: [] as boolean[],
    connectCalls: [] as Array<{ url: string; token: string }>,
  },
  reset() {
    this.state.micDesiredCalls.length = 0;
    this.state.camDesiredCalls.length = 0;
    this.state.screenDesiredCalls.length = 0;
    this.state.connectCalls.length = 0;
  },
}));

vi.mock('livekit-client', () => {
  type TrackSource = 'microphone' | 'camera' | 'screen_share';

  class MockTrack {
    constructor(public readonly source: TrackSource) {}

    attach() {
      return this.source === 'microphone' ? document.createElement('audio') : document.createElement('video');
    }

    detach(_element?: HTMLMediaElement) {
      return [] as HTMLMediaElement[];
    }
  }

  class MockTrackPublication {
    constructor(public readonly source: TrackSource, public readonly track: MockTrack | null) {}
  }

  class Participant {
    identity = '';
    name = '';
    isSpeaking = false;
    protected readonly publications = new Map<TrackSource, MockTrackPublication>();

    getTrackPublication(source: TrackSource) {
      return this.publications.get(source);
    }

    get isCameraEnabled() {
      return Boolean(this.getTrackPublication('camera')?.track);
    }

    get isMicrophoneEnabled() {
      return Boolean(this.getTrackPublication('microphone')?.track);
    }

    get isScreenShareEnabled() {
      return Boolean(this.getTrackPublication('screen_share')?.track);
    }
  }

  class Room {
    remoteParticipants = new Map<string, Participant>();
    localParticipant: LocalParticipant;
    private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

    constructor() {
      this.localParticipant = new LocalParticipant(this);
    }

    async connect(url: string, token: string) {
      livekitMock.state.connectCalls.push({ url, token });
      this.emit('connected');
    }

    async disconnect() {
      this.emit('disconnected');
    }

    on(event: string, listener: (...args: any[]) => void) {
      if (!this.listeners.has(event)) {
        this.listeners.set(event, new Set());
      }
      this.listeners.get(event)?.add(listener);
      return this;
    }

    emit(event: string, ...args: any[]) {
      this.listeners.get(event)?.forEach((listener) => listener(...args));
    }

    removeAllListeners() {
      this.listeners.clear();
    }
  }

  class LocalParticipant extends Participant {
    constructor(private readonly room: Room) {
      super();
      this.identity = 'viewer-local';
      this.name = 'Parity Viewer';
    }

    publishData = vi.fn(async (_payload: Uint8Array) => undefined);

    private async setTrack(source: TrackSource, enabled: boolean) {
      await Promise.resolve();

      if (enabled) {
        this.publications.set(source, new MockTrackPublication(source, new MockTrack(source)));
        this.room.emit('local-track-published');
        return;
      }

      this.publications.delete(source);
      this.room.emit('local-track-unpublished');
    }

    async setMicrophoneEnabled(enabled: boolean) {
      livekitMock.state.micDesiredCalls.push(enabled);
      await this.setTrack('microphone', enabled);
    }

    async setCameraEnabled(enabled: boolean) {
      livekitMock.state.camDesiredCalls.push(enabled);
      await this.setTrack('camera', enabled);
    }

    async setScreenShareEnabled(enabled: boolean) {
      livekitMock.state.screenDesiredCalls.push(enabled);
      await this.setTrack('screen_share', enabled);
    }
  }

  const RoomEvent = {
    Connected: 'connected',
    Disconnected: 'disconnected',
    ParticipantConnected: 'participant-connected',
    ParticipantDisconnected: 'participant-disconnected',
    TrackSubscribed: 'track-subscribed',
    TrackUnsubscribed: 'track-unsubscribed',
    LocalTrackPublished: 'local-track-published',
    LocalTrackUnpublished: 'local-track-unpublished',
    ActiveSpeakersChanged: 'active-speakers-changed',
    DataReceived: 'data-received',
  };

  const Track = {
    Source: {
      Microphone: 'microphone',
      Camera: 'camera',
      ScreenShare: 'screen_share',
    },
  };

  return {
    Room,
    RoomEvent,
    Track,
    Participant,
    LocalParticipant,
    __mockLiveKit: livekitMock,
  };
});

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

function installFetchMock(options?: { deferMainRoomToken?: boolean }) {
  const tokenRoomRequests: string[] = [];
  const mainToken = deferred<Response>();
  let deferredMainUsed = false;

  vi.spyOn(globalThis, 'fetch' as any).mockImplementation(async (...args: any[]) => {
    const [input, init] = args as [RequestInfo | URL, RequestInit?];
    const url = String(input);

    if (url.endsWith('/api/online')) return jsonResponse([]);
    if (url.endsWith('/api/version')) return jsonResponse({ latest: '0.0.0' });

    if (url.endsWith('/v1/auth/login')) return jsonResponse({ token: 'admin-token' });
    if (url.endsWith('/v1/rooms')) return jsonResponse({ ok: true });

    if (url.endsWith('/v1/auth/token')) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as { room?: string };
      const requestedRoom = payload.room ?? 'main';
      tokenRoomRequests.push(requestedRoom);

      if (options?.deferMainRoomToken && requestedRoom === 'main' && !deferredMainUsed) {
        deferredMainUsed = true;
        return mainToken.promise;
      }

      return jsonResponse({ token: `room-token-${requestedRoom}` });
    }

    if (url.endsWith('/v1/ice-servers')) return jsonResponse({ ice_servers: [] });
    if (url.includes('/api/chat/history/')) return jsonResponse([]);
    if (url.endsWith('/v1/room-status')) return jsonResponse([{ room_id: 'main', participants: [] }]);

    return jsonResponse({ ok: true });
  });

  return {
    tokenRoomRequests,
    resolveMainToken: () => mainToken.resolve(jsonResponse({ token: 'room-token-main-stale' })),
  };
}

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

async function connectAndWait() {
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => {
    expect(screen.getByText(/^Connected/)).toBeInTheDocument();
  });
}

beforeEach(() => {
  useViewerPrefsStore.getState().reset();
  useViewerPrefsStore.setState({ name: 'Parity Viewer', adminPassword: 'pw' });
  livekitMock.reset();

  vi.stubGlobal(
    'navigator',
    Object.assign(Object.create(navigator), {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => []),
        getUserMedia: vi.fn(async () => null),
      },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App media/room reliability parity', () => {
  it('keeps local mic/camera/screen state correct under quick double toggles', async () => {
    installFetchMock();
    renderApp();
    await connectAndWait();

    fireEvent.click(screen.getByRole('button', { name: /Enable Mic/i }));
    fireEvent.click(screen.getByRole('button', { name: /Enable Mic|Disable Mic/i }));

    fireEvent.click(screen.getByRole('button', { name: /Enable Camera/i }));
    fireEvent.click(screen.getByRole('button', { name: /Enable Camera|Disable Camera/i }));

    fireEvent.click(screen.getByRole('button', { name: /Share Screen/i }));
    fireEvent.click(screen.getByRole('button', { name: /Share Screen|Stop Screen/i }));

    await waitFor(() => {
      expect(livekitMock.state.micDesiredCalls.slice(-2)).toEqual([true, false]);
      expect(livekitMock.state.camDesiredCalls.slice(-2)).toEqual([true, false]);
      expect(livekitMock.state.screenDesiredCalls.slice(-2)).toEqual([true, false]);
    });

    expect(screen.getByRole('button', { name: /Enable Mic/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enable Camera/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Share Screen/i })).toBeInTheDocument();
  });

  it('applies the latest room switch request when switching while provisioning', async () => {
    const { tokenRoomRequests, resolveMainToken } = installFetchMock({ deferMainRoomToken: true });
    renderApp();

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(screen.getByText('Connecting…')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByRole('button', { name: /Breakout 2/i })[0]);

    await waitFor(() => {
      expect(screen.getByText(/^Connected/)).toBeInTheDocument();
    });

    expect(tokenRoomRequests).toContain('main');
    expect(tokenRoomRequests).toContain('breakout-2');
    expect(tokenRoomRequests[tokenRoomRequests.length - 1]).toBe('breakout-2');

    resolveMainToken();
  });
});
