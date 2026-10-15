import { describe, expect, test, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as delegate from './browser-native-delegate';

const { createNativeDelegateRegistry, handleNativeDelegationFrame } = delegate;
const isFrameAllowed = (delegate as { isNativeDelegateFrameAllowed?: (raw: unknown) => boolean }).isNativeDelegateFrameAllowed
  ?? (() => true);

describe('native delegate frame ownership', () => {
  test('the socket filter runs before browser message parsing', () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const parse = source.indexOf('const raw = JSON.parse(');
    const delegation = source.indexOf('handleNativeDelegationFrame(', parse);
    expect(parse).toBeGreaterThanOrEqual(0);
    expect(delegation).toBeGreaterThan(parse);
    expect(source.slice(parse, delegation)).toMatch(
      /if\s*\(\s*ws\.data\._nativeDelegate\s*&&\s*!isNativeDelegateFrameAllowed\(raw\)\s*\)\s*\{[\s\S]*?return\s*;?\s*\}/,
    );
  });

  test('the delegate socket accepts only delegate frame types', () => {
    const navigate = mock(() => {});
    const dispatchInput = mock(() => {});
    const changeEngine = mock(() => {});

    for (const raw of [
      { type: 'nav', phase: 'request', url: 'https://example.test' },
      { type: 'input', action: 'click', payload: {} },
      { type: 'set_engine', engine: 'chromium' },
    ]) {
      if (!isFrameAllowed(raw)) continue;
      if (raw.type === 'nav') navigate();
      if (raw.type === 'input') dispatchInput();
      if (raw.type === 'set_engine') changeEngine();
    }

    expect(navigate).not.toHaveBeenCalled();
    expect(dispatchInput).not.toHaveBeenCalled();
    expect(changeEngine).not.toHaveBeenCalled();
  });

  test('an op result counts only from the socket registered for its context', async () => {
    const registry = createNativeDelegateRegistry({ timeoutMs: 100, genOpId: () => '6a7b6f26-9f14-4de3-bbe7-84e78e5af3d1' });
    const registeredSocket = {};
    const otherSocket = {};
    registry.register('context', () => {}, registeredSocket);
    const pending = registry.delegateOp('context', 'browser_eval', {});

    expect(handleNativeDelegationFrame(
      { type: 'browser_op_result', opId: '6a7b6f26-9f14-4de3-bbe7-84e78e5af3d1', result: 'wrong' },
      'context', () => {}, registry, otherSocket,
    )).toBe('result');
    expect(handleNativeDelegationFrame(
      { type: 'browser_op_result', opId: '6a7b6f26-9f14-4de3-bbe7-84e78e5af3d1', result: 'right' },
      'context', () => {}, registry, registeredSocket,
    )).toBe('result');

    expect(await pending).toBe('right');
  });

  test('op ids are UUIDs with no context-derived prefix', () => {
    const registry = createNativeDelegateRegistry();
    let opId = '';
    registry.register('known-context', (frame) => { opId = frame.opId; });
    void registry.delegateOp('known-context', 'browser_eval', {});
    expect(opId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    registry.unregister('known-context');
  });
});
