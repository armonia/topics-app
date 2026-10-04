/**
 * The one sum, at table: the nine rules of precedence (design section 3) and
 * the transitions T1-T19 of section 4.2 as the composition sees them. The
 * epoch is the store's (`store.test.ts`); here the CAUSE that decides it.
 * @covers ATTN-01
 * @covers ATTN-02
 * @covers ATTN-05
 */
import { describe, expect, test } from "bun:test";
import { composeAttention, countingTaskCount, isLitComposition, isTurnUnseen, type AttentionInputs } from "./compose";

const AT = "2026-10-03T10:00:00.000Z";
const LATER = "2026-10-03T11:00:00.000Z";
const done = { id: "m1", outcome: "done" as const, at: AT };
const error = { id: "m2", outcome: "error" as const, at: AT, detail: "overloaded" };
const bash = { b1: { kind: "bash", label: "make", startedAt: AT } };
const cron = { c1: { kind: "cron", label: "*/5 * * * *", startedAt: AT, recurring: true } };
const question = { ask: { kind: "question" as const, id: "ask:1", text: "Procedo?", since: AT } };
const review = { status: "review" as const, since: AT };

/** Every rule, with every rule below it also true: the first one must win. */
const PRECEDENCE: Array<[string, AttentionInputs, ReturnType<typeof composeAttention>["state"], string | null]> = [
  ["1 archived", { archived: true, dispatched: true, holds: question, card: review, turnOpen: true, lastTurn: error, background: bash }, "idle", null],
  ["1 deleted", { deleted: true, holds: question }, "idle", null],
  ["1 closed terminal", { closed: true, lastTurn: done }, "idle", null],
  ["2 board agent's topic", { dispatched: true, holds: question, card: review, turnOpen: true, lastTurn: error }, "idle", null],
  ["3 a wait", { holds: question, card: review, turnOpen: true, lastTurn: error, background: bash }, "needs-you", "question"],
  ["4 card in review", { card: review, turnOpen: true, lastTurn: error, background: bash }, "needs-you", "review"],
  ["4 card parked", { card: { status: "parked", since: AT } }, "needs-you", "parked"],
  ["5 turn open", { turnOpen: true, lastTurn: error, background: bash }, "working", null],
  ["6 error unseen beats background", { lastTurn: error, background: bash }, "finished", "error"],
  ["7 a job in flight is working, and beats done", { lastTurn: done, background: bash }, "working", null],
  ["8 done unseen", { lastTurn: done }, "finished", "done"],
  ["9 nothing", {}, "idle", null],
  ["9 done seen", { lastTurn: done, seenAt: AT }, "idle", null],
];

describe("the precedence, first rule wins", () => {
  for (const [name, inputs, state, why] of PRECEDENCE) {
    test(name, () => {
      const c = composeAttention(inputs);
      expect(c.state).toBe(state);
      expect(c.reason ?? c.outcome).toBe(why as never);
    });
  }
});

describe("the cause of a lit state", () => {
  test("a wait, a card, a turn each name their fact", () => {
    expect(composeAttention({ holds: question }).cause).toBe("hold:question:ask:1");
    expect(composeAttention({ card: review }).cause).toBe(`card:review:${AT}`);
    expect(composeAttention({ lastTurn: done }).cause).toBe("turn:done:m1");
    expect(composeAttention({ lastTurn: error }).cause).toBe("turn:error:m2");
  });

  test("an unlit state has none", () => {
    for (const i of [{}, { turnOpen: true }, { background: bash }, { archived: true, lastTurn: done }]) {
      expect(composeAttention(i).cause).toBeNull();
    }
  });

  test("two waits: the oldest is the one shown, so a second wait on the same turn is the same fact", () => {
    const c = composeAttention({ holds: { phase: { kind: "question", id: "phase:2", since: LATER }, ask: question.ask } });
    expect(c.cause).toBe("hold:question:ask:1");
  });
});

describe("the transitions as the composition sees them (design section 4.2)", () => {
  test("T1 a turn opens from any dark state", () => {
    for (const i of [{}, { background: bash }, { lastTurn: done, seenAt: AT }]) expect(composeAttention({ ...i, turnOpen: true }).state).toBe("working");
  });
  test("T2 a turn ends with a message and nothing in flight: finished(done)", () => {
    expect(composeAttention({ lastTurn: done })).toMatchObject({ state: "finished", outcome: "done" });
  });
  test("T3 / T5 a turn ends with tasks in flight: working, the turn kept unseen", () => {
    expect(composeAttention({ lastTurn: done, background: bash }).state).toBe("working");
    expect(isTurnUnseen(done, null)).toBe(true);
  });
  test("T6 / T7 the last task returns: finished(done) if the turn was not seen, idle if it was", () => {
    expect(composeAttention({ lastTurn: done, background: {} }).state).toBe("finished");
    expect(composeAttention({ lastTurn: done, background: {}, seenAt: AT }).state).toBe("idle");
  });
  test("T7 within the grace the subject stays working", () => {
    expect(composeAttention({ lastTurn: done, background: {}, backgroundGrace: true }).state).toBe("working");
  });
  test("T8 / T9 a wait opens and closes", () => {
    expect(composeAttention({ turnOpen: true, holds: question }).state).toBe("needs-you");
    expect(composeAttention({ turnOpen: true, holds: {} }).state).toBe("working");
  });
  test("T10 an error with tasks in flight is finished(error)", () => {
    expect(composeAttention({ lastTurn: error, background: bash })).toMatchObject({ state: "finished", outcome: "error", detail: "overloaded" });
  });
  test("T11 seen: idle", () => {
    expect(composeAttention({ lastTurn: done, seenAt: LATER }).state).toBe("idle");
  });
  test("T13 archived or closed: idle whatever else is true", () => {
    expect(composeAttention({ archived: true, lastTurn: done }).state).toBe("idle");
    expect(composeAttention({ closed: true, holds: question }).state).toBe("idle");
  });
  test("T14 / T15 the card enters and leaves review", () => {
    expect(composeAttention({ card: review }).state).toBe("needs-you");
    expect(composeAttention({ card: null }).state).toBe("idle");
  });
  test("T18 reopened: the turn seen at the archiving stays dark", () => {
    expect(composeAttention({ archived: false, lastTurn: done, seenAt: AT }).state).toBe("idle");
  });
});

describe("tasks that count", () => {
  test("a recurring cron is in the map and counts zero", () => {
    expect(countingTaskCount({ ...bash, ...cron })).toBe(1);
    expect(countingTaskCount(cron)).toBe(0);
    expect(composeAttention({ lastTurn: done, background: cron }).state).toBe("finished");
  });
  test("lit is needs-you or finished", () => {
    expect(isLitComposition({ state: "needs-you" })).toBe(true);
    expect(isLitComposition({ state: "finished" })).toBe(true);
    for (const state of ["idle", "working"] as const) expect(isLitComposition({ state })).toBe(false);
  });
});
