/**
 * Exercise the actual singleton in an isolated process so its API mock and
 * browser cache cannot leak into other unit files.
 * @covers SNAPSYNC-01 @covers MP-SETUP-01
 */
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

function race(outcome: 'stale' | 'failure' | 'retry' | 'initial-failure') {
  const script = `
    import { mock } from 'bun:test';
    const pending = [], cache = new Map(), notifications = [];
    let requests = 0;
    globalThis.localStorage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value) };
    mock.module(${JSON.stringify(resolve(import.meta.dir, 'api.ts'))}, () => ({
      providersApi: { snapshot: () => { requests++; return new Promise((resolve, reject) => pending.push({ resolve, reject })); } },
      isProvidersSnapshot: value => Array.isArray(value?.providers) && typeof value.generatedAt === 'string',
    }));
    const store = await import(${JSON.stringify(resolve(import.meta.dir, 'providersSnapshotStore.ts'))});
    const { dispatchFrame } = await import(${JSON.stringify(resolve(import.meta.dir, 'wsFrameBus.ts'))});
    const snapshot = (status, time) => ({ providers: [{ name: 'openai', status, isDefault: true, models: ['gpt-test'], requirements: [], fetchedAt: time }], defaultProvider: 'openai', generatedAt: time });
    store.subscribeProvidersSnapshot(state => notifications.push({ status: state.snapshot?.providers[0].status ?? null, error: state.error?.message ?? null }));
    store.subscribeProvidersSnapshot(() => {});
    const outcome = ${JSON.stringify(outcome)};
    if (outcome !== 'initial-failure') dispatchFrame({ type: 'providers:snapshot', snapshot: snapshot('ready', '2026-09-08T12:00:02Z') });
    if (outcome === 'failure' || outcome === 'initial-failure') pending.shift().reject(new Error('offline'));
    else pending.shift().resolve(snapshot('unavailable', '2026-09-08T12:00:01Z'));
    await new Promise(resolve => setTimeout(resolve, 0));
    if (outcome === 'retry' || outcome === 'initial-failure') {
      const retry = store.reloadProvidersSnapshot();
      pending.shift().resolve(snapshot('ready', '2026-09-08T12:00:03Z'));
      await retry;
    }
    const state = store.getProvidersSnapshotState();
    process.stdout.write(JSON.stringify({ requests, notifications, status: state.snapshot?.providers[0].status ?? null, error: state.error?.message ?? null, generatedAt: state.snapshot?.generatedAt, cached: JSON.parse(cache.get('providers-snapshot-cache') ?? 'null') }));
  `;
  const child = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  return JSON.parse(new TextDecoder().decode(child.stdout));
}

test('an initial HTTP response cannot undo a newer WebSocket connection state or cache', () => {
  const result = race('stale');
  expect(result.requests).toBe(1);
  expect(result.notifications).toEqual([{ status: 'ready', error: null }]);
  expect(result.status).toBe('ready');
  expect(result.cached.providers[0].status).toBe('ready');
  expect(result.generatedAt).toBe('2026-09-08T12:00:02Z');
});

test('a superseded HTTP failure cannot restore an error after a successful WebSocket frame', () => {
  const result = race('failure');
  expect(result.notifications).toEqual([{ status: 'ready', error: null }]);
  expect(result.error).toBeNull();
});

test('an explicit reload after the WebSocket frame can still adopt fresh HTTP state', () => {
  const result = race('retry');
  expect(result.requests).toBe(2);
  expect(result.generatedAt).toBe('2026-09-08T12:00:03Z');
  expect(result.cached.generatedAt).toBe(result.generatedAt);
});

test('a first-paint failure remains visible and retry clears it', () => {
  const result = race('initial-failure');
  expect(result.notifications).toEqual([{ status: null, error: 'offline' }, { status: 'ready', error: null }]);
  expect(result.requests).toBe(2);
  expect(result.error).toBeNull();
});
