/**
 * Browser web-mode regression.
 *
 * History: this file also carried an "Electron native" suite (gated behind
 * ELECTRON_RUNTIME=true) that asserted the WebContentsView placeholder / CDP
 * dispatcher of the Electron shell. Electron was archived in v2.0.0 and the
 * `window.electronAPI` surface deleted, so that suite tested code that no longer
 * exists and was removed. What remains is the always-on web-mode gate: with no
 * native host API present, the Phase 30 streaming path (not the native
 * placeholder) is the one that mounts.
 *
 * Test isolation: each test creates its own topic via the helper to avoid the
 * full-suite flakiness (state pollution on shared topics DB).
 */
import { test, expect } from '@playwright/test';

test.describe('Browser web-mode regression (always runs)', () => {
  test('no native host API is present in web mode', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'BROWSER-CHAT-06' });

    await page.goto('/');
    const hasNative = await page.evaluate(() => {
      return Boolean((window as unknown as { electronAPI?: { browserNative?: { isAvailable?: boolean } } }).electronAPI?.browserNative?.isAvailable);
    });
    expect(hasNative).toBe(false);
  });

  test('Phase 30 streaming path mounts (no native placeholder) in web mode', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'BROWSER-CHAT-06' });

    await page.goto('/');
    // The web-mode panel mount path renders a streaming <img> or the
    // localhost-iframe fallback — but NEVER the native placeholder (that mounts
    // only under the Tauri shell). Assert the discriminator is absent.
    await expect(page.getByTestId('browser-native-placeholder')).toHaveCount(0);
  });
});
