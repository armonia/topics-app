/**
 * THE PERSON'S BUBBLE IS KNOWN BY THE KEY ITS SEND CARRIED, ON EVERY WAY THE SEND ENDS.
 *
 * Invariant: after a send with key K the sent text is on screen at most once,
 * the thread and the queue together, on every exit path; and no user row
 * written by somebody else disappears or is renamed.
 *
 * Until 03/10 the bubble took its row's durable id only while this window
 * still held the stream (`ownSendsRef`, cleared in `performSend`'s `finally`):
 * an echo arriving after a 500, a Stop or a network error was drawn as a
 * second row, and the bubble, still under its local name, survived every
 * history read beside it (`mergeFetchedHistory` matches a local bubble by text
 * only against rows nobody on screen already holds). The bubble now carries
 * the key (`hooks/ownBubble.ts`), and so does every exit path of the send.
 *
 * Real `useChat` and `usePanelLifecycle`, wired as the app wires them
 * (`test/chatPaneHarness.ts`); each test names the scenario of the review it
 * replays (S2..S9, N1).
 *
 * @covers CHAT-01, CHAT-QUEUE-01
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chat, drivenSse, mountBoth, net, restoreGlobals, settle, setUp, tearDown } from '../test/chatPaneHarness';
import { getQueue } from '../state/chatQueue';

beforeEach(setUp);
afterEach(tearDown);
afterAll(restoreGlobals);

type App = ReturnType<typeof mountBoth>;

const MINE = 'deploy the branch';
const REPLY = 'Deployed.';
const ROW = { id: 'row-mine', role: 'user' as const, content: MINE };
const REPLY_ROW = { id: 'row-reply', role: 'assistant' as const, content: REPLY };
const TURN_OPEN = { boot: 'b', asOf: 1, turnId: 1, open: true };
const turnClosed = (asOf: number) => ({ type: 'turn:state', sessionKey: chat.sk, ...TURN_OPEN, asOf, open: false });

const refusal = (status: number, code?: string) => new Response(
  JSON.stringify({ error: 'refused', ...(code ? { code } : {}) }),
  { status, headers: { 'content-type': 'application/json' } },
);

/** A send held at its POST: its key, and the promise `sendMessage` returned. */
async function heldSend(app: App, content: string): Promise<{ key: string; sent: Promise<boolean> }> {
  net.holdChat = true;
  const sent = app.chat().sendMessage(chat.sk, content);
  await settle();
  return { key: net.sentClientId!, sent };
}

/** The server's announcement of a person's row, with the key it was written with. */
function echo(app: App, id: string, content: string, key?: string): void {
  app.ws({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: id, content, ...(key ? { clientMessageId: key } : {}) });
}

/** How many times `text` is on screen: as a row of the thread, or as a queued message. */
function countShown(app: App, text: string): number {
  const rows = app.rows().filter((r) => r.role === 'user' && r.content === text).length;
  return rows + getQueue(chat.sk).filter((q) => q.content === text).length;
}

/** Empty reply bubbles left in the thread. */
const emptyReplyCount = (app: App) => app.rows().filter((r) => r.role === 'assistant' && !r.content).length;

/** `MINE` written while another device's turn runs: it waits in the turn queue. */
async function queuedBehindATurn(app: App): Promise<void> {
  app.ws({ type: 'turn:state', sessionKey: chat.sk, ...TURN_OPEN });
  await app.chat().sendMessage(chat.sk, MINE);
  expect(getQueue(chat.sk).map((q) => q.content)).toEqual([MINE]);
  expect(app.rows()).toEqual([]);
}

/** The queued `MINE` leaves when that turn closes, its POST held; returns its key. */
async function drainHeld(app: App): Promise<string> {
  net.holdChat = true;
  app.ws(turnClosed(2));
  await settle();
  return net.sentClientId!;
}

