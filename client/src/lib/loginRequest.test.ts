/**
 * @covers BROWSER-LOGIN-01
 */
import { describe, expect, it, mock } from 'bun:test';
import { handleLoginRequest, type LoginRequestEffects } from './loginRequest';

function effects(popped = true): LoginRequestEffects & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    focusTab: mock(() => { calls.push('focus'); }),
    raiseWindow: mock(() => { calls.push('raise'); }),
    popOut: mock(async () => { calls.push('popout'); return popped; }),
  };
}

const REQ = { contextId: 'task-560413f6-login', url: 'https://example.test/login', topicId: 't1' };

describe('handleLoginRequest', () => {
  it('focuses the new tab and raises the window', async () => {
    const fx = effects();
    const out = await handleLoginRequest({ ...REQ, detached: false }, fx);
    expect(fx.calls).toEqual(['focus', 'raise']);
    expect(out.detached).toBe(false);
  });

  it('pops the topic out into a detached window, after raising, when asked', async () => {
    const fx = effects();
    const out = await handleLoginRequest({ ...REQ, detached: true }, fx);
    expect(fx.calls).toEqual(['focus', 'raise', 'popout']);
    expect(fx.popOut).toHaveBeenCalledWith('t1');
    expect(out.detached).toBe(true);
  });

  it('reports a window that did not open and never pops out without a topic', async () => {
    const refused = await handleLoginRequest({ ...REQ, detached: true }, effects(false));
    expect(refused.detached).toBe(false);
    const fx = effects();
    await handleLoginRequest({ contextId: 'c', url: 'u', detached: true }, fx);
    expect(fx.popOut).not.toHaveBeenCalled();
  });
});
