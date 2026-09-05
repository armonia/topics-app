/**
 * @covers NATIVEOPS-01
 */
import { test, expect } from 'bun:test';
import {
  executeNativeBrowserOp,
  NATIVE_SUPPORTED_OPS,
  clearNativeSnapshotCache,
  type Invoke,
} from './tauriBrowserOps';
import { serialize, diff, type Snapshot } from '../../../../shared/browser-snapshot-core';

function recordingInvoke(returns: Record<string, unknown> = {}): { invoke: Invoke; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const invoke: Invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    return (returns[cmd] ?? '') as never;
  };
  return { invoke, calls };
}

/** A snapshot fixture + an invoke that discriminates SNAPSHOT_FN vs ACT_FN by body. */
const SNAP: Snapshot = {
  url: 'https://example.com/',
  title: 'Example',
  scrollY: 0,
  scrollMaxY: 0,
  elements: [
    { ref: 1, role: 'link', name: 'Home' },
    { ref: 2, role: 'button', name: 'Go' },
  ],
  truncated: false,
};

function snapshotAwareInvoke(actResult: unknown = { ok: true }): { invoke: Invoke; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const invoke: Invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'browser_eval_js') {
      const js = (args as { js: string }).js;
      if (js.includes('getClientRects')) return JSON.stringify(SNAP) as never; // SNAPSHOT_FN
      if (js.includes('scrollIntoView')) return JSON.stringify(actResult) as never; // ACT_FN
      return '' as never;
    }
    return '' as never;
  };
  return { invoke, calls };
}

/** An invoke whose readyState probe answers from a queue, one reply per call. */
function loadProbeInvoke(states: string[], origin = 'https://x.com'): { invoke: Invoke; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const queue = [...states];
  const invoke: Invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'browser_eval_js') {
      const ready = queue.length > 1 ? queue.shift() : queue[0];
      return JSON.stringify({ origin, ready }) as never;
    }
    return '' as never;
  };
  return { invoke, calls };
}

test('browser_open navigates and answers only once the document has settled', async () => {
  const { invoke, calls } = loadProbeInvoke(['complete']);
  const out = await executeNativeBrowserOp('ctx', 'browser_open', { url: 'https://x.com' }, invoke);
  expect(calls[0]).toEqual(['browser_navigate', { id: 'ctx', url: 'https://x.com' }]);
  // The probe is the proof the op waited instead of answering on the request.
  expect(calls[1][0]).toBe('browser_eval_js');
  expect(out).toEqual({ result: { ok: true, url: 'https://x.com', ready: true } });
});

test('browser_open keeps polling while the pane is still loading', async () => {
  // `browser_navigate` returns before WKWebView finishes: a pane that answers
  // 'loading' must not be handed to the agent (an empty frame makes the vision
  // model invent a page instead of reporting a blank one).
  const { invoke } = loadProbeInvoke(['loading', 'complete']);
  const out = await executeNativeBrowserOp('ctx', 'browser_open', { url: 'https://x.com' }, invoke);
  expect(out).toEqual({ result: { ok: true, url: 'https://x.com', ready: true } });
});

test('browser_open on a non-http url waits on readyState alone (no origin to match)', async () => {
  // about:/data: report origin "null": matching it would never settle.
  const { invoke } = loadProbeInvoke(['complete'], 'null');
  const out = await executeNativeBrowserOp('ctx', 'browser_open', { url: 'about:blank' }, invoke);
  expect(out).toEqual({ result: { ok: true, url: 'about:blank', ready: true } });
});

test('browser_eval forwards the expression to browser_eval_js and returns its result', async () => {
  const { invoke, calls } = recordingInvoke({ browser_eval_js: '42' });
  const out = await executeNativeBrowserOp('ctx', 'browser_eval', { expression: '6*7' }, invoke);
  expect(calls[0]).toEqual(['browser_eval_js', { id: 'ctx', js: '6*7' }]);
  expect(out).toEqual({ result: '42' });
});

test('browser_get_text reads document text capped at max', async () => {
  const { invoke, calls } = recordingInvoke({ browser_eval_js: 'hello' });
  const out = await executeNativeBrowserOp('ctx', 'browser_get_text', { max: 100 }, invoke);
  expect((calls[0][1] as { js: string }).js).toContain('.slice(0,100)');
  expect(out).toEqual({ result: 'hello' });
});

