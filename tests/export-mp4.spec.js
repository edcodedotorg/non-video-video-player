import { test, expect } from '@playwright/test';

test('export mp4 initializes ffmpeg without init failure', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');

  const lightweightProject = {
    width: 1280,
    height: 720,
    scenes: [
      {
        duration: '1s',
        comment: 'Playwright Smoke Test',
        speech: '',
        html: "<html><body style='margin:0;display:flex;align-items:center;justify-content:center;height:100%;font-family:sans-serif;'><h1>Export OK</h1></body></html>",
        pauseBackground: false,
      },
    ],
    audio: 'data:audio/mpeg;base64,',
  };

  const jsonEditor = page.locator('#video-json');
  await jsonEditor.fill(JSON.stringify(lightweightProject, null, 2));
  await page.getByRole('button', { name: 'Render in Player' }).click();

  const exportButton = page.getByRole('button', { name: 'Export MP4' });
  await expect(exportButton).toBeEnabled();

  const status = page.locator('#export-status-text');
  await exportButton.click();

  await expect(status).not.toContainText('Init Failed', { timeout: 20_000 });
  await expect(status).toContainText('FFmpeg Ready.', { timeout: 30_000 });
});
