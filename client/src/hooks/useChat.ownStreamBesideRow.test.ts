/**
 * A ROW WRITTEN BESIDE THIS WINDOW'S OWN TURN REACHES ITS PANE.
 *
 * The race (M1): the stopped-by-parent card is written by the sub-agent wake at
 * the first poll after the server's `activeStreams` lets the session go
 * (`server/services/subagent-wake.ts`). `endStream` lets it go BEFORE `[DONE]`,
 * while the window that owns the turn keeps it as its own stream until the
 * `finally` after its history reload (`useChat` `performSend`). The pane handler
 * dropped every `message:new` of an own stream before asking whether the pane
 * held that id, and the reload's snapshot, older than the row, then replaced the
 * whole thread: the card showed only at the next history load.
 *
 * Reproduced deterministically on the real hooks, `useChat` and
 * `usePanelLifecycle` wired as the app wires them: the SSE ends, the history
 * read is HELD, the row arrives over the socket, and only then the read answers
 * with a snapshot taken before the row.
 *
 * @covers SUBAGENT-12
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chat, drivenSse, mountBoth, net, restoreGlobals, settle, setUp, tearDown } from '../test/chatPaneHarness';
import { getQueue } from '../state/chatQueue';

beforeEach(setUp);
afterEach(tearDown);
afterAll(restoreGlobals);

const PROMPT = 'ferma il figlio';
const REPLY = 'Fermato.';
const STOP_ROW = () => ({
  type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'assistant',
  messageId: 'row-stopped-by-parent', content: 'Sub-agent «child» stopped by the parent.',
  preview: 'Sub-agent «child» stopped by the parent.',
  blocks: [{ kind: 'subagent-result', results: [{ agentId: 'child', status: 'stopped' }] }],
});
const STOP_ID = 'row-stopped-by-parent';
const STOP_TEXT = 'Sub-agent «child» stopped by the parent.';

const SNAPSHOT_BEFORE_ROW = [
  { id: 'row-user', role: 'user', content: PROMPT, timestamp: '2026-10-03T10:00:00.000Z' },
  { id: 'row-reply', role: 'assistant', content: REPLY, timestamp: '2026-10-03T10:00:01.000Z' },
];

describe('a row written beside the own turn', () => {
  test('arrives while the reload after [DONE] is in flight, older snapshot: it stays in the pane', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { net.historyAsked = r; });
    const sent = app.chat().sendMessage(chat.sk, PROMPT);
    await settle();
    net.sse.content(REPLY);
    net.sse.done();
    await asked;
    await settle();
    expect(app.chat().isOwnStream(chat.sk)).toBe(true);

    // The turn's own echo comes back too, under the durable ids: never twice.
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: 'row-user', content: PROMPT });
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'assistant', messageId: 'row-reply', content: REPLY });
    app.ws(STOP_ROW());
    await settle();
    // Before the fix: dropped by `isOwnStream`, so not here.
    expect(app.rows().map((r) => r.id)).toContain(STOP_ID);

    net.releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.rerender();

    // Before the fix: the snapshot replaced the thread and the card was gone.
    expect(app.rows()).toEqual([
      { id: 'row-user', role: 'user', content: PROMPT },
      { id: 'row-reply', role: 'assistant', content: REPLY },
      { id: STOP_ID, role: 'assistant', content: STOP_TEXT },
    ]);
    app.unmount();
  });

  test('arrives before [DONE], while the reply still streams: it does not take the reply\'s bubble', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { net.historyAsked = r; });
    const sent = app.chat().sendMessage(chat.sk, PROMPT);
    await settle();
    net.sse.content(REPLY);
    await settle();

    app.ws(STOP_ROW());
    await settle();
    const live = app.rows();
    // The reply bubble keeps its text, and the card is a row of its own.
    expect(live.filter((r) => r.role === 'assistant').map((r) => r.content)).toEqual([REPLY, STOP_TEXT]);

    net.sse.done();
    await asked;
    net.releaseHistory!([...SNAPSHOT_BEFORE_ROW, { id: STOP_ID, role: 'assistant', content: STOP_TEXT, timestamp: '2026-10-03T10:00:02.000Z' }]);
    await sent;
    await settle();
    app.rerender();
    // In the snapshot as well: once, not twice.
    expect(app.rows().map((r) => r.id)).toEqual(['row-user', 'row-reply', STOP_ID]);
    app.unmount();
  });

  test('without blocks, a row of the own stream is the turn\'s echo and is not drawn again', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { net.historyAsked = r; });
    const sent = app.chat().sendMessage(chat.sk, PROMPT);
    await settle();
    net.sse.content(REPLY);
    await settle();
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'assistant', messageId: 'row-reply', content: REPLY });
    await settle();
    expect(app.rows().filter((r) => r.role === 'assistant')).toHaveLength(1);
    net.sse.done();
    await asked;
    net.releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.unmount();
  });
});

/**
 * The same class with `user` rows (verifier, 03/10): the pane took every
 * non-assistant row of an own stream for the turn's echo. But the machine
 * writes `user` rows beside the turn too, each with its mark: the wake's
 * sub-agent result, the goal's continuation, the board's envelope. Only the
 * row of the message THIS window sent is its echo, known by the key the send
 * carried.
 */
