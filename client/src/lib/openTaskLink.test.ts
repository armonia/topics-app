import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { buildTaskLink, parseTaskLink, consumePendingTaskOpen, openTaskFromUrl } from './openTaskLink';

// jsdom-less: stub the tiny window surface the module touches.
const origin = 'https://localhost:3333';

describe('parseTaskLink', () => {
  test('round-trips a project slug + UUID', () => {
    const projectId = 'topics-app-ar3jt5';
    const taskId = '92a1091a-c9e3-4064-a098-2383bd37f2fe';
    (globalThis as any).window = { location: { origin } };
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
  const events: Array<{ type: string; detail: any }> = [];
  let replaced: string | null = null;

  beforeEach(() => {
    events.length = 0;
    replaced = null;
    consumePendingTaskOpen(); // drain any leftover
    (globalThis as any).window = {
      location: { origin, href: `${origin}/?task=proj-x~task-1&keep=1`, search: '?task=proj-x~task-1&keep=1' },
      dispatchEvent: (e: any) => { events.push({ type: e.type, detail: e.detail }); return true; },
      history: { replaceState: (_s: any, _t: any, url: string) => { replaced = url; } },
    };
    (globalThis as any).CustomEvent = class { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o?.detail; } };
    (globalThis as any).URL = URL;
    (globalThis as any).URLSearchParams = URLSearchParams;
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
    (globalThis as any).window.location.search = '?keep=1';
    (globalThis as any).window.location.href = `${origin}/?keep=1`;
    openTaskFromUrl();
    expect(events.length).toBe(0);
    expect(consumePendingTaskOpen()).toBeNull();
  });
});

describe('consumePendingTaskOpen', () => {
  test('is one-shot', () => {
    (globalThis as any).window = {
      location: { origin, href: `${origin}/?task=p~t`, search: '?task=p~t' },
      dispatchEvent: () => true,
      history: { replaceState: () => {} },
    };
    (globalThis as any).CustomEvent = class { type: string; detail: any; constructor(t: string, o: any) { this.type = t; this.detail = o?.detail; } };
    openTaskFromUrl();
    expect(consumePendingTaskOpen()).toEqual({ projectId: 'p', taskId: 't' });
    expect(consumePendingTaskOpen()).toBeNull();
  });
});
