/**
 * The cleanup of closed browsers' data obeys the Topics setting, at two levels.
 *
 * Removing a whole browser store cannot be undone: the cookies, the logins and
 * the local data of every site in it go for good. Attilio, on #425: cookies and
 * history are what keep the logins, so the default is the harmless level.
 *
 *   - LEVEL 1, on unless switched off: only the cache of the idle orphan stores
 *     (`browser_reap_store_caches`). It NEVER calls the whole-store command, in
 *     any path, and when its own command is missing (an older shell) it removes
 *     nothing instead of falling back;
 *   - LEVEL 2, off unless switched on, and only while level 1 is on: the whole
 *     store (`browser_reap_data_stores`), and only that command;
 *   - level 1 off: nothing is removed, and neither the keep list nor any Tauri
 *     command is ever called, whatever level 2 says;
 *   - the age threshold handed to Tauri is the one in the setting, brought back
 *     inside 7..365 days;
 *   - nothing stored (a person who never opened the setting): level 1, 60 days;
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
 * @covers BROWSER-STORE-REAP-01, BROWSER-STORE-REAP-02, BROWSER-STORE-REAP-03, BROWSER-STORE-REAP-04, BROWSER-STORE-REAP-07, BROWSER-STORE-REAP-08
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
// With `levels=2`: the server gives the list only to a client that knows the
// two levels. The bare path is what a shell up to 2.3.23 asks, and it gets 404.
const KEEP_LIST_PATH = '/api/browsers/data-store-keep-list?levels=2';
const WHOLE_COMMAND = 'browser_reap_data_stores';
const CACHE_COMMAND = 'browser_reap_store_caches';

type Invoke = { cmd: string; args?: Record<string, unknown> };

let invokes: Invoke[] = [];
let requested: string[] = [];
/** Commands that throw when invoked, as an older shell does for one it lacks. */
let missingCommands = new Set<string>();
let settingsAnswer: () => Promise<Response> = () => answer({ settings: {} });
let keepListAnswer: () => Promise<Response> = () => answer({ contextIds: ['ctx-open'] });

