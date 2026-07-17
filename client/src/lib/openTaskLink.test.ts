import { describe, test, expect, beforeEach } from 'bun:test';
import {
  buildTaskLink,
  parseTaskLink,
  currentTaskTarget,
  selfTaskLinkTarget,
  reflectTaskOpen,
  reflectTaskClose,
  subscribePopstateTask,
  openTaskInApp,
  openTaskFromUrl,
} from './openTaskLink';

// jsdom-less: a minimal, typed view of the global surface the module touches,
// so the stubs below need no `any` (this file is linted under no-explicit-any).
type Listener = (e: unknown) => void;
type StubWindow = {
  location: { origin: string; href: string; search: string };
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
    g.window.location.search = u.search;
    g.window.location.origin = u.origin;
  };
  g.window = {
    location: { origin: new URL(href).origin, href, search: new URL(href).search },
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

describe('parseTaskLink / buildTaskLink', () => {
  test('round-trips a project slug + UUID', () => {
    const projectId = 'topics-app-ar3jt5';
    const taskId = '92a1091a-c9e3-4064-a098-2383bd37f2fe';
    const link = buildTaskLink(projectId, taskId);
    // The URL API percent-encodes '~' as %7E in the query — that's fine, it
    // round-trips through parseTaskLink (URLSearchParams decodes it back).
    expect(link.startsWith(`${origin}/?task=`)).toBe(true);
    expect(parseTaskLink(new URL(link).search)).toEqual({ projectId, taskId });
  });

  test('splits on the FIRST ~ (project slug may not, but be defensive)', () => {
    expect(parseTaskLink('?task=a~b~c')).toEqual({ projectId: 'a', taskId: 'b~c' });
  });

  test('rejects missing / malformed', () => {
    expect(parseTaskLink('')).toBeNull();
    expect(parseTaskLink('?task=')).toBeNull();
    expect(parseTaskLink('?task=noseparator')).toBeNull();
    expect(parseTaskLink('?task=~onlytask')).toBeNull();
    expect(parseTaskLink('?task=onlyproject~')).toBeNull();
    expect(parseTaskLink('?other=x')).toBeNull();
  });
});

describe('currentTaskTarget', () => {
  test('reads the task from the current location', () => {
    stubWindow(`${origin}/?task=proj-x~task-1&keep=1`);
    expect(currentTaskTarget()).toEqual({ projectId: 'proj-x', taskId: 'task-1' });
  });
  test('null when absent', () => {
    stubWindow(`${origin}/?keep=1`);
    expect(currentTaskTarget()).toBeNull();
  });
});

describe('selfTaskLinkTarget', () => {
  test('same page origin → target', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget(`${origin}/?task=proj~t1`)).toEqual({ projectId: 'proj', taskId: 't1' });
  });
  test('relative self URL → target', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget('/?task=proj~t1')).toEqual({ projectId: 'proj', taskId: 't1' });
  });
  test('foreign origin → null (falls back to external open)', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget('https://evil.example/?task=proj~t1')).toBeNull();
  });
  test('self origin but no ?task → null', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget(`${origin}/docs`)).toBeNull();
  });
  test('garbage url → null', () => {
    stubWindow(`${origin}/`);
    expect(selfTaskLinkTarget('not a url ::://')).toBeNull();
  });
});

describe('URL reflection (reflectTaskOpen / reflectTaskClose)', () => {
  test('open pushes ?task=, preserving other params', () => {
    stubWindow(`${origin}/?keep=1`);
    reflectTaskOpen({ projectId: 'proj', taskId: 't1' });
    expect(currentTaskTarget()).toEqual({ projectId: 'proj', taskId: 't1' });
    expect(g.window.location.search).toContain('keep=1');
  });

  test('open is a no-op when already reflected (no duplicate push)', () => {
    const { sync } = stubWindow(`${origin}/`);
    let pushes = 0;
    g.window.history = { pushState: (_s, _t, url) => { pushes++; sync(url); } };
    reflectTaskOpen({ projectId: 'proj', taskId: 't1' });
    reflectTaskOpen({ projectId: 'proj', taskId: 't1' });
    expect(pushes).toBe(1);
  });

  test('close removes ?task=, keeping other params', () => {
    stubWindow(`${origin}/?task=proj~t1&keep=1`);
    reflectTaskClose();
    expect(currentTaskTarget()).toBeNull();
    expect(g.window.location.search).toContain('keep=1');
  });

  test('close is a no-op when the param is already absent', () => {
    const { sync } = stubWindow(`${origin}/`);
    let pushes = 0;
    g.window.history = { pushState: (_s, _t, url) => { pushes++; sync(url); } };
    reflectTaskClose();
    expect(pushes).toBe(0);
  });
});

describe('subscribePopstateTask', () => {
  test('reports the URL target on back/forward and unsubscribes', () => {
    const { popstateCbs } = stubWindow(`${origin}/?task=proj~t1`);
    const seen: Array<{ projectId: string; taskId: string } | null> = [];
    const off = subscribePopstateTask((t) => seen.push(t));
    // simulate a back nav that lands on ?task=proj~t2
    g.window.location.search = '?task=proj~t2';
    g.window.location.href = `${origin}/?task=proj~t2`;
    popstateCbs.forEach((cb) => cb({ type: 'popstate' }));
    // and a forward/back to a clean URL
    g.window.location.search = '';
    g.window.location.href = `${origin}/`;
    popstateCbs.forEach((cb) => cb({ type: 'popstate' }));
    off();
    expect(seen).toEqual([{ projectId: 'proj', taskId: 't2' }, null]);
    expect(popstateCbs.length).toBe(0);
  });
});

describe('openTaskInApp / openTaskFromUrl', () => {
  test('openTaskInApp activates the board + emits open-task', () => {
    const { events } = stubWindow(`${origin}/`);
    openTaskInApp({ projectId: 'proj', taskId: 't1' });
    expect(events.map((e) => e.type)).toEqual(['topics:open-utility', 'topics:open-task']);
    expect(events[0].detail).toEqual({ type: 'board' });
    expect(events[1].detail).toEqual({ projectId: 'proj', taskId: 't1' });
  });

  test('openTaskFromUrl opens when ?task present, and does NOT strip it', () => {
    const { events } = stubWindow(`${origin}/?task=proj~t1&keep=1`);
    openTaskFromUrl();
    expect(events.map((e) => e.type)).toEqual(['topics:open-utility', 'topics:open-task']);
    // The param stays — the URL is the source of truth (refresh recovers it);
    // it is cleared only when the drawer closes, not on load.
    expect(currentTaskTarget()).toEqual({ projectId: 'proj', taskId: 't1' });
  });

  test('openTaskFromUrl is a no-op without ?task', () => {
    const { events } = stubWindow(`${origin}/?keep=1`);
    openTaskFromUrl();
    expect(events.length).toBe(0);
  });
});
