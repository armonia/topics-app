/**
 * @covers RUNTIME-23
 */
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/chat.fixture';
import { goToApp, openTestChat } from './helpers';
import { openPerfPanel } from './helpers/open-perf-panel';
import { hermetic } from './fixtures/hermetic';

hermetic(test);

const WINDOW_MS = 10_000;
const MAX_HIDDEN_CALLBACKS = 12;

interface CallbackProbe {
  count: number;
  sources: Record<string, number>;
  enabled: boolean;
  /** The page's own setTimeout, unwrapped: the measuring window must not count itself. */
  sleep: (ms: number) => Promise<void>;
}

async function setHidden(page: Page, value: boolean): Promise<void> {
  await page.evaluate((next) => {
    (window as unknown as { __topicsHidden: boolean }).__topicsHidden = next;
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

test('timer callbacks sleep while the app is hidden, and the data is fresh on return', async ({ page, context }) => {
  test.info().annotations.push({ type: 'spec', description: 'RUNTIME-23' });
  let openSessions = 1;
  let presenceRequests = 0;
  await page.addInitScript(() => {
    // Under Playwright a foreground page stays `visible` (a second tab brought to the front does
    // not hide it in headless Chromium), so the test drives the property the app reads, the way
    // idle-frame-budget does. Chrome then throttles nothing: the count is the app's own discipline.
    const hidden = window as unknown as { __topicsHidden: boolean };
    hidden.__topicsHidden = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden.__topicsHidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden.__topicsHidden });
    const unwrappedTimeout = window.setTimeout.bind(window);
    const probe: CallbackProbe = { count: 0, sources: {}, enabled: false, sleep: (ms) => new Promise((resolve) => { unwrappedTimeout(resolve, ms); }) };
    (window as unknown as { __callbackProbe: CallbackProbe }).__callbackProbe = probe;
    const source = () => {
      const stack = new Error().stack ?? '';
      return stack.split('\n').find((line) => /\/(client|assets)\//.test(line))?.trim() ?? 'unknown';
    };

    const originalInterval = window.setInterval.bind(window);
    window.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof callback !== 'function') return originalInterval(callback, delay, ...args);
      const origin = source();
      return originalInterval(() => {
        if (probe.enabled) {
          probe.count += 1;
          probe.sources[origin] = (probe.sources[origin] ?? 0) + 1;
        }
        callback(...args);
      }, delay);
    }) as typeof window.setInterval;

    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (typeof callback !== 'function') return originalTimeout(callback, delay, ...args);
      const origin = source();
      return originalTimeout(() => {
        if (probe.enabled) {
          probe.count += 1;
          probe.sources[origin] = (probe.sources[origin] ?? 0) + 1;
        }
        callback(...args);
      }, delay);
    }) as typeof window.setTimeout;

    const originalFrameRequest = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const origin = source();
      return originalFrameRequest((time) => {
        if (probe.enabled) {
          probe.count += 1;
          probe.sources[origin] = (probe.sources[origin] ?? 0) + 1;
        }
        callback(time);
      });
    }) as typeof window.requestAnimationFrame;
  });
  await context.route('**/api/system/presence', (route) => {
    presenceRequests += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ openSessions, workingSessions: 0, activeTasks: 0, focusProject: null, externalSessions: 0, externalWorking: 0 }),
    });
  });

  await goToApp(page);
  await openTestChat(page);
  await expect.poll(() => presenceRequests).toBeGreaterThan(0);
  const profile = page.getByTestId('identity-me-profile');
  await expect.poll(() => profile.getAttribute('title')).not.toBeNull();
  const beforeTitle = await profile.getAttribute('title');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'board' } })));
  await expect(page.getByTestId('kanban-board')).toBeVisible();
  await openPerfPanel(page);
  await expect(page.getByTestId('perf-inventory')).toBeVisible({ timeout: 10_000 });

  await setHidden(page, true);
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('hidden');

  const mode = 'visibilityState driven by the test, visibilitychange dispatched';
  await page.evaluate(() => {
    const state = (window as unknown as { __callbackProbe: CallbackProbe }).__callbackProbe;
    state.count = 0;
    state.sources = {};
    state.enabled = true;
  });
  // The measuring window itself: callbacks are counted for exactly this long, inside the page.
  const probe = await page.evaluate(async (windowMs) => {
    const state = (window as unknown as { __callbackProbe: CallbackProbe }).__callbackProbe;
    await state.sleep(windowMs);
    state.enabled = false;
    return { count: state.count, sources: state.sources };
  }, WINDOW_MS);

  console.log(`[D2a/background] mode=${mode} hidden=${await page.evaluate(() => document.visibilityState)} callbacks=${probe.count}/${WINDOW_MS}ms`);
  console.log(Object.entries(probe.sources).sort((a, b) => b[1] - a[1]).map(([source, count]) => `${count}× ${source}`).join('\n'));
  expect(probe.count, 'timer callbacks while document.hidden').toBeLessThanOrEqual(MAX_HIDDEN_CALLBACKS);

  openSessions = 9;
  await setHidden(page, false);
  await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible');
  await expect.poll(() => profile.getAttribute('title'), { timeout: 1000 }).not.toBe(beforeTitle);
  await expect(page.getByTestId('kanban-board')).toBeVisible();
});
