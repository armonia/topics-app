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

test('browser_open maps to browser_navigate', async () => {
  const { invoke, calls } = recordingInvoke();
  const out = await executeNativeBrowserOp('ctx', 'browser_open', { url: 'https://x.com' }, invoke);
  expect(calls).toEqual([['browser_navigate', { id: 'ctx', url: 'https://x.com' }]]);
  expect(out).toEqual({ result: { ok: true, url: 'https://x.com' } });
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

test('still-unsupported ops return a structured streaming-mode hint (no invoke)', async () => {
  const { invoke, calls } = recordingInvoke();
  for (const tool of ['browser_read_screen', 'browser_point', 'browser_save_state', 'browser_load_state', 'browser_import_chrome']) {
    const out = await executeNativeBrowserOp('ctx', tool, {}, invoke);
    expect(out.error).toContain('not supported on the native Tauri pane');
    expect(out.error).toContain('streaming');
    expect(NATIVE_SUPPORTED_OPS.has(tool)).toBe(false);
  }
  expect(calls).toHaveLength(0);
});

test('an invoke that throws is caught and reported as a structured error', async () => {
  const invoke: Invoke = async () => { throw new Error('pane gone'); };
  const out = await executeNativeBrowserOp('ctx', 'browser_eval', { expression: '1' }, invoke);
  expect(out.error).toContain('pane gone');
});