test('browser_get_text with a ref scopes to the observed element', async () => {
  const { invoke, calls } = recordingInvoke({ browser_eval_js: 'snippet' });
  const out = await executeNativeBrowserOp('ctx', 'browser_get_text', { ref: 3, max: 100 }, invoke);
  expect((calls[0][1] as { js: string }).js).toContain('data-topics-ref="3"');
  expect(out).toEqual({ result: 'snippet' });
});

test('browser_observe (full) serializes with the shared core format', async () => {
  clearNativeSnapshotCache('obs');
  const { invoke } = snapshotAwareInvoke();
  const out = await executeNativeBrowserOp('obs', 'browser_observe', { full: true }, invoke);
  expect(out).toEqual({
    result: { url: SNAP.url, title: SNAP.title, count: 2, snapshot: serialize(SNAP), full: true },
  });
});

test('browser_observe (incremental) diffs against the previous snapshot', async () => {
  clearNativeSnapshotCache('obs2');
  const { invoke } = snapshotAwareInvoke();
  // First observe primes the cache (full).
  await executeNativeBrowserOp('obs2', 'browser_observe', {}, invoke);
  // Second observe (same DOM) → "no element changes" diff, full:false.
  const out = await executeNativeBrowserOp('obs2', 'browser_observe', {}, invoke);
  expect(out.result).toEqual({
    url: SNAP.url,
    title: SNAP.title,
    count: 2,
    snapshot: diff(SNAP, SNAP).text,
    full: false,
  });
});

test('browser_act clicks by ref and returns the post-action diff', async () => {
  clearNativeSnapshotCache('act');
  const { invoke, calls } = snapshotAwareInvoke({ ok: true });
  const out = await executeNativeBrowserOp('act', 'browser_act', { ref: 2, action: 'click' }, invoke);
  // Injected ACT_FN call carries the ref + action.
  const actCall = calls.find(([cmd, args]) => cmd === 'browser_eval_js' && (args as { js: string }).js.includes('scrollIntoView'));
  expect(actCall).toBeTruthy();
  // `untrusted: true` — the native pane drives synthetic (isTrusted=false) events.
  expect(out.result).toEqual({ ok: true, action: 'click', ref: 2, snapshot: diff(undefined, SNAP).text, untrusted: true });
});

test('browser_act rejects a ref-action without a ref (no invoke)', async () => {
  const { invoke, calls } = recordingInvoke();
  const out = await executeNativeBrowserOp('ctx', 'browser_act', { action: 'click' }, invoke);
  expect(out.error).toContain("requires 'ref'");
  expect(calls).toHaveLength(0);
});

test('browser_act rejects an unknown action', async () => {
  const { invoke } = recordingInvoke();
  const out = await executeNativeBrowserOp('ctx', 'browser_act', { ref: 1, action: 'teleport' }, invoke);
  expect(out.error).toContain("'action' must be one of");
});

test('browser_act surfaces a failed ACT_FN result as an error', async () => {
  clearNativeSnapshotCache('actfail');
  const { invoke } = snapshotAwareInvoke({ ok: false, error: 'ref 9 not found on the page (stale snapshot?)' });
  const out = await executeNativeBrowserOp('actfail', 'browser_act', { ref: 9, action: 'click' }, invoke);
  expect(out.error).toContain('ref 9 not found');
});

/**
 * Stale ref on the native pane. Same rule as the server path (both call
 * `refAfterResnapshot`): the DOM here is a snapshot we can swap, and ACT_FN is
 * answered by looking for the ref in the CURRENT one.
 */
function stalePaneInvoke(first: Snapshot, after: Snapshot): { invoke: Invoke; actedRefs: number[] } {
  const actedRefs: number[] = [];
  let current = first;
  const invoke: Invoke = async (cmd, args) => {
    if (cmd !== 'browser_eval_js') return '' as never;
    const js = (args as { js: string }).js;
    if (js.includes('getClientRects')) {
      const out = JSON.stringify(current);
      current = after; // the next read sees the re-rendered page
      return out as never;
    }
    if (js.includes('scrollIntoView')) {
      const ref = Number(/"ref":(\d+)/.exec(js)?.[1] ?? NaN);
      const known = current.elements.some((e) => e.ref === ref);
      if (!known) {
        return JSON.stringify({
          ok: false,
          error: `ref ${ref} not found on the page (stale snapshot? call browser_observe again, then act)`,
        }) as never;
      }
      actedRefs.push(ref);
      return JSON.stringify({ ok: true }) as never;
    }
    return '' as never;
  };
  return { invoke, actedRefs };
}

