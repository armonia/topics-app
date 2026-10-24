/**
 * The cleanup of closed browsers' data obeys the Topics setting.
 *
 * Removing a browser store cannot be undone: the cookies, the logins and the
 * local data of every site in it go for good. That is why the cleanup is a
 * setting (Attilio, approving #425: it has to be a Topics setting), and why the
 * reaper reads it at every start BEFORE it asks anything else:
 *
 *   - off: nothing is removed, and neither the keep list nor the Tauri command
 *     is ever called;
 *   - the age threshold handed to Tauri is the one in the setting, brought back
 *     inside 7..365 days;
 *   - nothing stored (a person who never opened the setting): on, 60 days;
 *   - a setting that did not arrive counts as no permission, the same rule the
 *     reaper already applies to a keep list that did not arrive.
 *
 * The mocks follow `browserClaimHeartbeat.test.ts`. `isTauri` is a constant
 * computed when `./shell` loads, so under `bun test` it is false and the branch
 * that matters is unreachable: `mock.module` rewrites the module in the
 * registry. `./shell/net` is rewritten as well, and that is a safety choice and
 * not a convenience: under a faked Tauri the real `apiFetch` aims at the
 * shell's loopback proxy, which is the production server of whoever runs the
 * test. Here no request can leave the process.
 *
 * @covers BROWSER-STORE-REAP-01, BROWSER-STORE-REAP-02, BROWSER-STORE-REAP-03, BROWSER-STORE-REAP-04
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
// THE REAL MODULES, TAKEN BEFORE THEY ARE REPLACED, named one by one for the
// same reason `browserClaimHeartbeat.test.ts` gives: whatever is missing here
// comes back `undefined` for every file that runs after the undo.
import { detectShell, shellKind, isTauri, isDesktop, isTauriWindows } from './shell';
import {
  currentWindowLabel as realCurrentWindowLabel,
  tauriInvoke as realTauriInvoke,
  releaseNativeFocus as realReleaseNativeFocus,
  focusBrowserPane as realFocusBrowserPane,
} from './shell/tauri';
import {
  serverHttpBase as realServerHttpBase,
  isAppLoopbackOrigin as realIsAppLoopbackOrigin,
  serverWsBase as realServerWsBase,
  apiFetch as realApiFetch,
  __resetNetShimForTests as realResetNetShim,
  installNetShim as realInstallNetShim,
} from './shell/net';

const realShell = { detectShell, shellKind, isTauri, isDesktop, isTauriWindows };
const realTauri = {
  currentWindowLabel: realCurrentWindowLabel,
  tauriInvoke: realTauriInvoke,
  releaseNativeFocus: realReleaseNativeFocus,
  focusBrowserPane: realFocusBrowserPane,
};
const realNet = {
  serverHttpBase: realServerHttpBase,
  isAppLoopbackOrigin: realIsAppLoopbackOrigin,
  serverWsBase: realServerWsBase,
  apiFetch: realApiFetch,
  __resetNetShimForTests: realResetNetShim,
  installNetShim: realInstallNetShim,
};

const SETTINGS_PATH = '/api/app-settings';
const KEEP_LIST_PATH = '/api/browsers/data-store-keep-list';
const REAP_COMMAND = 'browser_reap_data_stores';

type Invoke = { cmd: string; args?: Record<string, unknown> };

let invokes: Invoke[] = [];
let requested: string[] = [];
let settingsAnswer: () => Promise<Response> = () => answer({ settings: {} });
let keepListAnswer: () => Promise<Response> = () => answer({ contextIds: [] });

function answer(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

/** What `GET /api/app-settings` holds for the two fields. */
function stored(fields: Record<string, unknown>): void {
  settingsAnswer = () => answer({ settings: fields });
}

mock.module('./shell', () => ({
  isTauri: true,
  isDesktop: true,
  isTauriWindows: false,
  shellKind: 'tauri' as const,
  detectShell: () => 'tauri' as const,
}));
mock.module('./shell/tauri', () => ({
  currentWindowLabel: () => 'main',
  tauriInvoke: (cmd: string, args?: Record<string, unknown>) => {
    invokes.push({ cmd, args });
    return Promise.resolve(3);
  },
  releaseNativeFocus: () => {},
  focusBrowserPane: () => {},
}));
mock.module('./shell/net', () => ({
  serverHttpBase: () => '',
  isAppLoopbackOrigin: () => false,
  serverWsBase: () => '',
  apiFetch: (path: string) => {
    requested.push(path);
    if (path === SETTINGS_PATH) return settingsAnswer();
    if (path === KEEP_LIST_PATH) return keepListAnswer();
    return Promise.reject(new Error(`unexpected request ${path}`));
  },
  __resetNetShimForTests: () => {},
  installNetShim: () => {},
}));