function answer(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

/** What `GET /api/app-settings` holds for the three fields. */
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
    if (missingCommands.has(cmd)) return Promise.reject(new Error(`command ${cmd} not found`));
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

const cacheCalls = () => invokes.filter((i) => i.cmd === CACHE_COMMAND);
const wholeCalls = () => invokes.filter((i) => i.cmd === WHOLE_COMMAND);
const askedKeepList = () => requested.includes(KEEP_LIST_PATH);

beforeEach(() => {
  invokes = [];
  requested = [];
  missingCommands = new Set();
  stored({ browserStoreCacheReapEnabled: null, browserStoreReapEnabled: null, browserStoreReapAfterDays: null });
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

/** Level 1 on (stored), level 2 as given: the whole-store mode when true. */
const LEVEL_2_ON = { browserStoreCacheReapEnabled: true, browserStoreReapEnabled: true };

describe('level 1 switched off: nothing is removed and nothing is asked', () => {
  test('no Tauri command and no keep list', async () => {
    stored({ browserStoreCacheReapEnabled: false, browserStoreReapEnabled: false, browserStoreReapAfterDays: 90 });

    const removed = await reapBrowserDataStores();

    expect(invokes).toEqual([]);
    expect(askedKeepList()).toBe(false);
    expect(removed).toBe(-1);
  });

  test('level 2 stored as on removes nothing while level 1 is off', async () => {
    // The panel disables level 2 while level 1 is off, but a row written before
    // that, or by hand, can still hold both: the reaper is the last word.
    stored({ browserStoreCacheReapEnabled: false, browserStoreReapEnabled: true, browserStoreReapAfterDays: 90 });

    const removed = await reapBrowserDataStores();

    expect(invokes).toEqual([]);
    expect(askedKeepList()).toBe(false);
    expect(removed).toBe(-1);
  });
});

describe('level 1 (the default): only the cache is emptied, never the whole store', () => {
  test('nothing stored: the cache command alone, with the keep list and 60 days', async () => {
    const removed = await reapBrowserDataStores();

    expect(requested).toEqual([SETTINGS_PATH, KEEP_LIST_PATH]);
    expect(invokes).toEqual([{ cmd: CACHE_COMMAND, args: { keepIds: ['ctx-open'], maxAgeDays: 60 } }]);
    expect(wholeCalls()).toEqual([]);
    expect(removed).toBe(3);
  });

  test('level 1 stored as on and level 2 stored as off: the cache command alone', async () => {
    stored({ browserStoreCacheReapEnabled: true, browserStoreReapEnabled: false, browserStoreReapAfterDays: 30 });

    await reapBrowserDataStores();

    expect(invokes).toEqual([{ cmd: CACHE_COMMAND, args: { keepIds: ['ctx-open'], maxAgeDays: 30 } }]);
  });

  test('level 2 is OFF by default: every shape of "never said so" stays on the cache level', async () => {
    // NULL, a field a server older than the setting does not send, and values
    // that are not an explicit `true`: none of them is a permission to remove
    // whole stores.
    const notTrue: unknown[] = [null, undefined, false, 0, 1, 'true', 'on'];
    for (const level2 of notTrue) {
      invokes = [];
      stored({ browserStoreCacheReapEnabled: null, browserStoreReapEnabled: level2, browserStoreReapAfterDays: null });

      await reapBrowserDataStores();

      expect({ level2, whole: wholeCalls().length, cache: cacheCalls().length }).toEqual({ level2, whole: 0, cache: 1 });
    }
  });

  test('a server that does not know the fields yet reads as never touched: level 1, 60 days', async () => {
    stored({});

    await reapBrowserDataStores();

    expect(invokes).toEqual([{ cmd: CACHE_COMMAND, args: { keepIds: ['ctx-open'], maxAgeDays: 60 } }]);
  });

  test('the shell does not know the cache command (older shell): nothing is removed, no fallback', async () => {
    // The reason level 1 is a command of its own: an older shell fails on a
    // command it does not know, while it would ignore an extra argument and
    // remove whole stores. And the reaper must not turn that failure into the
    // destructive call.
    missingCommands = new Set([CACHE_COMMAND]);

    const removed = await reapBrowserDataStores();

    expect(removed).toBe(-1);
    expect(wholeCalls()).toEqual([]);
    expect(invokes.map((i) => i.cmd)).toEqual([CACHE_COMMAND]);
  });

  test('never the whole-store command, in any path of level 1', async () => {
    // Every way a level 1 round can end: it worked, the command threw, the keep
    // list failed in three ways, the setting did not arrive. None of them may
    // reach `browser_reap_data_stores`.
    const rounds: Array<[string, () => void]> = [
      ['it worked', () => {}],
      ['the cache command throws', () => { missingCommands = new Set([CACHE_COMMAND]); }],
      ['the keep list answers 500', () => { keepListAnswer = () => answer({ error: 'boom' }, 500); }],
      ['the keep list cannot be reached', () => { keepListAnswer = () => Promise.reject(new TypeError('Failed to fetch')); }],
      ['the keep list has no ids', () => { keepListAnswer = () => answer({}); }],
      ['the setting answers 503', () => { settingsAnswer = () => answer({ ok: false }, 503); }],
      ['the setting cannot be reached', () => { settingsAnswer = () => Promise.reject(new TypeError('Failed to fetch')); }],
    ];
    for (const [name, arrange] of rounds) {
      invokes = [];
      missingCommands = new Set();
      stored({ browserStoreCacheReapEnabled: true, browserStoreReapEnabled: false, browserStoreReapAfterDays: 45 });
      keepListAnswer = () => answer({ contextIds: ['ctx-open'] });
      arrange();

      await reapBrowserDataStores();

      expect({ name, whole: wholeCalls().length }).toEqual({ name, whole: 0 });
    }
  });
});

describe('level 2 on top of level 1: the whole store, and only the whole store', () => {
  test('both on: the whole-store command alone, never the cache one', async () => {
    stored({ ...LEVEL_2_ON, browserStoreReapAfterDays: 14 });

    const removed = await reapBrowserDataStores();

    expect(invokes).toEqual([{ cmd: WHOLE_COMMAND, args: { keepIds: ['ctx-open'], maxAgeDays: 14 } }]);
    expect(cacheCalls()).toEqual([]);
    expect(removed).toBe(3);
  });

  test('level 1 never touched (NULL) and level 2 on: still the whole store', async () => {
    stored({ browserStoreCacheReapEnabled: null, browserStoreReapEnabled: true, browserStoreReapAfterDays: null });

    await reapBrowserDataStores();

    expect(invokes).toEqual([{ cmd: WHOLE_COMMAND, args: { keepIds: ['ctx-open'], maxAgeDays: 60 } }]);
  });

  test('the command throws: -1, and nothing else is called', async () => {
    stored({ ...LEVEL_2_ON });
    missingCommands = new Set([WHOLE_COMMAND]);

    expect(await reapBrowserDataStores()).toBe(-1);
    expect(invokes.map((i) => i.cmd)).toEqual([WHOLE_COMMAND]);
  });
});

describe('the age threshold handed to Tauri is the one in the setting', () => {
  test('a stored number of days reaches the command as it is, at both levels', async () => {
    for (const level2 of [false, true]) {
      const cmd = level2 ? WHOLE_COMMAND : CACHE_COMMAND;
      for (const days of [14, 90, 200]) {
        invokes = [];
        stored({ browserStoreCacheReapEnabled: true, browserStoreReapEnabled: level2, browserStoreReapAfterDays: days });

        await reapBrowserDataStores();

        expect(invokes).toEqual([{ cmd, args: { keepIds: ['ctx-open'], maxAgeDays: days } }]);
      }
    }
  });

  test('outside 7..365 it is brought back to the nearest limit before Tauri', async () => {
    const cases: Array<[number, number]> = [[3, 7], [0, 7], [-20, 7], [1000, 365], [366, 365]];
    for (const [written, sent] of cases) {
      invokes = [];
      stored({ browserStoreCacheReapEnabled: true, browserStoreReapAfterDays: written });

      await reapBrowserDataStores();

      expect(invokes.map((c) => c.args?.maxAgeDays)).toEqual([sent]);
    }
  });
});

describe('the threshold reaches Tauri as a whole number of days', () => {
  test('a fraction stored by hand or by an older build is rounded before Tauri', async () => {
    // The commands take `max_age_days: u64`. A 14.4 handed over as it is makes
    // the invoke fail, the reaper return -1, and the cleanup quietly never run.
    const cases: Array<[number, number]> = [[14.4, 14], [30.6, 31], [200.5, 201]];
    for (const [written, sent] of cases) {
      invokes = [];
      stored({ browserStoreCacheReapEnabled: true, browserStoreReapAfterDays: written });

      await reapBrowserDataStores();

      const days = invokes.map((c) => c.args?.maxAgeDays);
      expect(days).toEqual([sent]);
      expect(Number.isInteger(days[0])).toBe(true);
    }
  });
});

describe('a setting that did not arrive is not a permission', () => {
  const failures: Array<[string, () => Promise<Response>]> = [
    ['the server answers 500', () => answer({ error: 'boom' }, 500)],
    // What the server answers when it could not read the row: never a 200 with
    // every field NULL, which would read as never touched, so level 1 on.
    ['the server could not read the setting (503)', () => answer({ ok: false, error: 'settings unreadable' }, 503)],
    ['the server cannot be reached', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the answer carries no settings', () => answer({})],
    // A failure is a failure whatever its body says: a proxy or an older
    // server can answer an error status with a settings object inside.
    ['a 500 that carries settings switched on', () => answer({ settings: { ...LEVEL_2_ON, browserStoreReapAfterDays: 30 } }, 500)],
    ['a 401 that carries settings', () => answer({ settings: {} }, 401)],
    // A 200 whose settings are not an object: reading fields off a string or
    // a number gives undefined, which would resolve to level 1, 60 days.
    ['a 200 whose settings are a string', () => answer({ settings: 'on' })],
    ['a 200 whose settings are a number', () => answer({ settings: 1 })],
  ];
  for (const [name, failure] of failures) {
    test(`${name}: no keep list, no Tauri command`, async () => {
      settingsAnswer = failure;

      const removed = await reapBrowserDataStores();

      expect(invokes).toEqual([]);
      expect(askedKeepList()).toBe(false);
      expect(removed).toBe(-1);
    });
  }
});

describe('switched back on, the cleanup runs again', () => {
  test('off at one start, on at the next: the second start empties the caches', async () => {
    stored({ browserStoreCacheReapEnabled: false, browserStoreReapAfterDays: 30 });
    expect(await reapBrowserDataStores()).toBe(-1);
    expect(invokes).toEqual([]);

    stored({ browserStoreCacheReapEnabled: true, browserStoreReapAfterDays: 30 });
    expect(await reapBrowserDataStores()).toBe(3);
    expect(invokes).toEqual([{ cmd: CACHE_COMMAND, args: { keepIds: ['ctx-open'], maxAgeDays: 30 } }]);
  });
});

describe('switched on, the keep list is still required', () => {
  test('a keep list that did not arrive removes nothing, at either level', async () => {
    keepListAnswer = () => answer({ error: 'boom' }, 500);

    for (const level2 of [false, true]) {
      stored({ browserStoreCacheReapEnabled: true, browserStoreReapEnabled: level2 });
      expect(await reapBrowserDataStores()).toBe(-1);
    }
    expect(invokes).toEqual([]);
  });

  // An empty list makes every store an orphan: a ui_state that lost its rows,
  // or a server that read none, would empty or remove all of them at once.
  test('an empty keep list removes nothing, at either level', async () => {
    for (const ids of [[], ['', 7, null]]) {
      keepListAnswer = () => answer({ contextIds: ids });
      for (const level2 of [false, true]) {
        stored({ browserStoreCacheReapEnabled: true, browserStoreReapEnabled: level2 });
        expect(await reapBrowserDataStores()).toBe(-1);
      }
    }
    expect(invokes).toEqual([]);
  });

  test('the keep list is asked as a client that knows the two levels', async () => {
    expect(await reapBrowserDataStores()).toBe(3);
    expect(requested.filter((path) => path.startsWith('/api/browsers/'))).toEqual([KEEP_LIST_PATH]);
  });
});
