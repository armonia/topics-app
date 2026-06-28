import { test, expect } from 'bun:test';
import { createNativeDelegateRegistry, handleNativeDelegationFrame, type BrowserOpMessage } from './browser-native-delegate';

test('register / isDelegated / unregister', () => {
  const r = createNativeDelegateRegistry();
  expect(r.isDelegated('ctx')).toBe(false);
  r.register('ctx', () => {});
  expect(r.isDelegated('ctx')).toBe(true);
  expect(r.size()).toBe(1);
  r.unregister('ctx');
  expect(r.isDelegated('ctx')).toBe(false);
  expect(r.size()).toBe(0);
});

test('delegateOp forwards the op and resolves on the matching result', async () => {
  const sent: BrowserOpMessage[] = [];
  const r = createNativeDelegateRegistry({ genOpId: () => 'X' });
  r.register('ctx', (m) => sent.push(m));

  const p = r.delegateOp('ctx', 'browser_eval', { expression: '1+1' });
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ type: 'browser_op', opId: 'ctx::X', tool: 'browser_eval', args: { expression: '1+1' } });

  // Client replies with the matching opId.
  r.resolveOp({ opId: 'ctx::X', result: { value: 2 } });
  expect(await p).toEqual({ value: 2 });
});

test('an error result surfaces as a structured { error }', async () => {
  const r = createNativeDelegateRegistry({ genOpId: () => 'Y' });
  r.register('ctx', () => {});
  const p = r.delegateOp('ctx', 'browser_act', {});
  r.resolveOp({ opId: 'ctx::Y', error: 'unsupported on native pane' });
  expect(await p).toEqual({ error: 'unsupported on native pane' });
});

test('delegateOp on an unregistered context resolves with an error (never hangs)', async () => {
  const r = createNativeDelegateRegistry();
  expect(await r.delegateOp('nope', 'browser_eval', {})).toEqual({ error: 'no native executor for context' });
});

test('timeout resolves with a structured error', async () => {
  const r = createNativeDelegateRegistry({ timeoutMs: 10, genOpId: () => 'T' });
  r.register('ctx', () => {});
  const out = (await r.delegateOp('ctx', 'browser_eval', {})) as { error: string };
  expect(out.error).toContain('timed out');
});

test('unregister fails the in-flight ops of that context', async () => {
  const r = createNativeDelegateRegistry({ genOpId: () => 'Z' });
  r.register('ctx', () => {});
  const p = r.delegateOp('ctx', 'browser_eval', {});
  r.unregister('ctx');
  expect(await p).toEqual({ error: 'native browser pane disconnected' });
});

test('a stale/unknown result is ignored (no throw)', () => {
  const r = createNativeDelegateRegistry();
  expect(() => r.resolveOp({ opId: 'ghost', result: 1 })).not.toThrow();
});

// The exact classifier server.ts runs on inbound /ws/browser frames.
test('handleNativeDelegationFrame: register frame registers this socket', () => {
  const r = createNativeDelegateRegistry();
  const out = handleNativeDelegationFrame({ type: 'register_native_executor' }, 'ctx', () => {}, r);
  expect(out).toBe('registered');
  expect(r.isDelegated('ctx')).toBe(true);
});

test('handleNativeDelegationFrame: result frame resolves the matching pending op', async () => {
  const r = createNativeDelegateRegistry({ genOpId: () => 'A' });
  r.register('ctx', () => {});
  const p = r.delegateOp('ctx', 'browser_eval', {});
  const out = handleNativeDelegationFrame({ type: 'browser_op_result', opId: 'ctx::A', result: 'ok' }, 'ctx', () => {}, r);
  expect(out).toBe('result');
  expect(await p).toBe('ok');
});

test('handleNativeDelegationFrame: a non-delegation frame falls through (null)', () => {
  const r = createNativeDelegateRegistry();
  expect(handleNativeDelegationFrame({ type: 'agent_active', active: true }, 'ctx', () => {}, r)).toBeNull();
  expect(handleNativeDelegationFrame(null, 'ctx', () => {}, r)).toBeNull();
  expect(handleNativeDelegationFrame('nope', 'ctx', () => {}, r)).toBeNull();
});
