/**
 * The proxy's log in the background: read once when the first reader comes,
 * again every minute while the window is visible, never with nobody reading,
 * and dropped when the proxy stops answering.
 * @covers HUBBR-06
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  PROXY_ACTIVITY_REFRESH_MS, _readProxyActivityForTests, _resetProxyActivityForTests, refreshProxyActivity, retainProxyActivity,
} from './proxyActivity';
import type { VisibleIntervalEnv } from './documentVisibility';

function fakeEnv() {
  const timers: { cb: () => void; ms: number }[] = [];
  const env: VisibleIntervalEnv = {
    isVisible: () => true,
    subscribe: () => () => {},
    setInterval: (cb, ms) => { const t = { cb, ms }; timers.push(t); return t; },
    clearInterval: (t) => { timers.splice(timers.indexOf(t as (typeof timers)[number]), 1); },
  };
  return { env, timers };
}

function fakeFetch(answers: { activity: unknown }) {
  const paths: string[] = [];
  const fetch = async (path: string) => {
    paths.push(path);
    if (path.endsWith('/activity') && answers.activity === null) return new Response('down', { status: 502 });
    const body = path.endsWith('/activity') ? answers.activity : { profiles: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetch, paths };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => _resetProxyActivityForTests({ fetch: async () => new Response('{}') }));

describe('HUBBR-06: the proxy log read in the background', () => {
  test('the first reader reads at once and starts the minute; the last one out stops it', async () => {
    const { env, timers } = fakeEnv();
    const answers = { activity: { log: [{ type: 'auth-expired', ts: 1 }] } as unknown };
    const { fetch, paths } = fakeFetch(answers);
    _resetProxyActivityForTests({ fetch, env, now: () => 42 });
    const a = retainProxyActivity();
    const b = retainProxyActivity();
    await flush();
    expect(paths).toEqual(['/api/switchboard/activity', '/api/switchboard/profiles']);
    expect(timers.map((t) => t.ms)).toEqual([PROXY_ACTIVITY_REFRESH_MS]);
    expect(_readProxyActivityForTests()).toEqual({ activity: answers.activity, profiles: { profiles: [] }, readAt: 42 });

    // A minute later the log is read again: a new event arrives with the panel closed.
    answers.activity = { log: [{ type: 'upgrade', ts: 2 }] };
    timers[0]!.cb();
    await flush();
    expect(paths).toHaveLength(4);
    expect(_readProxyActivityForTests()?.activity).toEqual({ log: [{ type: 'upgrade', ts: 2 }] });

    a();
    a(); // released twice: still one reader left
    expect(timers).toHaveLength(1);
    b();
    expect(timers).toHaveLength(0);
  });

  test('a proxy that stops answering drops the old log', async () => {
    const answers = { activity: { log: [] } as unknown };
    const { fetch } = fakeFetch(answers);
    _resetProxyActivityForTests({ fetch, env: fakeEnv().env });
    await refreshProxyActivity();
    expect(_readProxyActivityForTests()).not.toBeNull();
    answers.activity = null;
    await refreshProxyActivity();
    expect(_readProxyActivityForTests()).toBeNull();
  });
});