describe('the echo of my row arrives after the send ended', () => {
  test('S2: the POST answers 500, my echo comes late: one copy, after a fresh history read too', async () => {
    const app = mountBoth();
    const { key, sent } = await heldSend(app, MINE);
    net.answerChat!(new Response('boom', { status: 500 }));
    expect(await sent).toBe(false);
    await settle();
    // The bubble stays, beside the error the person reads.
    expect(app.rows().map((r) => r.content)).toEqual([MINE]);

    echo(app, ROW.id, MINE, key);
    await settle();
    // Before: the send no longer held the session, the bubble kept its local
    // name and the pane drew the row beside it.
    expect(app.rows()).toEqual([ROW]);

    net.historyAnswer = [ROW];
    await app.chat().loadHistory(chat.sk, { fresh: true });
    await settle();
    // Before: two copies, and the read kept both.
    expect(app.rows()).toEqual([ROW]);
    app.unmount();
  });

  test('S3: Stop while the POST is in flight, my echo arrives after the abort: one copy', async () => {
    const app = mountBoth();
    const { key, sent } = await heldSend(app, MINE);
    await app.chat().stopSession(chat.sk);
    expect(await sent).toBe(true);
    await settle();

    echo(app, ROW.id, MINE, key);
    await settle();
    expect(app.rows()).toEqual([ROW]);

    net.historyAnswer = [ROW];
    await app.chat().loadHistory(chat.sk, { fresh: true });
    await settle();
    expect(app.rows()).toEqual([ROW]);
    app.unmount();
  });

  test('S8: the same words sent twice, echoes in reverse order after a failed reload: each bubble takes its own row', async () => {
    const app = mountBoth();
    const first = app.chat().sendMessage(chat.sk, 'ok');
    await settle();
    const k1 = net.sentClientId!;
    // The same words again while the first streams: they wait behind it.
    await app.chat().sendMessage(chat.sk, 'ok');
    expect(getQueue(chat.sk)).toHaveLength(1);
    const asked = new Promise<void>((r) => { net.historyAsked = r; });
    net.sse.content('Reply one.');
    net.sse.done();
    await asked;
    // The end-of-turn read fails: the thread keeps the bubbles' local names.
    net.failHistory!();
    await first;
    await settle();

    net.sse = drivenSse();
    app.ws(turnClosed(2));
    await settle();
    const k2 = net.sentClientId!;
    expect(k2).not.toBe(k1);

    // The second echo first, the first one late (a socket that lagged).
    echo(app, 'row-u2', 'ok', k2);
    echo(app, 'row-u1', 'ok', k1);
    await settle();
    // Before: by text the first bubble took row-u2; by stream only the second
    // send's key was adopted, and row-u1 was drawn a third time.
    expect(app.rows().filter((r) => r.role === 'user').map((r) => r.id)).toEqual(['row-u1', 'row-u2']);

    const again = new Promise<void>((r) => { net.historyAsked = r; });
    net.sse.content('Reply two.');
    net.sse.done();
    await again;
    net.releaseHistory!([
      { id: 'row-u1', role: 'user', content: 'ok' }, { id: 'row-r1', role: 'assistant', content: 'Reply one.' },
      { id: 'row-u2', role: 'user', content: 'ok' }, { id: 'row-r2', role: 'assistant', content: 'Reply two.' },
    ]);
    await settle();
    expect(app.rows().map((r) => r.id)).toEqual(['row-u1', 'row-r1', 'row-u2', 'row-r2']);
    app.unmount();
  });
});

describe('the order the two handlers hear my echo in', () => {
  test('K1: the panes hear it before the chat, the turn still streaming: one copy, in the bubble\'s place', async () => {
    const app = mountBoth();
    const { key, sent } = await heldSend(app, MINE);
    app.wsPanesFirst({ type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'user', messageId: ROW.id, content: MINE, clientMessageId: key });
    await settle();
    // Without the key check in the pane: the row drawn after the reply's
    // placeholder, and the bubble then dropped as its double.
    expect(app.rows().map((r) => [r.id === ROW.id ? ROW.id : r.role, r.content])).toEqual([[ROW.id, MINE], ['assistant', '']]);
    net.answerChat!(new Response('boom', { status: 500 }));
    await sent;
    await settle();
    expect(app.rows()).toEqual([ROW]);
    app.unmount();
  });
});

