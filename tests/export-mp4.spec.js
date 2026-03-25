import { test, expect } from '@playwright/test';

test('export mp4 does not show init failure', async ({ page }) => {
  await page.goto('/');

  const exportButton = page.getByRole('button', { name: 'Export MP4' });
  await expect(exportButton).toBeEnabled();
  await exportButton.click();

  const status = page.locator('#export-status-text');
  await expect(status).not.toContainText('Init Failed', { timeout: 20_000 });
});