const BESIDE_USER_ROWS = () => [
  {
    id: 'row-wake', content: 'Sub-agent «child» finished.',
    blocks: [{ kind: 'subagent-result', results: [{ agentId: 'child', status: 'completed' }] }],
  },
  { id: 'row-nudge', content: 'Objective still open: finish the migration.', blocks: [{ kind: 'goal-nudge', attempt: 1 }] },
  { id: 'row-envelope', content: 'Card #12: carry on.', blocks: [{ kind: 'dispatched-envelope' }] },
];

describe('a user row written beside the own turn', () => {
  test('the wake\'s result, the goal nudge and the board\'s envelope reach the pane and survive the older snapshot', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { net.historyAsked = r; });
    const sent = app.chat().sendMessage(chat.sk, PROMPT);
    await settle();
    net.sse.content(REPLY);
    net.sse.done();
    await asked;
    await settle();
    expect(app.chat().isOwnStream(chat.sk)).toBe(true);
    expect(net.sentClientId).toBeTruthy();

    // The own echo comes back WITH a mark (a repeated message is marked too):
    // the key says it is ours, and it is not drawn twice.
    app.ws({
      type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: 'row-user', content: PROMPT,
      clientMessageId: net.sentClientId, blocks: [{ kind: 'repeated', count: 2 }],
    });
    for (const row of BESIDE_USER_ROWS()) {
      app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: row.id, content: row.content, blocks: row.blocks });
    }
    await settle();
    // Before the fix: every user row of an own stream was dropped as echo.
    expect(app.markedUserRows()).toEqual(['row-wake', 'row-nudge', 'row-envelope']);
    expect(app.rows().filter((r) => r.role === 'user' && r.content === PROMPT)).toHaveLength(1);

    net.releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.rerender();
    expect(app.rows().map((r) => r.id)).toEqual(['row-user', 'row-reply', 'row-wake', 'row-nudge', 'row-envelope']);
    app.unmount();
  });

  // Until 03/10 a keyless row with the sent text was dropped here as the echo
  // of a server without the key: it was another agent's message
  // (`a keyless user row with the words I sent`, below).
  test('a user row with another window\'s key is not mine: it is drawn', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { net.historyAsked = r; });
    const sent = app.chat().sendMessage(chat.sk, PROMPT);
    await settle();
    net.sse.content(REPLY);
    net.sse.done();
    await asked;
    await settle();
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: 'row-user', content: PROMPT, clientMessageId: net.sentClientId });
    // Another window's message, with its own key: not ours.
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: 'row-other', content: 'from the phone', clientMessageId: 'phone-key' });
    await settle();
    expect(app.rows().filter((r) => r.role === 'user').map((r) => r.content)).toEqual([PROMPT, 'from the phone']);
    net.releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    // And past the reload's snapshot, taken before it was written.
    expect(app.rows().map((r) => r.id)).toEqual(['row-user', 'row-reply', 'row-other']);
    app.unmount();
  });

  test('regenerate: a row that arrives while its reload is in flight stays in the pane', async () => {
    const app = mountBoth();
    // A thread already on screen.
    let asked = new Promise<void>((r) => { net.historyAsked = r; });
    const first = app.chat().sendMessage(chat.sk, PROMPT);
    await settle();
    net.sse.content(REPLY);
    net.sse.done();
    await asked;
    net.releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await first;
    await settle();

    net.sse = drivenSse();
    asked = new Promise<void>((r) => { net.historyAsked = r; });
    const regenerated = app.chat().regenerateMessage(chat.sk, 'row-reply');
    await asked;
    expect(app.chat().isOwnStream(chat.sk)).toBe(true);
    const wake = BESIDE_USER_ROWS()[0]!;
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: wake.id, content: wake.content, blocks: wake.blocks });
    app.ws(STOP_ROW());
    await settle();
    expect(app.rows().map((r) => r.id)).toContain(wake.id);

    // The branch's snapshot, taken before both rows were written.
    net.releaseHistory!([...SNAPSHOT_BEFORE_ROW, { id: 'row-reply-2', role: 'assistant', content: '', timestamp: '2026-10-03T10:00:05.000Z', partial: true }]);
    await settle();
    net.sse.content('Again.');
    net.sse.done();
    await regenerated;
    await settle();
    app.rerender();
    // Before the fix: the branch reload replaced the thread and both were gone.
    const ids = app.rows().map((r) => r.id);
    expect(ids).toContain(wake.id);
    expect(ids).toContain(STOP_ID);
    app.unmount();
  });
});

