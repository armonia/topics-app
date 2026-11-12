/**
 * A failed GET of a task's saved tabs must not let the next commit replace the
 * saved row with a partial one.
 * @covers BROWSER-STATE-01
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { taskBrowserTabs, ensureTaskTabsLoaded, __resetTaskTabs } from './taskBrowserTabs';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('task tabs: a failed read never leads to a PUT over the saved row', () => {
  const REAL_FETCH = globalThis.fetch;
  let methods: string[];
  let failGets: boolean;
  const taskId = `t-${Math.random().toString(36).slice(2)}`;

  beforeEach(() => {
    methods = [];
    failGets = true;
    (globalThis as unknown as { fetch: unknown }).fetch = (_url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      if (method === 'GET' && failGets) return Promise.resolve(new Response('{}', { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify(method === 'GET' ? null : { ok: true, server_seq: 1 }), { status: 200 }));
    };
  });
  afterEach(() => {
    __resetTaskTabs();
    (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
  });

  test('GET fails, then a commit: no PUT leaves', async () => {
    await ensureTaskTabsLoaded(taskId);
    taskBrowserTabs.addTab(taskId, 'https://example.com');
    await wait(1000);
    expect(methods).not.toContain('PUT');
  });

  test('the PUT goes out once a later GET succeeds', async () => {
    await ensureTaskTabsLoaded(taskId);
    taskBrowserTabs.addTab(taskId, 'https://example.com');
    await wait(20); // let the retry read the commit started fail too
    failGets = false;
    await ensureTaskTabsLoaded(taskId);
    await wait(1000);
    expect(methods).toContain('PUT');
  });
});
