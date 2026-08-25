/**
 * @covers CHAT-DEF-04
 *
 * Partial: the composer controls are sensible and wired. The rendering half
 * lives in the Chat component specs.
 */
import { describe, expect, test } from "bun:test";
import { decideComposerAction } from "./composerAction";

describe("decideComposerAction", () => {
  describe("idle (busy=false)", () => {
    test("empty composer is disabled — there is nothing to do", () => {
      expect(decideComposerAction({ busy: false, hasContent: false })).toEqual({
        kind: "disabled",
      });
    });

    test("composer with content sends — the canonical happy path", () => {
      expect(decideComposerAction({ busy: false, hasContent: true })).toEqual({
        kind: "send",
      });
    });
  });

  describe("busy (streaming / loading / thinking / waiting-for-tool-input)", () => {
    test("empty composer offers Stop — agent owns the turn, user can abort", () => {
      expect(decideComposerAction({ busy: true, hasContent: false })).toEqual({
        kind: "stop",
      });
    });

    test("composer with content queues — preserves typed text for after the stream", () => {
      // Critical UX invariant: typing while streaming must NOT lose the text.
      // The queue path persists it and auto-sends on stream:end.
      expect(decideComposerAction({ busy: true, hasContent: true })).toEqual({
        kind: "queue",
      });
    });
  });

  describe("domanda a schermo", () => {
    test("con testo scritto il bottone RISPONDE, non accoda", () => {
      // Il caso che ha morso: accodare mentre una domanda aspetta significa
      // aspettare la fine di un turno che finisce solo rispondendo. Il testo
      // deve andare alla domanda.
      expect(decideComposerAction({ busy: true, hasContent: true, awaitingAnswer: true })).toEqual({
        kind: "answer",
      });
    });

    test("a campo vuoto resta «ferma»: non c'è niente da rispondere", () => {
      expect(decideComposerAction({ busy: true, hasContent: false, awaitingAnswer: true })).toEqual({
        kind: "stop",
      });
    });

    test("domanda che il testo NON può rispondere ⇒ si torna alla coda", () => {
      // `awaitingAnswer` è già filtrato da `canAnswerWithText`: domande
      // multiple ed elicitation arrivano qui come false.
      expect(decideComposerAction({ busy: true, hasContent: true, awaitingAnswer: false })).toEqual({
        kind: "queue",
      });
    });
  });

  test("decision is pure: same input → same output (no hidden state)", () => {
    const probe = { busy: true, hasContent: false };
    const first = decideComposerAction(probe);
    const second = decideComposerAction(probe);
    expect(first).toEqual(second);
  });
});