/**
 * A send the server REFUSES while a row written by someone else lands beside it
 * (verifier, 03/10). From the moment the POST leaves, the window holds the
 * stream as its own; a row another device or the machine writes in that window
 * wins the server's gate, reaches this pane (it is not this send's echo), and
 * the POST then answers 409 `stream_in_flight`. The message goes back to the
 * queue, and only there: its optimistic bubble and its assistant placeholder
 * leave the thread by the ids this send gave them, wherever they are, not by
 * position (the other row is now the last one) nor by text (the other row may
 * say the same words).
 */
const FROM_DESKTOP = 'from desktop';
const TURN_OPEN = { boot: 'b', asOf: 1, turnId: 1, open: true };
const inFlight = () => new Response(
  JSON.stringify({ error: 'a response is already streaming for this session', code: 'stream_in_flight', turn: TURN_OPEN }),
  { status: 409, headers: { 'content-type': 'application/json' } },
);

describe('a send refused while a row written beside it lands', () => {
  async function refusedBeside(app: ReturnType<typeof mountBoth>, content: string, row: Record<string, unknown>): Promise<boolean> {
    net.holdChat = true;
    const sent = app.chat().sendMessage(chat.sk, content);
    await settle();
    expect(app.chat().isOwnStream(chat.sk)).toBe(true);
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, ...row });
    await settle();
    net.answerChat!(inFlight());
    const accepted = await sent;
    await settle();
    app.rerender();
    return accepted;
  }

  test('a row from the phone: the thread holds the phone\'s row only, my message waits in the queue', async () => {
    const app = mountBoth();
    await refusedBeside(app, FROM_DESKTOP, { role: 'user', messageId: 'row-phone', content: 'from the phone', clientMessageId: 'phone-key' });
    // Before the fix: [from desktop, empty placeholder, row-phone] and the queue held it too.
    expect(app.rows()).toEqual([{ id: 'row-phone', role: 'user', content: 'from the phone' }]);
    expect(getQueue(chat.sk).map((q) => q.content)).toEqual([FROM_DESKTOP]);
    app.unmount();
  });

  test('once the queue drains, my message is in the thread once, not twice', async () => {
    const app = mountBoth();
    await refusedBeside(app, FROM_DESKTOP, { role: 'user', messageId: 'row-phone', content: 'from the phone', clientMessageId: 'phone-key' });
    // The phone's turn ends: the queue leaves on its close, on a fresh stream.
    net.sse = drivenSse();
    app.ws({ type: 'turn:state', sessionKey: chat.sk, ...TURN_OPEN, asOf: 2, open: false });
    await settle();
    expect(getQueue(chat.sk)).toHaveLength(0);
    expect(app.chat().isOwnStream(chat.sk)).toBe(true);
    // Before the fix: two «from desktop» bubbles until the end-of-turn reload.
    expect(app.rows().filter((r) => r.role === 'user').map((r) => r.content)).toEqual(['from the phone', FROM_DESKTOP]);
    expect(app.rows().filter((r) => r.role === 'assistant')).toHaveLength(1);
    // Its echo, under the key of the drained batch, and the end of its turn.
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: 'row-desktop', content: FROM_DESKTOP, clientMessageId: net.sentClientId });
    const asked = new Promise<void>((r) => { net.historyAsked = r; });
    net.sse.content(REPLY);
    net.sse.done();
    await asked;
    net.releaseHistory!([
      { id: 'row-phone', role: 'user', content: 'from the phone' },
      { id: 'row-desktop', role: 'user', content: FROM_DESKTOP },
      { id: 'row-reply', role: 'assistant', content: REPLY },
    ]);
    await settle();
    expect(app.rows().map((r) => r.id)).toEqual(['row-phone', 'row-desktop', 'row-reply']);
    expect(getQueue(chat.sk)).toHaveLength(0);
    app.unmount();
  });

  test('the sub-agent wake\'s row, the race measured on 30/09: same outcome', async () => {
    const app = mountBoth();
    const wake = BESIDE_USER_ROWS()[0]!;
    await refusedBeside(app, FROM_DESKTOP, { role: 'user', messageId: wake.id, content: wake.content, blocks: wake.blocks });
    expect(app.rows()).toEqual([{ id: wake.id, role: 'user', content: wake.content }]);
    expect(app.markedUserRows()).toEqual([wake.id]);
    expect(getQueue(chat.sk).map((q) => q.content)).toEqual([FROM_DESKTOP]);
    app.unmount();
  });

  test('another window\'s row with the same words is not adopted as mine, and survives my refusal', async () => {
    const app = mountBoth();
    await refusedBeside(app, 'ok', { role: 'user', messageId: 'row-w2', content: 'ok', clientMessageId: 'w2-key' });
    // Before the fix: my bubble took row-w2's id, the pane then held «row-w2»
    // and skipped it, and the 409 removed it by its text: rows [].
    expect(app.rows()).toEqual([{ id: 'row-w2', role: 'user', content: 'ok' }]);
    expect(getQueue(chat.sk).map((q) => q.content)).toEqual(['ok']);
    app.unmount();
  });
});