const RENUMBERED: Snapshot = {
  ...SNAP,
  elements: [{ ref: 1, role: 'button', name: 'Go' }],
};
const AMBIGUOUS: Snapshot = {
  ...SNAP,
  elements: [
    { ref: 1, role: 'button', name: 'Go' },
    { ref: 2, role: 'button', name: 'Go' },
  ],
};

test('browser_act on a stale ref: re-snapshots and acts on the SAME element, once', async () => {
  clearNativeSnapshotCache('stale');
  // Seed the cache with the page as it was, then let the pane re-render.
  const { invoke, actedRefs } = stalePaneInvoke(SNAP, RENUMBERED);
  await executeNativeBrowserOp('stale', 'browser_observe', { full: true }, invoke);
  const out = await executeNativeBrowserOp('stale', 'browser_act', { ref: 2, action: 'click' }, invoke);
  expect(actedRefs).toEqual([1]);
  expect((out.result as { ref?: number })?.ref).toBe(1);
  expect((out.result as { snapshot?: string })?.snapshot).toContain('ref 2 was stale');
});

test('browser_act on a stale ref with two identical candidates: no guess, the error carries the listing', async () => {
  clearNativeSnapshotCache('stale2');
  const { invoke, actedRefs } = stalePaneInvoke(SNAP, AMBIGUOUS);
  await executeNativeBrowserOp('stale2', 'browser_observe', { full: true }, invoke);
  const out = await executeNativeBrowserOp('stale2', 'browser_act', { ref: 5, action: 'click' }, invoke);
  expect(actedRefs).toEqual([]);
  expect(out.error).toContain('Fresh snapshot');
  expect(out.error).toContain('[2] button "Go"');
});

test('browser_extract maps CSS-selector fields to values', async () => {
  const invoke: Invoke = async (cmd, args) => {
    if (cmd === 'browser_eval_js') {
      expect((args as { js: string }).js).toContain('querySelector');
      return JSON.stringify({ title: 'Hello', count: '3' }) as never;
    }
    return '' as never;
  };
  const out = await executeNativeBrowserOp('ctx', 'browser_extract', { fields: { title: 'h1', count: '.n' } }, invoke);
  expect(out).toEqual({ result: { extracted: { title: 'Hello', count: '3' } } });
});

test('browser_extract requires fields', async () => {
  const { invoke, calls } = recordingInvoke();
  const out = await executeNativeBrowserOp('ctx', 'browser_extract', {}, invoke);
  expect(out.error).toContain("'fields'");
  expect(calls).toHaveLength(0);
});

test('browser_console parses the drained buffer JSON', async () => {
  const { invoke } = recordingInvoke({ browser_eval_js: '[{"level":"error","text":"boom"}]' });
  const out = await executeNativeBrowserOp('ctx', 'browser_console', {}, invoke);
  expect(out).toEqual({ result: [{ level: 'error', text: 'boom' }] });
});

test('browser_screenshot returns the native PNG as base64 in the streaming-compatible shape', async () => {
  const { invoke, calls } = recordingInvoke({ browser_screenshot: 'iVBORw0KGgo=' });
  const out = await executeNativeBrowserOp('ctx', 'browser_screenshot', {}, invoke);
  expect(calls[0]).toEqual(['browser_screenshot', { id: 'ctx' }]);
  expect(out).toEqual({ result: { data: 'iVBORw0KGgo=', mime: 'image/png', encoding: 'base64' } });
  expect(NATIVE_SUPPORTED_OPS.has('browser_screenshot')).toBe(true);
});

test('observe/act/extract are now supported native ops', () => {
  expect(NATIVE_SUPPORTED_OPS.has('browser_observe')).toBe(true);
  expect(NATIVE_SUPPORTED_OPS.has('browser_act')).toBe(true);
  expect(NATIVE_SUPPORTED_OPS.has('browser_extract')).toBe(true);
  expect(NATIVE_SUPPORTED_OPS.has('browser_eval')).toBe(true);
});

