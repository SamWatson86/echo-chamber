import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const evidenceStamp = process.env.PARITY_EVIDENCE_STAMP ?? new Date().toISOString().replace(/[:.]/g, '-');
const evidenceDir = path.resolve(currentDir, '../../../docs/proof/parity');

const liveKitStub = `
(function () {
  function makeSender() {
    return {
      getParameters: function () { return { encodings: [{ rid: 'f', maxBitrate: 2500000, maxFramerate: 60 }] }; },
      setParameters: function () { return Promise.resolve(); }
    };
  }

  class FakeLocalAudioTrack {
    constructor(mediaStreamTrack) {
      this.kind = 'audio';
      this.mediaStreamTrack = mediaStreamTrack || { kind: 'audio', stop: function () {} };
      this.sender = makeSender();
    }
  }

  class FakeLocalVideoTrack {
    constructor(mediaStreamTrack) {
      this.kind = 'video';
      this.mediaStreamTrack = mediaStreamTrack || { kind: 'video', stop: function () {} };
      this.sender = makeSender();
    }
  }

  class FakeLocalParticipant {
    constructor() {
      this.identity = 'viewer-parity-test';
      this.name = 'Viewer';
      this.metadata = '';
      this._publications = new Map();
    }

    publishData() {
      return Promise.resolve();
    }

    setMetadata(metadata) {
      this.metadata = metadata;
      return Promise.resolve();
    }

    setMicrophoneEnabled(enabled) {
      this._micEnabled = !!enabled;
      return Promise.resolve();
    }

    setCameraEnabled(enabled) {
      this._camEnabled = !!enabled;
      return Promise.resolve();
    }

    publishTrack(track, options) {
      const source = (options && options.source) || 'microphone';
      const publication = {
        track,
        source,
        kind: track && track.kind ? track.kind : 'audio',
        trackSid: 'PUB_' + Math.random().toString(36).slice(2),
        isMuted: false,
        isSubscribed: true,
        setSubscribed: function () {},
        setVideoQuality: function () {},
        setPreferredLayer: function () {},
      };
      this._publications.set(source, publication);
      return Promise.resolve(publication);
    }

    unpublishTrack() {
      return Promise.resolve();
    }

    getTrackPublication(source) {
      return this._publications.get(source) || null;
    }
  }

  class FakeRoom {
    constructor() {
      this.localParticipant = new FakeLocalParticipant();
      this.remoteParticipants = new Map();
      this._listeners = new Map();
    }

    on(event, callback) {
      if (!this._listeners.has(event)) this._listeners.set(event, []);
      this._listeners.get(event).push(callback);
      return this;
    }

    emit(event) {
      const args = Array.prototype.slice.call(arguments, 1);
      const listeners = this._listeners.get(event) || [];
      listeners.forEach(function (listener) { listener.apply(null, args); });
    }

    connect() {
      this.emit('ConnectionStateChanged', 'connected');
      return Promise.resolve();
    }

    disconnect() {
      this.emit('Disconnected', 'client_initiated');
    }

    startAudio() {
      return Promise.resolve();
    }
  }

  const RoomEvent = new Proxy({}, {
    get: function (_, property) {
      return String(property);
    }
  });

  const stub = {
    Room: FakeRoom,
    RoomEvent,
    LocalAudioTrack: FakeLocalAudioTrack,
    LocalVideoTrack: FakeLocalVideoTrack,
    VideoQuality: { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' },
    Track: {
      Source: {
        Microphone: 'microphone',
        Camera: 'camera',
        ScreenShare: 'screen_share',
        ScreenShareAudio: 'screen_share_audio',
      },
      Kind: {
        Audio: 'audio',
        Video: 'video',
      }
    },
    createAudioAnalyser: function () {
      return {
        cleanup: function () {},
        analyser: { context: { state: 'running', resume: function () { return Promise.resolve(); } } },
      };
    }
  };

  window.LiveKitClient = stub;
  window.LivekitClient = stub;
  window.LiveKit = stub;
})();
`;

function ensureEvidenceDir(): void {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

function evidencePath(name: string): string {
  ensureEvidenceDir();
  return path.join(evidenceDir, `${evidenceStamp}-${name}.png`);
}

async function fulfillJson(route: Route, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });
}

