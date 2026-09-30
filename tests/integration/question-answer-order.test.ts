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
import { readFileSync } from "fs";
import { join } from "path";
import { finalizeOrphanedRunningTools } from "../../server/lib/boot-orphan-tools";
import { _dropAskStateLikeARestart } from "../../server/lib/ask-user-bridge";
import { TopicsRoutingIncompatibleError } from "../../server/providers/resolve-topic-provider";
import { NativeProvider } from "../../server/providers/native/provider";
import { configureNativeHistorySource } from "../../server/providers/native/history-rehydrate";
import { nativeHistorySource } from "../../server/providers/native/history-source";
import {
  ctx, handlers, streamEnds, setModelConnected, setProviderRefusal, QUESTION, askOnRow, storedCall, bootServer,
  machineTurnInFlight, until, receivedBy, modelReceived, useQuestionBench,
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
  // Sent once the model hears that turn.
  await until(() => storedCall(rowA, "toolu_carry_A")?.answerRelay === "sent");
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

/** How many times the answer's quoted question appears in a text. */
const answerCount = (text: string) => text.split(`> ${QUESTION}`).length - 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("after a restart, an owed answer is there for the first message", () => {
  test("server.ts loads the answers the rows owe into the relay, held, before the server listens", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "server.ts"), "utf8");
    const hold = src.indexOf("answerRelay?.hold()");
    const load = src.indexOf("finalizeOrphanedRunningTools(db, liveBrokerChatSessions)");
    const listen = src.indexOf("await listenWithSquatterFallback(");
    expect(hold).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(hold);
    expect(listen).toBeGreaterThan(load);
  });

  test("a message that reaches the route before the surviving turns are adopted carries the owed answer in front of it", async () => {
    const sk = "topic:q-restart-first";
    const rowA = askOnRow(sk, "toolu_restart_A", { finalize: true });
    // What the route wrote before the restart cut the relay short.
    ctx.updateToolCallFields(sk, "toolu_restart_A", {
      status: "success", answerRelay: "queued",
      userResponse: { kind: "questions", answers: { [QUESTION]: "next" }, submittedAt: new Date().toISOString() },
    }, { rowId: rowA });
    _dropAskStateLikeARestart();
    // The boot, in server.ts's order: routers first, then the sweep loads the
    // owed answers into the relay under a hold, then the server listens.
    const server = bootServer();
    const releaseAtAdoption = server.relay().hold();
    for (const o of finalizeOrphanedRunningTools(ctx.db, new Set())) if (o.sessionKey === sk) server.relay().enqueue(o);
    // The composer resends what the person typed across the restart, while
    // the boot is still adopting the surviving turns.
    expect(await server.send(sk, "PERSON-AFTER-RESTART")).toBe(200);
    releaseAtAdoption();
    await until(() => storedCall(rowA, "toolu_restart_A")?.answerRelay === "sent");
    await sleep(60);
    await server.relay().idle();
    const text = readInOrder(sk);
    expect(storedCall(rowA, "toolu_restart_A")?.answerRelay).toBe("sent");
    expect(text.indexOf(`> ${QUESTION}`)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("PERSON-AFTER-RESTART")).toBeGreaterThan(text.indexOf(`> ${QUESTION}`));
    expect(answerCount(text)).toBe(1);
    // The release had nothing left to post.
    expect(server.lateMessages).toEqual([]);
  });
});

