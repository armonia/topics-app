/**
 * The queue that carries an answer whose asker is gone to the model: it waits
 * behind a turn in flight instead of dropping the answer, moves at the
 * session's turn end (not on a clock), sends each answer once and in order,
 * gives way to a person's message that carries the answer itself, and keeps a
 * refused answer owed to the next turn end.
 *
 * @covers ASK-11
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createAnswerRelay, owedAnswerOf, type AnswerRelay, type OwedAnswer } from "./answer-relay";
import { announceTurnEnded, turnEndedListenerCount } from "./turn-ended";

let benchSeq = 0;

/** Past the relay's wait after a failed post (1 s the first time, doubled after each failure in a row). */
let clock = 0;
function afterTheWait(ms = 1_001): void {
  clock = (clock || Date.now()) + ms;
  setSystemTime(new Date(clock));
}
afterEach(() => { clock = 0; setSystemTime(); });

/**
 * The relay over a fake chat route that behaves like the real gate: a busy
 * session answers 409 `stream_in_flight`, a free one claims the answer (or
 * refuses it as `answer_not_owed`) and starts a turn. `statuses` forces a
 * refusal before the gate, as a disconnected provider does.
 */
function bench(statuses: number[] = []) {
  const sessionKey = `topic:relay-${++benchSeq}`;
  let busy = false;
  /** The turn the route starts fails before the model hears anything (a provider error). */
  let modelFails = false;
  const posted: string[] = [];
  const sent: string[] = [];
  const settled: string[] = [];
  const logs: string[] = [];
  let relay!: AnswerRelay;
  relay = createAnswerRelay({
    isBusy: () => busy,
    route: async (req) => {
      const body = await req.json() as { questionAnswer: { toolCallId: string } };
      const id = body.questionAnswer.toolCallId;
      posted.push(id);
      const forced = statuses.shift();
      // A forced 409 is the real gate's: a turn in flight, `stream_in_flight` (routes/chat.ts).
      if (forced === 409) return new Response(JSON.stringify({ code: "stream_in_flight" }), { status: 409 });
      if (forced !== undefined && forced !== 200) return new Response("{}", { status: forced });
      if (busy) return new Response(JSON.stringify({ code: "stream_in_flight" }), { status: 409 });
      const claimed = relay.claim(sessionKey, id);
      if (!claimed) return new Response(JSON.stringify({ code: "answer_not_owed" }), { status: 409 });
      // The turn starts; the model hears it at once unless the test says it fails first.
      claimed.turnStarted = true;
      busy = true;
      if (modelFails) return new Response("data: [DONE]\n\n", { status: 200 });
      relay.heard(claimed);
      sent.push(id);
      return new Response("data: [DONE]\n\n", { status: 200 });
    },
    settle: (o) => { settled.push(o.toolCallId); },
    log: (m) => { logs.push(m); },
  });
  const owed = (toolCallId: string): OwedAnswer => ({ sessionKey, toolCallId, rowId: "row-1", content: `answer of ${toolCallId}` });
  /** The turn in flight ends, as `endStream` says it. */
  const endTurn = async () => {
    busy = false;
    announceTurnEnded(sessionKey);
    await new Promise((r) => setTimeout(r, 5));
    await relay.idle();
  };
  return {
    sessionKey, relay, owed, posted, sent, settled, logs, endTurn,
    setBusy: (b: boolean) => { busy = b; },
    setModelFails: (f: boolean) => { modelFails = f; },
  };
}

