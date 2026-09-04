/**
 * @covers TASKLINK-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  buildTaskLink,
  parseTaskLocation,
  currentTaskTarget,
  selfTaskLinkTarget,
  reflectTaskOpen,
  reflectTaskClose,
  reflectTaskFocus,
  subscribePopstateTask,
  openTaskInApp,
  parseTopicLocation,
  selfTopicLinkTarget,
} from './openTaskLink';
// The deep-link FRONT DOOR moved one layer up, into its own module, so that the
// single gate (`tabLink`) and the task-URL primitives stop importing each other.
// The behaviour under test is unchanged, so the cases stay here next to it.
import {
  openTaskFromUrl,
  subscribeServiceWorkerTaskOpen,
  openTopicInApp,
  openDeepLinkInApp,
  setDeepLinkNotifier,
} from './deepLinkEntry';
import {
  DEAD_TAB_MESSAGE,
  __resetTabLinkStateForTests,
  __setTabLinkRetryDelayForTests,
} from './tabLink';

// jsdom-less: a minimal, typed view of the global surface the module touches,
// so the stubs below need no `any` (this file is linted under no-explicit-any).
type Listener = (e: unknown) => void;
type StubWindow = {
  location: { origin: string; href: string; pathname: string; search: string };
  open?: (url: string, target?: string, features?: string) => void;
  dispatchEvent?: (e: { type: string; detail?: unknown }) => boolean;
  history?: {
    pushState: (state: unknown, title: unknown, url: string) => void;
    replaceState?: (state: unknown, title: unknown, url: string) => void;
  };
  addEventListener?: (type: string, cb: Listener) => void;
  removeEventListener?: (type: string, cb: Listener) => void;
};
const g = globalThis as unknown as {
  window: StubWindow;
  CustomEvent: unknown;
  URL: unknown;
  URLSearchParams: unknown;
};

const origin = 'https://localhost:3333';

// Minimal CustomEvent stand-in for the jsdom-less environment.
class StubCustomEvent {
  type: string;
  detail: unknown;
  constructor(type: string, opts?: { detail?: unknown }) {
    this.type = type;
    this.detail = opts?.detail;
  }
}

// Build a window stub whose location fields stay in sync when history.pushState
// rewrites the URL — so a reflect* call is observable via currentTaskTarget().
function stubWindow(href: string, opts?: { withHistory?: boolean; listeners?: boolean }) {
  const events: Array<{ type: string; detail: unknown }> = [];
  const popstateCbs: Listener[] = [];
  const sync = (url: string) => {
    const u = new URL(url);
    g.window.location.href = u.href;
    g.window.location.pathname = u.pathname;
    g.window.location.search = u.search;
    g.window.location.origin = u.origin;
  };
  const u0 = new URL(href);
  g.window = {
    location: { origin: u0.origin, href, pathname: u0.pathname, search: u0.search },
    dispatchEvent: (e) => { events.push({ type: e.type, detail: e.detail }); return true; },
    history: opts?.withHistory === false ? undefined
      : { pushState: (_s, _t, url) => sync(url) },
    addEventListener: opts?.listeners === false ? undefined
      : (type, cb) => { if (type === 'popstate') popstateCbs.push(cb); },
    removeEventListener: (type, cb) => {
      if (type === 'popstate') { const i = popstateCbs.indexOf(cb); if (i >= 0) popstateCbs.splice(i, 1); }
    },
  };
  g.CustomEvent = StubCustomEvent;
  g.URL = URL;
  g.URLSearchParams = URLSearchParams;
  return { events, popstateCbs, sync };
}

// WHAT `/api/tabs/resolve` ANSWERS in this file. `openTopicInApp` now goes
// through the single gate (`openTabInApp`), which asks the server whether the
// subject still exists before routing: 'unknown' is the only answer that
// refuses. Tests that only care about the routing leave it at 'closed' - an
// existing, closed topic - because the interesting branch is the other one.
let resolveState: string | null = 'closed';

/** The subject check is asynchronous, so an assertion on the bus has to WAIT
 *  for it. Polls instead of guessing a number of microtasks: the gate does one
 *  fetch, and on `unavailable` a second one after the (shortened) retry. */
async function until(check: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
}