describe("an answer stays owed until the turn that carries it has really started", () => {
  test("taken by a message the route then refused after the gate: still queued, and the next message carries it", async () => {
    const sk = "topic:q-taken-refused";
    const rowA = askOnRow(sk, "toolu_takenref_A", { finalize: true });
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer();
    const warns: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
    try {
      // The routing switch can no longer reach the topic's provider: the
      // route refuses at provider resolution, after it took the answer.
      setProviderRefusal(new TopicsRoutingIncompatibleError("fake-model", "fake-model is not reachable through the routing"));
      expect((await server.answer(sk, "toolu_takenref_A", "next")).body.deliveredAs).toBe("message");
      await until(() => server.lateMessages.length > 0);
      await server.relay().idle();
      expect(storedCall(rowA, "toolu_takenref_A")?.answerRelay).toBe("queued");
      expect(receivedBy(sk)).toEqual([]);
      // Said once, and true: it is still owed.
      const said = warns.filter((w) => w.includes("[answer-relay]") && w.includes("toolu_takenref_A"));
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("stays owed");
      // The switch is fixed; the person writes.
      setProviderRefusal(null);
      expect(await server.send(sk, "PERSON-AFTER-REFUSAL")).toBe(200);
      await until(() => storedCall(rowA, "toolu_takenref_A")?.answerRelay === "sent");
    } finally { console.warn = warn; }
    const text = readInOrder(sk);
    expect(storedCall(rowA, "toolu_takenref_A")?.answerRelay).toBe("sent");
    expect(answerCount(text)).toBe(1);
    expect(text.indexOf("PERSON-AFTER-REFUSAL")).toBeGreaterThan(text.indexOf(`> ${QUESTION}`));
  });

  test("taken by a turn the provider failed before the model heard anything: still queued, not re-sent in a loop, carried by the next message", async () => {
    const sk = "topic:q-taken-failed";
    const rowA = askOnRow(sk, "toolu_takenfail_A", { finalize: true });
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer({ modelAnswersRelay: false });
    const machine = await machineTurnInFlight(server.chat, sk);
    expect((await server.answer(sk, "toolu_takenfail_A", "next")).body.deliveredAs).toBe("message");
    machine.onTextDelta("done", "done");
    machine.onDone();
    await until(() => server.lateMessages.length > 0);
    await server.relay().idle();
    // The relay's turn started, and the provider fails before the model says anything.
    const relayTurn = handlers[handlers.length - 1]!;
    expect(storedCall(rowA, "toolu_takenfail_A")?.answerRelay).toBe("queued");
    relayTurn.onError("PROCESS_DEAD: the child exited before reading its input");
    await sleep(100);
    await server.relay().idle();
    expect(storedCall(rowA, "toolu_takenfail_A")?.answerRelay).toBe("queued");
    // Its own end does not post it again: no loop into a failing provider.
    expect(server.lateMessages).toHaveLength(1);
    expect(await server.send(sk, "PERSON-AFTER-FAILURE")).toBe(200);
    await until(() => storedCall(rowA, "toolu_takenfail_A")?.answerRelay === "sent");
    expect(storedCall(rowA, "toolu_takenfail_A")?.answerRelay).toBe("sent");
    const last = receivedBy(sk).at(-1)!;
    expect(answerCount(last)).toBe(1);
    expect(last.indexOf("PERSON-AFTER-FAILURE")).toBeGreaterThan(last.indexOf(`> ${QUESTION}`));
  });
});

describe("a carried answer is read once", () => {
  /** A person's message that carries an owed answer: what the route hands the provider. */
  async function carriedTurn(sk: string, toolCallId: string, words: string) {
    askOnRow(sk, toolCallId, { finalize: true });
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer();
    const machine = await machineTurnInFlight(server.chat, sk);
    expect((await server.answer(sk, toolCallId, "main")).body.deliveredAs).toBe("message");
    // Sent in the very frame of stream:end, so it carries the answer.
    const drain = composerDrain(server, sk, words, { sync: true, replyMs: 60_000 });
    machine.onTextDelta("done", "done");
    machine.onDone();
    await until(() => drain.delivered(), 5000);
    const sent = modelReceived.filter((m) => m.sessionKey === sk).at(-1)!;
    expect(answerCount(sent.message)).toBe(1);
    expect(sent.message).toContain(words);
    return sent;
  }

  test("the history the route sends with a carried turn leaves the answer out: it is in the message", async () => {
    const sent = await carriedTurn("topic:q-carry-history", "toolu_carryhist_A", "PERSON-HIST");
    const history = JSON.stringify(sent.options?.history ?? []);
    expect(history).toContain("help me decide");
    expect(answerCount(history)).toBe(0);
    expect(history).not.toContain("PERSON-HIST");
  });

  test("the native runtime rebuilding the session from the rows (restart, idle eviction) does not read it twice", async () => {
    const sk = "topic:q-carry-native";
    const sent = await carriedTurn(sk, "toolu_carrynat_A", "PERSON-NATIVE");
    // The native runtime is `inline-system`: the route sends it no history,
    // and a session not in memory is rebuilt from the rows.
    const { history: _history, ...toNative } = sent.options ?? {};
    configureNativeHistorySource((k) => nativeHistorySource(ctx, k));
    let rebuilt: unknown = null;
    try {
      const native = new NativeProvider({ type: "native" } as never);
      (native as unknown as { driveTurn: (...a: unknown[]) => Promise<{ runId?: string }> }).driveTurn = async (_sk: unknown, session: unknown) => {
        rebuilt = JSON.parse(JSON.stringify((session as { history: unknown }).history));
        return { runId: "probe" };
      };
      await native.sendChat(sk, sent.message, { onTextDelta() {}, onDone() {}, onError() {} } as never, toNative);
    } finally { configureNativeHistorySource(null); }
    const text = JSON.stringify(rebuilt);
    expect(text).toContain("help me decide");
    expect(text).toContain("PERSON-NATIVE");
    expect(answerCount(text)).toBe(1);
  });
});
});
