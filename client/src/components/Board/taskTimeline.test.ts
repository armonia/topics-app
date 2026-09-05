/**
 * The projection, rule by rule. One test per rule of KANBAN-73, plus the three
 * cases of the derived chip of KANBAN-74 and the restart that must not promise
 * anything. No DOM: the whole point of the module is that the join can be wrong
 * in silence, so it has to be readable on plain objects.
 *
 * @covers KANBAN-73
 * @covers KANBAN-74
 */
import { describe, expect, it } from 'bun:test';
import type { TaskComment } from '../../../../shared/board';
import type { ChatMessage, ContentBlock, ToolCall } from '../../types';
import { mergeTaskTimeline, type TimelineItem } from './taskTimeline';

let clock = 0;
/** Instants as ISO strings, increasing, so a test can say "later" by order. */
const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();

const comment = (over: Partial<TaskComment> & { id: string }): TaskComment => ({
  taskId: 't1',
  author: 'user',
  content: 'said something',
  mentions: [],
  media: [],
  createdAt: at(++clock),
  kind: 'comment',
  ...over,
});

const tool = (name: string): ToolCall => ({ id: `tc-${name}-${++clock}`, name, args: {} });

const assistant = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  role: 'assistant',
  content: 'agent words',
  timestamp: at(++clock),
  ...over,
});

const envelopeBlocks = (commentIds?: string[]): ContentBlock[] =>
  [{ kind: 'dispatched-envelope', ...(commentIds ? { commentIds } : {}) }] as ContentBlock[];

const userRow = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  role: 'user',
  content: 'typed by a person',
  timestamp: at(++clock),
  ...over,
});

const ids = (items: readonly TimelineItem[]): string[] => items.map((i) => i.id);
const OPEN = { status: 'in_progress' as const };

describe('mergeTaskTimeline / rule a: the dispatcher envelopes', () => {
  it('hides an envelope that names what it delivered, collapses one that names nothing, keeps a real person', () => {
    const carried = comment({ id: 'c1' });
    const msgs = [
      userRow({ id: 'kickoff', blocks: envelopeBlocks() }),
      userRow({ id: 'resume', blocks: envelopeBlocks(['c1']) }),
      userRow({ id: 'typed' }),
    ];
    const out = mergeTaskTimeline([carried], msgs, OPEN);
    expect(ids(out)).toEqual(['c1', 'kickoff', 'typed']);
    const kickoff = out.find((i) => i.id === 'kickoff')!;
    expect(kickoff.source === 'session' && kickoff.envelope).toBe(true);
    const typed = out.find((i) => i.id === 'typed')!;
    expect(typed.source === 'session' && typed.envelope).toBeUndefined();
  });
});

describe('mergeTaskTimeline / rule b: the mirrored tool calls', () => {
  it('strips a mirrored call only when a comment anchored to that message exists', () => {
    const anchored = comment({ id: 'c1', messageId: 'm1', author: 'agent' });
    const m1 = assistant({ id: 'm1', toolCalls: [tool('mcp__topics__comment_task'), tool('Read')] });
    const out = mergeTaskTimeline([anchored], [m1], OPEN);
    const row = out.find((i) => i.id === 'm1')!;
    expect(row.source === 'session' && row.msg.toolCalls?.map((t) => t.name)).toEqual(['Read']);
    expect(row.source === 'session' && row.msg).not.toBe(m1);
  });

  it('keeps every tool row when nothing anchored to the message', () => {
    const loose = comment({ id: 'c2', messageId: null, author: 'agent' });
    const m2 = assistant({ id: 'm2', toolCalls: [tool('mcp__topics__comment_task')] });
    const out = mergeTaskTimeline([loose], [m2], OPEN);
    const row = out.find((i) => i.id === 'm2')!;
    expect(row.source === 'session' && row.msg).toBe(m2);
    expect(ids(out)).toContain('c2');
  });

  it('drops a row the strip emptied, and keeps one that still has words', () => {
    const anchored = comment({ id: 'c3', messageId: 'm3', author: 'agent' });
    const alsoAnchored = comment({ id: 'c4', messageId: 'm4', author: 'agent' });
    const m3 = assistant({ id: 'm3', content: '', toolCalls: [tool('mcp__topics__update_task')] });
    const m4 = assistant({ id: 'm4', content: 'here is why', toolCalls: [tool('mcp__topics__ask_user_question')] });
    const out = mergeTaskTimeline([anchored, alsoAnchored], [m3, m4], OPEN);
    expect(ids(out)).not.toContain('m3');
    expect(ids(out)).toContain('m4');
  });
});

