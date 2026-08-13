import { describe, test, expect, beforeEach } from 'bun:test';
import {
  buildTaskLink,
  parseTaskLocation,
  currentTaskTarget,
  selfTaskLinkTarget,
  reflectTaskOpen,
  reflectTaskClose,
  subscribePopstateTask,
  openTaskInApp,
  openTaskFromUrl,
  subscribeServiceWorkerTaskOpen,
  parseTopicLocation,
  selfTopicLinkTarget,
  openTopicInApp,
} from './openTaskLink';

// jsdom-less: a minimal, typed view of the global surface the module touches,
// so the stubs below need no `any` (this file is linted under no-explicit-any).
type Listener = (e: unknown) => void;
type StubWindow = {
  location: { origin: string; href: string; pathname: string; search: string };
  dispatchEvent?: (e: { type: string; detail?: unknown }) => boolean;
  history?: { pushState: (state: unknown, title: unknown, url: string) => void };
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

beforeEach(() => { stubWindow(`${origin}/`); });

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
  type SWListener = (e: { data: unknown }) => void;
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

  test('un /topic/<id> dalla push di fine chat apre la tab del topic', () => {
    const { events } = stubWindow(`${origin}/`);
    const { post } = stubServiceWorker();
    const off = subscribeServiceWorkerTaskOpen();
    post({ type: 'topics:open-url', url: '/topic/tp1' });
    expect(events.map((e) => e.type)).toEqual(['topics:open-topic']);
    expect(events[0].detail).toEqual({ topicId: 'tp1', mode: 'permanent' });
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

  test('openTopicInApp emette topics:open-topic (permanent)', () => {
    const { events } = stubWindow(`${origin}/`);
    openTopicInApp({ topicId: 'tp1' });
    expect(events.map((e) => e.type)).toEqual(['topics:open-topic']);
    expect(events[0].detail).toEqual({ topicId: 'tp1', mode: 'permanent' });
  });

  test('openTaskFromUrl apre il topic da finestra chiusa (/topic/<id> al boot)', () => {
    const { events } = stubWindow(`${origin}/topic/tp1`);
    openTaskFromUrl();
    expect(events.map((e) => e.type)).toEqual(['topics:open-topic']);
    expect(events[0].detail).toEqual({ topicId: 'tp1', mode: 'permanent' });
  });
});