async function installLegacyRuntimeMocks(page: Page): Promise<void> {
  await page.route('**/legacy/livekit-client.umd.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: liveKitStub,
    });
  });

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());

    if (pathname.endsWith('/v1/auth/login') && request.method() === 'POST') {
      await fulfillJson(route, { token: 'admin-token' });
      return;
    }

    if (pathname.endsWith('/v1/auth/token') && request.method() === 'POST') {
      await fulfillJson(route, { token: 'room-token', expires_in_seconds: 14400 });
      return;
    }

    if (pathname.endsWith('/v1/ice-servers')) {
      await fulfillJson(route, { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      return;
    }

    if (pathname.endsWith('/v1/room-status')) {
      await fulfillJson(route, []);
      return;
    }

    if (pathname.endsWith('/v1/rooms') && request.method() === 'GET') {
      await fulfillJson(route, []);
      return;
    }

    if (pathname.endsWith('/v1/rooms') && request.method() === 'POST') {
      await fulfillJson(route, { ok: true }, 201);
      return;
    }

    await fulfillJson(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());

    if (request.method() === 'HEAD' && (pathname.startsWith('/api/avatar/') || pathname.startsWith('/api/chime/'))) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }

    if (pathname.startsWith('/api/chat/history/')) {
      await fulfillJson(route, []);
      return;
    }

    if (pathname.startsWith('/api/soundboard/list')) {
      await fulfillJson(route, { sounds: [] });
      return;
    }

    if (pathname === '/api/jam/state') {
      await fulfillJson(route, {
        active: false,
        spotify_connected: false,
        now_playing: null,
        queue: [],
        listener_count: 0,
        listeners: [],
      });
      return;
    }

    await fulfillJson(route, { ok: true });
  });

  await page.addInitScript(() => {
    if (!window.RTCPeerConnection) {
      class StubPeerConnection {
        createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
        setLocalDescription() { return Promise.resolve(); }
        setRemoteDescription() { return Promise.resolve(); }
        addTransceiver() { return {}; }
      }
      // @ts-expect-error test shim
      window.RTCPeerConnection = StubPeerConnection;
    }

    if (!window.RTCRtpSender) {
      class StubSender {
        setParameters() { return Promise.resolve(); }
      }
      // @ts-expect-error test shim
      window.RTCRtpSender = StubSender;
    }

    const navAny = navigator as Navigator & { mediaDevices?: Partial<MediaDevices> };
    const mediaDevices = navAny.mediaDevices ?? {};
    if (!navAny.mediaDevices) {
      Object.defineProperty(navAny, 'mediaDevices', {
        value: mediaDevices,
        configurable: true,
      });
    }

    mediaDevices.getUserMedia = async () => {
      const stream = new MediaStream();
      return stream;
    };

    mediaDevices.enumerateDevices = async () => [
      { deviceId: 'mic-1', kind: 'audioinput', label: 'Mock Mic', groupId: 'mock' } as MediaDeviceInfo,
      { deviceId: 'cam-1', kind: 'videoinput', label: 'Mock Cam', groupId: 'mock' } as MediaDeviceInfo,
      { deviceId: 'spk-1', kind: 'audiooutput', label: 'Mock Speaker', groupId: 'mock' } as MediaDeviceInfo,
    ];

    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play(): Promise<void> {
      return originalPlay ? originalPlay.call(this).catch(() => Promise.resolve()) : Promise.resolve();
    };
  });
}

test('loads legacy viewer in parity frame', async ({ page }) => {
  await installLegacyRuntimeMocks(page);
  await page.goto('/');

  const frame = page.frameLocator('iframe[title="Echo Chamber Viewer"]');
  await expect(frame.getByRole('heading', { name: 'Echo Chamber' })).toBeVisible();
  await expect(frame.locator('#connect')).toBeVisible();
});

test('executes login flow and captures parity screenshots', async ({ page }) => {
  await installLegacyRuntimeMocks(page);
  await page.goto('/');

  const frame = page.frameLocator('iframe[title="Echo Chamber Viewer"]');

  await expect(frame.getByRole('heading', { name: 'Echo Chamber' })).toBeVisible();
  await page.screenshot({ path: evidencePath('viewer-next-parity-pre-login'), fullPage: true });

  await frame.locator('#name').fill('Parity Bot');
  await frame.locator('#admin-password').fill('test-admin-password');
  await frame.locator('#connect').click();

  await expect(frame.locator('#connect-panel')).toHaveClass(/hidden/);
  await expect(frame.locator('#disconnect')).toBeEnabled();
  await expect(frame.locator('#status')).toContainText('Connected to main');

  await page.screenshot({ path: evidencePath('viewer-next-parity-post-login'), fullPage: true });
});