type SWListener = (e: { data: unknown }) => void;
/** The channel `public/sw.js` uses to hand a notification click to the app.
 *  Module scope because two describes need it: the web-push route, and the
 *  detached window that must NOT be routed by it. */
function stubServiceWorker() {
  const listeners: SWListener[] = [];
  (globalThis as unknown as { navigator: unknown }).navigator = {
    serviceWorker: {
      addEventListener: (type: string, cb: SWListener) => { if (type === 'message') listeners.push(cb); },
      removeEventListener: (type: string, cb: SWListener) => {
        if (type !== 'message') return;
        const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1);
      },
    },
  };
  return { post: (data: unknown) => listeners.forEach((cb) => cb({ data })), listeners };
}

/** The real globals, captured BEFORE anything here replaces them. */
const realFetch = (globalThis as unknown as { fetch: unknown }).fetch;
const realNavigator = (globalThis as unknown as { navigator: unknown }).navigator;

beforeEach(() => {
  stubWindow(`${origin}/`);
  resolveState = 'closed';
  __resetTabLinkStateForTests();
  __setTabLinkRetryDelayForTests(1);
  (globalThis as unknown as { fetch: unknown }).fetch = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(resolveState === null ? {} : { state: resolveState }),
    });
});

// PUT THE GLOBALS BACK, and this is load-bearing far from here. The whole unit
// suite runs in ONE process, so a `fetch` left stubbed by this file becomes the
// `fetch` of every file that runs after it: the suites that really do speak
// over the network (the MCP fleet, the OAuth sign-in, web_fetch) then answer
// `{ state: 'closed' }` to everything and fail instantly, with a message that
// points nowhere near the file that caused it.
afterEach(() => {
  (globalThis as unknown as { fetch: unknown }).fetch = realFetch;
  (globalThis as unknown as { navigator: unknown }).navigator = realNavigator;
});

describe('buildTaskLink / parseTaskLocation (path-based)', () => {
  test('emits a clean /task/<uuid> path — no query, no %7E', () => {
    const taskId = '92a1091a-c9e3-4064-a098-2383bd37f2fe';
    const link = buildTaskLink(taskId);
    expect(link).toBe(`${origin}/task/${taskId}`);
    expect(link.includes('?')).toBe(false);
    expect(link.includes('%7E')).toBe(false);
  });

  test('build → parse round-trip', () => {
    const taskId = 'd8ea2ff3-d412-4771-810d-401faa1d1754';
    const link = buildTaskLink(taskId);
    const u = new URL(link);
    expect(parseTaskLocation(u.pathname, u.search)).toEqual({ taskId });
  });

  test('parses /task/<id> from the pathname, ignores query junk', () => {
    expect(parseTaskLocation('/task/t1', '?keep=1')).toEqual({ taskId: 't1' });
  });

  test('tolerates a trailing slash', () => {
    expect(parseTaskLocation('/task/t1/', '')).toEqual({ taskId: 't1' });
  });

  test('con un titolo il link porta davanti uno slug leggibile', () => {
    const taskId = '92a1091a-c9e3-4064-a098-2383bd37f2fe';
    const link = buildTaskLink(taskId, 'Leggibilità del link condiviso');
    expect(link).toBe(`${origin}/task/leggibilita-del-link-condiviso-${taskId}`);
    expect(link.includes('%')).toBe(false);
    const u = new URL(link);
    expect(parseTaskLocation(u.pathname, u.search)).toEqual({ taskId });
  });

  test('con slug o senza, il task aperto è LO STESSO', () => {
    const taskId = 'd8ea2ff3-d412-4771-810d-401faa1d1754';
    expect(parseTaskLocation(`/task/${taskId}`, '')).toEqual({ taskId });
    expect(parseTaskLocation(`/task/un-titolo-qualunque-${taskId}`, '')).toEqual({ taskId });
    expect(parseTaskLocation(`/task/un-titolo-qualunque-${taskId}/`, '')).toEqual({ taskId });
  });

  test('UNO SLUG SBAGLIATO apre comunque il task giusto', () => {
    // The one that decides whether the slug is decoration: a title renamed
    // after the link was sent must not break the link that is already out
    // there. If it did, the prefix would be addressing again.
    const taskId = 'd8ea2ff3-d412-4771-810d-401faa1d1754';
    expect(parseTaskLocation(`/task/tutt-altro-titolo-${taskId}`, '')).toEqual({ taskId });
    expect(selfTaskLinkTarget(`${origin}/task/niente-a-che-vedere-${taskId}`)).toEqual({ taskId });
  });

  test('rejects non-task / malformed paths', () => {
    expect(parseTaskLocation('/', '')).toBeNull();
    expect(parseTaskLocation('/task', '')).toBeNull();
    expect(parseTaskLocation('/task/', '')).toBeNull();
    expect(parseTaskLocation('/task/a/b', '')).toBeNull();
    expect(parseTaskLocation('/other/t1', '')).toBeNull();
  });
});