describe('mergeTaskTimeline / rule c: runs of wordless work are coalesced first', () => {
  it('folds three consecutive tool-only rows into one item', () => {
    const runs = [0, 1, 2].map((n) =>
      assistant({ id: `w${n}`, content: '', toolCalls: [tool('Read')] }),
    );
    const out = mergeTaskTimeline([], runs, OPEN);
    expect(out).toHaveLength(1);
    const carrier = out[0]!;
    expect(carrier.source === 'session' && (carrier.msg as { mergedIds?: string[] }).mergedIds).toEqual(['w0', 'w1', 'w2']);
  });
});

describe('mergeTaskTimeline / rule d: order by instant, ties to the comment, anchors to their message', () => {
  it('interleaves by clock and puts the comment first on a tie', () => {
    const shared = at(50);
    const c = comment({ id: 'c1', createdAt: shared });
    const m = assistant({ id: 'm1', timestamp: shared });
    const later = comment({ id: 'c2', createdAt: at(51) });
    expect(ids(mergeTaskTimeline([c, later], [m], OPEN))).toEqual(['c1', 'm1', 'c2']);
  });

  it('draws an anchored comment right after its message even when its clock is older', () => {
    const m0 = assistant({ id: 'm0', timestamp: at(60) });
    const m1 = assistant({ id: 'm1', timestamp: at(62), toolCalls: [tool('mcp__topics__comment_task')] });
    const anchored = comment({ id: 'c1', messageId: 'm1', createdAt: at(61), author: 'agent' });
    const out = mergeTaskTimeline([anchored], [m0, m1], OPEN);
    expect(ids(out)).toEqual(['m0', 'm1', 'c1']);
    const row = out.find((i) => i.id === 'm1')!;
    expect(row.source === 'session' && row.msg.toolCalls).toEqual([]);
  });
});

describe('mergeTaskTimeline / rule e: the streaming row is last, its comments follow it', () => {
  it('orders the partial row, then what anchored to it', () => {
    const m8 = assistant({ id: 'm8', timestamp: at(70) });
    const m9 = assistant({ id: 'm9', timestamp: at(71), partial: true });
    const c9 = comment({ id: 'c9', messageId: 'm9', createdAt: at(70.5), author: 'agent' });
    expect(ids(mergeTaskTimeline([c9], [m8, m9], OPEN))).toEqual(['m8', 'm9', 'c9']);
  });
});

describe('mergeTaskTimeline / rule f: the pinned delivery is not painted twice', () => {
  it('leaves the pinned row out of the list', () => {
    const d1 = comment({ id: 'd1', kind: 'delivery', author: 'agent' });
    const other = comment({ id: 'c1' });
    const out = mergeTaskTimeline([d1, other], [], { status: 'done', pinnedDeliveryId: 'd1' });
    expect(ids(out)).toEqual(['c1']);
  });
});

describe('mergeTaskTimeline / rule g: an unchanged row is the same object', () => {
  it('reuses the item when the comment and the message are the same references', () => {
    const c = comment({ id: 'c1' });
    const m = assistant({ id: 'm1' });
    const first = mergeTaskTimeline([c], [m], OPEN);
    const second = mergeTaskTimeline([c], [m], OPEN, first);
    expect(second[0]).toBe(first[0]!);
    expect(second[1]).toBe(first[1]!);
  });
});

describe('mergeTaskTimeline / rule h: the delivery chip is derived, never written', () => {
  const human = () => comment({ id: 'c1', author: 'user', createdAt: at(80) });

  it('says delivered when an envelope carried its id', () => {
    const c = human();
    const resume = userRow({ id: 'r', timestamp: at(81), blocks: envelopeBlocks(['c1']) });
    const item = mergeTaskTimeline([c], [resume], OPEN)[0]!;
    expect(item.delivery).toBe('delivered');
  });

  it('says queued while the card still owes a turn and no envelope went out', () => {
    const item = mergeTaskTimeline([human()], [], OPEN)[0]!;
    expect(item.delivery).toBe('pending');
    const todo = mergeTaskTimeline([human()], [], { status: 'todo' })[0]!;
    expect(todo.delivery).toBe('pending');
  });

  it('promises nothing after a restart: a newer envelope that did not name it drops the chip', () => {
    const c = human();
    const continuation = userRow({ id: 'r', timestamp: at(90), blocks: envelopeBlocks() });
    expect(mergeTaskTimeline([c], [continuation], OPEN)[0]!.delivery).toBeUndefined();
  });

  it('says nothing on a closed card, and nothing on rows that are not a person speaking', () => {
    expect(mergeTaskTimeline([human()], [], { status: 'done' })[0]!.delivery).toBeUndefined();
    const agentRow = comment({ id: 'c2', author: 'agent' });
    const statusRow = comment({ id: 'c3', author: 'user', kind: 'status' });
    const out = mergeTaskTimeline([agentRow, statusRow], [], OPEN);
    expect(out.every((i) => i.delivery === undefined)).toBe(true);
  });
});