/**
 * A row WITHOUT the key is never this window's echo: every send of a window
 * carries one and the server writes it on the person's row. The rows without
 * one are written by somebody else (`send_chat_message` of another agent, the
 * answer relay), and they may say the very words this window sent.
 */
describe('a keyless user row with the words I sent', () => {
  test('arrives while the reload after [DONE] is in flight, older snapshot: it stays', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { net.historyAsked = r; });
    const sent = app.chat().sendMessage(chat.sk, PROMPT);
    await settle();
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: 'row-user', content: PROMPT, clientMessageId: net.sentClientId });
    net.sse.content(REPLY);
    net.sse.done();
    await asked;
    await settle();
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: 'row-agent', content: PROMPT });
    await settle();
    net.releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.rerender();
    // Before the fix: dropped as the echo by its text, gone until the next history load.
    expect(app.rows().map((r) => r.id)).toEqual(['row-user', 'row-reply', 'row-agent']);
    app.unmount();
  });

  test('my own echo never reached this window (a socket that reconnected): my bubble does not take its id', async () => {
    const app = mountBoth();
    const asked = new Promise<void>((r) => { net.historyAsked = r; });
    const sent = app.chat().sendMessage(chat.sk, PROMPT);
    await settle();
    net.sse.content(REPLY);
    net.sse.done();
    await asked;
    await settle();
    app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: 'row-agent', content: PROMPT });
    await settle();
    // Before the fix: my bubble was renamed «row-agent» by its words, so the
    // pane held that id and skipped the row, and the older snapshot lost it.
    expect(app.rows().filter((r) => r.role === 'user').map((r) => r.id)).toContain('row-agent');
    expect(app.rows().filter((r) => r.role === 'user')).toHaveLength(2);
    net.releaseHistory!(SNAPSHOT_BEFORE_ROW);
    await sent;
    await settle();
    app.rerender();
    expect(app.rows().map((r) => r.id)).toEqual(['row-user', 'row-reply', 'row-agent']);
    app.unmount();
  });
});
