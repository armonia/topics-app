/**
 * A failed GET of a task's saved layout must not let the next commit replace
 * the saved row with a near-empty one.
 * @covers LAYOUT-23
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { taskBrowserLayout, forgetTaskLayout, ensureTaskLayoutLoaded, EMPTY_TASK_LAYOUT } from './taskBrowserLayout';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('task layout: a failed read never leads to a PUT over the saved row', () => {
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
      return Promise.resolve(new Response(JSON.stringify(method === 'GET' ? null : { ok: true }), { status: 200 }));
    };
  });
  afterEach(() => {
    forgetTaskLayout(taskId);
    (globalThis as unknown as { fetch: unknown }).fetch = REAL_FETCH;
  });

  test('GET fails, then a commit: no PUT leaves', async () => {
    await ensureTaskLayoutLoaded(taskId);
    taskBrowserLayout.set(taskId, { ...EMPTY_TASK_LAYOUT, focusedGroupId: 'g1' });
    await wait(1000);
    expect(methods).not.toContain('PUT');
  });

  test('the PUT goes out once a later GET succeeds', async () => {
    await ensureTaskLayoutLoaded(taskId);
    taskBrowserLayout.set(taskId, { ...EMPTY_TASK_LAYOUT, focusedGroupId: 'g1' });
    await wait(20); // let the retry read the commit started fail too
    failGets = false;
    await ensureTaskLayoutLoaded(taskId);
    await wait(1000);
    expect(methods).toContain('PUT');
    expect(methods.indexOf('PUT')).toBeGreaterThan(methods.lastIndexOf('GET') - 1);
  });
});