describe("answer relay", () => {
  test("waits while the session is busy, with no clock, and sends at the turn end, once", async () => {
    const b = bench();
    b.setBusy(true);
    b.relay.enqueue(b.owed("toolu_1"));
    await new Promise((r) => setTimeout(r, 60));
    await b.relay.idle();
    expect(b.posted).toEqual([]);
    await b.endTurn();
    expect(b.sent).toEqual(["toolu_1"]);
    expect(b.settled).toEqual(["toolu_1"]);
    await b.endTurn();
    expect(b.posted).toEqual(["toolu_1"]);
  });

  test("a 409 stream_in_flight leaves it owed to the next turn end, with no cap", async () => {
    const b = bench([409, 409]);
    b.relay.enqueue(b.owed("toolu_2"));
    await b.relay.idle();
    expect(b.sent).toEqual([]);
    await b.endTurn();
    expect(b.sent).toEqual([]);
    await b.endTurn();
    expect(b.sent).toEqual(["toolu_2"]);
    expect(b.posted).toHaveLength(3);
  });

  test("the same answer queued twice goes once; two answers of a session go in order, one turn each", async () => {
    const b = bench();
    b.relay.enqueue(b.owed("toolu_a"));
    b.relay.enqueue(b.owed("toolu_a"));
    b.relay.enqueue(b.owed("toolu_b"));
    await b.relay.idle();
    expect(b.sent).toEqual(["toolu_a"]);
    await b.endTurn();
    expect(b.sent).toEqual(["toolu_a", "toolu_b"]);
    await b.endTurn();
    expect(b.posted).toEqual(["toolu_a", "toolu_b"]);
  });

  test("any other refusal leaves it owed, says so once, and the first turn end after the wait sends it", async () => {
    const b = bench([503, 503]);
    b.relay.enqueue(b.owed("toolu_3"));
    await b.relay.idle();
    expect(b.settled).toEqual([]);
    // A turn end inside the wait does not post: a refusal is not retried at once.
    await b.endTurn();
    expect(b.posted).toEqual(["toolu_3"]);
    afterTheWait();
    await b.endTurn();
    expect(b.settled).toEqual([]);
    expect(b.logs.filter((l) => l.includes("toolu_3"))).toHaveLength(1);
    expect(b.logs[0]).toContain("owed to the next turn end");
    // Refused twice in a row: the wait doubled, one second is not enough.
    afterTheWait();
    await b.endTurn();
    expect(b.posted).toHaveLength(2);
    afterTheWait();
    await b.endTurn();
    expect(b.settled).toEqual(["toolu_3"]);
  });

  test("a post that fails and ends a turn of its own is not posted again by that end: no loop (CI run 36726755945)", async () => {
    const sessionKey = `topic:relay-loop-${++benchSeq}`;
    let posts = 0;
    const logs: string[] = [];
    const relay = createAnswerRelay({
      isBusy: () => false,
      // The route fails the way a closed database made it fail: the stream it
      // opened is ended (a turn end), then the request throws.
      route: async () => {
        posts++;
        announceTurnEnded(sessionKey);
        throw new Error("Cannot use a closed database");
      },
      settle: () => {},
      log: (m) => { logs.push(m); },
    });
    try {
      relay.enqueue({ sessionKey, toolCallId: "toolu_loop", rowId: "row-1", content: "answer" });
      await new Promise((r) => setTimeout(r, 200));
      await relay.idle();
      expect(posts).toBe(1);
      expect(logs).toHaveLength(1);
      afterTheWait();
      announceTurnEnded(sessionKey);
      await new Promise((r) => setTimeout(r, 50));
      await relay.idle();
      expect(posts).toBe(2);
      expect(logs).toHaveLength(1);
    } finally {
      relay.dispose();
    }
  });

  test("a disposed relay posts nothing and listens to no turn end", async () => {
    const b = bench();
    const before = turnEndedListenerCount();
    b.setBusy(true);
    b.relay.enqueue(b.owed("toolu_d"));
    expect(turnEndedListenerCount()).toBe(before + 1);
    b.relay.dispose();
    expect(turnEndedListenerCount()).toBe(before);
    await b.endTurn();
    expect(b.posted).toEqual([]);
  });

  test("a person's message takes every owed answer in order, and the relay then has nothing left to post", async () => {
    const b = bench();
    b.setBusy(true);
    b.relay.enqueue(b.owed("toolu_x"));
    b.relay.enqueue(b.owed("toolu_y"));
    const carry = b.relay.takeOwed(b.sessionKey)!;
    expect(carry.answers.map((o) => o.toolCallId)).toEqual(["toolu_x", "toolu_y"]);
    expect(b.relay.takeOwed(b.sessionKey)).toBeNull();
    expect(b.relay.claim(b.sessionKey, "toolu_x")).toBeNull();
    carry.turnStarted = true;
    b.relay.heard(carry);
    expect(b.settled).toEqual(["toolu_x", "toolu_y"]);
    await b.endTurn();
    await b.endTurn();
    expect(b.posted).toEqual([]);
    expect(b.sent).toEqual([]);
  });

  test("a turn that ended before the model heard anything gives the answer back, and it waits for the NEXT turn end, not a loop", async () => {
    const b = bench();
    b.setModelFails(true);
    b.relay.enqueue(b.owed("toolu_f"));
    await b.relay.idle();
    expect(b.posted).toEqual(["toolu_f"]);
    // The turn it started ends with nothing heard: owed again, not settled, not re-posted by that same end.
    await b.endTurn();
    expect(b.settled).toEqual([]);
    expect(b.posted).toEqual(["toolu_f"]);
    expect(b.logs.filter((l) => l.includes("toolu_f"))).toHaveLength(1);
    expect(b.logs[0]).toContain("before the model heard anything");
    // Somebody else's turn ends later, after the wait: now it goes, and the model hears it.
    b.setModelFails(false);
    afterTheWait();
    await b.endTurn();
    expect(b.posted).toEqual(["toolu_f", "toolu_f"]);
    expect(b.settled).toEqual(["toolu_f"]);
  });

  test("a message that took answers and never started its turn gives them back in order, ahead of what was queued since", () => {
    const b = bench();
    b.setBusy(true);
    b.relay.enqueue(b.owed("toolu_1st"));
    b.relay.enqueue(b.owed("toolu_2nd"));
    const carry = b.relay.takeOwed(b.sessionKey)!;
    b.relay.enqueue(b.owed("toolu_3rd"));
    b.relay.notCarried(carry);
    expect(b.settled).toEqual([]);
    // A late event of that message cannot settle what it gave back.
    b.relay.heard(carry);
    expect(b.settled).toEqual([]);
    expect(b.relay.takeOwed(b.sessionKey)!.answers.map((o) => o.toolCallId)).toEqual(["toolu_1st", "toolu_2nd", "toolu_3rd"]);
  });

  test("under a hold nothing is posted, a message can still take what is owed, and the release sends the rest", async () => {
    const b = bench();
    const release = b.relay.hold();
    b.relay.enqueue(b.owed("toolu_h1"));
    await b.relay.idle();
    expect(b.posted).toEqual([]);
    await b.endTurn();
    expect(b.posted).toEqual([]);
    // What the boot loaded is there for the first message, before any release.
    expect(b.relay.takeOwed(b.sessionKey)!.answers.map((o) => o.toolCallId)).toEqual(["toolu_h1"]);
    b.relay.enqueue(b.owed("toolu_h2"));
    release();
    await b.relay.idle();
    expect(b.posted).toEqual(["toolu_h2"]);
  });

  test("a relay with nothing owed or carried holds no turn-end listener, so a router built and dropped leaks none", async () => {
    const before = turnEndedListenerCount();
    const relays = Array.from({ length: 5 }, () => bench());
    expect(turnEndedListenerCount()).toBe(before);
    const b = relays[0]!;
    b.setBusy(true);
    b.relay.enqueue(b.owed("toolu_l"));
    expect(turnEndedListenerCount()).toBe(before + 1);
    await b.endTurn();
    expect(b.settled).toEqual(["toolu_l"]);
    expect(turnEndedListenerCount()).toBe(before);
  });

  test("owedAnswerOf reads a queued answer off a stored call, and nothing else", () => {
    const call = {
      id: "toolu_q", name: "mcp__topics__ask_user_question", status: "success", answerRelay: "queued",
      args: { questions: [{ question: "Which branch?" }] },
      userResponse: { kind: "questions", answers: { "Which branch?": "next" } },
    };
    const o = owedAnswerOf(call, { sessionKey: "topic:x", rowId: "r1" });
    expect(o).toMatchObject({ sessionKey: "topic:x", toolCallId: "toolu_q", rowId: "r1" });
    expect(o!.content).toContain("> Which branch?");
    expect(o!.content).toContain("next");
    expect(owedAnswerOf({ ...call, answerRelay: "sent" }, { sessionKey: "topic:x", rowId: "r1" })).toBeNull();
    expect(owedAnswerOf(call, { sessionKey: null, rowId: "r1" })).toBeNull();
  });
});