describe('parseTaskLocation — legacy ?task= back-compat', () => {
  test('reads the taskId from the old ?task=<slug>~<uuid> form', () => {
    const uuid = 'd8ea1091-c9e3-4064-a098-2383bd37f2fe';
    expect(parseTaskLocation('/', `?task=demoapp-v1skoz~${uuid}`)).toEqual({ taskId: uuid });
  });

  test('splits on the FIRST ~ (defensive: slug should never contain one)', () => {
    expect(parseTaskLocation('/', '?task=a~b~c')).toEqual({ taskId: 'b~c' });
  });

  test('a legacy link with a task path wins over the query', () => {
    expect(parseTaskLocation('/task/newid', '?task=slug~oldid')).toEqual({ taskId: 'newid' });
  });

  test('rejects missing / malformed legacy queries', () => {
    expect(parseTaskLocation('/', '')).toBeNull();
    expect(parseTaskLocation('/', '?task=')).toBeNull();
    expect(parseTaskLocation('/', '?task=noseparator')).toBeNull();
    expect(parseTaskLocation('/', '?task=~onlytask')).toBeNull();
    expect(parseTaskLocation('/', '?task=onlyproject~')).toBeNull();
    expect(parseTaskLocation('/', '?other=x')).toBeNull();
  });
});

describe('currentTaskTarget', () => {
  test('reads the task from the current path', () => {
    stubWindow(`${origin}/task/task-1`);
    expect(currentTaskTarget()).toEqual({ taskId: 'task-1' });
  });
  test('reads a legacy ?task= location too', () => {
    stubWindow(`${origin}/?task=proj-x~task-1&keep=1`);
    expect(currentTaskTarget()).toEqual({ taskId: 'task-1' });
  });
  test('null when absent', () => {
    stubWindow(`${origin}/?keep=1`);
    expect(currentTaskTarget()).toBeNull();
  });
});

describe('selfTaskLinkTarget', () => {
  test('same page origin, new path → target', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget(`${origin}/task/t1`)).toEqual({ taskId: 't1' });
  });
  test('same page origin, LEGACY ?task → target (pasted-comment back-compat)', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget(`${origin}/?task=proj~t1`)).toEqual({ taskId: 't1' });
  });
  test('relative self URL → target', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget('/task/t1')).toEqual({ taskId: 't1' });
  });
  test('foreign origin → null (falls back to external open)', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget('https://evil.example/task/t1')).toBeNull();
  });
  test('self origin but not a task URL → null', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget(`${origin}/docs`)).toBeNull();
  });
  test('garbage url → null', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget('not a url ::://')).toBeNull();
  });
});

