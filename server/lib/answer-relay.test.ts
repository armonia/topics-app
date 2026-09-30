/**
 * The queue that carries an answer whose asker is gone to the model: it waits
 * behind a turn in flight instead of dropping the answer, sends each answer
 * once, in order, and leaves a refused one owed to the next boot.
 *
 * @covers ASK-11
 */
import { describe, expect, test } from "bun:test";
import { createAnswerRelay, owedAnswerOf, type OwedAnswer } from "./answer-relay";

const owed = (toolCallId: string, sessionKey = "topic:relay"): OwedAnswer => ({ sessionKey, toolCallId, rowId: "row-1", content: `answer of ${toolCallId}` });

function bench(statuses: number[]) {
  let busy = false;
  const posted: Array<{ content: string; questionAnswer: unknown }> = [];
  const settled: string[] = [];
  const logs: string[] = [];
  const relay = createAnswerRelay({
    isBusy: () => busy,
    route: async (req) => {
      const body = await req.json() as { messages: Array<{ content: string }>; questionAnswer: unknown };
      posted.push({ content: body.messages[0]!.content, questionAnswer: body.questionAnswer });
      const status = statuses.shift() ?? 200;
      return new Response(JSON.stringify(status === 409 ? { code: "stream_in_flight" } : {}), { status });
    },
    settle: (o) => { settled.push(o.toolCallId); },
    log: (m) => { logs.push(m); },
    pollMs: 5,
  });
  return { relay, posted, settled, logs, setBusy: (b: boolean) => { busy = b; } };
}

describe("answer relay", () => {
  test("waits while the session is busy, then sends once, marked as the answer to its question", async () => {
    const b = bench([]);
    b.setBusy(true);
    b.relay.enqueue(owed("toolu_1"));
    await new Promise((r) => setTimeout(r, 40));
    expect(b.posted).toEqual([]);
    b.setBusy(false);
    await b.relay.idle();
    expect(b.posted).toEqual([{ content: "answer of toolu_1", questionAnswer: { toolCallId: "toolu_1" } }]);
    expect(b.settled).toEqual(["toolu_1"]);
  });

  test("a 409 stream_in_flight puts it back to wait, with no cap", async () => {
    const b = bench([409, 409, 409, 200]);
    b.relay.enqueue(owed("toolu_2"));
    await b.relay.idle();
    expect(b.posted).toHaveLength(4);
    expect(b.settled).toEqual(["toolu_2"]);
  });

  test("the same answer queued twice goes once; two answers of a session go in order", async () => {
    const b = bench([]);
    b.relay.enqueue(owed("toolu_a"));
    b.relay.enqueue(owed("toolu_a"));
    b.relay.enqueue(owed("toolu_b"));
    await b.relay.idle();
    expect(b.posted.map((p) => p.content)).toEqual(["answer of toolu_a", "answer of toolu_b"]);
  });

  test("any other refusal leaves it owed (not settled) and says so", async () => {
    const b = bench([503]);
    b.relay.enqueue(owed("toolu_3"));
    await b.relay.idle();
    expect(b.settled).toEqual([]);
    expect(b.logs.join("\n")).toContain("owed to the next boot");
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
