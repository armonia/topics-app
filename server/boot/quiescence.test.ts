/**
 * `whatIsStillWorking`, the one answer behind the restart gate AND `GET /__daemon/idle`:
 * a turn blocked on a PERSON is parked, not working.
 *
 * Measured on a live install: a chat asked a question at 02:06, nobody answered,
 * and ten hours later the server still reported "3 chat in streaming" with
 * `idle: false`. Nothing was stuck. The turn was alive, its row carried the open
 * question (`waiting_for_input`), and the process was polling the bridge every
 * 25 s for the answer. The gate counted it TWICE, once as the dedicated "parked
 * on a question" source and once as a plain stream, and the stream won the
 * sentence, `unadoptable`, `workingChats` and `lostWorkingChats`: the very things
 * RGATE-09 says a question must stay out of.
 *
 * The wiring is driven for real (`bootQuiescence` over an in-memory database and
 * the real ask registry) instead of a copy of its composition, because the
 * defect lived in what the function did with right rules.
 *
 * @covers RGATE-12, RGATE-13
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { bootQuiescence } from "./quiescence";
import { runIncrementalVacuum } from "../lib/db-incremental-vacuum";
import { _dropAskStateLikeARestart, ASK_POLL_LIVE_MS, beginAsk, endAsk } from "../lib/ask-user-bridge";
import { beginPermission, cancelPermissionsForSession } from "../lib/permission-bridge";
import type { AfterDispatcher } from "./scope";

const ASKING = "topic:aaaaaaaa";
const WORKING = "topic:bbbbbbbb";
const CARD = "topic:cccccccc";
const CARD_TURN = { taskId: "task-1", sessionKey: CARD };

let db: Database;
let activeStreams: Map<string, Record<string, unknown>>;

function addStream(sessionKey: string, messageId: string, partial = 1, brokerKeeps = false): void {
  db.run("INSERT INTO messages (id, session_key, partial, timestamp, sort_order) VALUES (?, ?, ?, ?, 0)", [messageId, sessionKey, partial, new Date().toISOString()]);
  activeStreams.set(sessionKey, { sessionKey, messageId, startedAt: new Date().toISOString(), survivesRestart: false, brokerKeeps });
}

/** The row of a turn parked on a question, as a restart leaves it: nothing in the registry, the question on the row. */
function addQuestionOnRow(sessionKey: string, messageId: string): void {
  const toolCalls = JSON.stringify([{ id: `${messageId}-q`, name: "ask_user_question", status: "waiting_for_input", startedAt: Date.now() }]);
  db.run("INSERT INTO messages (id, session_key, partial, tool_calls, timestamp, sort_order) VALUES (?, ?, 1, ?, ?, 0)", [messageId, sessionKey, toolCalls, new Date().toISOString()]);
}

/** Card turns the dispatcher holds in flight, and lands in the queue, for the tests that need a board. */
interface Board { cards?: Array<{ taskId: string; sessionKey: string }>; lands?: number }

function gate(brokerOpenTurns?: () => Promise<string[]>, bridgeOn?: boolean, board: Board = {}) {
  const cards = board.cards ?? [];
  const scope = {
    activeStreams,
    ctx: { db },
    deliveryOnlyWaitsOnChecks: () => false,
    landingQueue: { inFlight: () => board.lands ?? 0 },
    taskDispatcher: { busyTurns: () => cards, busySessionKeys: () => cards.map((c) => c.sessionKey) },
  } as unknown as AfterDispatcher;
  return bootQuiescence(scope, { ...(brokerOpenTurns ? { brokerOpenTurns } : {}), ...(bridgeOn === undefined ? {} : { bridgeOn: () => bridgeOn }) });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, partial INTEGER, tool_calls TEXT, blocks TEXT, timestamp TEXT, sort_order INTEGER)");
  db.run("CREATE TABLE topics (id TEXT, session_key TEXT, archived INTEGER DEFAULT 0)");
  activeStreams = new Map();
  _dropAskStateLikeARestart();
});

afterEach(() => {
  setSystemTime();
  _dropAskStateLikeARestart();
  cancelPermissionsForSession(ASKING, "test over");
  db.close();
});

