/**
 * Per-turn restart gate for native turns (lossless-restart). Kept apart from
 * quiescence.test.ts, which is at its size limit.
 *
 * @covers RGATE-01, RESUME-06
 */
import { test, expect, describe } from "bun:test";
import { chatGraceMs, turnComesBack } from "./quiescence";

/**
 * The gate decides per TURN whether a native turn comes back: the stream's flag
 * is set before the runtime knows whether the broker spawned its process or the
 * turn fell back into the server (lossless-restart review, finding 3).
 */
describe("turnComesBack / chatGraceMs: a native turn comes back only when it runs detached", () => {
  const CHAT_CAP = 60_000;

  test("native detached: comes back, so a card does not hold and a chat gets no grace", () => {
    const back = turnComesBack({ bridgeOn: true, streamSurvives: true, nativeTurn: true, nativeDetached: true });
    expect(back).toBe(true);
    expect(chatGraceMs({ unrecoverable: 0, everyTurnComesBack: back, capMs: CHAT_CAP })).toBe(0);
  });

  test("native in-process fallback: holds even though its stream promised to survive, and the chat keeps its minute", () => {
    const back = turnComesBack({ bridgeOn: true, streamSurvives: true, nativeTurn: true, nativeDetached: false });
    expect(back).toBe(false);
    expect(chatGraceMs({ unrecoverable: 0, everyTurnComesBack: back, capMs: CHAT_CAP })).toBe(CHAT_CAP);
  });

  test("claude-code keeps reading the stream's flag", () => {
    expect(turnComesBack({ bridgeOn: true, streamSurvives: true, nativeTurn: false, nativeDetached: false })).toBe(true);
    expect(turnComesBack({ bridgeOn: true, streamSurvives: false, nativeTurn: false, nativeDetached: false })).toBe(false);
  });

  test("with the broker off nothing comes back, and a lost holder always keeps the minute", () => {
    expect(turnComesBack({ bridgeOn: false, streamSurvives: true, nativeTurn: true, nativeDetached: true })).toBe(false);
    expect(chatGraceMs({ unrecoverable: 1, everyTurnComesBack: true, capMs: CHAT_CAP })).toBe(CHAT_CAP);
  });
});