describe('a network error, and the resend with the same key', () => {
  test('N1: the bubble is marked queued by its key and the empty placeholder goes, with a row written beside it', async () => {
    const app = mountBoth();
    const { sent } = await heldSend(app, MINE);
    echo(app, 'row-phone', 'from the phone', 'phone-key');
    await settle();
    net.answerChat!(new TypeError('Failed to fetch'));
    expect(await sent).toBe(false);
    await settle();
    const rows = app.chat().getSessionMessages(chat.sk).map((m) => ({ role: m.role, content: m.content, queued: !!m.queued }));
    // Before: the LAST row (the phone's) was marked queued, and the empty placeholder stayed.
    expect(rows).toEqual([
      { role: 'user', content: MINE, queued: true },
      { role: 'user', content: 'from the phone', queued: false },
    ]);
    app.unmount();
  });

  test('S4: my echo arrives, then the outbound queue resends with the same key and gets duplicate_message: one copy, no empty placeholder', async () => {
    const app = mountBoth();
    const { key, sent } = await heldSend(app, MINE);
    net.answerChat!(new TypeError('Failed to fetch'));
    await sent;
    await settle();
    echo(app, ROW.id, MINE, key);
    await settle();
    expect(app.rows()).toEqual([ROW]);

    net.holdChat = true;
    net.historyAnswer = [ROW];
    const drained = app.chat().drainQueue();
    await settle();
    expect(net.sentKeys).toEqual([key, key]);
    // The resend redraws nothing: the row already on screen is this message.
    expect(countShown(app, MINE)).toBe(1);
    net.answerChat!(refusal(409, 'duplicate_message'));
    await drained;
    await settle();
    expect(app.rows()).toEqual([ROW]);
    expect(emptyReplyCount(app)).toBe(0);
    app.unmount();
  });

  test('S6: the outbound resend gets duplicate_message before my echo: the history is read and the row appears once, the late echo adds nothing', async () => {
    const app = mountBoth();
    const { key, sent } = await heldSend(app, MINE);
    net.answerChat!(new TypeError('Failed to fetch'));
    await sent;
    await settle();

    net.holdChat = true;
    net.historyAnswer = [ROW];
    const drained = app.chat().drainQueue();
    await settle();
    expect(net.sentKeys).toEqual([key, key]);
    expect(countShown(app, MINE)).toBe(1);
    net.answerChat!(refusal(409, 'duplicate_message'));
    await drained;
    await settle();
    // Before: the read ran while the send still held the session, and returned at once.
    expect(net.historyReads).toBe(1);
    expect(app.rows()).toEqual([ROW]);

    echo(app, ROW.id, MINE, key);
    await settle();
    expect(app.rows()).toEqual([ROW]);
    expect(emptyReplyCount(app)).toBe(0);
    app.unmount();
  });
});

describe('a send from the turn queue', () => {
  test('S5: another window already sent the batch, mine gets duplicate_message: the stored row appears', async () => {
    const app = mountBoth();
    await queuedBehindATurn(app);
    net.holdChat = true;
    net.historyAnswer = [ROW];
    app.ws(turnClosed(2));
    await settle();
    net.answerChat!(refusal(409, 'duplicate_message'));
    await settle();
    // Before: the bubbles went, the read never ran, and the row was nowhere.
    expect(app.rows()).toEqual([ROW]);
    expect(getQueue(chat.sk)).toHaveLength(0);
    app.unmount();
  });

  test('S7: 500 before the stream puts it back in the queue and off the thread; after the drain, one copy', async () => {
    const app = mountBoth();
    await queuedBehindATurn(app);
    net.holdChat = true;
    app.ws(turnClosed(2));
    await settle();
    net.answerChat!(new Response('boom', { status: 500 }));
    await settle();
    // Before: back in the queue AND on the thread.
    expect(countShown(app, MINE)).toBe(1);
    expect(getQueue(chat.sk).map((q) => q.content)).toEqual([MINE]);
    expect(emptyReplyCount(app)).toBe(0);

    net.sse = drivenSse();
    app.ws(turnClosed(3));
    await settle();
    expect(getQueue(chat.sk)).toHaveLength(0);
    // Before: the old bubble beside the new one for the whole turn.
    expect(countShown(app, MINE)).toBe(1);
    echo(app, ROW.id, MINE, net.sentClientId!);
    net.historyAnswer = [ROW, REPLY_ROW];
    net.sse.content(REPLY);
    net.sse.done();
    await settle();
    expect(app.rows()).toEqual([ROW, REPLY_ROW]);
    app.unmount();
  });
});

