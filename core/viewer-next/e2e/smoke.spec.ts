import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('legacy workflow parity journey (mocked APIs)', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    (window as any).__ECHO_ADMIN__ = true;

    const mediaProto = window.HTMLMediaElement?.prototype as any;
    if (mediaProto) {
      mediaProto.play = () => Promise.resolve();
      mediaProto.pause = () => undefined;
    }
  });

  const tokenRoomRequests: string[] = [];

  let soundUpdateCalled = false;
  let soundUploadCalled = false;
  let soundPlayFetches = 0;
  let chatDeleteCalled = false;
  let chatUploadCalled = false;
  let bugUploadCalled = false;
  let bugReportCalled = false;
  let jamStartCalled = false;
  let jamSkipCalled = false;
  let jamStopCalled = false;
  let jamQueueCalled = false;

  let soundboardSounds = [
    { id: 'sound-1', name: 'Airhorn', icon: '🎺', roomId: 'breakout-2', volume: 100 },
    { id: 'sound-2', name: 'Applause', icon: '👏', roomId: 'breakout-2', volume: 90 },
  ];

  const chatMessages: any[] = [];
  const bugReports: any[] = [];

  const sampleTrack = {
    spotify_uri: 'spotify:track:123',
    name: 'Lo-fi Focus',
    artist: 'Echo Bot',
    album_art_url: 'https://img.local/track.jpg',
    duration_ms: 120000,
    progress_ms: 12000,
  };

  let jamState: any = {
    active: false,
    spotify_connected: true,
    bot_connected: true,
    host_identity: '',
    listeners: [],
    listener_count: 0,
    queue: [],
    now_playing: null,
  };

  await page.route('**/v1/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'mock-admin-token' }),
    });
  });

  await page.route('**/v1/auth/token', async (route) => {
    const payload = route.request().postDataJSON() as { room?: string };
    tokenRoomRequests.push(payload.room ?? 'main');

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: `mock-room-token-${payload.room ?? 'main'}` }),
    });
  });

  await page.route('**/v1/rooms', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ room_id: 'main', participant_count: 2 }]),
    });
  });

  await page.route('**/v1/room-status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          room_id: 'main',
          participants: [
            { identity: 'sam-1000', name: 'Sam' },
            { identity: 'alex-1001', name: 'Alex' },
          ],
        },
        {
          room_id: 'breakout-1',
          participants: [{ identity: 'zoe-2000', name: 'Zoe' }],
        },
        {
          room_id: 'breakout-2',
          participants: [{ identity: 'max-3000', name: 'Max' }],
        },
      ]),
    });
  });

  await page.route('**/api/online', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { identity: 'sam-1000', name: 'Sam', room: 'main' },
        { identity: 'alex-1001', name: 'Alex', room: 'main' },
      ]),
    });
  });

  await page.route('**/v1/ice-servers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ice_servers: [{ urls: 'stun:stun.l.google.com:19302' }],
      }),
    });
  });

  await page.route('**/api/chime/**', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.route('**/api/avatar/**', async (route) => {
    await route.fulfill({ status: 404, body: '' });
  });

  await page.route('**/api/chat/history/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(chatMessages),
    });
  });

  await page.route('**/api/chat/message', async (route) => {
    const payload = route.request().postDataJSON() as any;
    chatMessages.push(payload);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/chat/upload**', async (route) => {
    const url = route.request().url();
    const fileUrl = `/uploads/${Date.now()}-${url.includes('room=') ? 'chat' : 'bug'}.png`;

    if (url.includes('room=')) {
      chatUploadCalled = true;
    } else {
      bugUploadCalled = true;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, url: fileUrl }),
    });
  });

  await page.route('**/api/chat/delete', async (route) => {
    chatDeleteCalled = true;
    const payload = route.request().postDataJSON() as { id?: string };
    if (payload.id) {
      const index = chatMessages.findIndex((entry) => entry.id === payload.id);
      if (index >= 0) chatMessages.splice(index, 1);
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api/soundboard/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sounds: soundboardSounds }),
    });
  });

  await page.route('**/api/soundboard/update', async (route) => {
    soundUpdateCalled = true;
    const payload = route.request().postDataJSON() as any;
    soundboardSounds = soundboardSounds.map((sound) =>
      sound.id === payload.id
        ? {
            ...sound,
            name: payload.name ?? sound.name,
            icon: payload.icon ?? sound.icon,
            volume: payload.volume ?? sound.volume,
          }
        : sound,
    );

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api/soundboard/upload**', async (route) => {
    soundUploadCalled = true;
    const parsed = new URL(route.request().url());
    const next = {
      id: `sound-${soundboardSounds.length + 1}`,
      name: parsed.searchParams.get('name') || 'Uploaded sound',
      icon: parsed.searchParams.get('icon') || '🎵',
      roomId: parsed.searchParams.get('roomId') || 'main',
      volume: Number(parsed.searchParams.get('volume') || '100'),
    };
    soundboardSounds = [...soundboardSounds, next];

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, sound: next }),
    });
  });

  await page.route('**/api/soundboard/file/**', async (route) => {
    soundPlayFetches += 1;
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
      },
      body: Buffer.from([0, 1, 2, 3]),
    });
  });

  await page.route('**/api/jam/state', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(jamState),
    });
  });

  await page.route('**/api/jam/search', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([sampleTrack]),
    });
  });

  await page.route('**/api/jam/spotify-init', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ auth_url: 'https://spotify.example/auth' }),
    });
  });

  await page.route('**/api/jam/spotify-code**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: null }) });
  });

  await page.route('**/api/jam/spotify-token', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/jam/queue', async (route) => {
    jamQueueCalled = true;
    const payload = route.request().postDataJSON() as { track?: any };
    if (payload.track) {
      jamState = {
        ...jamState,
        queue: [...(jamState.queue || []), payload.track],
      };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/jam/start', async (route) => {
    jamStartCalled = true;
    const payload = route.request().postDataJSON() as { identity?: string };
    const queue = jamState.queue?.length ? jamState.queue : [sampleTrack];
    jamState = {
      ...jamState,
      active: true,
      host_identity: payload.identity || 'parity-viewer',
      queue,
      now_playing: queue[0],
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/jam/skip', async (route) => {
    jamSkipCalled = true;
    const queue = jamState.queue?.length ? jamState.queue.slice(1) : [];
    jamState = {
      ...jamState,
      queue,
      now_playing: queue[0] ?? null,
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/jam/stop', async (route) => {
    jamStopCalled = true;
    jamState = {
      ...jamState,
      active: false,
      host_identity: '',
      queue: [],
      now_playing: null,
      listeners: [],
      listener_count: 0,
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/jam/join', async (route) => {
    const payload = route.request().postDataJSON() as { identity?: string };
    const identity = payload.identity || 'listener';
    jamState = {
      ...jamState,
      listeners: Array.from(new Set([...(jamState.listeners || []), identity])),
      listener_count: Array.from(new Set([...(jamState.listeners || []), identity])).length,
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/jam/leave', async (route) => {
    const payload = route.request().postDataJSON() as { identity?: string };
    const identity = payload.identity || '';
    const listeners = (jamState.listeners || []).filter((entry: string) => entry !== identity);
    jamState = {
      ...jamState,
      listeners,
      listener_count: listeners.length,
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/bug-report', async (route) => {
    bugReportCalled = true;
    const payload = route.request().postDataJSON() as any;
    bugReports.push({
      timestamp: Math.floor(Date.now() / 1000),
      identity: payload.identity,
      name: payload.name,
      description: payload.description,
    });

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/admin/api/dashboard', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total_online: 2,
        server_version: '2026.2.25',
        rooms: [{ room_id: 'main', participants: [{ identity: 'sam-1000', name: 'Sam' }] }],
      }),
    });
  });

  await page.route('**/admin/api/sessions', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events: [{ timestamp: 1700000000, event_type: 'join', identity: 'sam-1000', name: 'Sam', room_id: 'main' }] }),
    });
  });

  await page.route('**/admin/api/metrics', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [{ identity: 'sam-1000', name: 'Sam', avg_fps: 29.8, avg_bitrate_kbps: 1800, pct_bandwidth_limited: 3.1, pct_cpu_limited: 1.2, sample_count: 12, total_minutes: 5 }],
      }),
    });
  });

  await page.route('**/admin/api/metrics/dashboard', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        summary: {
          total_sessions: 12,
          unique_users: 3,
          total_hours: 18,
          avg_duration_mins: 22,
        },
        per_user: [
          { identity: 'sam-1000', name: 'Sam', session_count: 8, total_hours: 10 },
          { identity: 'alex-1001', name: 'Alex', session_count: 4, total_hours: 8 },
        ],
      }),
    });
  });

  await page.route('**/admin/api/bugs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ reports: bugReports }),
    });
  });

  await page.route('**/admin/api/deploys', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        commits: [
          {
            short_sha: 'abc1234',
            message: 'viewer-next parity release candidate',
            author: 'Sam',
            timestamp: new Date().toISOString(),
            deploy_status: 'success',
            deploy_duration: 42,
          },
        ],
      }),
    });
  });

  await page.route('**/admin/api/stats', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.route('**/api/version', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ latest_client: '0.0.0' }),
    });
  });

  await page.goto('/');

  await page.getByLabel('Control URL').fill('https://control.mock.local');
  await page.getByLabel('Name').fill('Parity Viewer');
  await page.getByLabel('Admin password').fill('test-password');

  // Legacy critical control IDs/classes must exist.
  await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('#disconnect')).toBeVisible();
  await expect(page.locator('#toggle-mic')).toBeVisible();
  await expect(page.locator('#toggle-cam')).toBeVisible();
  await expect(page.locator('#toggle-screen')).toBeVisible();
  await expect(page.locator('#chat-panel')).toHaveCount(1);
  await expect(page.locator('#soundboard')).toBeHidden();

  await page.locator('#connect').click();

  await expect(page.locator('#status')).toHaveText(/Connected/i);
  await expect(page.locator('#user-list')).toContainText('Sam');
  await expect.poll(() => tokenRoomRequests[0]).toBe('main');

  await page.locator('#room-list button:has-text("Breakout 2")').first().click();
  await expect.poll(() => tokenRoomRequests[tokenRoomRequests.length - 1]).toBe('breakout-2');

  await page.locator('#disconnect').click();
  await expect(page.locator('#status')).toHaveText(/Idle/i);
  await page.locator('#connect').click();
  await expect(page.locator('#status')).toHaveText(/Connected/i);
  await expect.poll(() => tokenRoomRequests[tokenRoomRequests.length - 1]).toBe('breakout-2');

  const captureParityEvidence = process.env.PARITY_EVIDENCE === '1';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const proofDir = path.resolve(process.cwd(), '../../docs/proof/parity');
  if (captureParityEvidence) {
    await fs.mkdir(proofDir, { recursive: true });
  }

  const shellShot = path.join(proofDir, `${timestamp}-01-connected-shell.png`);
  if (captureParityEvidence) {
    await page.screenshot({ path: shellShot, fullPage: true });
  }

  // Chat send/upload/delete handling.
  await page.getByRole('button', { name: /^Chat$/ }).click();
  await page.locator('#chat-input').fill('React parity chat smoke message');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('#chat-messages')).toContainText('React parity chat smoke message');

  await page.setInputFiles('#chat-file-input', {
    name: 'chat-attachment.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('parity upload', 'utf-8'),
  });

  await expect.poll(() => chatUploadCalled).toBeTruthy();
  await expect(page.locator('#chat-messages')).toContainText('chat-attachment.txt');

  await page.locator('.chat-message-delete').first().evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => chatDeleteCalled).toBeTruthy();

  const chatShot = path.join(proofDir, `${timestamp}-02-chat-open.png`);
  if (captureParityEvidence) {
    await page.screenshot({ path: chatShot, fullPage: true });
  }

  // Theme/settings shell parity.
  await page.getByRole('button', { name: 'Theme' }).click();
  await expect(page.locator('#theme-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Cyberpunk' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'cyberpunk');
  await page.locator('#close-theme').click();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#chime-settings-section')).toBeVisible();
  await page.locator('#close-settings').click();

  // Soundboard play/edit/upload/update.
  await page.locator('#open-soundboard').click();
  await expect(page.locator('#soundboard-compact')).toBeVisible();

  await page.locator('#open-soundboard-edit').click();
  await expect(page.locator('#soundboard')).toBeVisible();
  await page.locator('#soundboard-grid .sound-tile-main').first().evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => soundPlayFetches > 0).toBeTruthy();

  await page.locator('.sound-edit').first().click();
  await page.locator('#sound-name').fill('Airhorn v2');
  await page.locator('.sound-icon-btn').nth(2).click();
  await page.locator('#sound-upload-button').click();
  await expect.poll(() => soundUpdateCalled).toBeTruthy();
  await expect(page.locator('#sound-upload-button')).toHaveText('Upload');

  await page.locator('#sound-name').fill('Bell Upload');
  await page.setInputFiles('#sound-file', {
    name: 'bell.mp3',
    mimeType: 'audio/mpeg',
    buffer: Buffer.from([0, 1, 2, 3]),
  });
  await expect(page.locator('#sound-file-label')).toContainText('bell.mp3');
  await page.locator('#sound-upload-button').click();
  await expect.poll(() => soundUploadCalled).toBeTruthy();
  await expect(page.locator('#soundboard-grid')).toContainText('Bell Upload');
  await page.locator('#back-to-soundboard').click();
  await page.locator('#close-soundboard').click();
  await expect(page.locator('#soundboard')).toBeHidden();

  // Jam controls (start/queue/skip/stop).
  await page.locator('#open-jam').click();
  await expect(page.locator('#jam-panel')).toBeVisible();

  await page.locator('#jam-start-btn').click();
  await expect.poll(() => jamStartCalled).toBeTruthy();
  await expect(page.locator('#jam-now-playing')).toContainText('Lo-fi Focus');

  await page.locator('#jam-search-input').fill('lofi');
  await expect(page.locator('.jam-result-item')).toBeVisible();
  await page.locator('.jam-result-add').first().click();
  await expect.poll(() => jamQueueCalled).toBeTruthy();

  await page.locator('#jam-skip-btn').click();
  await expect.poll(() => jamSkipCalled).toBeTruthy();

  await page.locator('#jam-stop-btn').click();
  await expect.poll(() => jamStopCalled).toBeTruthy();

  const jamShot = path.join(proofDir, `${timestamp}-03-jam-open.png`);
  if (captureParityEvidence) {
    await page.screenshot({ path: jamShot, fullPage: true });
  }

  // Bug report flow.
  await page.locator('#open-bug-report').click();
  await page.locator('#bug-report-desc').fill('Parity bug report smoke test issue details');
  await page.setInputFiles('#bug-report-file', {
    name: 'bug.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71]),
  });
  await page.locator('#submit-bug-report').click();
  await expect.poll(() => bugUploadCalled).toBeTruthy();
  await expect.poll(() => bugReportCalled).toBeTruthy();
  await expect(page.locator('#bug-report-status')).toContainText(/report sent/i);
  await page.locator('#close-bug-report').click();

  // Admin tabs parity (live/history/metrics/bugs/deploys).
  await page.locator('#open-admin-dash').click();
  await expect(page.locator('#admin-dash-panel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Live' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'History' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Metrics' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bugs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deploys' })).toBeVisible();

  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator('#admin-dash-history')).toContainText('Sam');

  await page.getByRole('button', { name: 'Metrics' }).click();
  await expect(page.locator('#admin-dash-metrics')).toContainText('Sessions (30d)');

  await page.getByRole('button', { name: 'Bugs' }).click();
  await expect(page.locator('#admin-dash-bugs')).toContainText('Parity bug report smoke test issue details');

  await page.getByRole('button', { name: 'Deploys' }).click();
  await expect(page.locator('#admin-dash-deploys')).toContainText('viewer-next parity release candidate');

  const adminShot = path.join(proofDir, `${timestamp}-04-admin-open.png`);
  if (captureParityEvidence) {
    await page.screenshot({ path: adminShot, fullPage: true });

    const evidencePath = path.join(proofDir, `${timestamp}-behavior.json`);
    await fs.writeFile(
      evidencePath,
      JSON.stringify(
        {
          timestamp,
          scenarios: [
            'connect/disconnect/reconnect flow with room switch token refresh',
            'legacy control IDs/classes present for connect/media/chat/soundboard shells',
            'chat send/upload/delete handling',
            'theme + settings shell parity checks',
            'soundboard play/edit/upload/update workflows',
            'jam controls (search/queue/start/skip/stop)',
            'bug report submit with screenshot upload',
            'admin dashboard tabs present and populated (live/history/metrics/bugs/deploys)',
          ],
          assertions: {
            tokenRoomRequests,
            soundUpdateCalled,
            soundUploadCalled,
            soundPlayFetches,
            chatUploadCalled,
            chatDeleteCalled,
            bugUploadCalled,
            bugReportCalled,
            jamStartCalled,
            jamSkipCalled,
            jamStopCalled,
            jamQueueCalled,
          },
          screenshots: [shellShot, chatShot, jamShot, adminShot],
        },
        null,
        2,
      ),
      'utf-8',
    );
  }
});
