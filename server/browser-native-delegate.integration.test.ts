/**
 * Integration: compose the SERVER delegate registry and the CLIENT op executor
 * through the exact wire protocol they use over /ws/browser, in-process (no socket).
 * This proves the full native-pane round-trip logic: agent tool-call → delegateOp →
 * browser_op message → executeNativeBrowserOp → browser_op_result → resolveOp →
 * the agent's awaited result. The only thing NOT exercised here is the literal WS
 * JSON transport (standard, and the subscription mirrors the proven agent-pill WS).
 */
import { test, expect } from 'bun:test';
import { createNativeDelegateRegistry } from './browser-native-delegate';
import { executeNativeBrowserOp, type Invoke } from '../client/src/lib/shell/tauriBrowserOps';

// Wire a registry so each forwarded op is executed by the client executor (with a
// mock native `invoke`) and its result piped back — exactly what the WS does.
function wired(invoke: Invoke) {
  const reg = createNativeDelegateRegistry();
  reg.register('ctx', (msg) => {
    void executeNativeBrowserOp('ctx', msg.tool, msg.args, invoke).then((out) =>
      reg.resolveOp({ opId: msg.opId, ...out }),
    );
  });
  return reg;
}

test('browser_eval round-trips from agent dispatch to native result', async () => {
  const invoke: Invoke = async (cmd) => (cmd === 'browser_eval_js' ? '99' : '') as never;
  const reg = wired(invoke);
  expect(await reg.delegateOp('ctx', 'browser_eval', { expression: '33*3' })).toBe('99');
});

test('browser_open round-trips and the native navigate is invoked', async () => {
  const calls: string[] = [];
  const invoke: Invoke = async (cmd) => { calls.push(cmd); return '' as never; };
  const reg = wired(invoke);
  expect(await reg.delegateOp('ctx', 'browser_open', { url: 'https://x.com' })).toEqual({ ok: true, url: 'https://x.com' });
  expect(calls).toContain('browser_navigate');
});

test('an unsupported op round-trips a structured streaming hint (no native invoke)', async () => {
  const calls: string[] = [];
  const invoke: Invoke = async (cmd) => { calls.push(cmd); return '' as never; };
  const reg = wired(invoke);
  const out = (await reg.delegateOp('ctx', 'browser_act', { ref: 1, action: 'click' })) as { error: string };
  expect(out.error).toContain('streaming');
  expect(calls).toHaveLength(0);
});

test('a crashing native command round-trips as a structured error, never hangs', async () => {
  const invoke: Invoke = async () => { throw new Error('pane closed'); };
  const reg = wired(invoke);
  const out = (await reg.delegateOp('ctx', 'browser_eval', { expression: '1' })) as { error: string };
  expect(out.error).toContain('pane closed');
});
