import { expect, test } from '@playwright/test';

test('shows refactor shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Echo Chamber Frontend Refactor' })).toBeVisible();
  await expect(page.getByText('Viewer Next (React + TS)')).toBeVisible();
});
