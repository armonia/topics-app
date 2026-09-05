/**
 * The Tauri updater adapter — the side that actually talks to the shell, and
 * the side no test covered.
 *
 * Why a file of its own, and why a mock: `isTauri` (`shell/index.ts`) is a
 * constant computed at module load, so under `bun test` it is always false and
 * `getUpdaterApi()` returns undefined. The lever is `mock.module('./shell/index')`,
 * which is process-wide: `afterAll` puts the real module back. Same pattern,
 * and same reasons, as `shell/net.tauri.test.ts`.
 *
 * What it pins, both of them measured on the shipped app:
 *   · a check that finds nothing is `up-to-date`, not `idle` — `idle` means "no
 *     check has been made" and no surface draws it, so an explicit "Check for
 *     updates…" answered with a flash and then silence.
 *   · "Download" DOWNLOADS. It used to set `ready` without invoking anything:
 *     the popover showed a green "new version ready" and the banner went
 *     sticky over zero bytes (visible by unplugging the network first).
 * @covers UPDATER-04
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

let realIndex: {
  isTauri: boolean;
  isDesktop: boolean;
  shellKind: 'tauri' | 'web';
  detectShell: () => 'tauri' | 'web';
};

/** Commands the adapter asked the shell for, in order. */
let invoked: string[];
/** What the next `invoke` does: resolve with this, or throw when it is an Error. */
let nextResult: unknown = null;

const realWindow = (globalThis as unknown as { window?: unknown }).window;

async function loadUpdater() {
  const { getUpdaterApi, updateTitle, updateErrorKey, shouldShowUpdaterToast } = await import('./updater');
  return { getUpdaterApi, updateTitle, updateErrorKey, shouldShowUpdaterToast };
}
let updater: Awaited<ReturnType<typeof loadUpdater>>;

beforeAll(async () => {
  invoked = [];
  (globalThis as unknown as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string) => {
        invoked.push(cmd);
        return nextResult instanceof Error ? Promise.reject(nextResult) : Promise.resolve(nextResult);
      },
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  const { isTauri, isDesktop, shellKind, detectShell } = await import('./shell/index');
  realIndex = { isTauri, isDesktop, shellKind, detectShell };
  mock.module('./shell/index', () => ({
    ...realIndex,
    isTauri: true,
    isDesktop: true,
    shellKind: 'tauri' as const,
    detectShell: () => 'tauri' as const,
  }));
  updater = await loadUpdater();
  // If this fails the mock did not take and every test below would be green for
  // the wrong reason: it would be exercising the web branch (no updater at all).
  expect(updater.getUpdaterApi()).toBeDefined();
});

afterAll(() => {
  mock.module('./shell/index', () => realIndex);
  (globalThis as unknown as { window?: unknown }).window = realWindow;
});

describe('a check that finds nothing has something to say', () => {
  test('no update available lands on `up-to-date`, not on `idle`', async () => {
    const api = updater.getUpdaterApi()!;
    nextResult = null;
    await api.checkForUpdates();
    const s = await api.status();
    expect(s.state).toBe('up-to-date');
    // And the toast draws it, which is the whole point of the state existing.
    expect(
      updater.shouldShowUpdaterToast(s, { dismissed: false, versionPopoverOpen: false }),
    ).toBe(true);
  });

  test('the silent boot check still says nothing', async () => {
    const api = updater.getUpdaterApi()!;
    nextResult = null;
    await api.checkForUpdates({ silent: true });
    const s = await api.status();
    expect(s.state).toBe('up-to-date');
    expect(
      updater.shouldShowUpdaterToast(s, { dismissed: false, versionPopoverOpen: false }),
    ).toBe(false);
  });
});

describe('"Download" downloads', () => {
  test('nothing is `ready` unless the shell was actually asked to install', async () => {
    const api = updater.getUpdaterApi()!;
    invoked = [];
    nextResult = new Error('Network Error: error sending request for url (https://…)');
    await api.downloadUpdate!();
    expect(invoked).toEqual(['updater_install']);
    const s = await api.status();
    expect(s.state).not.toBe('ready');
    expect(s.state).toBe('error');
  });

  test('the raw transport error never becomes the headline', async () => {
    const s = await updater.getUpdaterApi()!.status();
    expect(updater.updateTitle(s).key).toBe('update.err.network');
  });
});
