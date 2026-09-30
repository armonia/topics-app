/**
 * A QUESTION WAITS FOR ITS HUMAN, like it does in Claude Code (29/09).
 *
 * "Look at how a topic handles questions too: it looks like one can expire.
 * That makes no sense." A question asked by a topic used to end on a clock
 * (the 24-hour TTL of the rendez-vous), with the process that asked it (a
 * restart, a dead child: the row was closed as interrupted), and with
 * whatever killer ran over its turn. Here each of those, against the real
 * routes on a real database:
 *
 *   1. an ask open for 25 hours is still answerable;
 *   2. across a server restart, with the asker gone, the answer still reaches
 *      the model: as the next user message, with the question quoted;
 *   3. across a restart with the asker still alive (a CLI child in the broker)
 *      an answer given before the restart is collected from the row;
 *   4. every killer on the map skips a turn that is waiting on a question;
 *   5. a new message supersedes a question nobody is waiting on, and says so;
 *   6. an answer is bound to ITS question from the click to the model: never
 *      the result of another question's leg, never dropped behind a machine
 *      turn, never lost to a restart or to the window of recent rows (its
 *      order against the person's next message: `question-answer-order.test.ts`).
 *
 * The restart is simulated at the boundary the design has: the in-memory
 * rendez-vous is dropped (`_dropAskStateLikeARestart`), the routers are built
 * again, and the boot sweep runs over the same database.
 *
 * @covers ASK-11
 * @covers HOLD-01
 */
import { describe, test, expect, setSystemTime, jest } from "bun:test";
import type { ToolCall } from "../../server/types";
import { decodeCol } from "../../shared/message-blob";
import {
  beginAsk, endAsk, hasPendingAsk, pendingAskVerdict, _dropAskStateLikeARestart, ASK_BUFFER_TTL_MS,
} from "../../server/lib/ask-user-bridge";
import { isHumanHold } from "../../server/lib/human-hold";
import { finalizeOrphanedRunningTools } from "../../server/lib/boot-orphan-tools";
import { ClaudeCodeProvider, turnWatchdogDecision } from "../../server/providers/claude-code";
import { armStallDetector } from "../../server/lib/stall-detector";
import { decidePark } from "../../server/lib/terminal-idle-park";
import { runWithDelegatedDeadline } from "../../server/services/task-dispatcher-delegated";
import { armCodexTurnTimeout } from "../../server/providers/codex";
import { sessionHasOpenQuestion } from "../../server/lib/question-outlives-asker";
import {
  ctx, modelReceived, HOUR, QUESTION, QUESTIONS, askOnRow, storedCall, bootServer, machineTurnInFlight, until, receivedBy,
  useQuestionBench,
} from "./helpers/question-bench";

useQuestionBench("question-waits");

/** The `owed_answers` entry of a tool call: what the next boot loads (`lib/owed-answers.ts`). */
const owedIndexRow = (toolCallId: string) => ctx.db.query("SELECT row_id FROM owed_answers WHERE tool_call_id = ?").get(toolCallId);

describe("no clock ends a question", () => {
  test("an ask open for 25 hours is still answerable, and the answer is the tool's result", async () => {
    const sk = "topic:q-25h";
    const toolCallId = "toolu_q_25h";
    askOnRow(sk, toolCallId);
    const server = bootServer();
    const t0 = Date.now();

    expect((await server.leg(sk)).body).toEqual({ pending: true });
    // The person went home. The server used to answer this leg with "the
    // question expired with no answer" and the CLI closed the tool.
    setSystemTime(new Date(t0 + 25 * HOUR));
    expect((await server.leg(sk)).body).toEqual({ pending: true });
    expect(hasPendingAsk(sk)).toBe(true);

    const answered = await server.answer(sk, toolCallId, "next");
    expect(answered.status).toBe(200);
    expect((await server.leg(sk)).body).toEqual({ answers: { [QUESTION]: "next" } });
    // The asker was there, so no second channel was used.
    expect(server.lateMessages).toEqual([]);
  });
});

