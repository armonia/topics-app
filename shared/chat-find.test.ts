/**
 * The pure search inside one conversation (shared by the server route and the
 * client's streaming message).
 *
 * @covers CHAT-FIND-01
 * @covers CHAT-FIND-03
 */
import { describe, expect, test } from 'bun:test';
import { chatFind, countOccurrences, mergeLiveHits, toolSearchText, type FindableMessage } from './chat-find';

describe('chatFind', () => {
  test('the spec scenario: two hits on the text, at 0 and 4', () => {
    const r = chatFind([{ id: 'a', content: 'Uno uno' }], 'uno', { matchCase: false });
    expect(r.hits).toEqual([
      { messageId: 'a', part: 'text', offset: 0 },
      { messageId: 'a', part: 'text', offset: 4 },
    ]);
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(false);
  });

  test('match case counts only the exact spelling', () => {
    const r = chatFind([{ id: 'a', content: 'Uno uno' }], 'uno', { matchCase: true });
    expect(r.hits).toEqual([{ messageId: 'a', part: 'text', offset: 4 }]);
  });

  test('an empty query finds nothing', () => {
    expect(chatFind([{ id: 'a', content: 'abc' }], '', { matchCase: false })).toEqual({ total: 0, hits: [], truncated: false });
  });

  test('reasoning, tool command and tool output from detail are searched, in timeline order', () => {
    const m: FindableMessage = {
      id: 'm1',
      content: 'ignored when blocks exist ENOENT',
      blocks: [
        { kind: 'thinking', text: 'maybe ENOENT here' },
        { kind: 'tool', toolCall: { id: 't1', args: {}, detail: { type: 'shell', command: 'cat missing', output: 'cat: missing: ENOENT' } } },
        { kind: 'text', text: 'It failed with ENOENT.' },
      ],
    };
    const r = chatFind([m], 'enoent', { matchCase: false });
    expect(r.hits.map((h) => [h.part, h.toolCallId])).toEqual([
      ['thinking', undefined],
      ['tool', 't1'],
      ['text', undefined],
    ]);
  });

  test('a tool without detail is searched in args and result', () => {
    const m: FindableMessage = {
      id: 'm2',
      blocks: [{ kind: 'tool', toolCall: { id: 't2', args: { query: 'zibaldone' }, result: 'one zibaldone found' } }],
    };
    const r = chatFind([m], 'zibaldone', { matchCase: false });
    expect(r.total).toBe(2);
    expect(r.hits.every((h) => h.part === 'tool' && h.toolCallId === 't2')).toBe(true);
  });

  test('the typed detail wins over args: the same command is not counted twice', () => {
    expect(toolSearchText({ id: 'x', args: { command: 'ls foo' }, detail: { type: 'shell', command: 'ls foo', output: 'foo' } }))
      .toBe('ls foo\nfoo');
  });

  test('legacy rows: content, then thinking, then toolCalls', () => {
    const r = chatFind([{ id: 'L', content: 'k', thinking: 'k', toolCalls: [{ id: 'tc', result: 'k' }] }], 'k', { matchCase: false });
    expect(r.hits.map((h) => h.part)).toEqual(['text', 'thinking', 'tool']);
  });

  test('order follows the conversation, first message first', () => {
    const r = chatFind([{ id: 'a', content: 'x' }, { id: 'b', content: 'x x' }], 'x', { matchCase: false });
    expect(r.hits.map((h) => h.messageId)).toEqual(['a', 'b', 'b']);
  });

  test('past the cap the total stays exact and truncated says so', () => {
    const r = chatFind([{ id: 'a', content: 'y'.repeat(12) }], 'y', { matchCase: false, maxHits: 5 });
    expect(r.total).toBe(12);
    expect(r.hits.length).toBe(5);
    expect(r.truncated).toBe(true);
  });

  test('matches do not overlap', () => {
    expect(countOccurrences('aaaa', 'aa', false)).toBe(2);
  });
});

describe('a streaming message that grows (CHAT-FIND-03)', () => {
  test('its fresh hits replace its old ones in place and the earlier hits keep their index', () => {
    const server = chatFind([
      { id: 'a', content: 'deploy' },
      { id: 'b', content: 'deploy deploy' },
      { id: 'live', content: 'deploy' },
    ], 'deploy', { matchCase: false }).hits;
    expect(server.length).toBe(4);
    // The agent writes the word once more in the live message.
    const live = chatFind([{ id: 'live', content: 'deploy and deploy' }], 'deploy', { matchCase: false }).hits;
    const merged = mergeLiveHits(server, 'live', live);
    expect(merged.length).toBe(5);
    // Hit #3 (1-based) is still the second one of message b.
    expect(merged[2]).toEqual(server[2]);
    expect(merged.slice(3).every((h) => h.messageId === 'live')).toBe(true);
  });

  test('a message the server has not seen yet goes at the end', () => {
    const merged = mergeLiveHits([{ messageId: 'a', part: 'text', offset: 0 }], 'new', [{ messageId: 'new', part: 'text', offset: 3 }]);
    expect(merged.map((h) => h.messageId)).toEqual(['a', 'new']);
  });
});
