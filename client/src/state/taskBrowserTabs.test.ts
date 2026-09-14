/**
 * Tests for the task-owned browser tab group's pure reducer ops. No I/O — the
 * ui-state persistence / React hook layers are exercised only in the app.
  * @covers BROWSER-STATE-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  EMPTY_TASK_TABS,
  mintTaskContextId,
  isTaskContextId,
  addTab,
  upsertTab,
  closeTab,
  unparkTab,
  removeTab,
  liveTabs,
  setActiveTab,
  reorderTabs,
  updateTab,
  sanitizeTaskTabs,
  taskIdFromKey,
  applyRemoteTaskTabs,
  applyRemoteTaskTabsInit,
  resyncTaskTabsFromServer,
  forgetTaskTabs,
  getTaskTabs,
  subscribeTaskTabs,
  taskBrowserTabs,
  __resetTaskTabs,
} from './taskBrowserTabs';

const TASK = '125aafd5-0e15-4aa0-ab25-f00000000000';

describe('mintTaskContextId / isTaskContextId', () => {
  test('mints task-<id8>-<seq>', () => {
    expect(mintTaskContextId(TASK, 0)).toBe('task-125aafd5-0');
    expect(mintTaskContextId(TASK, 3)).toBe('task-125aafd5-3');
  });
  test('isTaskContextId recognizes task- ctx and rejects others', () => {
    expect(isTaskContextId('task-125aafd5-0')).toBe(true);
    expect(isTaskContextId('term-abc')).toBe(false);
    expect(isTaskContextId('125aafd5-...')).toBe(false);
    expect(isTaskContextId('')).toBe(false);
  });
});

describe('addTab', () => {
  test('appends a minted tab and activates it, bumping nextSeq', () => {
    const s1 = addTab(EMPTY_TASK_TABS, TASK, 'https://a.test', 'A');
    expect(s1.tabs).toHaveLength(1);
    expect(s1.tabs[0]).toEqual({ contextId: 'task-125aafd5-0', url: 'https://a.test', title: 'A', seq: 0 });
    expect(s1.activeContextId).toBe('task-125aafd5-0');
    expect(s1.nextSeq).toBe(1);
    const s2 = addTab(s1, TASK, 'https://b.test');
    expect(s2.tabs.map((t) => t.contextId)).toEqual(['task-125aafd5-0', 'task-125aafd5-1']);
    expect(s2.activeContextId).toBe('task-125aafd5-1');
    expect(s2.nextSeq).toBe(2);
  });
});

describe('upsertTab', () => {
  test('adds an externally-minted ctx and advances nextSeq', () => {
    const s = upsertTab(EMPTY_TASK_TABS, 'task-125aafd5-agent', 'https://x.test', 'X');
    expect(s.tabs).toHaveLength(1);
    expect(s.activeContextId).toBe('task-125aafd5-agent');
    expect(s.nextSeq).toBe(1);
  });
  test('is idempotent: same ctx refreshes url/title + activates, no dup', () => {
    const s1 = upsertTab(EMPTY_TASK_TABS, 'task-1-a', 'https://x.test', 'X');
    const s2 = setActiveTab(addTab(s1, TASK, 'https://b.test'), 'task-1-a'); // move active away then back
    const s3 = upsertTab(s2, 'task-1-a', 'https://x2.test', 'X2');
    expect(s3.tabs.filter((t) => t.contextId === 'task-1-a')).toHaveLength(1);
    expect(s3.tabs.find((t) => t.contextId === 'task-1-a')).toMatchObject({ url: 'https://x2.test', title: 'X2' });
    expect(s3.activeContextId).toBe('task-1-a');
  });
});

describe('closeTab (soft-close / park)', () => {
  const base = addTab(addTab(addTab(EMPTY_TASK_TABS, TASK, 'a'), TASK, 'b'), TASK, 'c'); // seq 0,1,2 active=2
  test('soft-close PARKS the tab (kept as preview), does not destroy it', () => {
    const s = closeTab(base, 'task-125aafd5-2'); // close last active → prev live
    expect(s.tabs).toHaveLength(3); // still there
    expect(s.tabs.find((t) => t.seq === 2)?.parked).toBe(true);
    expect(liveTabs(s).map((t) => t.seq)).toEqual([0, 1]);
    expect(s.activeContextId).toBe('task-125aafd5-1');
  });
  test('closing a middle active tab focuses the same index among live tabs', () => {
    const mid = setActiveTab(base, 'task-125aafd5-1');
    const s = closeTab(mid, 'task-125aafd5-1');
    expect(liveTabs(s).map((t) => t.seq)).toEqual([0, 2]);
    expect(s.activeContextId).toBe('task-125aafd5-2'); // live idx 1 clamps to the tab now at 1
  });
  test('closing a non-active tab leaves the active one', () => {
    const s = closeTab(base, 'task-125aafd5-0');
    expect(s.activeContextId).toBe('task-125aafd5-2');
    expect(liveTabs(s).map((t) => t.seq)).toEqual([1, 2]);
  });
  test('closing the last LIVE tab clears active but keeps the parked preview', () => {
    const one = addTab(EMPTY_TASK_TABS, TASK, 'a');
    const s = closeTab(one, 'task-125aafd5-0');
    expect(s.activeContextId).toBeNull();
    expect(s.tabs).toHaveLength(1);
    expect(liveTabs(s)).toHaveLength(0);
  });
  test('closing an already-parked tab is a no-op', () => {
    const parked = closeTab(base, 'task-125aafd5-0');
    expect(closeTab(parked, 'task-125aafd5-0')).toBe(parked);
  });
  test('unknown ctx is a no-op', () => {
    expect(closeTab(base, 'nope')).toBe(base);
  });
});

describe('unparkTab / removeTab', () => {
  const base = addTab(addTab(addTab(EMPTY_TASK_TABS, TASK, 'a'), TASK, 'b'), TASK, 'c');
  test('unparkTab reopens a parked tab and activates it', () => {
    const parked = closeTab(base, 'task-125aafd5-0'); // park seq 0
    const s = unparkTab(parked, 'task-125aafd5-0');
    expect(s.tabs.find((t) => t.seq === 0)?.parked).toBeFalsy();
    expect(liveTabs(s).map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(s.activeContextId).toBe('task-125aafd5-0');
  });
  test('unparkTab is a no-op for a live/unknown ctx', () => {
    expect(unparkTab(base, 'task-125aafd5-1')).toBe(base); // already live
    expect(unparkTab(base, 'nope')).toBe(base);
  });
  test('removeTab hard-deletes and refocuses the live neighbour', () => {
    const s = removeTab(base, 'task-125aafd5-2'); // was active
    expect(s.tabs.map((t) => t.seq)).toEqual([0, 1]);
    expect(s.activeContextId).toBe('task-125aafd5-1');
  });
  test('removeTab on a parked tab drops it without touching active', () => {
    const parked = closeTab(base, 'task-125aafd5-0');
    const s = removeTab(parked, 'task-125aafd5-0');
    expect(s.tabs.map((t) => t.seq)).toEqual([1, 2]);
    expect(s.activeContextId).toBe('task-125aafd5-2');
  });
});

describe('upsertTab reopens a parked tab', () => {
  test('an agent re-open of a parked ctx un-parks + refreshes + activates', () => {
    const base = upsertTab(EMPTY_TASK_TABS, 'task-1-a', 'https://x.test', 'X');
    const parked = closeTab(base, 'task-1-a');
    expect(parked.tabs[0].parked).toBe(true);
    const s = upsertTab(parked, 'task-1-a', 'https://x2.test', 'X2');
    expect(s.tabs[0]).toMatchObject({ url: 'https://x2.test', title: 'X2', parked: false });
    expect(s.activeContextId).toBe('task-1-a');
  });
});

describe('setActiveTab / reorderTabs / updateTab', () => {
  const base = addTab(addTab(EMPTY_TASK_TABS, TASK, 'a'), TASK, 'b');
  test('setActiveTab ignores unknown ctx', () => {
    expect(setActiveTab(base, 'nope')).toBe(base);
  });
  test('setActiveTab ignores a parked ctx (reopen is via unparkTab)', () => {
    const parked = closeTab(base, 'task-125aafd5-0');
    expect(setActiveTab(parked, 'task-125aafd5-0')).toBe(parked);
  });
  test('reorderTabs moves a tab', () => {
    const s = reorderTabs(base, 0, 1);
    expect(s.tabs.map((t) => t.seq)).toEqual([1, 0]);
  });
  test('reorderTabs is a no-op for same/out-of-range indices', () => {
    expect(reorderTabs(base, 0, 0)).toBe(base);
    expect(reorderTabs(base, 5, 0)).toBe(base);
  });
  test('updateTab merges url/title, no-op when unchanged', () => {
    const s = updateTab(base, 'task-125aafd5-0', { url: 'https://a2.test', title: 'A2' });
    expect(s.tabs[0]).toMatchObject({ url: 'https://a2.test', title: 'A2' });
    expect(updateTab(s, 'task-125aafd5-0', { url: 'https://a2.test' })).toBe(s);
  });
  test('a user-pinned title is not overwritten by an automatic title update', () => {
    const pinned = updateTab(base, 'task-125aafd5-0', { title: 'My name', titleSource: 'user' });
    expect(pinned.tabs[0]).toMatchObject({ title: 'My name', titleSource: 'user' });
    // an auto (poll) title update leaves the pinned label intact, but url still flows
    const after = updateTab(pinned, 'task-125aafd5-0', { title: 'page title', url: 'https://x' });
    expect(after.tabs[0]).toMatchObject({ title: 'My name', url: 'https://x' });
  });
});

describe('sanitizeTaskTabs', () => {
  test('rejects non-objects and missing tabs', () => {
    expect(sanitizeTaskTabs(null)).toBeNull();
    expect(sanitizeTaskTabs({})).toBeNull();
    expect(sanitizeTaskTabs({ tabs: 'x' })).toBeNull();
  });
  test('drops malformed tab entries and derives active + nextSeq', () => {
    const s = sanitizeTaskTabs({
      tabs: [
        { contextId: 'task-1-0', url: 'a', title: 'A', seq: 0 },
        { url: 'no-ctx' },
        { contextId: 'task-1-4', seq: 4 },
      ],
      activeContextId: 'gone',
    });
    expect(s?.tabs.map((t) => t.contextId)).toEqual(['task-1-0', 'task-1-4']);
    expect(s?.tabs[1]).toEqual({ contextId: 'task-1-4', url: '', title: '', seq: 4 });
    expect(s?.activeContextId).toBe('task-1-0'); // stale active → first tab
    expect(s?.nextSeq).toBe(5); // maxSeq + 1
  });
  test('round-trips parked + user titleSource, and active resolves to a LIVE tab', () => {
    const s = sanitizeTaskTabs({
      tabs: [
        { contextId: 'task-1-0', url: 'a', title: 'Pinned', seq: 0, parked: true, titleSource: 'user' },
        { contextId: 'task-1-1', url: 'b', title: 'B', seq: 1 },
      ],
      activeContextId: 'task-1-0', // persisted active was parked
    });
    expect(s?.tabs[0]).toMatchObject({ parked: true, titleSource: 'user' });
    expect(s?.tabs[1].parked).toBeUndefined();
    expect(s?.activeContextId).toBe('task-1-1'); // falls back to first LIVE tab
  });
});

// ── inbound cross-device sync (the write-only → live-apply fix) ───────────────
// These touch the module singleton cache; each test uses a UNIQUE taskId so the
// shared cache can't leak between cases. No pending writeTimers (no mutator PUTs
// here), so applyRemote is never gated by an in-flight local edit.

const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2)}`;

describe('taskIdFromKey', () => {
  test('parses task-browser-tabs keys, rejects unrelated ones', () => {
    expect(taskIdFromKey('task-browser-tabs:abc-123')).toBe('abc-123');
    expect(taskIdFromKey('pane-store-v2')).toBeNull();
    expect(taskIdFromKey('tombstones-browser')).toBeNull();
    expect(taskIdFromKey('')).toBeNull();
  });
});

describe('applyRemoteTaskTabs (inbound live-apply)', () => {
  test('seeds the cache from a server-pushed value and notifies subscribers', () => {
    const tid = uniq('apply');
    let notified = 0;
    const unsub = subscribeTaskTabs(() => { notified++; });
    applyRemoteTaskTabs(tid, { tabs: [{ contextId: 'task-a-0', url: 'u', title: 'T', seq: 0 }], activeContextId: 'task-a-0', nextSeq: 1 });
    expect(getTaskTabs(tid).tabs.map((t) => t.contextId)).toEqual(['task-a-0']);
    expect(notified).toBeGreaterThan(0);
    unsub();
  });

  test('a remote PARK drops the tab from the live set — the close→sync bug', () => {
    const tid = uniq('apply');
    applyRemoteTaskTabs(tid, {
      tabs: [
        { contextId: 'task-b-0', url: 'a', title: 'A', seq: 0 },
        { contextId: 'task-b-1', url: 'b', title: 'B', seq: 1 },
      ],
      activeContextId: 'task-b-0', nextSeq: 2,
    });
    expect(liveTabs(getTaskTabs(tid)).length).toBe(2);
    // Other device closed (parked) task-b-0 → the broadcast carries it parked.
    applyRemoteTaskTabs(tid, {
      tabs: [
        { contextId: 'task-b-0', url: 'a', title: 'A', seq: 0, parked: true },
        { contextId: 'task-b-1', url: 'b', title: 'B', seq: 1 },
      ],
      activeContextId: 'task-b-1', nextSeq: 2,
    });
    expect(liveTabs(getTaskTabs(tid)).map((t) => t.contextId)).toEqual(['task-b-1']);
  });

  test('an identical value is a no-op — no spurious notify', () => {
    const tid = uniq('apply');
    const value = { tabs: [{ contextId: 'task-c-0', url: 'u', title: 'T', seq: 0 }], activeContextId: 'task-c-0', nextSeq: 1 };
    applyRemoteTaskTabs(tid, value);
    let notified = 0;
    const unsub = subscribeTaskTabs(() => { notified++; });
    applyRemoteTaskTabs(tid, value);
    expect(notified).toBe(0);
    unsub();
  });

  test('an unsanitizable payload leaves the cache untouched', () => {
    const tid = uniq('apply');
    applyRemoteTaskTabs(tid, { tabs: [{ contextId: 'task-d-0', url: 'u', title: 'T', seq: 0 }], activeContextId: 'task-d-0', nextSeq: 1 });
    applyRemoteTaskTabs(tid, null);
    expect(getTaskTabs(tid).tabs.length).toBe(1);
  });
});

describe('applyRemoteTaskTabsInit (snapshot di un server vecchio)', () => {
  test('applies only the task-browser-tabs keys from the snapshot', () => {
    const tid = uniq('init');
    applyRemoteTaskTabsInit({
      [`task-browser-tabs:${tid}`]: { tabs: [{ contextId: 'task-e-0', url: 'u', title: 'T', seq: 0 }], activeContextId: 'task-e-0', nextSeq: 1 },
      'pane-store-v2': { panes: {} },
    });
    expect(getTaskTabs(tid).tabs.map((t) => t.contextId)).toEqual(['task-e-0']);
  });
});

// ── resync di riconnessione, MIRATO ──────────────────────────────────────────
// Il server non manda più `task-browser-tabs:*` nell'`ui-state:init` (erano il
// 30% del payload di ogni riconnessione). Il riallineamento delle chiusure perse
// mentre si era offline lo chiede il client, e SOLO per i task che ha in cache.

describe('resyncTaskTabsFromServer (riconnessione)', () => {
  const REAL_FETCH = globalThis.fetch;
  let fetched: string[];
  let served: Map<string, unknown>;

  beforeEach(() => {
    fetched = [];
    served = new Map();
    (globalThis as unknown as { fetch: unknown }).fetch = async (url: string): Promise<Response> => {
      const key = decodeURIComponent(String(url).replace('/api/ui-state/', ''));
      fetched.push(key);
      const value = served.get(key);
      return new Response(JSON.stringify(value === undefined ? null : { value }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    };
  });
  afterEach(() => { (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH; });

  const tabsOf = (ctx: string) => ({ tabs: [{ contextId: ctx, url: 'u', title: 'T', seq: 0 }], activeContextId: ctx, nextSeq: 1 });

  test('ri-GETta i task IN CACHE e applica la chiusura persa mentre era offline', async () => {
    const tid = uniq('resync');
    // In cache perché un frame precedente lo ha portato (applyRemote marca loaded).
    applyRemoteTaskTabs(tid, tabsOf('task-r-0'));
    expect(liveTabs(getTaskTabs(tid))).toHaveLength(1);

    // Offline, un altro device ha parcheggiato la tab.
    served.set(`task-browser-tabs:${tid}`, { tabs: [{ contextId: 'task-r-0', url: 'u', title: 'T', seq: 0, parked: true }], activeContextId: null, nextSeq: 1 });
    await resyncTaskTabsFromServer({});

    expect(fetched).toContain(`task-browser-tabs:${tid}`);
    expect(liveTabs(getTaskTabs(tid))).toHaveLength(0);
  });

  test('un task MAI aperto non si chiede: è il GET pigro all\'apertura a coprirlo', async () => {
    const mai = uniq('mai-visto');
    await resyncTaskTabsFromServer({});
    expect(fetched).not.toContain(`task-browser-tabs:${mai}`);
  });

  test('una scrittura ancora in coda vince: niente GET, l\'edit locale resta', async () => {
    const tid = uniq('pending');
    taskBrowserTabs.addTab(tid, 'https://locale.test');   // arma il PUT debounced
    served.set(`task-browser-tabs:${tid}`, { tabs: [], activeContextId: null, nextSeq: 0 });

    await resyncTaskTabsFromServer({});

    expect(fetched).not.toContain(`task-browser-tabs:${tid}`);
    expect(getTaskTabs(tid).tabs).toHaveLength(1);
    forgetTaskTabs(tid);                                   // disarma il timer
  });

  test('server vecchio: la chiave arriva nello snapshot e NON si ri-chiede', async () => {
    const tid = uniq('vecchio');
    applyRemoteTaskTabs(tid, tabsOf('task-v-0'));
    await resyncTaskTabsFromServer({ [`task-browser-tabs:${tid}`]: tabsOf('task-v-1') });

    expect(fetched).not.toContain(`task-browser-tabs:${tid}`);
    expect(getTaskTabs(tid).tabs.map((t) => t.contextId)).toEqual(['task-v-1']);
  });

  test('chiave sparita dal server (task archiviato offline): la cache non cambia', async () => {
    // Parità col comportamento vecchio, dove la chiave semplicemente mancava
    // dallo snapshot. A cancellarla è `task:deleted` → forgetTaskTabs.
    const tid = uniq('sparito');
    applyRemoteTaskTabs(tid, tabsOf('task-s-0'));
    await resyncTaskTabsFromServer({});                    // served non ha la chiave ⇒ null
    expect(getTaskTabs(tid).tabs).toHaveLength(1);
  });
});

// ── il task è stato archiviato: si dimentica ─────────────────────────────────
// Il server ha appena CANCELLATO `task-browser-tabs:<id>`. Se questo client si
// ricorda la chiave, il suo PUT ancora in coda la ricrea qualche centinaio di
// millisecondi dopo — che è esattamente il modo in cui questi record sono
// diventati immortali.

describe('forgetTaskTabs (task archiviato)', () => {
  test('svuota la cache, avvisa, e ANNULLA la scrittura in coda', () => {
    const tid = uniq('forget');
    taskBrowserTabs.addTab(tid, 'https://e.test');
    expect(getTaskTabs(tid).tabs).toHaveLength(1);

    // Finché il debounce è in volo, `applyRemote` si tira indietro (l'edit
    // locale è più recente): è il modo di osservare che il timer c'è.
    applyRemoteTaskTabs(tid, { tabs: [], activeContextId: null, nextSeq: 0 });
    expect(getTaskTabs(tid).tabs).toHaveLength(1);

    let notified = 0;
    const unsub = subscribeTaskTabs(() => { notified++; });
    forgetTaskTabs(tid);
    unsub();

    expect(getTaskTabs(tid)).toBe(EMPTY_TASK_TABS);
    expect(notified).toBeGreaterThan(0);

    // Timer sparito ⇒ il remoto passa di nuovo. Se `forget` avesse lasciato il
    // timer, questa riga fallirebbe — ed è quel timer che ricrea la riga.
    applyRemoteTaskTabs(tid, {
      tabs: [{ contextId: 'task-z-0', url: 'u', title: 'T', seq: 0 }],
      activeContextId: 'task-z-0',
      nextSeq: 1,
    });
    expect(getTaskTabs(tid).tabs).toHaveLength(1);
  });

  test('un task mai visto (o id vuoto): no-op silenzioso, nessuna notifica', () => {
    let notified = 0;
    const unsub = subscribeTaskTabs(() => { notified++; });
    forgetTaskTabs(uniq('mai-visto'));
    forgetTaskTabs('');
    unsub();
    expect(notified).toBe(0);
  });
});

// ── a write stays protected until the server answers (card 0470f6df) ─────────
// Touching the LAST tab writes with no debounce, so the PUT leaves at once, and
// the protection used to end THERE instead of at the answer. In that round trip
// a frame from another device landed in the cache, our own echo was then dropped
// as an echo, and the two copies stayed apart until the next reconnection.

// The fix opened the opposite window, which is what the seq arbitration closes:
// the server broadcasts BEFORE it answers, so a frame carrying a write that
// happened AFTER ours must be adopted, not thrown away. And a resync GET issued
// before a close must lose to that close even when its answer lands later.
describe('a write in flight is arbitrated by server_seq, not by a flag', () => {
  const REAL_FETCH = globalThis.fetch;
  let served: Map<string, unknown>;
  let held: { method: string; key: string; release: (fail?: boolean) => void }[];
  let nextSeq: number;
  let asked: string[];

  beforeEach(() => {
    served = new Map();
    held = [];
    asked = [];
    nextSeq = 100;
    // A server that COMMITS on arrival (and would broadcast there) but hands the
    // answer over only when the test releases it: that gap is the race.
    (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: RequestInit): Promise<Response> => {
      const key = decodeURIComponent(String(url).replace('/api/ui-state/', ''));
      const method = init?.method ?? 'GET';
      if (method === 'DELETE') return Promise.resolve(new Response('{}', { status: 200 }));
      let body: string;
      if (method === 'PUT') {
        served.set(key, JSON.parse(String(init!.body)));
        body = JSON.stringify({ ok: true, server_seq: ++nextSeq });
      } else {
        asked.push(key);
        const value = served.get(key);
        body = JSON.stringify(value === undefined ? null : { value, server_seq: nextSeq });
      }
      return new Promise<Response>((resolve, reject) => {
        held.push({
          method,
          key,
          release: (fail) => (fail
            ? reject(new TypeError('network'))
            : resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } }))),
        });
      });
    };
  });
  afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
    __resetTaskTabs();
  });

  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
  const recordOf = (...ctx: string[]) => ({
    tabs: ctx.map((c, i) => ({ contextId: c, url: 'u', title: 'T', seq: i })),
    activeContextId: ctx[0] ?? null,
    nextSeq: ctx.length,
  });
  const liveIds = (taskId: string) => liveTabs(getTaskTabs(taskId)).map((t) => t.contextId);
  const onServer = (key: string) => ((served.get(key) as { tabs: { contextId: string }[] }).tabs).map((t) => t.contextId);
  const release = (method: string, fail?: boolean) => {
    const entry = held.find((h) => h.method === method)!;
    held = held.filter((h) => h !== entry);
    entry.release(fail);
  };
  /** Release the n-th withheld GET: two resyncs can overlap and answer out of order. */
  const releaseNth = (method: string, i: number) => {
    const entry = held.filter((h) => h.method === method)[i]!;
    held = held.filter((h) => h !== entry);
    entry.release();
  };
  const settleGets = async () => {
    await tick();
    while (held.some((h) => h.method === 'GET')) { release('GET'); await tick(); }
  };

  test('an OLDER frame arriving while our PUT travels is dropped', async () => {
    const tid = uniq('seq-older');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-i-0'), 100);
    served.set(key, recordOf('task-i-0'));

    taskBrowserTabs.removeTab(tid, 'task-i-0');   // last tab: PUT with no debounce
    await tick();                                  // PUT committed on the server, answer withheld

    applyRemoteTaskTabs(tid, recordOf('task-i-0', 'task-i-1'), 100);
    expect(liveIds(tid)).toEqual([]);              // held, and it is our own past

    release('PUT');
    await tick();
    expect(liveIds(tid)).toEqual([]);
    expect(onServer(key)).toEqual([]);             // both copies agree
  });

  test('a NEWER frame arriving before our PUT answers is adopted, not lost', async () => {
    const tid = uniq('seq-newer');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-n-0'), 100);
    served.set(key, recordOf('task-n-0'));

    taskBrowserTabs.removeTab(tid, 'task-n-0');
    await tick();                                  // the server holds our empty record at seq 101

    served.set(key, recordOf('task-n-1'));         // another device writes AFTER us
    applyRemoteTaskTabs(tid, recordOf('task-n-1'), 102);

    release('PUT');
    await tick();
    expect(liveIds(tid)).toEqual(['task-n-1']);    // the newer write wins
    expect(liveIds(tid)).toEqual(onServer(key));
  });

  test('a resync GET issued before a close does not resurrect the tab', async () => {
    const tid = uniq('seq-read');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-r-0'), 100);
    served.set(key, recordOf('task-r-0'));

    const reading = resyncTaskTabsFromServer({});
    await tick();                                  // the GET read one tab, answer withheld
    expect(asked).toContain(key);

    taskBrowserTabs.removeTab(tid, 'task-r-0');
    await tick();
    release('PUT');
    await tick();                                  // our close is persisted

    release('GET');
    await reading;
    await tick();
    expect(liveIds(tid)).toEqual([]);              // the read was overtaken by the write
    expect(onServer(key)).toEqual([]);
  });

  test('a PUT that fails releases the frame it was holding', async () => {
    const tid = uniq('seq-failed');
    applyRemoteTaskTabs(tid, recordOf('task-f-0'), 100);

    taskBrowserTabs.removeTab(tid, 'task-f-0');
    await tick();
    applyRemoteTaskTabs(tid, recordOf('task-f-9'), 105);

    release('PUT', true);
    await tick();
    expect(liveIds(tid)).toEqual(['task-f-9']);    // nothing of ours reached the row
  });

  // The flight protection made the reconnect resync SKIP the key, and nothing
  // ever came back for it: the write settled, the frame another device had sent
  // while the socket was down was gone, and the two copies stayed apart.
  test('a key the resync skipped is re-read when its write settles', async () => {
    const tid = uniq('seq-owed');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-o-0'), 100);
    served.set(key, recordOf('task-o-0'));

    taskBrowserTabs.removeTab(tid, 'task-o-0');    // PUT out, answer withheld
    await tick();
    served.set(key, recordOf('task-o-9'));         // device B writes while we are deaf

    await resyncTaskTabsFromServer({});            // reconnect: the key is skipped
    expect(asked).not.toContain(key);

    release('PUT');
    await tick();                                  // the settle owes that read
    release('GET');
    await tick();
    expect(asked).toContain(key);
    expect(liveIds(tid)).toEqual(['task-o-9']);
    expect(liveIds(tid)).toEqual(onServer(key));
  });

  // The owed read is a GET like any other, so it can be overtaken like any other:
  // between the settle that asks for it and its answer, the person can close a
  // tab again. Without the staleness guard on it, the answer (which still has the
  // old row) puts the closed tab back and the resync defect returns through the
  // door opened to fix it.
  test('a read owed to a resync does not resurrect a close committed while it travels', async () => {
    const tid = uniq('seq-owed-stale');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-w-0'), 100);
    served.set(key, recordOf('task-w-0'));

    taskBrowserTabs.removeTab(tid, 'task-w-0');
    await tick();
    served.set(key, recordOf('task-w-9'));         // device B writes while we are deaf

    await resyncTaskTabsFromServer({});            // key skipped
    release('PUT');
    await tick();                                  // the owed GET leaves, and will read [task-w-9]
    expect(asked).toContain(key);

    taskBrowserTabs.upsertTab(tid, 'task-w-5', 'u');
    taskBrowserTabs.removeTab(tid, 'task-w-5');    // a close committed meanwhile
    await tick();
    release('PUT');
    await tick();                                  // the server holds our empty record

    release('GET');
    await tick();
    expect(liveIds(tid)).toEqual([]);              // the owed read was overtaken
    expect(onServer(key)).toEqual([]);
  });

  // A read is ordered against OUR writes by the token; nothing ordered it
  // against the OTHER devices, so a GET that left when the row said [b] put [b]
  // back over a [c] that had landed meanwhile, and the copies stayed apart.
  test('an owed read does not undo a newer frame that landed while it travelled', async () => {
    const tid = uniq('read-seq-owed');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-ro-0'), 100);
    served.set(key, recordOf('task-ro-0'));

    taskBrowserTabs.removeTab(tid, 'task-ro-0');    // last tab: PUT with no debounce
    await tick();
    const skipped = resyncTaskTabsFromServer({});   // write in the air: the key is owed, not read
    await skipped;
    expect(asked).not.toContain(key);

    served.set(key, recordOf('task-ro-b'));         // another device wrote while we were in flight
    release('PUT');
    await tick();                                    // our write settles: the owed GET reads [b]
    expect(asked).toContain(key);

    applyRemoteTaskTabs(tid, recordOf('task-ro-c'), 103);   // and a third device writes [c]
    served.set(key, recordOf('task-ro-c'));
    expect(liveIds(tid)).toEqual(['task-ro-c']);

    release('GET');
    await tick();
    expect(liveIds(tid)).toEqual(['task-ro-c']);    // the read described a state we had left
    expect(liveIds(tid)).toEqual(onServer(key));
  });

  test('the bulk resync does not undo a newer frame either', async () => {
    const tid = uniq('read-seq-bulk');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-rb-0'), 100);
    served.set(key, recordOf('task-rb-0'));

    const reading = resyncTaskTabsFromServer({});
    await tick();                                    // the GET read [task-rb-0] at seq 100
    expect(asked).toContain(key);

    applyRemoteTaskTabs(tid, recordOf('task-rb-c'), 104);
    served.set(key, recordOf('task-rb-c'));

    release('GET');
    await reading;
    await tick();
    expect(liveIds(tid)).toEqual(['task-rb-c']);
    expect(liveIds(tid)).toEqual(onServer(key));
  });

  // A server_seq can go BACKWARDS: a data/topics.db put back from backup, which
  // is the rollback planned before a migration, with the app still open and the
  // socket simply reconnecting. Compared against a high-water mark the key would
  // be wedged -- and these keys are excluded from `ui-state:init`, so the read
  // refused as "old" is the only thing that realigns them.
  test('a seq that went backwards does not wedge a key we never wrote', async () => {
    const tid = uniq('regress-unwritten');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-g-a'), 500);
    served.set(key, recordOf('task-g-a'));
    nextSeq = 500;

    served.set(key, recordOf('task-g-old'));       // the row is restored from backup...
    nextSeq = 20;                                   // ...and the counter with it

    const reconnect = resyncTaskTabsFromServer({});
    await settleGets();
    await reconnect;
    expect(liveIds(tid)).toEqual(['task-g-old']);  // the read at seq 20 is believed
    expect(liveIds(tid)).toEqual(onServer(key));

    served.set(key, recordOf('task-g-d'));          // another device writes while we are down
    nextSeq = 499;
    const later = resyncTaskTabsFromServer({});
    await settleGets();
    await later;
    expect(liveIds(tid)).toEqual(onServer(key));    // still realigning, 499 or not
  });

  test('a seq that went backwards does not wedge a key we wrote ourselves', async () => {
    const tid = uniq('regress-written');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-h-a', 'task-h-x'), 100);
    served.set(key, recordOf('task-h-a', 'task-h-x'));
    nextSeq = 499;

    taskBrowserTabs.removeTab(tid, 'task-h-x');     // our own write, confirmed at 500
    await tick(900);
    while (held.some((h) => h.method === 'PUT')) { release('PUT'); await tick(); }
    expect(onServer(key)).toEqual(['task-h-a']);

    served.set(key, recordOf('task-h-old'));        // restore from backup
    nextSeq = 20;
    served.set(key, recordOf('task-h-b'));          // and another device writes at 21
    nextSeq = 21;

    const reconnect = resyncTaskTabsFromServer({});
    await settleGets();
    await reconnect;
    expect(liveIds(tid)).toEqual(onServer(key));    // the reconnect read realigns us
  });

  // Two resyncs can overlap (a socket that goes and comes back sends two inits):
  // the older GET answering LAST must not undo what the newer one applied.
  test('an overlapping read answered last does not undo the newer read', async () => {
    const tid = uniq('overlap-reads');
    const key = `task-browser-tabs:${tid}`;
    applyRemoteTaskTabs(tid, recordOf('task-o-a'), 100);
    served.set(key, recordOf('task-o-b'));
    nextSeq = 101;

    const first = resyncTaskTabsFromServer({});
    await tick();                                   // GET1 reads [b] at 101
    served.set(key, recordOf('task-o-c'));          // a write elsewhere, its frame lost
    nextSeq = 102;
    const second = resyncTaskTabsFromServer({});
    await tick();                                   // GET2 reads [c] at 102

    releaseNth('GET', 1);
    await second;
    await tick();
    expect(liveIds(tid)).toEqual(['task-o-c']);

    releaseNth('GET', 0);
    await first;
    await tick();
    expect(liveIds(tid)).toEqual(['task-o-c']);     // GET1 described a state already left
    expect(liveIds(tid)).toEqual(onServer(key));
  });
});
