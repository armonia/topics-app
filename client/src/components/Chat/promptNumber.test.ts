/**
 * @covers CHAT-04
 */
import { describe, it, expect } from 'bun:test';
import { resolvePromptNumbers } from './promptNumber';
import type { ChatMessage } from '../../types';

const at = '2026-09-23T00:00:00.000Z';
const user = (id: string, promptNumber?: number, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'user', content: `q ${id}`, timestamp: at, ...(promptNumber ? { promptNumber } : {}), ...extra });
const bot = (id: string): ChatMessage => ({ id, role: 'assistant', content: 'a', timestamp: at });

describe('resolvePromptNumbers', () => {
  it('keeps the numbers the server stamped on the whole thread, even on a tail', () => {
    const got = resolvePromptNumbers([user('u48', 48), bot('a'), user('u49', 49)], false);
    expect([...got]).toEqual([['u48', 48], ['u49', 49]]);
  });

  it('a prompt sent since the load continues from the last stamp', () => {
    const got = resolvePromptNumbers([user('u49', 49), bot('a'), user('fresh')], false);
    expect(got.get('fresh')).toBe(50);
  });

  it('machine rows and the gateway envelope are not prompts', () => {
    const got = resolvePromptNumbers([
      user('u1', 1),
      user('nudge', undefined, { blocks: [{ kind: 'goal-nudge', attempt: 1 }] }),
      user('env', undefined, { content: '[Chat messages since your last reply] x' }),
      user('fresh'),
    ], true);
    expect(got.get('nudge')).toBeUndefined();
    expect(got.get('env')).toBeUndefined();
    expect(got.get('fresh')).toBe(2);
  });

  it('on a partial tail with no stamp it invents nothing', () => {
    expect(resolvePromptNumbers([user('x'), user('y')], false).size).toBe(0);
  });

  it('on a complete local thread with no stamp it counts from one', () => {
    expect([...resolvePromptNumbers([user('x'), bot('a'), user('y')], true)]).toEqual([['x', 1], ['y', 2]]);
  });
});
