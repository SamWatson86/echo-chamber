import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('login + core shell journey (mocked APIs)', async ({ page }) => {
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

  await page.goto('/');

  await page.getByLabel('Control URL').fill('https://control.mock.local');
  await page.getByLabel('Name').fill('Parity Viewer');
  await page.getByLabel('Admin password').fill('test-password');
  await page.locator('#connect').click();

  await expect(page.locator('#status')).toHaveText(/Connected/i);
  await expect(page.getByRole('button', { name: 'Main' })).toBeVisible();
  await expect(page.locator('#user-list')).toContainText('Sam');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const proofDir = path.resolve(process.cwd(), '../../docs/proof/parity');
  await fs.mkdir(proofDir, { recursive: true });

  const shellShot = path.join(proofDir, `${timestamp}-01-connected-shell.png`);
  await page.screenshot({ path: shellShot, fullPage: true });

  await page.getByRole('button', { name: /^Chat$/ }).click();
  await page.locator('#chat-input').fill('React parity chat smoke message');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('#chat-messages')).toContainText('React parity chat smoke message');

  const chatShot = path.join(proofDir, `${timestamp}-02-chat-open.png`);
  await page.screenshot({ path: chatShot, fullPage: true });

  await page.getByRole('button', { name: 'Theme' }).click();
  await expect(page.locator('#theme-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Cyberpunk' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'cyberpunk');

  const themeShot = path.join(proofDir, `${timestamp}-03-theme-open.png`);
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
        ],
        screenshots: [shellShot, chatShot, themeShot],
      },
      null,
      2,
    ),
    'utf-8',
  );
});