describe("whatIsStillWorking: a turn waiting for a person is not a turn in flight", () => {
  test("a live stream under an open question is PARKED, not streaming", async () => {
    addStream(ASKING, "m-asking");
    beginAsk(ASKING);

    const now = await gate().whatIsStillWorking();

    expect(now.busy).toBe(`1 chat ferma/e su una domanda (${ASKING})`);
    expect(now.working).toBe(false);
    expect(now.workingChats).toBe(0);
    expect(now.waitingOnPerson).toBe(1);
    // A native turn does not come back after a restart, yet this is not what a
    // restart would lose: the question lives on its row and outlives the process.
    expect(now.unadoptable).toBe(0);
    expect(now.lostWorkingChats).toBe(0);
    expect(now.holderKind).toBe("question");
    expect(now.holder).toBe(ASKING);
  });

  test("the same stream with no question open is streaming, as ever", async () => {
    addStream(WORKING, "m-working");

    const now = await gate().whatIsStillWorking();

    expect(now.busy).toBe(`1 chat in streaming (${WORKING})`);
    expect(now.working).toBe(true);
    expect(now.workingChats).toBe(1);
    expect(now.unadoptable).toBe(1);
    expect(now.waitingOnPerson).toBe(0);
    expect(now.holderKind).toBe("turn");
  });

  test("answering gives the turn back to the streams, no stale label", async () => {
    addStream(ASKING, "m-asking");
    beginAsk(ASKING);
    const { whatIsStillWorking } = gate();
    expect((await whatIsStillWorking()).working).toBe(false);

    endAsk(ASKING);

    const after = await whatIsStillWorking();
    expect(after.working).toBe(true);
    expect(after.busy).toBe(`1 chat in streaming (${ASKING})`);
  });

  test("beside a working chat, only the working one is working", async () => {
    addStream(ASKING, "m-asking");
    addStream(WORKING, "m-working");
    beginAsk(ASKING);

    const now = await gate().whatIsStillWorking();

    // The sentence names the work, and the question is counted apart.
    expect(now.busy).toBe(`1 chat in streaming (${WORKING})`);
    expect(now.working).toBe(true);
    expect(now.workingChats).toBe(1);
    expect(now.waitingOnPerson).toBe(1);
    expect(now.chats).toBe(2);
  });

  test("a finished turn under a forgotten question holds nothing at all", async () => {
    addStream(ASKING, "m-done", 0);
    beginAsk(ASKING);

    const now = await gate().whatIsStillWorking();

    // The row says the turn is over (RGATE-03): it is not a stream. The question
    // is still on screen for the person, so it is parked, and parked only.
    expect(now.working).toBe(false);
    expect(now.workingChats).toBe(0);
  });
});

describe("whatIsStillWorking: the same rule for a turn the broker keeps open", () => {
  // After a restart a CLI chat has no stream entry: only the broker knows its
  // turn is open. Its child is blocked on the same bridge call and polls it
  // again, so the registry says "waiting" a leg after the boot.
  test("a broker turn under an open question is parked, not an open turn", async () => {
    beginAsk(ASKING);

    const now = await gate(async () => [ASKING]).whatIsStillWorking();

    expect(now.busy).toBe(`1 chat ferma/e su una domanda (${ASKING})`);
    expect(now.working).toBe(false);
    expect(now.workingChats).toBe(0);
    expect(now.waitingOnPerson).toBe(1);
    expect(now.holderKind).toBe("question");
  });

  test("a broker turn with no question is still an open turn", async () => {
    const now = await gate(async () => [WORKING]).whatIsStillWorking();

    expect(now.busy).toBe(`1 turno/i di chat aperti nel broker (${WORKING})`);
    expect(now.working).toBe(true);
    expect(now.workingChats).toBe(1);
    expect(now.waitingOnPerson).toBe(0);
  });

  test("one working and one waiting, side by side: only the first works", async () => {
    beginAsk(ASKING);

    const now = await gate(async () => [WORKING, ASKING]).whatIsStillWorking();

    expect(now.busy).toBe(`1 turno/i di chat aperti nel broker (${WORKING})`);
    expect(now.working).toBe(true);
    expect(now.waitingOnPerson).toBe(1);
  });
});

describe("whatIsStillWorking: the registry is not taken at its word", () => {
  test("an ask nobody polls any more does not hide a turn that is working", async () => {
    addStream(ASKING, "m-asking");
    beginAsk(ASKING);
    // The bridge went quiet (a leg re-opened the ask after a Stop and nothing
    // closed it again): the entry is a leftover and the turn, whatever it is
    // doing, is counted as working.
    setSystemTime(new Date(Date.now() + ASK_POLL_LIVE_MS + 5_000));

    const now = await gate().whatIsStillWorking();

    expect(now.working).toBe(true);
    expect(now.busy).toBe(`1 chat in streaming (${ASKING})`);
    expect(now.waitingOnPerson).toBe(0);
  });

  test("a permission prompt does not park the turn: its decision dies with it", async () => {
    addStream(ASKING, "m-asking");
    beginPermission(ASKING, "toolu_perm");

    const now = await gate().whatIsStillWorking();

    expect(now.working).toBe(true);
    expect(now.workingChats).toBe(1);
    expect(now.unadoptable).toBe(1);
  });

  test("a question on the row that the registry has not confirmed yet is not counted twice", async () => {
    // Just after a boot: the rows say the chat waits, its child has not polled
    // again, so the stream (or broker turn) is still working as far as anyone can tell.
    addQuestionOnRow(WORKING, "m-row");
    activeStreams.set(WORKING, { sessionKey: WORKING, messageId: "m-row", startedAt: new Date().toISOString(), survivesRestart: false, brokerKeeps: false });

    const now = await gate().whatIsStillWorking();

    expect(now.working).toBe(true);
    expect(now.waitingOnPerson).toBe(0);
  });
});

