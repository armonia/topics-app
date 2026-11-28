/**
 * The `agent` action against a fake chat door: one turn per occurrence, the
 * boot resume's copy, the generic rules block's outcomes, and chat
 * fresh/keep/archive (T4 and T5 of change lavori-programmati-in-topics, rules
 * R15 to R18 and R20; R19's retries and R27's brakes are a later track).
 *
 * @covers SCHED-05
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { addAgentJob, buildAgentEngine, fakeChatDoor, migratedDb, runsOf, scheduledJobClientMessageId } from "./agent-test-support";
import { AGENT_JOB_RULES_BLOCK } from "./agent-action";

let db: Database;
const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
const advance = (minutes: number) => { clock.now = new Date(clock.now.getTime() + minutes * 60_000); };

beforeEach(() => {
  db = migratedDb();
  clock.now = new Date("2026-01-01T00:00:00.000Z");
});

describe("one turn per occurrence (R15)", () => {
  test("two ticks before the turn closes send it once", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1");
    engine.tick();
    await action.idle();
    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0].prompt).toContain(AGENT_JOB_RULES_BLOCK);
    engine.tick();
    await action.idle();
    expect(chat.sent).toHaveLength(1);
    expect(runsOf(db, "j1")[0].status).toBe("running");
  });

  test("the key is the job and the occurrence, never the run's own id", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1");
    engine.tick();
    await action.idle();
    const run = runsOf(db, "j1")[0];
    expect(chat.sent[0].clientMessageId).toBe(scheduledJobClientMessageId("j1", run.occurrence_key));
  });
});

describe("state read from the chat, not kept locally (R18)", () => {
  test("the run waits while the turn is open, and closes on its final text", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1");
    engine.tick();
    await action.idle();
    engine.tick();
    await action.idle();
    expect(runsOf(db, "j1")[0].status).toBe("running");
    const { sessionKey, clientMessageId } = chat.sent[0];
    chat.answer(sessionKey, clientMessageId, "All done.\nNO_REPLY");
    engine.tick();
    await action.idle();
    expect(runsOf(db, "j1")[0].status).toBe("ok");
  });

  test("a boot resume's copy of the row closes the run with ITS outcome, and opens no second turn", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1");
    engine.tick();
    await action.idle();
    const { sessionKey, clientMessageId } = chat.sent[0];
    const copyKey = `${clientMessageId}#r1`;
    chat.resumeCopy(sessionKey, clientMessageId, copyKey);
    chat.answer(sessionKey, copyKey, "Finished after the restart.\nNO_REPLY");
    engine.tick();
    await action.idle();
    expect(chat.sent).toHaveLength(1); // no second turn
    expect(runsOf(db, "j1")[0].status).toBe("ok");
  });

  test("409 stream_in_flight is not a fault: the next sweep sends it once the chat is free", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1");
    chat.makeNextSendBusy();
    engine.tick();
    await action.idle();
    expect(chat.sent).toHaveLength(0);
    expect(runsOf(db, "j1")[0].status).toBe("running");
    expect(runsOf(db, "j1")[0].reason).toBeNull();
    engine.tick();
    await action.idle();
    expect(chat.sent).toHaveLength(1);
  });
});

describe("the generic rules block's outcomes (R17)", () => {
  test("AUTOMATION_FAILED on the first line closes the run in error, text kept", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1");
    engine.tick();
    await action.idle();
    const { sessionKey, clientMessageId } = chat.sent[0];
    chat.answer(sessionKey, clientMessageId, "AUTOMATION_FAILED: the API was down.\nTried twice.");
    engine.tick();
    await action.idle();
    const run = runsOf(db, "j1")[0];
    expect(run.status).toBe("error");
    expect(run.reason).toContain("AUTOMATION_FAILED");
  });

  test("NO_REPLY at the end is a normal close, not an error", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1");
    engine.tick();
    await action.idle();
    const { sessionKey, clientMessageId } = chat.sent[0];
    chat.answer(sessionKey, clientMessageId, "Nothing to add.\nNO_REPLY");
    engine.tick();
    await action.idle();
    expect(runsOf(db, "j1")[0].status).toBe("ok");
  });

  test("a turn closed with no readable outcome (an outage cut it) is an error", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1");
    engine.tick();
    await action.idle();
    const { sessionKey, clientMessageId } = chat.sent[0];
    chat.cutWithNoOutcome(sessionKey, clientMessageId);
    engine.tick();
    await action.idle();
    const run = runsOf(db, "j1")[0];
    expect(run.status).toBe("error");
    expect(run.reason).toContain("without a recorded outcome");
  });
});

describe("chat fresh, keep, and archiving (R20)", () => {
  test("`fresh` opens a new chat every occurrence", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1");
    engine.tick();
    await action.idle();
    const first = chat.sent[0].sessionKey;
    chat.answer(first, chat.sent[0].clientMessageId, "Done.\nNO_REPLY");
    engine.tick();
    await action.idle();
    advance(10);
    engine.tick();
    await action.idle();
    expect(chat.sent).toHaveLength(2);
    expect(chat.sent[1].sessionKey).not.toBe(first);
  });

  test("`keep` reuses the job's last chat, read off its run history", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1", { action: { chatMode: "keep" } });
    engine.tick();
    await action.idle();
    const first = chat.sent[0].sessionKey;
    chat.answer(first, chat.sent[0].clientMessageId, "Done.\nNO_REPLY");
    engine.tick();
    await action.idle();
    advance(10);
    engine.tick();
    await action.idle();
    expect(chat.sent).toHaveLength(2);
    expect(chat.sent[1].sessionKey).toBe(first);
  });

  test("an `at` job that succeeds with no open question archives its chat", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1", { schedule: { kind: "at", at: clock.now.toISOString() } });
    engine.tick();
    await action.idle();
    const { sessionKey, clientMessageId } = chat.sent[0];
    chat.answer(sessionKey, clientMessageId, "Done.\nNO_REPLY");
    engine.tick();
    await action.idle();
    expect(chat.archived.has(sessionKey)).toBe(true);
  });

  test("an open question keeps the chat: no archiving over it", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1", { schedule: { kind: "at", at: clock.now.toISOString() } });
    engine.tick();
    await action.idle();
    const { sessionKey, clientMessageId } = chat.sent[0];
    chat.openQuestions.add(sessionKey);
    chat.answer(sessionKey, clientMessageId, "Done, but need an answer.\nNO_REPLY");
    engine.tick();
    await action.idle();
    expect(chat.archived.has(sessionKey)).toBe(false);
  });

  test("a job turned off or deleted archives its last known chat", async () => {
    const chat = fakeChatDoor();
    const { engine, action } = buildAgentEngine(db, chat.door, clock);
    addAgentJob(db, clock, "j1");
    engine.tick();
    await action.idle();
    const sessionKey = chat.sent[0].sessionKey;
    action.turnedOff({ id: "j1", action: { kind: "agent", prompt: "x", chatMode: "fresh" } } as Parameters<typeof action.turnedOff>[0]);
    expect(chat.archived.has(sessionKey)).toBe(true);
  });
});