describe('a send from the turn queue whose row was announced before the 500', () => {
  test('S7b: the server holds it: it stays on the thread under its row, and does not go back to the queue', async () => {
    const app = mountBoth();
    app.ws({ type: 'turn:state', sessionKey: chat.sk, ...TURN_OPEN });
    await app.chat().sendMessage(chat.sk, MINE);
    net.holdChat = true;
    app.ws(turnClosed(2));
    await settle();
    echo(app, ROW.id, MINE, net.sentClientId!);
    await settle();
    net.answerChat!(new Response('boom', { status: 500 }));
    await settle();
    expect(app.rows()).toEqual([ROW]);
    expect(getQueue(chat.sk)).toHaveLength(0);
    app.unmount();
  });
});

describe('a 409 that is not stream_in_flight', () => {
  test('S9: topics_routing_incompatible after my row was written and announced: the row stays, the error shows, nothing is re-queued', async () => {
    const app = mountBoth();
    const { key, sent } = await heldSend(app, MINE);
    echo(app, ROW.id, MINE, key);
    await settle();
    net.answerChat!(refusal(409, 'topics_routing_incompatible'));
    expect(await sent).toBe(false);
    await settle();
    app.rerender();
    // Before: taken for stream_in_flight, the stored row left the thread and
    // went back to the queue under a new key, to be written a second time.
    expect(app.rows()).toEqual([ROW]);
    expect(getQueue(chat.sk)).toHaveLength(0);
    expect(app.chat().error[chat.sk]).toBe('refused');
    app.unmount();
  });

  test('S9: the same refusal before the echo: the bubble stays and takes the row when it comes', async () => {
    const app = mountBoth();
    const { key, sent } = await heldSend(app, MINE);
    net.answerChat!(refusal(409, 'topics_routing_incompatible'));
    await sent;
    await settle();
    expect(countShown(app, MINE)).toBe(1);
    expect(getQueue(chat.sk)).toHaveLength(0);
    expect(emptyReplyCount(app)).toBe(0);
    echo(app, ROW.id, MINE, key);
    await settle();
    expect(app.rows()).toEqual([ROW]);
    app.unmount();
  });
});

/**
 * The review of PR #199 (verifier, 03/10): a queued message whose POST the
 * server answered with an error AFTER it had stored and announced the row,
 * and the Stop exit, which still went by position.
 */
