import { expect, test } from '@playwright/test';
const runtimeErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
});
test.afterEach(async ({ page }) => expect(runtimeErrors.get(page)).toEqual([]));

test('the production viewer route serves the ready notice without a mocked response', async ({ request }) => {
  const response = await request.get('/viewer/restart-notice.json');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ state: 'ready' });
});

async function prepareNoticePage(page) {
  await page.addInitScript(() => {
    window.testRestartSpeech = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak(message) { window.testRestartSpeech.push(message.text); },
    } });
  });
  await page.goto('/?echo-ui-shell-v2=1', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    getControlUrl = () => location.origin;
    localStorage.setItem('echo-changelog-seen', CHANGELOG_LATEST);
  });
}

test('planned restart is announced once, survives the outage, and clears when ready', async ({ page }, testInfo) => {
  let state = { state: 'ready' };
  let offline = false;
  await page.route('**/viewer/restart-notice.json', route => offline
    ? route.abort('connectionrefused')
    : route.fulfill({ contentType: 'application/json', body: JSON.stringify(state) }));
  await prepareNoticePage(page);
  state = { state: 'restarting', id: 'fa7ff560-8ac3-4dd0-8828-77d8d5261f31', started_at: Date.now(), expires_at: Date.now() + 120000 };
  // The normal four-second polling loop must pick up the deployment marker.
  const banner = page.locator('#server-restart-banner');
  await expect(banner).toHaveText('The server is restarting. Echo will reconnect when it is ready.');
  await expect(banner).toHaveAttribute('role', 'alert');
  expect(await page.evaluate(() => window.testRestartSpeech)).toEqual(['The server is restarting']);
  await page.evaluate(() => checkServerRestartNotice());
  expect(await page.evaluate(() => window.testRestartSpeech)).toHaveLength(1);
  await expect.poll(() => banner.evaluate(element => element.getBoundingClientRect().top)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('planned-restart-notice.png') });
  offline = true;
  await page.evaluate(() => checkServerRestartNotice());
  await expect(banner).toBeVisible();
  offline = false;
  // A page reload must not speak the same restart again.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { getControlUrl = () => location.origin; return checkServerRestartNotice(); });
  await expect(banner).toBeVisible();
  expect(await page.evaluate(() => window.testRestartSpeech)).toHaveLength(0);
  state = { state: 'ready' };
  await page.evaluate(() => checkServerRestartNotice());
  await expect(banner).toHaveCount(0);
});

test('ordinary outages and expired deployment markers never announce a restart', async ({ page }) => {
  let state = { state: 'restarting', id: 'fa7ff560-8ac3-4dd0-8828-77d8d5261f31', started_at: Date.now() - 180000, expires_at: Date.now() - 60000 };
  await page.route('**/viewer/restart-notice.json', route => route.fulfill({ status: state ? 200 : 503,
    contentType: 'application/json', body: JSON.stringify(state || {}) }));
  await prepareNoticePage(page);
  await page.evaluate(() => checkServerRestartNotice());
  await expect(page.locator('#server-restart-banner')).toHaveCount(0);
  state = null;
  await page.evaluate(() => checkServerRestartNotice());
  await expect(page.locator('#server-restart-banner')).toHaveCount(0);
  expect(await page.evaluate(() => window.testRestartSpeech)).toHaveLength(0);
});

test('viewer update notes remain unread across reloads until dismissed, then stay in Updates history', async ({ page }, testInfo) => {
  await page.goto('/?echo-ui-shell-v2=1', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('echo-changelog-seen', 'v0.6.37'));
  const popup = page.locator('.whats-new-overlay:not(.updates-overlay)');
  await expect(popup).toBeVisible();
  await expect(popup.getByRole('heading')).toHaveText('Better Screen Sharing & Update Notices');
  await expect(popup).toContainText('top-right speaker');
  expect(await page.evaluate(() => localStorage.getItem('echo-changelog-seen'))).toBe('v0.6.37');
  await page.screenshot({ path: testInfo.outputPath('screen-sharing-update-notes.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(popup).toBeVisible();
  await popup.getByRole('button', { name: 'Got it' }).click();
  await expect(popup).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('echo-changelog-seen') === CHANGELOG_LATEST)).toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  // Allow the normal startup popup check to execute.
  await page.waitForTimeout(2800);
  await expect(popup).toHaveCount(0);
  await page.evaluate(() => showUpdatesPanel());
  await expect(page.locator('.updates-overlay')).toContainText('Better Screen Sharing & Update Notices');
  await expect(page.locator('.updates-overlay')).toContainText('Screen Audio Isolation');
});