// After the mocks, and destructured by name: a bare `import()` is opaque to
// knip (`check:deadcode-blindspots`).
const { reapBrowserDataStores } = await import('./browserDataStoreReaper');

const reapCalls = () => invokes.filter((i) => i.cmd === REAP_COMMAND);
const askedKeepList = () => requested.includes(KEEP_LIST_PATH);

beforeEach(() => {
  invokes = [];
  requested = [];
  stored({ browserStoreReapEnabled: null, browserStoreReapAfterDays: null });
  keepListAnswer = () => answer({ contextIds: ['ctx-open'] });
});

// The mock is per PROCESS, and `mock.restore()` alone does not take back a
// `mock.module`: the registry is rewritten with the real modules, as
// `browserClaimHeartbeat.test.ts` does.
afterAll(() => {
  mock.module('./shell', () => realShell);
  mock.module('./shell/tauri', () => realTauri);
  mock.module('./shell/net', () => realNet);
  mock.restore();
});

describe('switched off: nothing is removed and nothing is asked', () => {
  test('no Tauri command and no keep list', async () => {
    stored({ browserStoreReapEnabled: false, browserStoreReapAfterDays: 90 });

    const removed = await reapBrowserDataStores();

    expect(reapCalls()).toEqual([]);
    expect(askedKeepList()).toBe(false);
    expect(removed).toBe(-1);
  });
});

describe('the age threshold handed to Tauri is the one in the setting', () => {
  test('a stored number of days reaches the command as it is', async () => {
    for (const days of [14, 90, 200]) {
      invokes = [];
      stored({ browserStoreReapEnabled: true, browserStoreReapAfterDays: days });

      await reapBrowserDataStores();

      expect(reapCalls()).toEqual([{ cmd: REAP_COMMAND, args: { keepIds: ['ctx-open'], maxAgeDays: days } }]);
    }
  });

  test('outside 7..365 it is brought back to the nearest limit before Tauri', async () => {
    const cases: Array<[number, number]> = [[3, 7], [0, 7], [-20, 7], [1000, 365], [366, 365]];
    for (const [written, sent] of cases) {
      invokes = [];
      stored({ browserStoreReapEnabled: true, browserStoreReapAfterDays: written });

      await reapBrowserDataStores();

      expect(reapCalls().map((c) => c.args?.maxAgeDays)).toEqual([sent]);
    }
  });
});

describe('first start, nothing stored: on, 60 days', () => {
  test('the setting is read first, then the keep list, then Tauri with 60', async () => {
    const removed = await reapBrowserDataStores();

    expect(requested).toEqual([SETTINGS_PATH, KEEP_LIST_PATH]);
    expect(reapCalls()).toEqual([{ cmd: REAP_COMMAND, args: { keepIds: ['ctx-open'], maxAgeDays: 60 } }]);
    expect(removed).toBe(3);
  });

  test('a server that does not know the fields yet reads as never touched', async () => {
    stored({});

    await reapBrowserDataStores();

    expect(reapCalls().map((c) => c.args?.maxAgeDays)).toEqual([60]);
  });
});

describe('a setting that did not arrive is not a permission', () => {
  const failures: Array<[string, () => Promise<Response>]> = [
    ['the server answers 500', () => answer({ error: 'boom' }, 500)],
    ['the server cannot be reached', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the answer carries no settings', () => answer({})],
  ];
  for (const [name, failure] of failures) {
    test(`${name}: no keep list, no Tauri command`, async () => {
      settingsAnswer = failure;

      const removed = await reapBrowserDataStores();

      expect(reapCalls()).toEqual([]);
      expect(askedKeepList()).toBe(false);
      expect(removed).toBe(-1);
    });
  }
});

describe('switched on, the keep list is still required', () => {
  test('a keep list that did not arrive removes nothing', async () => {
    keepListAnswer = () => answer({ error: 'boom' }, 500);

    expect(await reapBrowserDataStores()).toBe(-1);
    expect(reapCalls()).toEqual([]);
  });
});
