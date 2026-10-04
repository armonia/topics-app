/**
 * The restart, read where the server reads it (`attentionBootReader`, the
 * reader `server.ts` hands to `recomposeAttentionOnBoot`), over a real
 * database. Review 2 of notifications-redesign:
 *
 *   - B3: a chat whose turn ended waiting on its own `run_command` is not dead
 *     when its CLI is: the process registry re-adopts the command and still
 *     owes its wake. The restart lit a red "process ended with 1 task in
 *     flight", and the command's wake then made a second epoch with a push.
 *   - B4: a plan to approve survives the restart on its row (`waiting_for_input`,
 *     answerable by `isPlanApprovalAnswer`): it stays `needs-you(plan)`, and
 *     the seen door cannot switch it off. The restart turned it into
 *     `finished(done)`, which «Mark seen» then put out with no answer.
 * @covers ATTN-04, ATTN-07, ATTN-09, ATTN-15
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTestDataDir, createTestAppContext, setupTestDataDir, testTmpDir } from "../../tests/integration/helpers";
import { decodeCol } from "../../shared/message-blob";
import { planApprovalSchema } from "../lib/plan-approval";
import { attentionBootReader, type AttentionBootSources } from "./boot-reader";
import { configureAttentionStore, getAttention, markAttentionSeen, openHold, recomposeAttentionOnBoot, resetAttentionStore, turnEnded, turnStarted } from "./store";
import type { AppContext, Topic } from "../types";

const ROOT = testTmpDir("attention-boot-reader");
beforeAll(() => setupTestDataDir(`${ROOT}/data`));
afterAll(() => { resetAttentionStore(); cleanupTestDataDir(ROOT); });

const pushes: unknown[] = [];
const configure = () => configureAttentionStore({ db: () => null, sendPush: (p) => { pushes.push(p); }, recordRow: () => null, markRowsSeen: () => 0, graceMs: 0 });
/** The table survives, the process memory does not. */
const restart = () => { resetAttentionStore({ keepRows: true }); configure(); };
beforeEach(() => { resetAttentionStore(); pushes.length = 0; configure(); });

let ctx: AppContext;
beforeAll(async () => { ctx = await createTestAppContext(); });

function topic(id: string): Topic {
  const now = new Date().toISOString();
  const t = { id, name: id, slug: id, parentId: null, links: [], sessionKey: `topic:sk-${id}`, color: "#5865f2", icon: "MessageSquare", createdAt: now, updatedAt: now, archived: false } as Topic;
  ctx.saveSingleTopic(t);
  return t;
}

function sources(over: Partial<AttentionBootSources> = {}): AttentionBootSources {
  return {
    db: ctx.db as AttentionBootSources["db"],
    loadActiveThread: ctx.loadActiveThread,
    getTopicById: ctx.getTopicById,
    cliHasWork: () => false,
    commandOwesWake: () => false,
    dispatchedSubjects: () => [],
    decode: decodeCol,
    ...over,
  };
}

