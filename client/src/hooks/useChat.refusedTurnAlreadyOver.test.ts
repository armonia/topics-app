/**
 * A MESSAGE REFUSED BY A TURN THAT IS ALREADY OVER MUST NOT WAIT FOR A WORD THAT WILL NEVER COME.
 *
 * `POST /api/chat` answers 409 `stream_in_flight` when the session's ledger
 * holds an open turn: the message is not stored, it goes back to the head of
 * the turn queue, and it leaves when the server says that turn closed
 * (`turn:state`, `decideDrain`). But the refusal travels: the turn it names can
 * end BEFORE this window reads the answer, and then the close has already been
 * heard, on an empty queue. Nothing drained it afterwards, so the message sat
 * in the queue with no turn to wait for, invisible as an answer: the chat
 * stayed silent until the person typed again, and the next send carried both.
 *
 * @covers CHAT-QUEUE-01
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chat, mountBoth, net, restoreGlobals, settle, setUp, tearDown } from '../test/chatPaneHarness';
import { getQueue } from '../state/chatQueue';

beforeEach(setUp);
afterEach(tearDown);
afterAll(restoreGlobals);

const MINE = 'deploy the branch';
const TURN = { boot: 'b', turnId: 1 };

/** The server's refusal, naming the turn in flight as its ledger saw it. */
const inFlight = (asOf: number) => new Response(
  JSON.stringify({ error: 'a response is already streaming for this session', code: 'stream_in_flight', turn: { ...TURN, asOf, open: true } }),
  { status: 409, headers: { 'content-type': 'application/json' } },
);

const closed = (asOf: number) => ({ type: 'turn:state', sessionKey: chat.sk, ...TURN, asOf, open: false });

/** The same refusal from a server with no ledger to quote: it names no turn. */
const inFlightUnnamed = () => new Response(
  JSON.stringify({ error: 'a response is already streaming for this session', code: 'stream_in_flight', messageId: 'someone-elses' }),
  { status: 409, headers: { 'content-type': 'application/json' } },
);

describe('a 409 stream_in_flight whose turn ended first', () => {
  test('the close heard before the refusal: the message leaves by itself, not at the next thing the person types', async () => {
    const app = mountBoth();
    // This window has heard nothing about the session: the turn in flight is
    // one the CLI opened by itself, known only to the server's ledger.
    net.holdChat = true;
    const sent = app.chat().sendMessage(chat.sk, MINE);
    await settle();
    expect(net.sentKeys).toHaveLength(1);

    // The turn ends while the refusal is still on the wire. The queue is empty
    // here: this close drains nothing.
    app.ws(closed(2));
    await settle();

    // Now the refusal lands, naming a turn the server has since closed.
    net.holdChat = true;
    net.answerChat!(inFlight(1));
    expect(await sent).toBe(true);
    await settle();

    expect(net.sentKeys).toHaveLength(2);
    expect(getQueue(chat.sk)).toHaveLength(0);
    app.unmount();
  });

  test('the turn is still open when the refusal lands: the message waits, as it did', async () => {
    const app = mountBoth();
    net.holdChat = true;
    const sent = app.chat().sendMessage(chat.sk, MINE);
    await settle();

    net.answerChat!(inFlight(2));
    expect(await sent).toBe(true);
    await settle();

    // One POST only: the message waits for the close of the turn that refused it.
    expect(net.sentKeys).toHaveLength(1);
    expect(getQueue(chat.sk).map((q) => q.content)).toEqual([MINE]);

    // And that close is what sends it.
    net.holdChat = true;
    app.ws(closed(3));
    await settle();
    expect(net.sentKeys).toHaveLength(2);
    expect(getQueue(chat.sk)).toHaveLength(0);
    app.unmount();
  });

  test('a refusal that names no turn is not a close: the message waits for the end of the other turn', async () => {
    const app = mountBoth();
    // Nothing is known here about the session, and the refusal quotes no
    // ledger: the only fact is that somebody else holds the session right now.
    net.holdChat = true;
    const sent = app.chat().sendMessage(chat.sk, MINE);
    await settle();

    net.answerChat!(inFlightUnnamed());
    expect(await sent).toBe(true);
    await settle();

    // It must NOT be sent again on the spot: that is the turn that just refused it.
    expect(net.sentKeys).toHaveLength(1);
    expect(getQueue(chat.sk).map((q) => q.content)).toEqual([MINE]);

    // It leaves when the other turn ends, like any queued message.
    net.holdChat = true;
    app.ws(closed(3));
    await settle();
    expect(net.sentKeys).toHaveLength(2);
    expect(getQueue(chat.sk)).toHaveLength(0);
    app.unmount();
  });
});
