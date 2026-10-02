/**
 * @covers PROJECT-14
 *
 * The project icon store follows the server: a pushed `project:icon` swaps the
 * icon in place, an answer taken from the persisted cache is revalidated in ONE
 * request, a reconnect revalidates everything, and a probe that left before
 * the server spoke cannot overwrite it.
 *
 * Each scenario runs the real module in its own process: the store is a module
 * singleton (state, cache, socket subscriptions), and a second scenario in the
 * same process would start from the first one's leftovers. The browser is
 * stubbed at its edges only: `localStorage`, `Image`, `fetch`, `window` and
 * `document` listeners. Frames and reconnects go through the real
 * `wsFrameBus`.
 */
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const STORE = JSON.stringify(resolve(import.meta.dir, 'projectIconStore.ts'));
const BUS = JSON.stringify(resolve(import.meta.dir, '../../lib/wsFrameBus.ts'));
const CACHE_KEY = 'topics-project-icon-cache-v4';

/**
 * The harness every scenario starts from. `fetches` records each request;
 * `answer(i, response)` settles the i-th one. `images` records each probe
 * `Image`. `until(cond)` waits on a condition, for the store's own timers.
 */
const HARNESS = `
  const storage = new Map();
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const listeners = { focus: [], visibilitychange: [] };
  globalThis.window = { addEventListener: (t, f) => listeners[t]?.push(f) };
  globalThis.document = { visibilityState: 'visible', addEventListener: (t, f) => listeners[t]?.push(f) };
  const images = [];
  globalThis.Image = class { constructor() { images.push(this); } };
  const fetches = [];
  globalThis.fetch = (url, init) => new Promise((res, rej) => fetches.push({ url: String(url), init, res, rej }));
  const answer = (i, status, opts = {}) => fetches[i].res({
    status, ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === 'etag' ? opts.etag ?? null : null) },
    json: async () => opts.json,
    blob: async () => new Blob(['x']),
  });
  const until = async (cond) => { const end = Date.now() + 5000; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 5)); } return cond(); };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const seed = (entries) => storage.set(${JSON.stringify(CACHE_KEY)}, JSON.stringify(entries));
  const disk = () => JSON.parse(storage.get(${JSON.stringify(CACHE_KEY)}) ?? '{}');
  const store = await import(${STORE});
  const bus = await import(${BUS});
  const out = (v) => process.stdout.write(JSON.stringify(v));
`;

function run(body: string): Record<string, unknown> {
  const child = Bun.spawnSync([process.execPath, '-e', HARNESS + body], { stdout: 'pipe', stderr: 'pipe' });
  const stderr = new TextDecoder().decode(child.stderr);
  expect(child.exitCode, stderr).toBe(0);
  return JSON.parse(new TextDecoder().decode(child.stdout));
}

test('a verified "no icon" from the cache is revalidated in one request, and an icon that appeared meanwhile shows up', () => {
  const r = run(`
    seed({ '/p/a': { s: 'none', t: Date.now(), v: true }, '/p/b': { s: 'none', t: Date.now(), v: true } });
    const first = [store.projectIconSnapshot('/p/a').s, store.projectIconSnapshot('/p/b').s];
    store.ensureProjectIcon('/p/a');
    store.ensureProjectIcon('/p/b');
    await until(() => fetches.length > 0);
    const req = fetches[0];
    answer(0, 200, { json: { versions: { '/p/a': 'v1', '/p/b': null } } });
    await until(() => store.projectIconSnapshot('/p/a').s === 'has');
    out({
      first,
      requests: fetches.map((f) => [f.init?.method ?? 'GET', f.url]),
      body: JSON.parse(req.init.body),
      probes: images.length,
      a: store.projectIconSnapshot('/p/a'),
      b: store.projectIconSnapshot('/p/b').s,
      diskA: disk()['/p/a'],
    });
  `);
  // The first frame draws what the cache says: no slot opens while asking.
  expect(r.first).toEqual(['none', 'none']);
  expect(r.requests).toEqual([['POST', '/api/projects/icon-versions']]);
  expect(r.body).toEqual({ paths: ['/p/a', '/p/b'] });
  expect(r.probes).toBe(0);
  expect(r.a).toEqual({ s: 'has', src: '/api/projects/icon?path=%2Fp%2Fa&v=v1', version: 'v1' });
  expect(r.b).toBe('none');
  expect(r.diskA).toMatchObject({ s: 'has', version: 'v1' });
});