describe("a question survives the process that asked it", () => {
  test("restart with the asker gone: the boot keeps the question open and the answer reaches the model as the next message", async () => {
    const sk = "topic:q-restart-gone";
    const toolCallId = "toolu_q_gone";
    const rowId = askOnRow(sk, toolCallId, { finalize: true });
    beginAsk(sk);

    // THE RESTART: memory gone, a native turn gone with it, the boot sweep
    // runs with no live child for this session.
    _dropAskStateLikeARestart();
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer();

    // The panel is still there to be clicked (a reload paints it from here).
    const kept = storedCall(rowId, toolCallId);
    expect(kept?.status).toBe("waiting_for_input");
    expect(kept?.askerGone).toBe(true);

    const answered = await server.answer(sk, toolCallId, "main");
    expect(answered.status).toBe(200);
    expect(answered.body.deliveredAs).toBe("message");

    // What the model receives, through the real chat route: the question it
    // asked, quoted, and the answer.
    const until = Date.now() + 3000;
    while (!modelReceived.some((m) => m.sessionKey === sk) && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    const received = modelReceived.filter((m) => m.sessionKey === sk);
    expect(received).toHaveLength(1);
    expect(received[0]!.message).toContain(`> ${QUESTION}`);
    expect(received[0]!.message).toContain("main");
    // And the panel shows it answered, not interrupted.
    const after = storedCall(rowId, toolCallId);
    expect(after?.status).toBe("success");
    expect(after?.userResponse).toMatchObject({ kind: "questions", answers: { [QUESTION]: "main" } });

    // A second click (another window) is refused: the question is closed.
    const again = await server.answer(sk, toolCallId, "next");
    expect(again.status).toBe(409);
    expect(server.lateMessages).toHaveLength(1);
  });

  test("restart with the asker alive: an answer given before the restart is collected from the row", async () => {
    const sk = "topic:q-restart-alive";
    const toolCallId = "toolu_q_alive";
    askOnRow(sk, toolCallId);
    const before = bootServer();
    expect((await before.leg(sk)).body).toEqual({ pending: true });
    // Answered between two legs: the answer sits in the in-memory buffer...
    expect((await before.answer(sk, toolCallId, "next")).status).toBe(200);

    // ...and the restart empties it, while the CLI child keeps polling.
    _dropAskStateLikeARestart();
    const after = bootServer();
    expect((await after.leg(sk)).body).toEqual({ answers: { [QUESTION]: "next" } });
    expect(after.lateMessages).toEqual([]);
  });

  test("restart with the asker alive: an answer given before the child's first leg after boot is its tool result", async () => {
    const sk = "topic:q-restart-window";
    const toolCallId = "toolu_q_window";
    const rowId = askOnRow(sk, toolCallId);
    const before = bootServer();
    expect((await before.leg(sk)).body).toEqual({ pending: true });

    // THE RESTART with the child alive in the broker: the rendez-vous AND the
    // stream map are empty (the reattach has not run yet), and the boot spares
    // the live session, so nothing marks the question gone.
    _dropAskStateLikeARestart();
    ctx.activeStreams.delete(sk);
    finalizeOrphanedRunningTools(ctx.db, new Set([sk]));
    const after = bootServer();
    expect(storedCall(rowId, toolCallId)?.askerGone).toBeUndefined();

    // The person clicks inside the bridge's backoff, before the next leg. It
    // used to be read as "asker gone": the answer went out as a message, the
    // row was closed, and every later leg of the live child got
    // `{pending:true}` forever.
    jest.useFakeTimers();
    try {
      const answered = await after.answer(sk, toolCallId, "next");
      expect(answered.status).toBe(200);
      expect(answered.body.deliveredAs).toBeUndefined();
      expect((await after.leg(sk)).body).toEqual({ answers: { [QUESTION]: "next" } });
      jest.advanceTimersByTime(ASK_BUFFER_TTL_MS + 1000);
    } finally {
      jest.useRealTimers();
    }
    expect(after.lateMessages).toEqual([]);
    expect(hasPendingAsk(sk)).toBe(false);
  });

  test("an answer a leg collects off the row is not sent again when the buffer's TTL runs out", async () => {
    const sk = "topic:q-no-duplicate";
    const toolCallId = "toolu_q_no_dup";
    askOnRow(sk, toolCallId);
    const server = bootServer();
    expect((await server.leg(sk)).body).toEqual({ pending: true });
    // Answered between two legs (no waiter registered): buffered AND recorded
    // on the row. The next leg collects it from the row; the buffer used to
    // stay armed and, two minutes later, sent the same answer to the model as
    // a message the person never typed.
    jest.useFakeTimers();
    try {
      expect((await server.answer(sk, toolCallId, "next")).body.deliveredAs).toBeUndefined();
      expect((await server.leg(sk)).body).toEqual({ answers: { [QUESTION]: "next" } });
      jest.advanceTimersByTime(ASK_BUFFER_TTL_MS + 1000);
    } finally {
      jest.useRealTimers();
    }
    expect(server.lateMessages).toEqual([]);
  });
});

describe("every killer on the map skips a turn waiting on a question", () => {
  const AGE = 25 * HOUR;

  function fakeTimers(start = 1_000_000) {
    let now = start;
    let seqId = 0;
    const pending = new Map<number, { fn: () => void; at: number }>();
    return {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => { const id = ++seqId; pending.set(id, { fn, at: now + ms }); return id; },
      clearTimer: (h: unknown) => { pending.delete(h as number); },
      /** Advance the clock, firing every timer that falls due, in order. */
      advance(ms: number) {
        const end = now + ms;
        for (;;) {
          const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          pending.delete(due[0]);
          now = due[1].at;
          due[1].fn();
        }
        now = end;
      },
    };
  }

  function providerWithChild(sessionKey: string) {
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const p = provider as unknown as Record<string, any>;
    const pp = {
      sessionKey, alive: true, inactivityTimer: null, lifetimeTimer: null, heartbeatInterval: null,
      subAgentEmit: new Map(), streamHandler: null, lastEventAt: Date.now(),
      io: { writeStdin: () => {}, kill: () => {}, signal: () => {} }, readline: { close() {} },
    };
    p.processes.set(sessionKey, pp);
    let killed = 0;
    p.killProcess = () => { killed++; };
    p.stopHeartbeat = () => {};
    return { p, pp, killed: () => killed };
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("the CLI child's lifetime cap rearms under a question", async () => {
    const sk = "killer:lifetime";
    const { p, pp, killed } = providerWithChild(sk);
    beginAsk(sk);
    const d = p.armLifetime(pp, sk, { ms: 5, rearmMs: 5 });
    await sleep(60);
    expect(killed()).toBe(0);
    d.clear();
    endAsk(sk);
  });

  test("the idle reaper does not reap a child parked on a question", async () => {
    const sk = "killer:reaper";
    const { p, pp, killed } = providerWithChild(sk);
    beginAsk(sk);
    p.resetInactivityTimer(sk, pp, { ms: 5 });
    await sleep(60);
    expect(killed()).toBe(0);
    endAsk(sk);
  });

  test("the turn watchdog rearms however old the question is", () => {
    const sk = "killer:watchdog";
    beginAsk(sk, Date.now() - AGE);
    expect(turnWatchdogDecision({ pendingAsk: hasPendingAsk(sk), idleMs: AGE, windowMs: 30 * 60_000 }).action).toBe("rearm");
    endAsk(sk);
  });

  test("the stall judge is never asked while the question is open", () => {
    const sk = "killer:stall";
    const t = fakeTimers();
    beginAsk(sk, t.now());
    let stuck = 0;
    let judged = 0;
    const d = armStallDetector({
      idleMs: 5 * 60_000,
      isWaitingForHuman: () => isHumanHold(sk),
      getTail: () => "assistant: waiting",
      judge: async () => { judged++; return "stuck"; },
      onStuck: () => { stuck++; },
      now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.advance(AGE);
    expect(judged).toBe(0);
    expect(stuck).toBe(0);
    d.clear();
    endAsk(sk);
  });

  test("the stale-stream sweep defers a 25-hour question on a live child", () => {
    expect(pendingAskVerdict({ askAgeMs: AGE, childAlive: true })).toBe("defer");
  });

  test("the terminal park does not kill a TUI whose question the reaper demoted to paused", () => {
    const decision = decidePark({
      id: "pty-1", type: "claude-code", claudeSessionId: "cs-1", busy: false, idleMs: AGE,
      attachedClients: 0, hasTranscript: true, phase: "paused", awaitingHuman: true,
    }, 30 * 60_000);
    expect(decision).toEqual({ park: false, reason: "awaiting-human" });
  });

  test("the delegated wall clock does not count the person's time", async () => {
    const sk = "killer:delegated";
    const t = fakeTimers();
    let held = false;
    let aborted = 0;
    let finish: () => void = () => {};
    const run = new Promise<void>((r) => { finish = r; });
    const deadlineAt = t.now() + 10 * 60_000;
    const racing = runWithDelegatedDeadline({
      resolvePolicy: () => ({ maxDurationMinutes: 10, model: "m", effort: "high" }) as never,
      persistedDeadlineAt: deadlineAt,
      sessionKey: sk,
      clock: t.now,
      abortTurn: async () => { aborted++; },
      run: () => run,
      isHumanHold: () => held,
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.advance(5 * 60_000);      // five minutes of work
    held = true;
    t.advance(AGE);             // a question open for 25 hours
    expect(aborted).toBe(0);
    held = false;
    t.advance(4 * 60_000);      // four more minutes of work: still inside ten
    expect(aborted).toBe(0);
    t.advance(2 * 60_000);      // eleven minutes of work: now it fires
    expect(aborted).toBe(1);
    finish();
    await racing;
  });

  test("the Codex turn cap rearms under a question and gives the turn a full window after", () => {
    const t = fakeTimers();
    let held = true;
    let expired = 0;
    const cap = armCodexTurnTimeout({
      sessionKey: "killer:codex", ms: 30 * 60_000, isHumanHold: () => held,
      onExpired: () => { expired++; }, now: t.now, setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.advance(AGE);
    expect(expired).toBe(0);
    held = false;
    t.advance(29 * 60_000);
    expect(expired).toBe(0);
    t.advance(3 * 60_000);
    expect(expired).toBe(1);
    cap.clear();
  });
});

describe("a question ends only because of a person, and says why", () => {
  test("a new message supersedes a question nobody is waiting on, in plain words", async () => {
    const sk = "topic:q-superseded";
    const toolCallId = "toolu_q_super";
    const rowId = askOnRow(sk, toolCallId, { finalize: true });
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer();
    expect(await server.send(sk, "never mind, do something else")).toBe(200);
    const ended = storedCall(rowId, toolCallId);
    expect(ended?.status).toBe("error");
    expect(ended?.askEnded).toBe("superseded");
  });

  test("a message the machine sends does not supersede a person's question", async () => {
    const sk = "topic:q-machine-message";
    const toolCallId = "toolu_q_machine";
    const rowId = askOnRow(sk, toolCallId, { finalize: true });
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer();
    // The goal loop's nudge, and the dispatcher relaunching an agent after a
    // restart: neither is the person choosing not to answer.
    expect(await server.send(sk, "Objective still open: carry on.", { goalNudge: 1 })).toBe(200);
    expect(await server.send(sk, "Resume the task.", { dispatched: true })).toBe(200);
    // Another agent writing into this chat (`send_chat_message`) is not the person either.
    expect(await server.send(sk, "From the other topic: done.", { fromAgent: true })).toBe(200);
    const kept = storedCall(rowId, toolCallId);
    expect(kept?.status).toBe("waiting_for_input");
    expect(kept?.askEnded).toBeUndefined();
  });
});

describe("an answer is bound to its own question, from the click to the model", () => {
  const Q_B = "Which database do we use?";
  const QUESTIONS_B = [{ question: Q_B, header: "DB", options: [{ label: "sqlite" }, { label: "postgres" }], multiSelect: false }];

  /** A new turn's row with a live question on it, as the detector paints it. */
  function askOnNewRow(sessionKey: string, toolCallId: string, questions: unknown[]): string {
    const msg = ctx.createPartialMessage(sessionKey, "assistant");
    ctx.startStream(sessionKey, msg.id);
    ctx.addToolCallToLastMessage(sessionKey, {
      id: toolCallId, name: "mcp__topics__ask_user_question", args: { questions },
      status: "waiting_for_input", startedAt: Date.now(), userInputSchema: { kind: "questions", questions },
    } as ToolCall);
    return msg.id;
  }

  test("an answer to a question whose asker is gone is never the result of the question a new turn asked", async () => {
    const sk = "topic:q-cross";
    const rowA = askOnRow(sk, "toolu_cross_A", { finalize: true });
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer();
    // The dispatcher relaunches the card; the relaunched turn asks B.
    expect(await server.send(sk, "Resume the task.", { dispatched: true })).toBe(200);
    const rowB = askOnNewRow(sk, "toolu_cross_B", QUESTIONS_B);
    const legB = server.legFor(sk, QUESTIONS_B, 400);
    await until(() => hasPendingAsk(sk));

    // The person clicks the OLD panel A.
    const clickA = await server.answer(sk, "toolu_cross_A", "next");
    expect(clickA.status).toBe(200);
    expect(clickA.body.deliveredAs).toBe("message");
    // B's leg is not handed A's answer: the model would read it as B's result.
    expect((await legB).body).toEqual({ pending: true });
    expect(hasPendingAsk(sk)).toBe(true);
    expect(storedCall(rowB, "toolu_cross_B")?.status).toBe("waiting_for_input");
    // A is answered and queued behind B's turn, which is still in flight.
    expect(storedCall(rowA, "toolu_cross_A")).toMatchObject({ status: "success", answerRelay: "queued" });
    expect(server.lateMessages).toEqual([]);

    // B's turn ends: A's answer reaches the model as a message, once.
    ctx.endStream(sk);
    await until(() => server.lateMessages.length > 0 && storedCall(rowA, "toolu_cross_A")?.answerRelay === "sent");
    expect(server.lateMessages).toHaveLength(1);
    expect(server.lateMessages[0]!.content).toContain(`> ${QUESTION}`);
    expect(server.lateMessages[0]!.content).toContain("next");
    expect(storedCall(rowA, "toolu_cross_A")?.answerRelay).toBe("sent");
  });

  test("the same question asked again by the relaunched turn: the old panel's answer does not feed the new leg", async () => {
    const sk = "topic:q-reask";
    const rowA = askOnRow(sk, "toolu_reask_A", { finalize: true });
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer();
    expect(await server.send(sk, "Resume the task.", { dispatched: true })).toBe(200);
    askOnNewRow(sk, "toolu_reask_B", QUESTIONS);
    const legB = server.legFor(sk, QUESTIONS, 400);
    await until(() => hasPendingAsk(sk));

    const clickA = await server.answer(sk, "toolu_reask_A", "next");
    expect(clickA.body.deliveredAs).toBe("message");
    expect((await legB).body).toEqual({ pending: true });
    expect(storedCall(rowA, "toolu_reask_A")).toMatchObject({ status: "success", answerRelay: "queued" });
    // The new panel answers the new leg, as its own result.
    const clickB = await server.answer(sk, "toolu_reask_B", "main");
    expect(clickB.body.deliveredAs).toBeUndefined();
    expect((await server.legFor(sk, QUESTIONS, 100)).body).toEqual({ answers: { [QUESTION]: "main" } });
    ctx.endStream(sk);
    await until(() => server.lateMessages.length > 0);
    expect(server.lateMessages).toHaveLength(1);
    expect(server.lateMessages[0]!.content).toContain("next");
  });

  test("an answer given while a machine turn runs waits for it and then reaches the model, and the panel says it is queued", async () => {
    const sk = "topic:q-busy";
    const rowA = askOnRow(sk, "toolu_busy_A", { finalize: true });
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer();
    const machine = await machineTurnInFlight(server.chat, sk);

    const clickA = await server.answer(sk, "toolu_busy_A", "main");
    expect(clickA.status).toBe(200);
    expect(clickA.body.deliveredAs).toBe("message");
    expect(storedCall(rowA, "toolu_busy_A")).toMatchObject({ status: "success", answerRelay: "queued" });
    // While the machine turn runs the answer is not sent into a 409 and dropped.
    await new Promise((r) => setTimeout(r, 150));
    expect(server.lateMessages).toEqual([]);
    expect(receivedBy(sk).some((m) => m.includes(`> ${QUESTION}`))).toBe(false);

    machine.onTextDelta("done", "done");
    machine.onDone();
    await until(() => storedCall(rowA, "toolu_busy_A")?.answerRelay === "sent");
    const answers = receivedBy(sk).filter((m) => m.includes(`> ${QUESTION}`));
    expect(answers).toHaveLength(1);
    expect(answers[0]).toContain("main");
    expect(storedCall(rowA, "toolu_busy_A")?.answerRelay).toBe("sent");
  });

  test("an answer still queued when the server restarts is sent by the next boot, once", async () => {
    const sk = "topic:q-owed-boot";
    const rowA = askOnRow(sk, "toolu_owed_A", { finalize: true });
    // What the route wrote before the restart cut the relay short.
    ctx.updateToolCallFields(sk, "toolu_owed_A", {
      status: "success", answerRelay: "queued",
      userResponse: { kind: "questions", answers: { [QUESTION]: "next" }, submittedAt: new Date().toISOString() },
    }, { rowId: rowA });

    _dropAskStateLikeARestart();
    const owed = finalizeOrphanedRunningTools(ctx.db, new Set());
    expect(owed.filter((o) => o.sessionKey === sk).map((o) => o.toolCallId)).toEqual(["toolu_owed_A"]);
    // A mark older than the index: the sweep puts it there, so a later boot finds it at any age.
    expect(owedIndexRow("toolu_owed_A")).toEqual({ row_id: rowA });
    const server = bootServer();
    for (const o of owed) if (o.sessionKey === sk) server.relay().enqueue(o);
    await server.relay().idle();
    expect(server.lateMessages).toHaveLength(1);
    expect(server.lateMessages[0]!.content).toContain(`> ${QUESTION}`);
    // Sent once the model hears the turn that carries it.
    await until(() => storedCall(rowA, "toolu_owed_A")?.answerRelay === "sent");
    expect(storedCall(rowA, "toolu_owed_A")?.answerRelay).toBe("sent");
    // The next boot owes nothing.
    expect(finalizeOrphanedRunningTools(ctx.db, new Set()).filter((o) => o.sessionKey === sk)).toEqual([]);
    expect(owedIndexRow("toolu_owed_A")).toBeNull();
  });

  test("an answer buffered for a leg that never came is not lost to a restart", async () => {
    const sk = "topic:q-buffer-restart";
    const rowA = askOnRow(sk, "toolu_buf_A", { finalize: true });
    // The boot spares the session (the broker listed its child), so nothing
    // marks the question: the answer goes to the buffer, the row to `running`.
    finalizeOrphanedRunningTools(ctx.db, new Set([sk]));
    const server = bootServer();
    expect((await server.answer(sk, "toolu_buf_A", "main")).body.deliveredAs).toBeUndefined();
    expect(storedCall(rowA, "toolu_buf_A")?.status).toBe("running");

    // The restart empties the buffer, and this time the child is dead.
    _dropAskStateLikeARestart();
    const owed = finalizeOrphanedRunningTools(ctx.db, new Set());
    expect(storedCall(rowA, "toolu_buf_A")).toMatchObject({ status: "success", answerRelay: "queued" });
    // Indexed with the mark, in the same write.
    expect(owedIndexRow("toolu_buf_A")).toEqual({ row_id: rowA });
    const next = bootServer();
    for (const o of owed) if (o.sessionKey === sk) next.relay().enqueue(o);
    await next.relay().idle();
    expect(next.lateMessages).toHaveLength(1);
    expect(next.lateMessages[0]!.content).toContain("main");
  });

  test("a buffered answer to one question is not collected by the leg of another", async () => {
    const sk = "topic:q-buffer-steal";
    const rowA = askOnRow(sk, "toolu_steal_A", { finalize: true });
    finalizeOrphanedRunningTools(ctx.db, new Set([sk]));
    const server = bootServer();
    expect((await server.answer(sk, "toolu_steal_A", "main")).status).toBe(200);
    expect(storedCall(rowA, "toolu_steal_A")?.status).toBe("running");
    // A new turn asks B inside the buffer's two minutes.
    askOnNewRow(sk, "toolu_steal_B", QUESTIONS_B);
    expect((await server.legFor(sk, QUESTIONS_B, 100)).body).toEqual({ pending: true });
    ctx.endStream(sk);
  });

  test("a question pushed out of the last twenty rows by machine turns still takes its answer", async () => {
    const sk = "topic:q-window";
    const rowA = askOnRow(sk, "toolu_window_A", { finalize: true });
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer();
    for (let i = 1; i <= 12; i++) expect(await server.send(sk, `Objective still open: carry on (${i}).`, { goalNudge: i })).toBe(200);
    const clickA = await server.answer(sk, "toolu_window_A", "next");
    expect(clickA.status).toBe(200);
    expect(clickA.body.deliveredAs).toBe("message");
    await until(() => storedCall(rowA, "toolu_window_A")?.answerRelay === "sent");
    expect(server.lateMessages).toHaveLength(1);
  });

  test("the answer to one question does not supersede the person's other open question", async () => {
    const sk = "topic:q-two-open";
    const rowA = askOnRow(sk, "toolu_two_A", { finalize: true });
    const rowB = askOnNewRow(sk, "toolu_two_B", QUESTIONS_B);
    ctx.updateLastMessage(sk, { partial: undefined, streamedAt: undefined }, { rowId: rowB });
    ctx.activeStreams.delete(sk);
    finalizeOrphanedRunningTools(ctx.db, new Set());
    const server = bootServer();
    expect(sessionHasOpenQuestion(ctx, sk, decodeCol)).toBe(true);
    expect((await server.answer(sk, "toolu_two_A", "main")).body.deliveredAs).toBe("message");
    await until(() => storedCall(rowA, "toolu_two_A")?.answerRelay === "sent");
    expect(storedCall(rowB, "toolu_two_B")).toMatchObject({ status: "waiting_for_input", askerGone: true });
    // B is still waiting on its person, and the goal loop reads it off the rows.
    expect(sessionHasOpenQuestion(ctx, sk, decodeCol)).toBe(true);
  });
});
