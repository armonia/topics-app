/**
 * WHEN THE TURN QUEUE LEAVES: each signal that used to fire it early.
 *
 * The drain's only condition was this window's `streaming` flag (and its own
 * send lock). Every case below is a path, found in the code and in the
 * production log of 27-29/09, where that flag said "free" while the server
 * still had the turn open. The rule now reads the server's ledger
 * (`state/serverTurn.ts`) and the turn the message waits for; the local flag is
 * not even an input. Each case states what the old condition did with it.
 *
 * @covers CHAT-QUEUE-07
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { decideDrain, type QueuedTurn } from './chatQueue';
import { __resetServerTurns, noteServerTurn, noteTurnSnapshot, openTurnRef, serverTurnOf, type ServerTurn } from './serverTurn';

const SK = 'topic:q';
const open = (turnId: number, asOf = turnId): ServerTurn => ({ boot: 'b1', asOf, turnId, open: true });
const closed = (turnId: number, asOf: number): ServerTurn => ({ boot: 'b1', asOf, turnId, open: false });

/** The old condition, kept here only to show each case was an early send. */
const oldDrains = (s: { held: boolean; queued: number; sendLocked: boolean; streaming: boolean }) =>
  !s.held && s.queued > 0 && !(s.sendLocked || s.streaming);

function verdict(over: Partial<Parameters<typeof decideDrain>[0]> = {}) {
  return decideDrain({ held: false, queued: 1, sendLocked: false, pendingAsk: false, ...over });
}

beforeEach(() => __resetServerTurns());

describe('early signals that no longer send', () => {
  test('a history read cleared the streaming flag while the server turn is open', () => {
    // loadHistory sets `streaming` false BEFORE asking the server.
    expect(oldDrains({ held: false, queued: 1, sendLocked: false, streaming: false })).toBe(true);
    expect(verdict({ serverTurn: open(7) })).toBe('wait-turn');
  });

  test('a 409 finally cleared the flag: the refusal named the open turn', () => {
    noteServerTurn(SK, open(7));
    const head: Pick<QueuedTurn, 'waitsFor'> = { waitsFor: openTurnRef(SK) };
    expect(verdict({ serverTurn: serverTurnOf(SK), head })).toBe('wait-turn');
  });

  test('stream:end of the route while the CLI is still in its turn (the ledger stays open)', () => {
    expect(verdict({ serverTurn: open(7) })).toBe('wait-turn');
  });

  test('the CLI opened a turn by itself, nobody adopted it yet: no stream:start ever came', () => {
    // No local streaming at all: the old condition sent at once.
    expect(oldDrains({ held: false, queued: 1, sendLocked: false, streaming: false })).toBe(true);
    noteServerTurn(SK, open(12));
    expect(verdict({ serverTurn: serverTurnOf(SK) })).toBe('wait-turn');
  });

  test('the silence watchdog or the orphan reconciler cleared the flag: the server still says open', () => {
    expect(verdict({ serverTurn: open(3) })).toBe('wait-turn');
  });

  test("a reconnect: a history answer older than the turn's opening does not reopen the gate", () => {
    noteServerTurn(SK, open(9));
    // Left the server before turn 9 opened, arrives after.
    expect(noteServerTurn(SK, closed(4, 8))).toBe(false);
    expect(verdict({ serverTurn: serverTurnOf(SK) })).toBe('wait-turn');
  });

  test('a snapshot older than a turn:state already received does not close it', () => {
    noteServerTurn(SK, open(9));
    noteTurnSnapshot({ boot: 'b1', asOf: 8, open: [] });
    expect(serverTurnOf(SK)?.open).toBe(true);
  });

  test('a window that missed the end of the turn another window queued behind', () => {
    // This window's last word is "closed after turn 5"; the head, written in
    // another window, waits for turn 7.
    const head = { waitsFor: { boot: 'b1', turnId: 7 } };
    expect(verdict({ serverTurn: closed(5, 6), head })).toBe('wait-turn');
    // ...and a window that has heard nothing at all waits too.
    expect(verdict({ serverTurn: undefined, head })).toBe('wait-turn');
  });

  test('a plan approval on screen: the person answers it first', () => {
    expect(verdict({ serverTurn: closed(7, 8), pendingAsk: true })).toBe('hold');
  });

  test('a turn the server says ended on a question for a person: held, though this window shows no question', () => {
    // The close reaches the window before its copy of the transcript shows the
    // plan panel, or the chat is not loaded here at all (e2e 30/09: sent 26 ms
    // after the plan approval was written).
    noteServerTurn(SK, { ...closed(7, 8), awaitsHuman: true });
    expect(verdict({ serverTurn: serverTurnOf(SK), pendingAsk: false })).toBe('hold');
    // The answer is the next turn: its plain close is the word that frees it.
    noteServerTurn(SK, open(9));
    noteServerTurn(SK, closed(9, 10));
    expect(verdict({ serverTurn: serverTurnOf(SK) })).toBe('drain');
  });

  test('a snapshot lists the sessions whose last turn ended on a question, and they stay held', () => {
    noteServerTurn(SK, open(7));
    noteTurnSnapshot({ boot: 'b1', asOf: 9, open: [], awaiting: [{ sessionKey: SK, boot: 'b1', asOf: 9, turnId: 7, open: false, awaitsHuman: true }] });
    expect(serverTurnOf(SK)).toMatchObject({ open: false, awaitsHuman: true });
    expect(verdict({ serverTurn: serverTurnOf(SK) })).toBe('hold');
  });

  test('stopped: nothing leaves on its own, whatever the server says', () => {
    expect(verdict({ held: true, serverTurn: closed(7, 8) })).toBe('hold');
  });

  test("this window's own send is still streaming: try again in a moment", () => {
    expect(verdict({ sendLocked: true, serverTurn: closed(7, 8) })).toBe('wait-own-send');
  });
});