test('ops with no native mapping return a structured streaming-mode hint (no invoke)', async () => {
  const { invoke, calls } = recordingInvoke();
  // read_screen/point are server-orchestrated (dispatcher nativeVisionOp) and so
  // never delegate here as-is; if they DO arrive, the hint is the honest answer.
  for (const tool of ['browser_read_screen', 'browser_point', 'browser_totally_new']) {
    const out = await executeNativeBrowserOp('ctx', tool, {}, invoke);
    expect(out.error).toContain('not supported on the native Tauri pane');
    expect(out.error).toContain('streaming');
    expect(NATIVE_SUPPORTED_OPS.has(tool)).toBe(false);
  }
  expect(calls).toHaveLength(0);
});

// ---------------- login-state legs (save/load/import_chrome) ----------------

/** Invoke stub for the state ops mirroring the Rust reality: get_cookies returns
 *  a JSON STRING of storageState cookies; set_cookies returns a JSON string
 *  `{"set":n,"skipped":m}`. Plus an eval router answering the localStorage
 *  capture / readyState probe / href reads, and a recorder for set + navigate. */
function stateAwareInvoke(opts: {
  paneCookies?: unknown;
  origin?: string;
  href?: string;
  localStorageJson?: string;
  failBatchSet?: boolean;
} = {}): { invoke: Invoke; calls: Array<[string, unknown]> } {
  const origin = opts.origin ?? 'https://example.com';
  const calls: Array<[string, unknown]> = [];
  const invoke: Invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'browser_pane_get_cookies') {
      return JSON.stringify(opts.paneCookies ?? []) as never;
    }
    if (cmd === 'browser_pane_set_cookies') {
      const batch = (args as { cookies: unknown[] }).cookies;
      if (opts.failBatchSet && batch.length > 1) throw new Error('batch rejected');
      return JSON.stringify({ set: batch.length, skipped: 0 }) as never;
    }
    if (cmd === 'browser_eval_js') {
      const js = (args as { js: string }).js;
      if (js.includes('localStorage.key')) return (opts.localStorageJson ?? 'null') as never;
      if (js.includes('readyState')) return JSON.stringify({ origin, ready: 'complete' }) as never;
      if (js === 'location.href') return (opts.href ?? `${origin}/page`) as never;
      return '' as never;
    }
    return '' as never;
  };
  return { invoke, calls };
}

test('browser_save_state parses the pane cookie jar (already storageState-shaped) + current-origin localStorage', async () => {
  // The Rust browser_pane_get_cookies already returns storageState cookies, so
  // this leg parses the JSON string and passes them through untouched.
  const jarCookies = [
    { name: 'sid', value: 's3cr3t', domain: 'example.com', path: '/', expires: 1900000000, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'pref', value: 'dark', domain: '.example.com', path: '/', expires: -1, httpOnly: false, secure: false },
  ];
  const { invoke } = stateAwareInvoke({
    paneCookies: jarCookies,
    localStorageJson: JSON.stringify({ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'abc' }] }),
  });
  const out = await executeNativeBrowserOp('ctx', 'browser_save_state', { handle: 'example' }, invoke);
  expect(out.result).toEqual({
    cookies: jarCookies,
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'abc' }] }],
  });
});

test('browser_save_state tolerates a malformed jar dump — no cookies, localStorage still exported', async () => {
  const invoke: Invoke = async (cmd, args) => {
    if (cmd === 'browser_pane_get_cookies') return 'not json' as never;
    if (cmd === 'browser_eval_js') {
      const js = (args as { js: string }).js;
      if (js.includes('localStorage.key')) {
        return JSON.stringify({ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'abc' }] }) as never;
      }
    }
    return '' as never;
  };
  const out = await executeNativeBrowserOp('ctx', 'browser_save_state', { handle: 'example' }, invoke);
  expect(out.result).toEqual({
    cookies: [],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'abc' }] }],
  });
});

