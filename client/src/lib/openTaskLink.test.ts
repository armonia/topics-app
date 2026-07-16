import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { buildTaskLink, parseTaskLink, consumePendingTaskOpen, openTaskFromUrl } from './openTaskLink';

// jsdom-less: a minimal, typed view of the global surface the module touches,
// so the stubs below need no `any` (this file is linted under no-explicit-any).
type StubWindow = {
  location: { origin: string; href?: string; search?: string };
  dispatchEvent?: (e: { type: string; detail?: unknown }) => boolean;
  history?: { replaceState: (state: unknown, title: unknown, url: string) => void };
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

describe('parseTaskLink', () => {
  test('round-trips a project slug + UUID', () => {
    const projectId = 'topics-app-ar3jt5';
    const taskId = '92a1091a-c9e3-4064-a098-2383bd37f2fe';
    g.window = { location: { origin } };
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

describe('openTaskFromUrl', () => {
  const events: Array<{ type: string; detail: unknown }> = [];
  let replaced: string | null = null;

  beforeEach(() => {
    events.length = 0;
    replaced = null;
    consumePendingTaskOpen(); // drain any leftover
    g.window = {
      location: { origin, href: `${origin}/?task=proj-x~task-1&keep=1`, search: '?task=proj-x~task-1&keep=1' },
      dispatchEvent: (e) => { events.push({ type: e.type, detail: e.detail }); return true; },
      history: { replaceState: (_s, _t, url) => { replaced = url; } },
    };
    g.CustomEvent = StubCustomEvent;
    g.URL = URL;
    g.URLSearchParams = URLSearchParams;
  });
  afterEach(() => { consumePendingTaskOpen(); });

  test('opens the board, hands off the target, strips only the task param', () => {
    openTaskFromUrl();
    expect(events.map((e) => e.type)).toEqual(['topics:open-utility', 'topics:open-task']);
    expect(events[0].detail).toEqual({ type: 'board' });
    expect(events[1].detail).toEqual({ projectId: 'proj-x', taskId: 'task-1' });
    // pending is available for a board that mounts now.
    expect(consumePendingTaskOpen()).toEqual({ projectId: 'proj-x', taskId: 'task-1' });
    // URL cleaned of ?task but other params preserved.
    expect(replaced).toBe(`${origin}/?keep=1`);
  });

  test('no-op without ?task', () => {
    g.window.location.search = '?keep=1';
    g.window.location.href = `${origin}/?keep=1`;
    openTaskFromUrl();
    expect(events.length).toBe(0);
    expect(consumePendingTaskOpen()).toBeNull();
  });
});

describe('consumePendingTaskOpen', () => {
  test('is one-shot', () => {
    g.window = {
      location: { origin, href: `${origin}/?task=p~t`, search: '?task=p~t' },
      dispatchEvent: () => true,
      history: { replaceState: () => {} },
    };
    g.CustomEvent = StubCustomEvent;
    openTaskFromUrl();
    expect(consumePendingTaskOpen()).toEqual({ projectId: 'p', taskId: 't' });
    expect(consumePendingTaskOpen()).toBeNull();
  });
});
