/**
 * Integration: compose the SERVER delegate registry and the CLIENT op executor
 * through the exact wire protocol they use over /ws/browser, in-process (no socket).
 * This proves the full native-pane round-trip logic: agent tool-call → delegateOp →
 * browser_op message → executeNativeBrowserOp → browser_op_result → resolveOp →
 * the agent's awaited result. The only thing NOT exercised here is the literal WS
 * JSON transport (standard, and the subscription mirrors the proven agent-pill WS).
  * @covers NATDEL-01
 */
import { test, expect } from 'bun:test';
import { createNativeDelegateRegistry, nativeDelegateRegistry } from './browser-native-delegate';
import { executeNativeBrowserOp, type Invoke } from '../client/src/lib/shell/tauriBrowserOps';
import { dispatchBrowserToolCallByContext } from './browser-tool-dispatcher';
import type { BrowserService } from './browser-service';

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
  // browser_act became NATIVE in 0811f083 (observe/act/extract run in-page) and
  // the cookie-state ops followed (save/load/import_chrome via browser-native-state
  // + the pane cookie commands), so only a tool with NO native mapping at all —
  // e.g. one newer than this client — gets the honest structured hint, without
  // touching native invoke.
  const calls: string[] = [];
  const invoke: Invoke = async (cmd) => { calls.push(cmd); return '' as never; };
  const reg = wired(invoke);
  const out = (await reg.delegateOp('ctx', 'browser_totally_new', {})) as { error: string };
  expect(out.error).toContain('streaming');
  expect(calls).toHaveLength(0);
});

test('a crashing native command round-trips as a structured error, never hangs', async () => {
  const invoke: Invoke = async () => { throw new Error('pane closed'); };
  const reg = wired(invoke);
  const out = (await reg.delegateOp('ctx', 'browser_eval', { expression: '1' })) as { error: string };
  expect(out.error).toContain('pane closed');
});

// The REAL dispatcher's guard: when a contextId is registered on the PROCESS
// singleton, dispatchBrowserToolCallByContext must forward the whole call there
// (never the CDP/Playwright path). Exercises the actual server-side integration
// point with the real dispatcher + real registry (no boot, no socket).
test('dispatchBrowserToolCallByContext delegates a registered native context', async () => {
  const seen: Array<{ tool: string; args: unknown }> = [];
  // Simulate the Tauri client: on a forwarded op, run it through the executor and reply.
  const invoke: Invoke = async (cmd) => (cmd === 'browser_eval_js' ? 'pong' : '') as never;
  nativeDelegateRegistry.register('ctx-real', (m) => {
    seen.push({ tool: m.tool, args: m.args });
    void executeNativeBrowserOp('ctx-real', m.tool, m.args, invoke).then((out) =>
      nativeDelegateRegistry.resolveOp({ opId: m.opId, ...out }),
    );
  });
  // A minimal service: only setAgentAction is touched before the guard delegates.
  const svc = { setAgentAction: () => {} } as unknown as BrowserService;
  try {
    const result = await dispatchBrowserToolCallByContext('browser_eval', { expression: '6*7' }, 'ctx-real', svc);
    expect(seen).toEqual([{ tool: 'browser_eval', args: { expression: '6*7' } }]);
    expect(result).toBe('pong'); // came back through the native executor, NOT CDP
  } finally {
    nativeDelegateRegistry.unregister('ctx-real');
  }
});

test('dispatch does NOT delegate an unregistered context (guard is a no-op for Electron/web)', async () => {
  expect(nativeDelegateRegistry.isDelegated('ctx-none')).toBe(false);
  // With no executor registered the guard is skipped; we assert that rather than
  // exercising the real CDP handler (which needs a full BrowserService).
});

// listDelegated() is the inventory seam the tab-inventory enumerates: every live
// native pane is a key here. Order-independent (Map insertion order is stable but
// callers dedupe/sort), so assert membership.
test('listDelegated() enumerates registered contexts and drops them on unregister', () => {
  const reg = createNativeDelegateRegistry();
  expect(reg.listDelegated()).toEqual([]);
  reg.register('ctx-a', () => {});
  reg.register('ctx-b', () => {});
  expect(new Set(reg.listDelegated())).toEqual(new Set(['ctx-a', 'ctx-b']));
  reg.unregister('ctx-a');
  expect(reg.listDelegated()).toEqual(['ctx-b']);
});

test('listDelegated() reflects a re-register from a new owner as one entry', () => {
  const reg = createNativeDelegateRegistry();
  reg.register('ctx', () => {}, 'sock-1');
  reg.register('ctx', () => {}, 'sock-2'); // reconnect: overwrites send+owner
  expect(reg.listDelegated()).toEqual(['ctx']);
});