test('browser_load_state applies cookies + per-origin localStorage and returns to the original page', async () => {
  clearNativeSnapshotCache('ctx');
  const { invoke, calls } = stateAwareInvoke({ href: 'https://example.com/inbox' });
  const state = {
    cookies: [
      { name: 'sid', value: 's3cr3t', domain: '.example.com', path: '/', expires: 1900000000, httpOnly: true, secure: true, sameSite: 'Lax' },
    ],
    origins: [
      { origin: 'https://example.com', localStorage: [{ name: 'token', value: 'abc' }] },
      { origin: 'file:///etc', localStorage: [{ name: 'evil', value: 'x' }] }, // non-web origin → never navigated
    ],
  };
  const out = await executeNativeBrowserOp('ctx', 'browser_load_state', { state }, invoke);
  expect(out).toEqual({ result: { ok: true, cookies: 1, origins: 1 } });
  const set = calls.find(([c]) => c === 'browser_pane_set_cookies');
  // Cookies pass through in the storageState (CookieJson) shape the Rust command
  // takes — no Electron `url`/`expirationDate`/lowercase-sameSite conversion.
  expect(set?.[1]).toEqual({
    id: 'ctx',
    cookies: [
      { name: 'sid', value: 's3cr3t', domain: '.example.com', path: '/', secure: true, httpOnly: true, expires: 1900000000, sameSite: 'Lax' },
    ],
  });
  const navs = calls.filter(([c]) => c === 'browser_navigate').map(([, a]) => (a as { url: string }).url);
  expect(navs).toEqual(['https://example.com', 'https://example.com/inbox']);
});

test('browser_load_state falls back to per-cookie set when the batch is rejected', async () => {
  const { invoke, calls } = stateAwareInvoke({ failBatchSet: true });
  const state = {
    cookies: [
      { name: 'a', value: '1', domain: 'example.com' },
      { name: 'b', value: '2', domain: 'example.com' },
    ],
    origins: [],
  };
  const out = await executeNativeBrowserOp('ctx', 'browser_load_state', { state }, invoke);
  expect(out.result).toMatchObject({ ok: true, cookies: 2 });
  expect(calls.filter(([c]) => c === 'browser_pane_set_cookies')).toHaveLength(3); // batch + 2 singles
});

test('browser_load_state without a server-resolved state is a structured error', async () => {
  const { invoke, calls } = recordingInvoke();
  const out = await executeNativeBrowserOp('ctx', 'browser_load_state', { handle: 'x' }, invoke);
  expect(out.error).toContain("missing resolved 'state'");
  expect(calls).toHaveLength(0);
});

test('browser_import_chrome injects the server-decrypted CDP cookies and reloads', async () => {
  const { invoke, calls } = stateAwareInvoke();
  const out = await executeNativeBrowserOp(
    'ctx',
    'browser_import_chrome',
    {
      cookies: [
        // CDP host-only form carries `url` (no domain) — must ride url untouched.
        { name: 'sid', value: 'v', secure: true, httpOnly: true, url: 'https://youtube.com/', expires: 1900000000, sameSite: 'None' },
        { name: 'dom', value: 'w', domain: '.youtube.com', path: '/' },
      ],
    },
    invoke,
  );
  expect(out).toEqual({ result: { ok: true, imported: 2 } });
  const set = calls.find(([c]) => c === 'browser_pane_set_cookies');
  // CDP → storageState CookieJson: the host-only `url` cookie gets a derived
  // domain (no leading dot); the dotted-domain cookie keeps its dot. sameSite
  // casing is preserved (Strict/Lax/None), no Electron shape.
  expect(set?.[1]).toEqual({
    id: 'ctx',
    cookies: [
      { name: 'sid', value: 'v', domain: 'youtube.com', path: '/', secure: true, httpOnly: true, expires: 1900000000, sameSite: 'None' },
      { name: 'dom', value: 'w', domain: '.youtube.com', path: '/', secure: false, httpOnly: false, expires: -1 },
    ],
  });
  const reload = calls.find(([c, a]) => c === 'browser_eval_js' && (a as { js: string }).js === 'location.reload()');
  expect(reload).toBeDefined();
});

test('browser_import_chrome without server-decrypted cookies is a structured error', async () => {
  const { invoke, calls } = recordingInvoke();
  const out = await executeNativeBrowserOp('ctx', 'browser_import_chrome', { domains: ['youtube.com'] }, invoke);
  expect(out.error).toContain("missing decrypted 'cookies'");
  expect(calls).toHaveLength(0);
});

test('login-state ops are supported native ops', () => {
  expect(NATIVE_SUPPORTED_OPS.has('browser_save_state')).toBe(true);
  expect(NATIVE_SUPPORTED_OPS.has('browser_load_state')).toBe(true);
  expect(NATIVE_SUPPORTED_OPS.has('browser_import_chrome')).toBe(true);
});

test('an invoke that throws is caught and reported as a structured error', async () => {
  const invoke: Invoke = async () => { throw new Error('pane gone'); };
  const out = await executeNativeBrowserOp('ctx', 'browser_eval', { expression: '1' }, invoke);
  expect(out.error).toContain('pane gone');
});