describe('URL reflection (reflectTaskOpen / reflectTaskClose)', () => {
  test('losing the board tab REPLACES /task/<id> with / (no history entry, CHROME-11)', () => {
    const { sync } = stubWindow(`${origin}/task/t1`);
    let pushes = 0, replaces = 0;
    g.window.history = {
      pushState: (_s, _t, url) => { pushes++; sync(url); },
      replaceState: (_s, _t, url) => { replaces++; sync(url); },
    };
    reflectTaskFocus(null);
    expect(g.window.location.pathname).toBe('/');
    expect(pushes).toBe(0);
    expect(replaces).toBe(1);
  });

  test('regaining the board tab with the drawer open writes the task back, still by replacing', () => {
    const { sync } = stubWindow(`${origin}/`);
    let pushes = 0, replaces = 0;
    g.window.history = {
      pushState: (_s, _t, url) => { pushes++; sync(url); },
      replaceState: (_s, _t, url) => { replaces++; sync(url); },
    };
    const taskId = 'd8ea2ff3-d412-4771-810d-401faa1d1754';
    reflectTaskFocus({ taskId }, 'Titolo del task');
    expect(g.window.location.pathname).toBe(`/task/titolo-del-task-${taskId}`);
    expect(pushes).toBe(0);
    expect(replaces).toBe(1);
  });

  test('open pushes /task/<id>, dropping any leftover query', () => {
    stubWindow(`${origin}/?keep=1`);
    reflectTaskOpen({ taskId: 't1' });
    expect(currentTaskTarget()).toEqual({ taskId: 't1' });
    expect(g.window.location.pathname).toBe('/task/t1');
    expect(g.window.location.search).toBe('');
  });

  test('open is a no-op when already reflected (no duplicate push)', () => {
    const { sync } = stubWindow(`${origin}/task/t1`);
    let pushes = 0;
    g.window.history = { pushState: (_s, _t, url) => { pushes++; sync(url); } };
    reflectTaskOpen({ taskId: 't1' });
    reflectTaskOpen({ taskId: 't1' });
    expect(pushes).toBe(0);
  });

  test('con il titolo, la riflessione scrive un percorso leggibile', () => {
    const taskId = 'd8ea2ff3-d412-4771-810d-401faa1d1754';
    stubWindow(`${origin}/`);
    reflectTaskOpen({ taskId }, 'Titolo del task');
    expect(g.window.location.pathname).toBe(`/task/titolo-del-task-${taskId}`);
    expect(currentTaskTarget()).toEqual({ taskId });
  });

  test('una URL già su quel task non si riscrive per lo slug (niente voce in più)', () => {
    // A link arrives with its own decoration (right, wrong or absent): pushing
    // the canonical form on top of it would cost a history entry that Back has
    // to walk through with nothing visible changing.
    const taskId = 'd8ea2ff3-d412-4771-810d-401faa1d1754';
    const { sync } = stubWindow(`${origin}/task/slug-vecchio-${taskId}`);
    let pushes = 0;
    g.window.history = { pushState: (_s, _t, url) => { pushes++; sync(url); } };
    reflectTaskOpen({ taskId }, 'Titolo nuovo');
    expect(pushes).toBe(0);
    expect(g.window.location.pathname).toBe(`/task/slug-vecchio-${taskId}`);
  });

  test('open UPGRADES a legacy ?task URL to the clean path', () => {
    stubWindow(`${origin}/?task=proj~t1`);
    reflectTaskOpen({ taskId: 't1' });
    expect(g.window.location.pathname).toBe('/task/t1');
    expect(g.window.location.search).toBe('');
  });

  test('close returns to /', () => {
    stubWindow(`${origin}/task/t1`);
    reflectTaskClose();
    expect(currentTaskTarget()).toBeNull();
    expect(g.window.location.pathname).toBe('/');
  });

  test('la riflessione NON cancella `?space=`: è l\'identità della finestra-gruppo', () => {
    // Il guasto misurato il 05/08/2026: la board è quasi sempre aperta, quindi
    // `reflectTaskClose` partiva al primo montaggio e portava la URL a `/`.
    // Una finestra-gruppo perdeva così il suo `?space=` e tornava una finestra
    // principale: disegnava le stesse tab dell'altra e non si annunciava più
    // come la casa di quel gruppo.
    stubWindow(`${origin}/task/t1?space=space%3Aabc`);
    reflectTaskClose();
    expect(g.window.location.pathname).toBe('/');
    expect(g.window.location.search).toBe('?space=space%3Aabc');

    stubWindow(`${origin}/?space=space%3Aabc`);
    reflectTaskOpen({ taskId: 't2' });
    expect(g.window.location.pathname).toBe('/task/t2');
    expect(g.window.location.search).toBe('?space=space%3Aabc');
  });

  test('in una finestra-gruppo la riflessione non si ripete a vuoto', () => {
    const { sync } = stubWindow(`${origin}/?space=space%3Aabc`);
    let pushes = 0;
    g.window.history = { pushState: (_s: unknown, _t: unknown, url: string) => { pushes++; sync(url); } };
    reflectTaskClose();
    reflectTaskClose();
    expect(pushes).toBe(0);
  });

  test('close is a no-op when already at / (clean)', () => {
    const { sync } = stubWindow(`${origin}/`);
    let pushes = 0;
    g.window.history = { pushState: (_s, _t, url) => { pushes++; sync(url); } };
    reflectTaskClose();
    expect(pushes).toBe(0);
  });
});