describe('a queued send the server stored before answering with an error', () => {
  test('V1a: the 500 puts it back in the queue; the late echo takes it out: once on screen', async () => {
    const app = mountBoth();
    await queuedBehindATurn(app);
    const key = await drainHeld(app);
    net.answerChat!(new Response('boom', { status: 500 }));
    await settle();
    expect(countShown(app, MINE)).toBe(1);
    echo(app, ROW.id, MINE, key);
    await settle();
    // Before: the row on the thread AND the item in the queue, with the same key.
    expect(app.rows()).toEqual([ROW]);
    expect(getQueue(chat.sk)).toHaveLength(0);
    app.unmount();
  });

  test('V1b: the person writes again after the late echo: the new words leave under a key of their own and arrive', async () => {
    const app = mountBoth();
    await queuedBehindATurn(app);
    const key = await drainHeld(app);
    net.answerChat!(new Response('boom', { status: 500 }));
    await settle();
    echo(app, ROW.id, MINE, key);
    await settle();
    net.holdChat = true;
    const sent = app.chat().sendMessage(chat.sk, 'and then run the tests');
    await settle();
    // Before: merged with the stored message under its key, refused as a duplicate, and gone.
    expect(net.sentClientId).not.toBe(key);
    expect(app.rows().map((r) => r.content)).toEqual([MINE, 'and then run the tests', '']);
    net.answerChat!(new Response(net.sse.body, { status: 200 }));
    net.historyAnswer = [ROW, { id: 'row-new', role: 'user', content: 'and then run the tests' }, { id: 'row-reply', role: 'assistant', content: 'Running.' }];
    net.sse.content('Running.');
    net.sse.done();
    await sent;
    await settle();
    expect(app.rows().map((r) => r.id)).toEqual([ROW.id, 'row-new', 'row-reply']);
    app.unmount();
  });

  test('V1b: no echo, the person writes again: the stored message goes alone under its key, the new words are never merged into it', async () => {
    const app = mountBoth();
    await queuedBehindATurn(app);
    const key = await drainHeld(app);
    net.answerChat!(new Response('boom', { status: 500 }));
    await settle();
    net.holdChat = true;
    const sent = app.chat().sendMessage(chat.sk, 'and then run the tests');
    await settle();
    expect(net.sentKeys).toEqual([key, key]);
    expect(getQueue(chat.sk).map((q) => q.content)).toEqual(['and then run the tests']);
    // The server holds `key`: it says so, and the history shows the row.
    net.historyAnswer = [ROW];
    net.holdChat = true;
    net.answerChat!(refusal(409, 'duplicate_message'));
    await sent;
    await settle();
    // The read after the refusal lets the queue go: the new words leave on their own key.
    expect(net.sentKeys).toHaveLength(3);
    expect(net.sentKeys[2]).not.toBe(key);
    expect(app.rows().filter((r) => r.role === 'user').map((r) => r.content)).toEqual([MINE, 'and then run the tests']);
    app.unmount();
  });

  test('V1c: the echo never came, a history read shows the row: the resend under the same key draws no second bubble', async () => {
    const app = mountBoth();
    await queuedBehindATurn(app);
    await drainHeld(app);
    net.answerChat!(new Response('bad gateway', { status: 502 }));
    await settle();
    net.holdChat = true;
    net.historyAnswer = [ROW];
    await app.chat().loadHistory(chat.sk, { fresh: true });
    await settle();
    // The read let the queue go: the resend is in flight.
    expect(net.sentKeys).toHaveLength(2);
    expect(net.sentKeys[0]).toBe(net.sentKeys[1]);
    // Before: the row from the history AND a new bubble for the resend.
    expect(countShown(app, MINE)).toBe(1);
    net.answerChat!(refusal(409, 'duplicate_message'));
    await settle();
    expect(app.rows()).toEqual([ROW]);
    app.unmount();
  });

  test('V2a: two rows really stored under one key (a restart lost the dedupe): both are drawn', async () => {
    const app = mountBoth();
    const { key, sent } = await heldSend(app, MINE);
    net.answerChat!(new TypeError('Failed to fetch'));
    await sent;
    await settle();
    echo(app, 'row-1', MINE, key);
    net.holdChat = true;
    const drained = app.chat().drainQueue();
    await settle();
    echo(app, 'row-2', MINE, key);
    await settle();
    expect(app.rows().filter((r) => r.role === 'user').map((r) => r.id)).toEqual(['row-1', 'row-2']);
    net.answerChat!(new Response('boom', { status: 500 }));
    await drained;
    await settle();
    app.unmount();
  });

  test('V3a: an outbound resend that meets a turn in flight waits in the turn queue under its key, and only there', async () => {
    const app = mountBoth();
    const { key, sent } = await heldSend(app, MINE);
    net.answerChat!(new TypeError('Failed to fetch'));
    await sent;
    await settle();
    app.ws({ type: 'turn:state', sessionKey: chat.sk, ...TURN_OPEN });
    await app.chat().drainQueue();
    await settle();
    // Before: the queued bubble on the thread AND a turn-queue item under a new id.
    expect(countShown(app, MINE)).toBe(1);
    expect(getQueue(chat.sk).map((q) => q.id)).toEqual([key]);
    net.holdChat = true;
    app.ws(turnClosed(2));
    await settle();
    expect(net.sentKeys).toEqual([key, key]);
    expect(countShown(app, MINE)).toBe(1);
    app.unmount();
  });

  test('a duplicate_message while a history read is already in flight: the row is read again after it', async () => {
    const app = mountBoth();
    await queuedBehindATurn(app);
    const reading = app.chat().loadHistory(chat.sk, { fresh: true });
    await settle();
    await drainHeld(app);
    net.answerChat!(refusal(409, 'duplicate_message'));
    await settle();
    // The read in flight is older than the row; the one after it is not.
    net.historyAnswer = [ROW];
    net.releaseHistory!([]);
    await reading;
    await settle();
    expect(app.rows()).toEqual([ROW]);
    app.unmount();
  });
});

