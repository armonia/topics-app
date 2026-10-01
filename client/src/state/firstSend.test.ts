/**
 * The first send of a draft: the bubble is staged in the draft's session at the
 * key, copied with its id into the topic's session once the topic exists, and
 * withdrawn when the promotion ends without a send.
 *
 * @covers CHAT-01
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { __resetMessageStore, getSessionMessagesFromStore, subscribeSession } from './messageStore';
import { carryFirstBubble, draftSessionKey, stageFirstBubble, withdrawFirstBubble } from './firstSend';

afterEach(() => __resetMessageStore());

const waitTask = () => new Promise<void>((r) => setTimeout(r, 5));

describe('the first bubble of a draft', () => {
  test('is in the draft session at the key, as a client-side user message', () => {
    const sk = draftSessionKey('draft:a');
    const id = stageFirstBubble(sk, 'hello');
    expect(getSessionMessagesFromStore(sk)).toEqual([expect.objectContaining({ id, role: 'user', content: 'hello' })]);
    expect(id.startsWith('msg_')).toBe(true);
  });

  test('reaches the topic session with the same id, and the draft copy goes once nobody shows it', async () => {
    const from = draftSessionKey('draft:a');
    const id = stageFirstBubble(from, 'hello');
    carryFirstBubble(from, 'topic:t1');
    expect(getSessionMessagesFromStore('topic:t1').map((m) => m.id)).toEqual([id]);
    // Still there in this task: a render of the draft pane now must not find it empty.
    expect(getSessionMessagesFromStore(from).map((m) => m.id)).toEqual([id]);
    await waitTask();
    expect(getSessionMessagesFromStore(from)).toEqual([]);
  });

  test('the draft copy stays while a pane still shows the draft', async () => {
    const from = draftSessionKey('draft:a');
    const id = stageFirstBubble(from, 'hello');
    const off = subscribeSession(from, () => {});
    carryFirstBubble(from, 'topic:t1');
    await waitTask();
    expect(getSessionMessagesFromStore(from).map((m) => m.id)).toEqual([id]);
    off();
  });

  test('is withdrawn when the promotion sends nothing', () => {
    const sk = draftSessionKey('draft:a');
    const id = stageFirstBubble(sk, 'hello');
    withdrawFirstBubble(sk, id);
    expect(getSessionMessagesFromStore(sk)).toEqual([]);
  });
});
