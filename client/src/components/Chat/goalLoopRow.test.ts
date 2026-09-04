/**
 * @covers CHAT-GOALLOOP-02
 */
import { describe, it, expect } from 'bun:test';
import { goalLoopRowOf } from './goalLoopRow';
import type { ContentBlock } from '../../types';

describe('goalLoopRowOf', () => {
  it('recognises the continuation the server sent, with its number', () => {
    expect(goalLoopRowOf([{ kind: 'goal-nudge', attempt: 3 }])).toEqual({ kind: 'nudge', attempt: 3 });
  });

  it('recognises the two ways the loop stops by itself', () => {
    expect(goalLoopRowOf([{ kind: 'goal-stop', reason: 'capped' }])).toEqual({ kind: 'stop', reason: 'capped' });
    expect(goalLoopRowOf([{ kind: 'goal-stop', reason: 'stalled' }])).toEqual({ kind: 'stop', reason: 'stalled' });
  });

  it('leaves an ordinary message alone', () => {
    const blocks: ContentBlock[] = [{ kind: 'text', text: 'ciao' }];
    expect(goalLoopRowOf(blocks)).toBe(null);
    expect(goalLoopRowOf([])).toBe(null);
    expect(goalLoopRowOf(undefined)).toBe(null);
  });
});