describe('subscribePopstateTask', () => {
  test('reports the URL target on back/forward and unsubscribes', () => {
    const { popstateCbs, sync } = stubWindow(`${origin}/task/t1`);
    const seen: Array<{ taskId: string } | null> = [];
    const off = subscribePopstateTask((t) => seen.push(t));
    // simulate a back nav that lands on /task/t2
    sync(`${origin}/task/t2`);
    popstateCbs.forEach((cb) => cb({ type: 'popstate' }));
    // and a forward/back to a clean URL
    sync(`${origin}/`);
    popstateCbs.forEach((cb) => cb({ type: 'popstate' }));
    off();
    expect(seen).toEqual([{ taskId: 't2' }, null]);
    expect(popstateCbs.length).toBe(0);
  });
});

describe('openTaskInApp / openTaskFromUrl', () => {
  test('openTaskInApp activates the board + emits open-task', () => {
    const { events } = stubWindow(`${origin}/`);
    openTaskInApp({ taskId: 't1' });
    expect(events.map((e) => e.type)).toEqual(['topics:open-utility', 'topics:open-task']);
    expect(events[0].detail).toEqual({ type: 'board' });
    expect(events[1].detail).toEqual({ taskId: 't1' });
  });

  test('openTaskFromUrl opens on a /task path, and does NOT strip it', () => {
    const { events } = stubWindow(`${origin}/task/t1`);
    openTaskFromUrl();
    expect(events.map((e) => e.type)).toEqual(['topics:open-utility', 'topics:open-task']);
    // The path stays — the URL is the source of truth (refresh recovers it);
    // it is cleared only when the drawer closes, not on load.
    expect(currentTaskTarget()).toEqual({ taskId: 't1' });
  });

  test('openTaskFromUrl opens on a LEGACY ?task URL (boot back-compat)', () => {
    const { events } = stubWindow(`${origin}/?task=proj~t1&keep=1`);
    openTaskFromUrl();
    expect(events.map((e) => e.type)).toEqual(['topics:open-utility', 'topics:open-task']);
    expect(events[1].detail).toEqual({ taskId: 't1' });
  });

  test('openTaskFromUrl is a no-op without a deep-link', () => {
    const { events } = stubWindow(`${origin}/?keep=1`);
    openTaskFromUrl();
    expect(events.length).toBe(0);
  });
});

