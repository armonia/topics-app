/**
 * The proofs of `interrupted-turn-block.ts`.
 *
 * Three questions, and the second one is what the 2026-09-03 report paid for:
 * the block carries the CAUSE as a code (not just the sentence), it does not
 * pile up when somebody already explained, and it does not copy the warning
 * sign inside a block the bubble already frames on its own.
 *
 * @covers CHAT-INT-01
 */
import { describe, expect, test } from "bun:test";
import { interruptedTurnBlock, timelineWithInterruptedVerdict } from "./interrupted-turn-block";
import type { ContentBlock } from "../types";

const AT = "2026-09-03T22:25:00.000Z";
const textBlock = (t = "ci stavo lavorando"): ContentBlock => ({ kind: "text", text: t });

describe("interruptedTurnBlock", () => {
  test("la causa viaggia in codice, accanto al testo e all'istante", () => {
    expect(interruptedTurnBlock([textBlock()], { text: "Response timed out.", cause: "watchdog", at: AT }))
      .toEqual({ kind: "error", text: "Response timed out.", cause: "watchdog", at: AT });
  });

  test("un turno senza blocchi lo prende lo stesso", () => {
    // The turn that died before writing a word: `blocks` is empty and the
    // verdict is all that row will ever have.
    expect(interruptedTurnBlock([], { text: "morto", cause: "process-died", at: AT }))
      .toEqual({ kind: "error", text: "morto", cause: "process-died", at: AT });
    expect(interruptedTurnBlock(undefined, { text: "morto", cause: "process-died", at: AT }))
      .not.toBeNull();
  });

  test("chi ha già spiegato tiene la sua spiegazione", () => {
    const già: ContentBlock[] = [textBlock(), { kind: "error", text: "l'ha fermato la persona", cause: "user" }];
    expect(interruptedTurnBlock(già, { text: "Response timed out.", cause: "watchdog", at: AT })).toBeNull();
  });

  test("il ⚠️ resta al formato vecchio: dentro il blocco è rumore", () => {
    const b = interruptedTurnBlock([textBlock()], { text: "⚠️ Response timed out.", cause: "watchdog", at: AT });
    expect(b).toEqual({ kind: "error", text: "Response timed out.", cause: "watchdog", at: AT });
  });
});

describe("timelineWithInterruptedVerdict - the reaper's half", () => {
  test("a turn cut mid answer gets the verdict at the end of its timeline", () => {
    const timeline = timelineWithInterruptedVerdict([textBlock("stavo scrivendo")], {
      text: "⚠️ Risposta interrotta: nessuna attività per 3 minuti.",
      cause: "watchdog",
      at: AT,
    });
    expect(timeline).toEqual([
      textBlock("stavo scrivendo"),
      { kind: "error", text: "Risposta interrotta: nessuna attività per 3 minuti.", cause: "watchdog", at: AT },
    ]);
  });

  test("AN EMPTY TIMELINE IS NOT TOUCHED: writing the first block would hide the prose", () => {
    // Such a row renders from `content`, and the renderer prints `content` only
    // while `blocks` is absent. The caller covers this case with the marker.
    expect(timelineWithInterruptedVerdict([], { text: "x", cause: "watchdog", at: AT })).toBeNull();
    expect(timelineWithInterruptedVerdict(null, { text: "x", cause: "watchdog", at: AT })).toBeNull();
    expect(timelineWithInterruptedVerdict(undefined, { text: "x", cause: "watchdog", at: AT })).toBeNull();
  });

  test("already explained: the sweep can run twice without stacking verdicts", () => {
    const già: ContentBlock[] = [textBlock(), { kind: "error", text: "spiegato prima", cause: "watchdog", at: AT }];
    expect(timelineWithInterruptedVerdict(già, { text: "x", cause: "watchdog", at: AT })).toBeNull();
  });

  test("the source array is not mutated: the caller decides whether to write", () => {
    const blocks = [textBlock("intatto")];
    timelineWithInterruptedVerdict(blocks, { text: "x", cause: "watchdog", at: AT });
    expect(blocks).toHaveLength(1);
  });
});
