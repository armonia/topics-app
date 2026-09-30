/**
 * AN ANSWER GIVEN FIRST REACHES THE MODEL FIRST (30/09).
 *
 * An answer to a question whose asker is gone is queued as the model's next
 * message (`lib/answer-relay.ts`). The relay used to look at the session every
 * two seconds, while the composer sends what the person typed meanwhile on
 * `stream:end`: the person's later message reached the model before the
 * answer. Here, against the real routes: the order holds whichever of the two
 * reaches the chat route first, each goes once, and an answer the route
 * refused goes at the next turn end instead of the next boot.
 *
 * @covers ASK-11
 */
import { describe, test, expect } from "bun:test";
import { finalizeOrphanedRunningTools } from "../../server/lib/boot-orphan-tools";
import {
  ctx, handlers, streamEnds, setModelConnected, QUESTION, askOnRow, storedCall, bootServer,
  machineTurnInFlight, until, receivedBy, useQuestionBench,
} from "./helpers/question-bench";

useQuestionBench("question-answer-order");

describe("an answer is not overtaken by the person's next message", () => {
/**
 * What the composer does with a message typed while a turn runs
 * (`useChat.settleTurn` -> `drainTurnQueue`): it sends it on `stream:end`,
 * and on a 409 puts it back at the head and sends it on the next one. The
 * model closes each of its turns after `replyMs`.
 */
function composerDrain(server: ReturnType<typeof bootServer>, sessionKey: string, content: string, opts: { sync?: boolean; replyMs?: number } = {}) {
  const statuses: number[] = [];
  let delivered = false;
  const url = new URL("http://topics.test/api/chat");
  const send = async () => {
    const r = await server.chat(new Request(url.toString(), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
    }), url, "/api/chat", "POST");
    statuses.push(r?.status ?? 0);
    r?.body?.cancel().catch(() => {});
    if (r?.ok) {
      delivered = true;
      const h = handlers[handlers.length - 1];
      setTimeout(() => { h?.onTextDelta("ok", "ok"); h?.onDone(); }, opts.replyMs ?? 50);
    }
  };
  streamEnds.push((ended) => {
    if (ended !== sessionKey || delivered) return;
    if (opts.sync) void send(); else setTimeout(() => { void send(); }, 0);
  });
  return { statuses, delivered: () => delivered };
}

/** Everything the model read on this session, in order, as one text. */
const readInOrder = (sk: string) => receivedBy(sk).join("\n---\n");

test("the person's message written after the answer never reaches the model before it (the composer drains on stream:end)", async () => {
  const sk = "topic:q-order";
  const rowA = askOnRow(sk, "toolu_order_A", { finalize: true });
  finalizeOrphanedRunningTools(ctx.db, new Set());
  const server = bootServer();
  const machine = await machineTurnInFlight(server.chat, sk);
  // t1: the person answers A, queued behind the machine turn.
  const clickA = await server.answer(sk, "toolu_order_A", "next");
  expect(clickA.body.deliveredAs).toBe("message");
  // t2 > t1: the person types M; the composer holds it until stream:end.
  const M = "PERSON-M: ok, and after that deploy it";
  const drain = composerDrain(server, sk, M);
  machine.onTextDelta("done", "done");
  machine.onDone();
  await until(() => drain.delivered() && storedCall(rowA, "toolu_order_A")?.answerRelay === "sent", 5000);
  await server.relay().idle();
  const text = readInOrder(sk);
  expect(text.indexOf(`> ${QUESTION}`)).toBeGreaterThanOrEqual(0);
  expect(text.indexOf("PERSON-M")).toBeGreaterThan(text.indexOf(`> ${QUESTION}`));
  // Once each.
  expect(text.split(`> ${QUESTION}`)).toHaveLength(2);
  expect(text.split("PERSON-M")).toHaveLength(2);
});

test("a message that reaches the route before the relay carries the owed answer in front of it, in one turn, as two rows", async () => {
  const sk = "topic:q-carry";
  const rowA = askOnRow(sk, "toolu_carry_A", { finalize: true });
  finalizeOrphanedRunningTools(ctx.db, new Set());
  const server = bootServer();
  const machine = await machineTurnInFlight(server.chat, sk);
  expect((await server.answer(sk, "toolu_carry_A", "main")).body.deliveredAs).toBe("message");
  // Sent in the very frame of stream:end, before the relay's next tick.
  const drain = composerDrain(server, sk, "PERSON-M2: then open the PR", { sync: true });
  const before = receivedBy(sk).length;
  machine.onTextDelta("done", "done");
  machine.onDone();
  await until(() => drain.delivered(), 5000);
  await server.relay().idle();
  expect(drain.statuses).toEqual([200]);
  const turn = receivedBy(sk).slice(before);
  // One turn: the answer first, the message after it.
  expect(turn).toHaveLength(1);
  expect(turn[0]!.indexOf(`> ${QUESTION}`)).toBeGreaterThanOrEqual(0);
  expect(turn[0]!.indexOf("PERSON-M2")).toBeGreaterThan(turn[0]!.indexOf(`> ${QUESTION}`));
  expect(storedCall(rowA, "toolu_carry_A")?.answerRelay).toBe("sent");
  // Two user rows, the answer's first: the person's row stays their words.
  const users = (ctx.db.query("SELECT content FROM messages WHERE session_key = ? AND role = 'user' ORDER BY rowid").all(sk) as Array<{ content: string }>).map((r) => r.content);
  expect(users.slice(-2)[0]).toContain(`> ${QUESTION}`);
  expect(users.slice(-2)[1]).toBe("PERSON-M2: then open the PR");
  // The relay has nothing left to send.
  await new Promise((r) => setTimeout(r, 150));
  await server.relay().idle();
  expect(server.lateMessages).toEqual([]);
  expect(readInOrder(sk).split(`> ${QUESTION}`)).toHaveLength(2);
});

test("an answer the chat route refused stays owed and goes at the next turn end, not at the next boot", async () => {
  const sk = "topic:q-refused";
  const rowA = askOnRow(sk, "toolu_refused_A", { finalize: true });
  finalizeOrphanedRunningTools(ctx.db, new Set());
  const server = bootServer();
  const machine = await machineTurnInFlight(server.chat, sk);
  expect((await server.answer(sk, "toolu_refused_A", "next")).body.deliveredAs).toBe("message");
  // The provider is down when the turn ends: the relay's post is refused.
  setModelConnected(false);
  machine.onTextDelta("done", "done");
  machine.onDone();
  await until(() => server.lateMessages.length > 0);
  await server.relay().idle();
  expect(storedCall(rowA, "toolu_refused_A")?.answerRelay).toBe("queued");
  expect(receivedBy(sk).some((m) => m.includes(`> ${QUESTION}`))).toBe(false);
  // The provider is back; a machine turn (a command's wake) runs and ends.
  setModelConnected(true);
  expect(await server.send(sk, "Process p1 finished.", { processExit: { processId: "p1" } })).toBe(200);
  await until(() => storedCall(rowA, "toolu_refused_A")?.answerRelay === "sent");
  await server.relay().idle();
  expect(storedCall(rowA, "toolu_refused_A")?.answerRelay).toBe("sent");
  expect(receivedBy(sk).filter((m) => m.includes(`> ${QUESTION}`))).toHaveLength(1);
});
});