test('a pushed project:icon swaps the icon in place, to a new URL, and a null takes it away', () => {
  const r = run(`
    seed({ '/p/a': { s: 'has', t: Date.now(), v: true, version: 'v1' } });
    const before = store.projectIconSnapshot('/p/a');
    store.ensureProjectIcon('/p/a');
    bus.dispatchFrame({ type: 'project:icon', path: '/p/a', version: 'v2' });
    const changed = store.projectIconSnapshot('/p/a');
    const diskChanged = disk()['/p/a'];
    bus.dispatchFrame({ type: 'project:icon', path: '/p/a', version: null });
    const removed = store.projectIconSnapshot('/p/a').s;
    const diskRemoved = disk()['/p/a'];
    bus.dispatchFrame({ type: 'project:icon', path: '/p/elsewhere', version: 'v9' });
    out({ before, changed, diskChanged, removed, diskRemoved, elsewhere: disk()['/p/elsewhere'] ?? null, probes: images.length });
  `);
  expect(r.before).toEqual({ s: 'has', src: '/api/projects/icon?path=%2Fp%2Fa&v=v1', version: 'v1' });
  expect(r.changed).toEqual({ s: 'has', src: '/api/projects/icon?path=%2Fp%2Fa&v=v2', version: 'v2' });
  expect(r.diskChanged).toMatchObject({ s: 'has', version: 'v2' });
  expect(r.removed).toBe('none');
  // A removal stated by the server is a VERIFIED answer, so it may persist.
  expect(r.diskRemoved).toMatchObject({ s: 'none', v: true });
  // A frame about a project this window draws nowhere changes nothing here.
  expect(r.elsewhere).toBeNull();
  expect(r.probes).toBe(0);
});

test('a probe that left before the push cannot overwrite it', () => {
  const r = run(`
    store.ensureProjectIcon('/p/new');
    const probing = store.projectIconSnapshot('/p/new').s;
    bus.dispatchFrame({ type: 'project:icon', path: '/p/new', version: 'v1' });
    // The <img> probe was answered by the 204 sent BEFORE the favicon existed.
    images[0].onerror();
    await flush();
    out({ probing, after: store.projectIconSnapshot('/p/new'), requests: fetches.length });
  `);
  expect(r.probing).toBe('probing');
  expect(r.after).toEqual({ s: 'has', src: '/api/projects/icon?path=%2Fp%2Fnew&v=v1', version: 'v1' });
  // Superseded: not even the fetch lane goes out.
  expect(r.requests).toBe(0);
});

test('a fetch-lane answer that arrives after the push is dropped too', () => {
  const r = run(`
    store.ensureProjectIcon('/p/new');
    images[0].onerror();
    await until(() => fetches.length === 1);
    bus.dispatchFrame({ type: 'project:icon', path: '/p/new', version: 'v1' });
    answer(0, 204);
    await flush(); await flush();
    out({ after: store.projectIconSnapshot('/p/new').s, disk: disk()['/p/new'] });
  `);
  expect(r.after).toBe('has');
  expect(r.disk).toMatchObject({ s: 'has', version: 'v1' });
});