describe("whatIsStillWorking: a parked turn that does not come back still gets the chat minute", () => {
  // `chatGraceMs` is zero only when EVERY open turn comes back. A native turn
  // running in this process, parked on a question, does not; taking it out of
  // the list made the list empty and the grace zero.
  test("a stream parked on a question that does not come back keeps the grace", async () => {
    addStream(ASKING, "m-asking", 1, false);
    beginAsk(ASKING);

    const now = await gate(undefined, true).whatIsStillWorking();

    expect(now.everyTurnComesBack).toBe(false);
    expect(now.working).toBe(false);
  });

  test("one the broker keeps, parked, comes back: the restart does not wait", async () => {
    addStream(ASKING, "m-asking", 1, true);
    beginAsk(ASKING);

    const now = await gate(undefined, true).whatIsStillWorking();

    expect(now.everyTurnComesBack).toBe(true);
  });
});


describe("whatIsStillWorking: a card turn waiting for a person is parked, and still held", () => {
  // The turn of a card that runs INSIDE this process (Codex, ACP, a native turn
  // fallen back from the broker) does not come back after a restart, and the
  // card's recovery resumes it at once without asking whether its question is
  // still open: so the restart keeps deferring for it (RGATE-13). What changes
  // is the label: it is not WORKING, and `idle` answers "is anything computing".
  test("a card parked on a question is not working, and still holds the restart", async () => {
    addStream(CARD, "m-card");
    beginAsk(CARD);

    const now = await gate(undefined, true, { cards: [CARD_TURN] }).whatIsStillWorking();

    expect(now.working).toBe(false);
    expect(now.workingBusy).toBeNull();
    expect(now.cardsOnPerson).toBe(1);
    // The restart verdict is the one it always was.
    expect(now.cards).toBe(1);
    expect(now.busy).toBe("1 turno/i di card della board");
  });

  test("the same card with no question open is working, as ever", async () => {
    addStream(CARD, "m-card");

    const now = await gate(undefined, true, { cards: [CARD_TURN] }).whatIsStillWorking();

    expect(now.working).toBe(true);
    expect(now.workingBusy).toBe("1 turno/i di card della board");
    expect(now.cardsOnPerson).toBe(0);
  });

  test("answering gives the card back to the working", async () => {
    addStream(CARD, "m-card");
    beginAsk(CARD);
    const { whatIsStillWorking } = gate(undefined, true, { cards: [CARD_TURN] });
    expect((await whatIsStillWorking()).working).toBe(false);

    endAsk(CARD);

    expect((await whatIsStillWorking()).working).toBe(true);
  });

  test("a land in flight is work whatever the card beside it does", async () => {
    addStream(CARD, "m-card");
    beginAsk(CARD);

    const now = await gate(undefined, true, { cards: [CARD_TURN], lands: 1 }).whatIsStillWorking();

    expect(now.cards).toBe(2);
    expect(now.cardsOnPerson).toBe(1);
    expect(now.working).toBe(true);
    expect(now.workingBusy).toBe("1 turno/i di card della board");
  });

  test("beside a working chat, the chat is what works", async () => {
    addStream(CARD, "m-card");
    beginAsk(CARD);
    addStream(WORKING, "m-working");

    const now = await gate(undefined, true, { cards: [CARD_TURN] }).whatIsStillWorking();

    expect(now.working).toBe(true);
    expect(now.workingBusy).toBe(`1 chat in streaming (${WORKING})`);
  });

  test("an ask nobody polls any more does not park a card", async () => {
    addStream(CARD, "m-card");
    beginAsk(CARD);
    setSystemTime(new Date(Date.now() + ASK_POLL_LIVE_MS + 5_000));

    const now = await gate(undefined, true, { cards: [CARD_TURN] }).whatIsStillWorking();

    expect(now.working).toBe(true);
    expect(now.cardsOnPerson).toBe(0);
  });

  test("a permission prompt does not park a card: its decision dies with the turn", async () => {
    addStream(CARD, "m-card");
    beginPermission(CARD, "toolu_perm");

    const now = await gate(undefined, true, { cards: [CARD_TURN] }).whatIsStillWorking();

    expect(now.working).toBe(true);
    expect(now.cardsOnPerson).toBe(0);
    cancelPermissionsForSession(CARD, "test over");
  });

  test("a card with no session yet has nobody to ask: it is working", async () => {
    const now = await gate(undefined, true, { cards: [{ taskId: "task-2", sessionKey: "" }] }).whatIsStillWorking();

    expect(now.working).toBe(true);
    expect(now.cardsOnPerson).toBe(0);
  });

  test("a card whose turn the broker keeps is parked like a chat, and holds nothing", async () => {
    // The usual card (claude-code, or a native turn running detached): it comes
    // back after a restart, so it is not even in `cards`.
    addStream(CARD, "m-card", 1, true);
    beginAsk(CARD);

    const now = await gate(undefined, true, { cards: [CARD_TURN] }).whatIsStillWorking();

    expect(now.cards).toBe(0);
    expect(now.working).toBe(false);
    expect(now.busy).toBe(`1 chat ferma/e su una domanda (${CARD})`);
  });
});

