/**
 * Per-turn restart gate for native turns (lossless-restart). Kept apart from
 * quiescence.test.ts, which is at its size limit.
 *
 * @covers RGATE-01, RESUME-06
 */
import { test, expect, describe } from "bun:test";
import { chatGraceMs, providerSurvivesRestart, quiescenceVerdict, turnComesBack, turnSurvivesRestart, unrecoverableHolders } from "./quiescence";

/**
 * The gate decides per TURN whether a native turn comes back: the stream's flag
 * is set before the runtime knows whether the broker spawned its process or the
 * turn fell back into the server (lossless-restart review, finding 3).
 */
describe("turnComesBack / chatGraceMs: a native turn comes back only when it runs detached", () => {
  const CHAT_CAP = 60_000;

  test("native detached: comes back, so a card does not hold and a chat gets no grace", () => {
    const back = turnComesBack({ bridgeOn: true, brokerKeeps: true, nativeTurn: true, nativeDetached: true });
    expect(back).toBe(true);
    expect(chatGraceMs({ unrecoverable: 0, everyTurnComesBack: back, capMs: CHAT_CAP })).toBe(0);
  });

  test("native in-process fallback: holds even though its stream promised to survive, and the chat keeps its minute", () => {
    const back = turnComesBack({ bridgeOn: true, brokerKeeps: true, nativeTurn: true, nativeDetached: false });
    expect(back).toBe(false);
    expect(chatGraceMs({ unrecoverable: 0, everyTurnComesBack: back, capMs: CHAT_CAP })).toBe(CHAT_CAP);
  });

  test("any other runtime comes back only when its provider re-adopts, whatever the stream promised", () => {
    const codex = {};
    const claudeCode = { reattach: () => {} };
    // A Codex chat "survives" only in the sense that the boot resumes it.
    expect(turnSurvivesRestart({ providerReattaches: providerSurvivesRestart(codex), boardCard: false })).toBe(true);
    const codexBack = turnComesBack({ bridgeOn: true, brokerKeeps: providerSurvivesRestart(codex), nativeTurn: false, nativeDetached: false });
    expect(codexBack).toBe(false);
    expect(chatGraceMs({ unrecoverable: 0, everyTurnComesBack: codexBack, capMs: CHAT_CAP })).toBe(CHAT_CAP);
    expect(turnComesBack({ bridgeOn: true, brokerKeeps: providerSurvivesRestart(claudeCode), nativeTurn: false, nativeDetached: false })).toBe(true);
  });

  test("with the broker off nothing comes back, and a lost holder always keeps the minute", () => {
    expect(turnComesBack({ bridgeOn: false, brokerKeeps: true, nativeTurn: true, nativeDetached: true })).toBe(false);
    expect(chatGraceMs({ unrecoverable: 1, everyTurnComesBack: true, capMs: CHAT_CAP })).toBe(CHAT_CAP);
  });
});

/**
 * A land restarts at zero turns (RGATE-09). With the broker on, a chat whose
 * turn runs in the server (native fallen back, Codex) must still defer it:
 * the gate counted every working chat as coming back because the broker was on.
 */
describe("unrecoverableHolders: a land defers for a chat a restart would cut", () => {
  const verdict = (lostWorkingChats: number, now: number) => quiescenceVerdict({
    busy: "1 chat", now, startedAt: 0, chatCapMs: 60_000,
    unrecoverable: unrecoverableHolders({ cards: 0, unadoptable: 0, workingChats: 1, lostWorkingChats, zeroTurns: true }),
  });

  test("an in-process chat defers the land for ever; a detached one lets it go", () => {
    for (const now of [0, 61_000, 3_600_000]) expect(verdict(1, now)).toBe("rinvia");
    expect(verdict(0, 0)).not.toBe("rinvia");
  });
});
