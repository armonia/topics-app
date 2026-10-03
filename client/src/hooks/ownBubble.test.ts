/**
 * The rules that make a send's key the identity of its bubble, one at a time
 * (`hooks/ownBubble.ts`). The exits of a real send that use them are replayed
 * on the real hooks in `useChat.ownBubbleByKey.test.ts`.
 *
 * @covers CHAT-01
 */
import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../types';
import { adoptDurableMessageId, afterUnfinishedSend, insertBeside, placeOwnBubble } from './ownBubble';

const bubble = (id: string, key?: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, role: 'user', content: 'ok', timestamp: 't', ...(key ? { clientMessageId: key } : {}), ...extra });
const reply = (id: string, content = ''): ChatMessage => ({ id, role: 'assistant', content, timestamp: 't', partial: true });

describe('adoptDurableMessageId', () => {
  test('renames only the bubble waiting under that key, never a row with the same words', () => {
    const rows = [bubble('row-phone', 'phone-key'), bubble('row-agent'), bubble('msg_1', 'k1'), bubble('msg_2', 'k2')];
    expect(adoptDurableMessageId(rows, 'k2', 'row-2').map((m) => m.id)).toEqual(['row-phone', 'row-agent', 'msg_1', 'row-2']);
    expect(adoptDurableMessageId(rows, 'other', 'row-x')).toBe(rows);
  });

  test('a bubble already named is that row: a second row with its key is not its echo', () => {
    const rows = [bubble('row-1', 'k1')];
    expect(adoptDurableMessageId(rows, 'k1', 'row-2')).toBe(rows);
  });

  test('the row already drawn under its own id: the waiting bubble is its double and goes', () => {
    const rows = [bubble('msg_1', 'k1'), reply('msg_r'), bubble('row-1')];
    expect(adoptDurableMessageId(rows, 'k1', 'row-1').map((m) => m.id)).toEqual(['msg_r', 'row-1']);
  });

  test('the adopted bubble leaves its queued state', () => {
    const [row] = adoptDurableMessageId([bubble('msg_1', 'k1', { queued: true, partial: true })], 'k1', 'row-1');
    expect(row).toEqual(bubble('row-1', 'k1', { partial: false }));
  });
});

describe('afterUnfinishedSend', () => {
  const rows = [bubble('msg_1', 'k1'), reply('msg_p'), bubble('row-phone', 'phone-key')];

  test('withdraw: the waiting bubble and the empty placeholder go, wherever they are', () => {
    expect(afterUnfinishedSend(rows, 'k1', 'msg_p', 'withdraw').map((m) => m.id)).toEqual(['row-phone']);
  });

  test('withdraw keeps a bubble the server already named: it is the stored row', () => {
    const named = [bubble('row-1', 'k1'), reply('msg_p')];
    expect(afterUnfinishedSend(named, 'k1', 'msg_p', 'withdraw').map((m) => m.id)).toEqual(['row-1']);
  });

  test('queued marks the bubble, not the last row; keep leaves it as it is', () => {
    const queued = afterUnfinishedSend(rows, 'k1', 'msg_p', 'queued');
    expect(queued.map((m) => [m.id, !!m.queued])).toEqual([['msg_1', true], ['row-phone', false]]);
    expect(afterUnfinishedSend(rows, 'k1', 'msg_p', 'keep').map((m) => m.id)).toEqual(['msg_1', 'row-phone']);
  });

  test('a placeholder with something worth keeping stays', () => {
    const said = [bubble('msg_1', 'k1'), reply('msg_p', 'Half of the answer')];
    expect(afterUnfinishedSend(said, 'k1', 'msg_p', 'keep')).toBe(said);
  });

  test('stopped: the bubble stays, an empty reply goes and a begun one is closed, by id and not as the last row', () => {
    expect(afterUnfinishedSend(rows, 'k1', 'msg_p', 'stopped').map((m) => m.id)).toEqual(['msg_1', 'row-phone']);
    const begun = afterUnfinishedSend([bubble('msg_1', 'k1'), reply('msg_p', 'Hal'), bubble('row-phone', 'phone-key')], 'k1', 'msg_p', 'stopped');
    expect(begun.map((m) => [m.id, !!m.partial])).toEqual([['msg_1', false], ['msg_p', false], ['row-phone', false]]);
  });
});

describe('placeOwnBubble', () => {
  const mine = { ...bubble('msg_new'), clientMessageId: 'k1' };

  test('a new send: the bubble goes at the end', () => {
    expect(placeOwnBubble([bubble('row-0')], mine).map((m) => m.id)).toEqual(['row-0', 'msg_new']);
  });

  test('a resend under the same key: the queued bubble is reused where it is', () => {
    const rows = [bubble('msg_1', 'k1', { queued: true, partial: true }), bubble('row-phone', 'phone-key')];
    const placed = placeOwnBubble(rows, mine);
    expect(placed.map((m) => [m.id, !!m.queued, !!m.partial])).toEqual([['msg_1', false, false], ['row-phone', false, false]]);
  });

  test('a resend the server may hold: the person\'s last row with these words, the server\'s, is taken for it', () => {
    const stored = [bubble('row-mine'), reply('row-r', 'Done.')];
    expect(placeOwnBubble(stored, mine, undefined, true)).toBe(stored);
    // Not on a first send, not over a bubble of this window, not over other words.
    expect(placeOwnBubble(stored, mine)).toHaveLength(3);
    expect(placeOwnBubble([bubble('msg_0')], mine, undefined, true)).toHaveLength(2);
    expect(placeOwnBubble([{ ...bubble('row-mine'), content: 'other' }], mine, undefined, true)).toHaveLength(2);
  });

  test('the draft\'s first bubble: reused by its id, and it takes the key', () => {
    const placed = placeOwnBubble([bubble('msg_draft')], mine, 'msg_draft');
    expect(placed).toEqual([bubble('msg_draft', 'k1', { partial: false })]);
  });
});

describe('insertBeside', () => {
  const thread = [bubble('row-0'), bubble('msg_1', 'k1'), reply('msg_p')];

  test('announced while my bubble waits: written before my row, it goes before my bubble', () => {
    expect(insertBeside(thread, bubble('row-carry'), 'k1').map((m) => m.id)).toEqual(['row-0', 'row-carry', 'msg_1', 'msg_p']);
  });

  test('after my echo, or with no send in flight: at the end', () => {
    expect(insertBeside([bubble('row-1', 'k1'), reply('msg_p')], bubble('row-x'), 'k1').map((m) => m.id)).toEqual(['row-1', 'msg_p', 'row-x']);
    expect(insertBeside(thread, bubble('row-x'), undefined).map((m) => m.id)).toEqual(['row-0', 'msg_1', 'msg_p', 'row-x']);
  });
});