describe("autoLandTurnCount: what a land's reload would meet", () => {
  // The automatic land waits for the count to be zero before it merges a diff
  // of the server. A question left open for ten hours is not a turn that the
  // reload meets: it survives on its row (RGATE-12).
  test("a chat parked on a question does not hold the land", async () => {
    addStream(ASKING, "m-asking");
    beginAsk(ASKING);

    expect(await gate().autoLandTurnCount()).toBe(0);
  });

  test("a broker turn parked on a question does not hold the land", async () => {
    beginAsk(ASKING);

    expect(await gate(async () => [ASKING]).autoLandTurnCount()).toBe(0);
  });

  test("a chat that is working holds it, with or without a parked one beside it", async () => {
    addStream(WORKING, "m-working");
    expect(await gate().autoLandTurnCount()).toBeGreaterThan(0);

    addStream(ASKING, "m-asking");
    beginAsk(ASKING);
    expect(await gate().autoLandTurnCount()).toBeGreaterThan(0);
  });

  test("a card that does not come back holds it, parked or not: the gate holds it too", async () => {
    addStream(CARD, "m-card");
    beginAsk(CARD);

    expect(await gate(undefined, true, { cards: [CARD_TURN] }).autoLandTurnCount()).toBeGreaterThan(0);
  });

  test("a card the broker keeps, parked on a question, does not hold it", async () => {
    addStream(CARD, "m-card", 1, true);
    beginAsk(CARD);

    expect(await gate(undefined, true, { cards: [CARD_TURN] }).autoLandTurnCount()).toBe(0);
  });

  test("a land asking from within its own slot does not wait for itself", async () => {
    expect(await gate(undefined, true, { lands: 1 }).autoLandTurnCount({ insideLand: true })).toBe(0);
    expect(await gate(undefined, true, { lands: 1 }).autoLandTurnCount()).toBeGreaterThan(0);
  });
});

describe("the incremental vacuum: an open question does not skip the round", () => {
  /** A database whose pages freed by a DELETE are waiting on the freelist. */
  function dbWithFreePages(): Database {
    const vacuumDb = new Database(":memory:");
    vacuumDb.run("PRAGMA auto_vacuum = INCREMENTAL");
    vacuumDb.run("CREATE TABLE blobs (id INTEGER PRIMARY KEY, body BLOB)");
    for (let i = 0; i < 64; i++) vacuumDb.run("INSERT INTO blobs (body) VALUES (zeroblob(8192))");
    vacuumDb.run("DELETE FROM blobs");
    return vacuumDb;
  }

  test("parked chat and parked card: the vacuum runs", async () => {
    addStream(ASKING, "m-asking");
    beginAsk(ASKING);
    addStream(CARD, "m-card");
    beginAsk(CARD);
    const { whatIsStillWorking } = gate(undefined, true, { cards: [CARD_TURN] });
    const vacuumDb = dbWithFreePages();
    // What used to be asked: the restart gate's sentence, which names the parked ones.
    const now = await whatIsStillWorking();
    expect(now.busy).not.toBeNull();
    expect(now.workingBusy).toBeNull();

    const outcome = await runIncrementalVacuum({ db: vacuumDb, busy: async () => (await whatIsStillWorking()).workingBusy });

    expect(outcome.action).toBe("vacuumed");
    expect(outcome.action === "vacuumed" && outcome.pages).toBeGreaterThan(0);
    vacuumDb.close();
  });

  test("a chat that is working still stops it", async () => {
    addStream(WORKING, "m-working");
    const { whatIsStillWorking } = gate();
    const vacuumDb = dbWithFreePages();

    const outcome = await runIncrementalVacuum({ db: vacuumDb, busy: async () => (await whatIsStillWorking()).workingBusy });

    expect(outcome.action).toBe("skipped");
    vacuumDb.close();
  });
});