// Il click su una web-push con la finestra già aperta: il service worker non
// può navigarla (ricaricherebbe la SPA), quindi manda la destinazione qui.
// Questo canale è l'ULTIMO pezzo del deep-link: se salta, la push ti sveglia e
// ti lascia dove eri.
describe('subscribeServiceWorkerTaskOpen (click su una web-push)', () => {
  test('un /task/<id> dal SW apre il drawer', () => {
    const { events } = stubWindow(`${origin}/`);
    const { post } = stubServiceWorker();
    const off = subscribeServiceWorkerTaskOpen();
    post({ type: 'topics:open-url', url: '/task/t7' });
    expect(events.map((e) => e.type)).toEqual(['topics:open-utility', 'topics:open-task']);
    expect(events[1].detail).toEqual({ taskId: 't7' });
    off();
  });

  test('accetta anche la URL assoluta della push e la forma legacy', () => {
    const { events } = stubWindow(`${origin}/`);
    const { post } = stubServiceWorker();
    const off = subscribeServiceWorkerTaskOpen();
    post({ type: 'topics:open-url', url: `${origin}/task/t8` });
    post({ type: 'topics:open-url', url: '/?task=proj~t9' });
    expect(events.filter((e) => e.type === 'topics:open-task').map((e) => e.detail))
      .toEqual([{ taskId: 't8' }, { taskId: 't9' }]);
    off();
  });

  test('muto su tutto ciò che non è un deep-link (la finestra è già a fuoco)', () => {
    const { events } = stubWindow(`${origin}/`);
    const { post } = stubServiceWorker();
    const off = subscribeServiceWorkerTaskOpen();
    post({ type: 'topics:open-url', url: '/' });           // push senza task
    post({ type: 'SKIP_WAITING' });                        // altro traffico del SW
    post({ type: 'topics:open-url' });                     // url mancante
    post(null);
    post({ type: 'topics:open-url', url: 'https://altro.example/task/t1' }); // altra origin
    expect(events.length).toBe(0);
    off();
  });

  test('l’unsubscribe stacca davvero il listener', () => {
    const { events } = stubWindow(`${origin}/`);
    const { post, listeners } = stubServiceWorker();
    subscribeServiceWorkerTaskOpen()();
    expect(listeners.length).toBe(0);
    post({ type: 'topics:open-url', url: '/task/t1' });
    expect(events.length).toBe(0);
  });

  test('senza service worker (guscio desktop / test) è un no-op, non un crash', () => {
    stubWindow(`${origin}/`);
    (globalThis as unknown as { navigator: unknown }).navigator = {};
    expect(() => subscribeServiceWorkerTaskOpen()()).not.toThrow();
  });

  test('un /topic/<id> dalla push di fine chat apre la tab del topic', async () => {
    const { events } = stubWindow(`${origin}/`);
    const { post } = stubServiceWorker();
    const off = subscribeServiceWorkerTaskOpen();
    post({ type: 'topics:open-url', url: '/topic/tp1' });
    await until(() => events.some((e) => e.type === 'topics:open-topic'));
    // `topics:open-tab` is the focus INTENT the single gate arms before routing.
    expect(events.map((e) => e.type)).toEqual(['topics:open-tab', 'topics:open-topic']);
    expect(events[1].detail).toEqual({ topicId: 'tp1', mode: 'permanent' });
    off();
  });
});

// Il deep-link per la CHAT (`/topic/<id>`), gemello di `/task/<id>`: è la
// destinazione del click sulla push di fine risposta.
describe('deep-link del topic', () => {
  test('parseTopicLocation legge /topic/<id> e ignora il resto', () => {
    expect(parseTopicLocation('/topic/tp1')).toEqual({ topicId: 'tp1' });
    expect(parseTopicLocation('/topic/tp1/')).toEqual({ topicId: 'tp1' });
    expect(parseTopicLocation('/task/t1')).toBeNull();
    expect(parseTopicLocation('/topic/a/b')).toBeNull();
    expect(parseTopicLocation('/')).toBeNull();
  });

  test('selfTopicLinkTarget accetta solo la self-origin', () => {
    stubWindow(`${origin}/`);
    expect(selfTopicLinkTarget(`${origin}/topic/tp1`)).toEqual({ topicId: 'tp1' });
    expect(selfTopicLinkTarget('/topic/tp1')).toEqual({ topicId: 'tp1' });
    expect(selfTopicLinkTarget('https://evil.example/topic/tp1')).toBeNull();
    expect(selfTopicLinkTarget(`${origin}/task/t1`)).toBeNull();
  });

  test('openTopicInApp emette topics:open-topic (permanent)', async () => {
    const { events } = stubWindow(`${origin}/`);
    openTopicInApp({ topicId: 'tp1' });
    await until(() => events.some((e) => e.type === 'topics:open-topic'));
    expect(events.map((e) => e.type)).toEqual(['topics:open-tab', 'topics:open-topic']);
    expect(events[1].detail).toEqual({ topicId: 'tp1', mode: 'permanent' });
  });

  test('openTaskFromUrl apre il topic da finestra chiusa (/topic/<id> al boot)', async () => {
    const { events } = stubWindow(`${origin}/topic/tp2`);
    openTaskFromUrl();
    await until(() => events.some((e) => e.type === 'topics:open-topic'));
    expect(events.map((e) => e.type)).toEqual(['topics:open-tab', 'topics:open-topic']);
    expect(events[1].detail).toEqual({ topicId: 'tp2', mode: 'permanent' });
  });
});