describe("a restart while a chat waits on its run_command (B3)", () => {
  test("the CLI gone, the command still owed: no epoch, still background; the command's wake is the one announce", () => {
    const t = topic("cmd");
    const subject = `topic:${t.id}`;
    turnStarted(subject);
    turnEnded(subject, { turnId: "m1", outcome: "done", background: { command: { kind: "command", label: "run_command", startedAt: new Date().toISOString() } } });
    const before = getAttention(subject);
    expect(before.state).toBe("background");

    restart();
    recomposeAttentionOnBoot(attentionBootReader(sources({ commandOwesWake: (sk) => sk === t.sessionKey })));
    const after = getAttention(subject);
    expect({ state: after.state, epoch: after.epoch, lit: after.lit, background: after.background.map((x) => x.kind) })
      .toEqual({ state: "background", epoch: before.epoch, lit: false, background: ["command"] });

    // The command ends and its wake opens the chat's turn.
    turnStarted(subject);
    turnEnded(subject, { turnId: "m2", outcome: "done", background: {} });
    const woke = getAttention(subject);
    expect({ state: woke.state, outcome: woke.outcome, epoch: woke.epoch }).toEqual({ state: "finished", outcome: "done", epoch: before.epoch + 1 });
    expect(pushes).toHaveLength(1);
  });

  test("the CLI gone with an Agent, a wake and the command owed: one task died, the command stays", () => {
    const t = topic("mixed");
    const subject = `topic:${t.id}`;
    const at = new Date().toISOString();
    turnStarted(subject);
    turnEnded(subject, { turnId: "m1", outcome: "done", background: {
      a1: { kind: "agent", label: "verify", startedAt: at },
      wake: { kind: "wake", label: "Run the build", startedAt: at },
      command: { kind: "command", label: "run_command", startedAt: at },
    } });
    restart();
    recomposeAttentionOnBoot(attentionBootReader(sources({ commandOwesWake: (sk) => sk === t.sessionKey })));
    const after = getAttention(subject);
    expect({ outcome: after.outcome, detail: after.detail, background: after.background.map((x) => x.kind) })
      .toEqual({ outcome: "error", detail: "Il processo è finito con 1 compito in volo", background: ["command"] });
  });

  test("the CLI gone and nothing owed: the tasks it held died with it, an error as before", () => {
    const t = topic("agentdied");
    const subject = `topic:${t.id}`;
    turnStarted(subject);
    turnEnded(subject, { turnId: "m1", outcome: "done", background: { a1: { kind: "agent", label: "verify", startedAt: new Date().toISOString() } } });
    restart();
    recomposeAttentionOnBoot(attentionBootReader(sources()));
    expect(getAttention(subject).outcome).toBe("error");
  });

  test("a saved wake is no task that died: the CLI's own queue is read again at the reattach", () => {
    const t = topic("wake");
    const subject = `topic:${t.id}`;
    turnStarted(subject);
    turnEnded(subject, { turnId: "m1", outcome: "done", background: { wake: { kind: "wake", label: "Run the build", startedAt: new Date().toISOString() } } });
    restart();
    recomposeAttentionOnBoot(attentionBootReader(sources()));
    // What is left is the turn itself, unseen: done, not a death.
    expect(getAttention(subject)).toMatchObject({ state: "finished", outcome: "done", background: [] });
  });
});

describe("a plan to approve across a restart (B4)", () => {
  function planTurn(t: Topic, status: "waiting_for_input" | "success") {
    const call = { id: `toolu_plan_${t.id}`, name: "Write", args: {}, status, userInputSchema: planApprovalSchema() };
    ctx.saveLocalMessages(t.sessionKey!, [
      { id: `msg-plan-${t.id}`, role: "assistant", content: "Plan: refactor X", timestamp: new Date().toISOString(), toolCalls: [call], blocks: [{ kind: "tool", toolCall: call }] },
    ]);
    const subject = `topic:${t.id}`;
    // The order of the route: the panel opens before the turn's end (chat.ts).
    turnStarted(subject);
    openHold(subject, "plan", { kind: "plan", id: call.id, text: "Plan: refactor X" });
    turnEnded(subject, { turnId: `msg-plan-${t.id}`, outcome: "done" });
    return subject;
  }

  test("still on its row: needs-you(plan), same epoch, and «Mark seen» leaves it lit", () => {
    const subject = planTurn(topic("plan"), "waiting_for_input");
    const before = getAttention(subject);
    expect({ state: before.state, reason: before.reason }).toEqual({ state: "needs-you", reason: "plan" });

    restart();
    recomposeAttentionOnBoot(attentionBootReader(sources()));
    const after = getAttention(subject);
    expect({ state: after.state, reason: after.reason, epoch: after.epoch, lit: after.lit }).toEqual({ state: "needs-you", reason: "plan", epoch: before.epoch, lit: true });

    markAttentionSeen([{ subject, epoch: after.epoch, turnAt: after.lastTurnAt }]);
    expect(getAttention(subject)).toMatchObject({ state: "needs-you", reason: "plan", lit: true });

    // The answer opens the next turn, which closes the wait.
    turnStarted(subject);
    expect(getAttention(subject).state).toBe("working");
  });

  test("answered while the server was away: no wait to bring back", () => {
    const subject = planTurn(topic("planok"), "success");
    restart();
    recomposeAttentionOnBoot(attentionBootReader(sources()));
    expect(getAttention(subject).state).not.toBe("needs-you");
  });
});
