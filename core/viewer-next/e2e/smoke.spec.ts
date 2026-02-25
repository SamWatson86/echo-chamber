import { expect, test } from '@playwright/test';

test('loads legacy viewer in parity frame', async ({ page }) => {
  await page.goto('/');

  const frame = page.frameLocator('iframe[title="Echo Chamber Viewer"]');
  await expect(frame.getByRole('heading', { name: 'Echo Chamber' })).toBeVisible();
  await expect(frame.locator('#connect')).toBeVisible();
});