test('a reconnect revalidates every icon on screen in one request; the first connection does not', () => {
  const r = run(`
    seed({ '/p/a': { s: 'has', t: Date.now(), v: true, version: 'v1' }, '/p/b': { s: 'none', t: Date.now(), v: true } });
    store.projectIconSnapshot('/p/a'); store.projectIconSnapshot('/p/b');
    store.ensureProjectIcon('/p/a'); store.ensureProjectIcon('/p/b');
    await until(() => fetches.length === 1);
    answer(0, 200, { json: { versions: { '/p/a': 'v1', '/p/b': null } } });
    await flush();
    bus.dispatchLifecycle('open');
    await flush();
    const afterFirstOpen = fetches.length;
    bus.dispatchLifecycle('close');
    bus.dispatchLifecycle('open');
    await until(() => fetches.length === 2);
    const body = JSON.parse(fetches[1].init.body);
    answer(1, 200, { json: { versions: { '/p/a': 'v2', '/p/b': 'v7' } } });
    await until(() => store.projectIconSnapshot('/p/b').s === 'has');
    out({ afterFirstOpen, body, a: store.projectIconSnapshot('/p/a').src, b: store.projectIconSnapshot('/p/b').src });
  `);
  expect(r.afterFirstOpen).toBe(1);
  expect((r.body as { paths: string[] }).paths.sort()).toEqual(['/p/a', '/p/b']);
  expect(r.a).toBe('/api/projects/icon?path=%2Fp%2Fa&v=v2');
  expect(r.b).toBe('/api/projects/icon?path=%2Fp%2Fb&v=v7');
});

test('back to the front: one revalidation, then none for the next 30 s', () => {
  const r = run(`
    seed({ '/p/a': { s: 'has', t: Date.now(), v: true, version: 'v1' } });
    store.projectIconSnapshot('/p/a');
    store.ensureProjectIcon('/p/a');
    await until(() => fetches.length === 1);
    answer(0, 200, { json: { versions: { '/p/a': 'v1' } } });
    await flush();
    for (const f of listeners.focus) f();
    for (const f of listeners.focus) f();
    for (const f of listeners.visibilitychange) f();
    await flush();
    out({ requests: fetches.length });
  `);
  expect(r.requests).toBe(2);
});

test('invariant kept: a transport error is never written to disk as "no icon"', () => {
  const r = run(`
    store.ensureProjectIcon('/p/x');
    images[0].onerror();
    await until(() => fetches.length === 1);
    fetches[0].rej(new Error('Load failed'));
    await until(() => store.projectIconSnapshot('/p/x').s === 'none');
    out({ s: store.projectIconSnapshot('/p/x').s, disk: disk()['/p/x'] ?? null });
  `);
  expect(r.s).toBe('none');
  expect(r.disk).toBeNull();
});

test('a probe learns the version from the ETag when it has to use the fetch lane', () => {
  const r = run(`
    store.ensureProjectIcon('/p/y');
    images[0].onerror();
    await until(() => fetches.length === 1);
    answer(0, 200, { etag: '"abc123"' });
    await until(() => store.projectIconSnapshot('/p/y').s === 'has');
    out({ version: store.projectIconSnapshot('/p/y').version, disk: disk()['/p/y'] });
  `);
  expect(r.version).toBe('abc123');
  expect(r.disk).toMatchObject({ s: 'has', version: 'abc123' });
});

