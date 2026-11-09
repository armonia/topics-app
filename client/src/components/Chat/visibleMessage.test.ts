/**
 * A turn that ends with the silent-reply marker keeps its work and never
 * draws the marker, whether it sits in `content` or inside a text block.
 *
 * @covers CHAT-TOOL-02
 */
import { describe, it, expect } from 'bun:test';
import { visibleMessage } from './visibleMessage';
import type { ChatMessage, ToolCall } from '../../types';

const tool = { id: 't1', name: 'Read', status: 'success' } as ToolCall;
const msg = (over: Partial<ChatMessage>): ChatMessage =>
  ({ id: 'm1', role: 'assistant', content: '', timestamp: '2026-11-09T00:00:00.000Z', ...over } as ChatMessage);

describe('visibleMessage', () => {
  it('hides a bare marker in content', () => {
    expect(visibleMessage(msg({ content: 'NO_REPLY' }))).toBeNull();
  });

  it('hides a message whose only block is a marker text block', () => {
    expect(visibleMessage(msg({ content: '', blocks: [{ kind: 'text', text: 'NO_REPLY' }] }))).toBeNull();
    expect(visibleMessage(msg({ content: 'NO_REPLY', blocks: [{ kind: 'text', text: 'NO_REPLY' }] }))).toBeNull();
  });

  it('keeps the tool and drops the marker block', () => {
    const out = visibleMessage(msg({
      content: 'NO_REPLY',
      blocks: [{ kind: 'tool', toolCall: tool }, { kind: 'text', text: 'NO_REPLY' }],
    }));
    expect(out).not.toBeNull();
    expect(out!.content).toBe('');
    expect(out!.blocks).toEqual([{ kind: 'tool', toolCall: tool }]);
  });

  it('strips a trailing marker from prose and keeps the prose', () => {
    const out = visibleMessage(msg({ content: 'Done.\nNO_REPLY', blocks: [{ kind: 'text', text: 'Done.\nNO_REPLY' }] }));
    expect(out!.content).toBe('Done.');
    expect(out!.blocks).toEqual([{ kind: 'text', text: 'Done.' }]);
  });

  it('keeps tool-only messages and hides announce steps', () => {
    expect(visibleMessage(msg({ toolCalls: [tool] }))).not.toBeNull();
    expect(visibleMessage(msg({ content: 'Agent-to-agent announce step 1' }))).toBeNull();
  });
});
