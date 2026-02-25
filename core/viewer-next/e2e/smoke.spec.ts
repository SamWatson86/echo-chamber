import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('login + core shell journey (mocked APIs)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__ECHO_ADMIN__ = true;
  });

  await page.route('**/v1/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'mock-admin-token' }),
    });
  });

  await page.route('**/v1/auth/token', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'mock-room-token' }),
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
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      }),
    });
  });

  await page.route('**/api/chime/**', async (route) => {
    const req = route.request();
    if (req.method() === 'HEAD') {
      await route.fulfill({ status: 404, body: '' });
      return;
    }
    await route.fulfill({ status: 404, body: '' });
  });

  await page.route('**/api/soundboard/list**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sounds: [
          { id: 'sound-1', name: 'Airhorn', icon: '🎺', roomId: 'main', volume: 100 },
          { id: 'sound-2', name: 'Applause', icon: '👏', roomId: 'main', volume: 90 },
        ],
      }),
    });
  });

  let soundUpdateCalled = false;
  await page.route('**/api/soundboard/update', async (route) => {
    soundUpdateCalled = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, sound: { id: 'sound-1', name: 'Airhorn v2', icon: '🔥', volume: 95 } }),
    });
  });

  await page.route('**/admin/api/dashboard', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        total_online: 2,
        server_version: '2026.2.24',
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

  await page.route('**/admin/api/bugs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ reports: [] }),
    });
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
  await page.locator('#connect').click();

  await expect(page.locator('#status')).toHaveText(/Connected/i);
  await expect(page.getByRole('button', { name: 'Main' })).toBeVisible();
  await expect(page.locator('#user-list')).toContainText('Sam');

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

  await page.getByRole('button', { name: /^Chat$/ }).click();
  await page.locator('#chat-input').fill('React parity chat smoke message');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('#chat-messages')).toContainText('React parity chat smoke message');

  const chatShot = path.join(proofDir, `${timestamp}-02-chat-open.png`);
  if (captureParityEvidence) {
    await page.screenshot({ path: chatShot, fullPage: true });
  }

  await page.getByRole('button', { name: 'Theme' }).click();
  await expect(page.locator('#theme-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Cyberpunk' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'cyberpunk');
  await page.locator('#close-theme').click();
  await expect(page.locator('#theme-panel')).toBeHidden();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#chime-settings-section')).toBeVisible();

  await page.locator('#open-soundboard').click();
  await page.locator('#open-soundboard-edit').click();
  await expect(page.locator('#soundboard')).toBeVisible();
  await page.locator('.sound-edit').first().click();
  await expect(page.locator('#sound-cancel-edit')).toBeVisible();
  await expect(page.locator('#sound-upload-button')).toHaveText('Save');
  await page.locator('#sound-name').fill('Airhorn v2');
  await page.locator('.sound-icon-btn').nth(2).click();
  await page.locator('#sound-upload-button').click();
  await expect.poll(() => soundUpdateCalled).toBeTruthy();
  await page.locator('#back-to-soundboard').click();
  await page.locator('#close-soundboard').click();
  await expect(page.locator('#soundboard')).toBeHidden();

  await page.locator('#open-admin-dash').click();
  await expect(page.locator('#admin-dash-panel')).toBeVisible();
  await expect(page.locator('#admin-dash-live')).toContainText('Sam');

  const themeShot = path.join(proofDir, `${timestamp}-03-theme-open.png`);
  if (captureParityEvidence) {
    await page.screenshot({ path: themeShot, fullPage: true });

    const evidencePath = path.join(proofDir, `${timestamp}-behavior.json`);
    await fs.writeFile(
      evidencePath,
      JSON.stringify(
        {
          timestamp,
          scenarios: [
            'mock login via /v1/auth/login',
            'connected shell render with room status + online users',
            'chat panel open + send message',
            'theme panel open + apply cyberpunk',
            'settings chime section visible',
            'soundboard edit/save flow hits /api/soundboard/update',
            'admin dashboard opens and renders live participant data',
          ],
          screenshots: [shellShot, chatShot, themeShot],
        },
        null,
        2,
      ),
      'utf-8',
    );
  }
});