// THE THREE ENTRANCES THAT SKIPPED THE SINGLE GATE. `openTabInApp` exists so a
// link can never mint a pane on a subject that is gone; every notification
// surface (native banner, web-push, the bell history) came in through
// `openDeepLinkInApp`, which did not use it.
describe('openDeepLinkInApp: la porta unica vale anche per le notifiche', () => {
  test('un topic CANCELLATO non apre niente e lo DICE', async () => {
    const { events } = stubWindow(`${origin}/`);
    resolveState = 'unknown';
    const said: string[] = [];
    const stop = setDeepLinkNotifier((message) => said.push(message));

    expect(openDeepLinkInApp('/topic/11111111-1111-4111-8111-111111111111')).toBe(true);
    await until(() => said.length > 0);
    // The ghost tab was born HERE: a bare `topics:open-topic` makes
    // `usePanelLifecycle` register the pane, and a UUID with no record survives
    // the validation effect forever.
    expect(events.some((e) => e.type === 'topics:open-topic')).toBe(false);
    expect(said).toEqual([DEAD_TAB_MESSAGE]);
    stop();
  });

  test('un topic che ESISTE (anche chiuso) si apre come prima', async () => {
    const { events } = stubWindow(`${origin}/`);
    resolveState = 'closed';
    const said: string[] = [];
    const stop = setDeepLinkNotifier((message) => said.push(message));

    expect(openDeepLinkInApp('/topic/22222222-2222-4222-8222-222222222222')).toBe(true);
    await until(() => events.some((e) => e.type === 'topics:open-topic'));
    expect(events[events.length - 1].detail)
      .toEqual({ topicId: '22222222-2222-4222-8222-222222222222', mode: 'permanent' });
    expect(said).toEqual([]);
    stop();
  });

  test('una URL che non è un deep-link torna false, senza avvisi', () => {
    stubWindow(`${origin}/`);
    const said: string[] = [];
    const stop = setDeepLinkNotifier((message) => said.push(message));
    expect(openDeepLinkInApp('https://altro.example/topic/tp1')).toBe(false);
    expect(openDeepLinkInApp('/')).toBe(false);
    expect(said).toEqual([]);
    stop();
  });
});

// A DETACHED window (`?topics=`) is a pop-out whose identity IS that query, and
// where pane-store persistence is off on purpose. Routing a deep-link there
// opens panes nobody saves AND wipes the query through the URL reflection, so
// the next reload reopens the whole workspace instead of those chats.
describe('finestra staccata: un deep-link non la degrada a principale', () => {
  test('la web-push non tocca la history e non apre niente in casa', async () => {
    const { events } = stubWindow(`${origin}/?topics=a,b`);
    const pushed: string[] = [];
    const replaced: string[] = [];
    const outside: string[] = [];
    g.window.history = {
      pushState: (_s, _t, url) => { pushed.push(url); },
      replaceState: (_s, _t, url) => { replaced.push(url); },
    };
    g.window.open = (url: string) => { outside.push(url); };
    const { post } = stubServiceWorker();
    const off = subscribeServiceWorkerTaskOpen();

    post({ type: 'topics:open-url', url: '/task/t-detached' });
    post({ type: 'topics:open-url', url: '/topic/33333333-3333-4333-8333-333333333333' });
    await until(() => false, 20);

    expect(pushed).toEqual([]);
    expect(replaced).toEqual([]);
    expect(events.map((e) => e.type)).toEqual([]);
    // The query IS the window's identity: losing it turns the pop-out into a
    // main window, which on reload draws the whole workspace.
    expect(g.window.location.search).toBe('?topics=a,b');
    // And it is not mute: the destination is handed OUTSIDE, absolute.
    expect(outside).toEqual([
      `${origin}/task/t-detached`,
      `${origin}/topic/33333333-3333-4333-8333-333333333333`,
    ]);
    off();
  });

  test('la forma storica `?topic=` conta come staccata', async () => {
    const { events } = stubWindow(`${origin}/?topic=solo-questa`);
    g.window.open = () => {};
    expect(openDeepLinkInApp('/task/t-detached-legacy')).toBe(true);
    await until(() => false, 20);
    expect(events.map((e) => e.type)).toEqual([]);
  });
});