test('in a window whose <img> cannot reach the server, a pushed version replaces the picture without emptying it', () => {
  const r = run(`
    globalThis.URL.createObjectURL = (() => { let n = 0; return () => 'blob:icon-' + (++n); })();
    globalThis.URL.revokeObjectURL = () => {};
    seed({ '/p/a': { s: 'has', t: Date.now(), v: true, version: 'v1' } });
    store.ensureProjectIcon('/p/a');
    await until(() => fetches.length > 0);
    answer(0, 200, { json: { versions: { '/p/a': 'v1' } } });
    await flush();
    // The <img> on the endpoint fails (WKWebView, self-signed TLS): the blob recovery takes over.
    store.reportImgError('/p/a', store.projectIconSnapshot('/p/a').src);
    await until(() => fetches.length > 1);
    answer(1, 200, { etag: '"v1"' });
    await until(() => store.projectIconSnapshot('/p/a').src?.startsWith('blob:'));
    const recovered = store.projectIconSnapshot('/p/a').src;
    // A new version is pushed.
    bus.dispatchFrame({ type: 'project:icon', path: '/p/a', version: 'v2' });
    const meanwhile = { ...store.projectIconSnapshot('/p/a') };
    await until(() => fetches.length > 2);
    const pushedUrl = fetches[2]?.url ?? null;
    if (pushedUrl) answer(2, 200, { etag: '"v2"' });
    await until(() => store.projectIconSnapshot('/p/a').version === 'v2' && store.projectIconSnapshot('/p/a').src !== recovered);
    out({ recovered, meanwhile, pushedUrl, after: store.projectIconSnapshot('/p/a') });
  `);
  expect(String(r.recovered)).toMatch(/^blob:/);
  // Until the new bytes land, the surfaces keep drawing the old picture.
  expect(r.meanwhile).toMatchObject({ s: 'has', src: r.recovered });
  expect(String(r.pushedUrl)).toContain('&v=v2');
  expect((r.after as { src: string }).src).toMatch(/^blob:/);
  expect((r.after as { src: string }).src).not.toBe(r.recovered);
});

test('the icons drawn longest are asked LAST, so the server, which watches a bounded set and drops the oldest, keeps them', () => {
  // The server watches 128 projects and drops the one asked about longest ago.
  // The palette draws every topic's project after the sidebar: asked in the
  // order they were first seen, the sidebar's paths went first and were the
  // ones dropped, at every revalidation too.
  const r = run(`
    const v = (paths) => Object.fromEntries(paths.map((p) => [p, 'v1']));
    seed(Object.fromEntries(['/p/side1', '/p/side2', '/p/pal1', '/p/pal2'].map((p) => [p, { s: 'has', t: Date.now(), v: true, version: 'v1' }])));
    const sidebar = ['/p/side1', '/p/side2'].map((p) => store.subscribeProjectIcon(p, () => {}));
    store.ensureProjectIcon('/p/side1'); store.ensureProjectIcon('/p/side2');
    await until(() => fetches.length === 1);
    answer(0, 200, { json: { versions: v(['/p/side1', '/p/side2']) } });
    await flush();
    // The palette opens: its rows draw two more projects.
    const palette = ['/p/pal1', '/p/pal2'].map((p) => store.subscribeProjectIcon(p, () => {}));
    store.ensureProjectIcon('/p/pal1'); store.ensureProjectIcon('/p/pal2');
    await until(() => fetches.length === 2);
    const opened = JSON.parse(fetches[1].init.body).paths;
    answer(1, 200, { json: { versions: v(opened) } });
    await flush();
    // It closes, and the socket comes back: everything is asked again.
    for (const off of palette) off();
    bus.dispatchLifecycle('open');
    bus.dispatchLifecycle('close');
    bus.dispatchLifecycle('open');
    await until(() => fetches.length === 3);
    const again = JSON.parse(fetches[2].init.body).paths;
    for (const off of sidebar) off();
    out({ opened, again });
  `);
  // The palette's new paths, then the sidebar's, still on screen, at the end.
  expect((r.opened as string[]).slice(-2).sort()).toEqual(['/p/side1', '/p/side2']);
  expect((r.opened as string[]).slice(0, 2).sort()).toEqual(['/p/pal1', '/p/pal2']);
  // Closed, the palette's paths go first and the sidebar's last.
  expect((r.again as string[]).slice(0, 2).sort()).toEqual(['/p/pal1', '/p/pal2']);
  expect((r.again as string[]).slice(-2).sort()).toEqual(['/p/side1', '/p/side2']);
});
