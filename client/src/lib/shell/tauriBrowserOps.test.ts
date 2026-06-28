import { test, expect } from 'bun:test';
import { executeNativeBrowserOp, NATIVE_SUPPORTED_OPS, type Invoke } from './tauriBrowserOps';

function recordingInvoke(returns: Record<string, unknown> = {}): { invoke: Invoke; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const invoke: Invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    return (returns[cmd] ?? '') as never;
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

test('browser_console parses the drained buffer JSON', async () => {
  const { invoke } = recordingInvoke({ browser_eval_js: '[{"level":"error","text":"boom"}]' });
  const out = await executeNativeBrowserOp('ctx', 'browser_console', {}, invoke);
  expect(out).toEqual({ result: [{ level: 'error', text: 'boom' }] });
});

test('unsupported ops return a structured streaming-mode hint (no invoke)', async () => {
  const { invoke, calls } = recordingInvoke();
  for (const tool of ['browser_act', 'browser_observe', 'browser_read_screen', 'browser_save_state', 'browser_import_chrome']) {
    const out = await executeNativeBrowserOp('ctx', tool, {}, invoke);
    expect(out.error).toContain('not supported on the native Tauri pane');
    expect(out.error).toContain('streaming');
  }
  expect(calls).toHaveLength(0);
  expect(NATIVE_SUPPORTED_OPS.has('browser_act')).toBe(false);
  expect(NATIVE_SUPPORTED_OPS.has('browser_eval')).toBe(true);
});

test('an invoke that throws is caught and reported as a structured error', async () => {
  const invoke: Invoke = async () => { throw new Error('pane gone'); };
  const out = await executeNativeBrowserOp('ctx', 'browser_eval', { expression: '1' }, invoke);
  expect(out.error).toContain('pane gone');
});