describe('the real end sends', () => {
  test('the close of the turn waited for', () => {
    const head = { waitsFor: { boot: 'b1', turnId: 7 } };
    expect(verdict({ serverTurn: closed(7, 8), head })).toBe('drain');
  });

  test('a snapshot after a reload: the turn ended while the window was away', () => {
    noteServerTurn(SK, open(7));
    const closedNow = noteTurnSnapshot({ boot: 'b1', asOf: 20, open: [] });
    expect(closedNow).toEqual([SK]);
    expect(verdict({ serverTurn: serverTurnOf(SK), head: { waitsFor: { boot: 'b1', turnId: 7 } } })).toBe('drain');
  });

  test('a session the snapshot does not list, never seen before: closed as of the snapshot', () => {
    noteTurnSnapshot({ boot: 'b1', asOf: 20, open: [] });
    expect(verdict({ serverTurn: serverTurnOf('topic:other'), head: { waitsFor: { boot: 'b1', turnId: 7 } } })).toBe('drain');
  });

  test('a restarted server: the old turn is gone, the new word decides', () => {
    const head = { waitsFor: { boot: 'b1', turnId: 7 } };
    expect(verdict({ serverTurn: { boot: 'b2', asOf: 1, turnId: 0, open: false }, head })).toBe('drain');
    // A turn the restart re-adopted is open under the new boot: still waits.
    expect(verdict({ serverTurn: { boot: 'b2', asOf: 2, turnId: 2, open: true }, head })).toBe('wait-turn');
  });

  test('no word from the server and nothing waited for: the server\'s 409 decides', () => {
    expect(verdict({ serverTurn: undefined })).toBe('drain');
  });

  test('an empty queue has nothing to drain', () => {
    expect(verdict({ queued: 0, serverTurn: closed(7, 8) })).toBe('hold');
  });
});

describe('the server word, kept in order', () => {
  test('malformed statements are dropped', () => {
    expect(noteServerTurn(SK, { open: true })).toBe(false);
    expect(serverTurnOf(SK)).toBeUndefined();
  });

  test('the message typed during a turn waits for that turn', () => {
    noteServerTurn(SK, open(11));
    expect(openTurnRef(SK)).toEqual({ boot: 'b1', turnId: 11 });
    noteServerTurn(SK, closed(11, 12));
    expect(openTurnRef(SK)).toBeUndefined();
  });
});