describe('Stop, with a row from the phone written beside the turn', () => {
  test('V4a: Stop before the answer starts: the empty placeholder goes by its id, my bubble stays where it was', async () => {
    const app = mountBoth();
    const { key, sent } = await heldSend(app, MINE);
    echo(app, 'row-phone', 'from the phone', 'phone-key');
    await settle();
    await app.chat().stopSession(chat.sk);
    await sent;
    await settle();
    // Before: an empty placeholder, `partial`, that even a fresh read kept.
    expect(app.rows().map((r) => r.content)).toEqual([MINE, 'from the phone']);
    echo(app, ROW.id, MINE, key);
    net.historyAnswer = [ROW, { id: 'row-phone', role: 'user', content: 'from the phone' }];
    await app.chat().loadHistory(chat.sk, { fresh: true });
    await settle();
    expect(app.rows().map((r) => r.id)).toEqual([ROW.id, 'row-phone']);
    app.unmount();
  });

  test('V4b: Stop mid-answer: the answer is closed by its id, not left writing', async () => {
    const app = mountBoth();
    const sent = app.chat().sendMessage(chat.sk, MINE);
    await settle();
    echo(app, ROW.id, MINE, net.sentClientId!);
    net.sse.content('Deploying now, step one');
    await settle();
    echo(app, 'row-phone', 'from the phone', 'phone-key');
    await settle();
    await app.chat().stopSession(chat.sk);
    await sent;
    await settle();
    const answers = app.chat().getSessionMessages(chat.sk).filter((m) => m.role === 'assistant');
    // Before: still `partial`, drawn as an answer being written after the turn closed.
    expect(answers.map((m) => [m.content, !!m.partial])).toEqual([['Deploying now, step one', false]]);
    app.unmount();
  });
});

describe('the answer streaming beside rows written by others', () => {
  test('D1: the text after a row from the phone and a sub-agent card goes into the answer, not nowhere and not into the card', async () => {
    const app = mountBoth();
    const sent = app.chat().sendMessage(chat.sk, MINE);
    await settle();
    net.sse.content('First part. ');
    await settle();
    echo(app, 'row-phone', 'from the phone', 'phone-key');
    app.ws({
      type: 'message:new', topicId: chat.topic.id, sessionKey: chat.sk, role: 'assistant', messageId: 'row-card', content: 'Sub-agent «child» finished.',
      blocks: [{ kind: 'subagent-result', results: [{ agentId: 'child', status: 'completed' }] }],
    });
    await settle();
    net.sse.content('Second part.');
    await settle();
    // Before: «Second part.» was appended to the card (the last assistant row), or lost behind a user row.
    expect(app.rows().filter((r) => r.role === 'assistant').map((r) => r.content)).toEqual(['First part. Second part.', 'Sub-agent «child» finished.']);
    net.historyAnswer = [];
    net.sse.done();
    await sent;
    app.unmount();
  });
});
