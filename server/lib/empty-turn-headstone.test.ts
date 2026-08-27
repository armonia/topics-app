/**
 * A headstone is reused ONLY when it really is a headstone.
 *
 * The risk in this rule is not the false negative (one notice too many stays
 * on screen, exactly as today): it is the false POSITIVE, that is, reusing
 * somebody else's row and erasing their turn. Most cases below are a row that
 * must NOT be touched.
 *
 * @covers INTERRUPT-04
 */
import { describe, it, expect } from "bun:test";
import { isReusableHeadstone, HEADSTONE_PREFIX, HEADSTONE_WINDOW_MS, type RowToReuse } from "./empty-turn-headstone";

const ORA = Date.parse("2026-08-21T10:51:19.000Z");
const CARTELLO = `${HEADSTONE_PREFIX} il turno si è chiuso senza produrre niente. Il tuo messaggio è ancora qui: «Riprova» lo rimanda.`;

function lapide(over: Partial<RowToReuse> = {}): RowToReuse {
  return {
    role: "assistant",
    content: CARTELLO,
    toolCallsJson: null,
    blocksJson: JSON.stringify([{ kind: "error", text: "Nessuna risposta: il turno si è chiuso senza produrre niente." }]),
    timestamp: "2026-08-21T10:51:11.448Z",
    partial: false,
    ...over,
  };
}

describe("isReusableHeadstone", () => {
  it("la riga vera del guasto misurato si riusa", () => {
    expect(isReusableHeadstone(lapide(), ORA)).toBe(true);
  });

  it("senza riga non inventa niente", () => {
    expect(isReusableHeadstone(null, ORA)).toBe(false);
    expect(isReusableHeadstone(undefined, ORA)).toBe(false);
  });

  it("un messaggio dell'umano non si tocca", () => {
    expect(isReusableHeadstone(lapide({ role: "user" }), ORA)).toBe(false);
  });

  it("una riga ANCORA VIVA non e' una lapide", () => {
    expect(isReusableHeadstone(lapide({ partial: true }), ORA)).toBe(false);
  });

  it("una risposta vera non si tocca, per quanto corta", () => {
    expect(isReusableHeadstone(lapide({ content: "Fatto." }), ORA)).toBe(false);
  });

  // The two that really matter: a turn that produced SOMETHING is not empty,
  // even if for some other reason it ended up wearing the notice.
  it("con dei tool sotto non e' vuoto", () => {
    expect(isReusableHeadstone(lapide({ toolCallsJson: '[{"id":"t1","name":"Bash"}]' }), ORA)).toBe(false);
  });

  it("con altri blocchi oltre all'errore non e' vuoto", () => {
    const misti = JSON.stringify([{ kind: "text", text: "ci stavo lavorando" }, { kind: "error", text: "x" }]);
    expect(isReusableHeadstone(lapide({ blocksJson: misti }), ORA)).toBe(false);
  });

  it("senza blocchi va bene lo stesso: il cartello puo' essere solo nel testo", () => {
    expect(isReusableHeadstone(lapide({ blocksJson: null }), ORA)).toBe(true);
    expect(isReusableHeadstone(lapide({ blocksJson: "[]" }), ORA)).toBe(true);
  });

  it("un JSON rotto non si interpreta a favore: non si tocca", () => {
    expect(isReusableHeadstone(lapide({ blocksJson: "{non json" }), ORA)).toBe(false);
    expect(isReusableHeadstone(lapide({ toolCallsJson: "{non json" }), ORA)).toBe(false);
  });

  // The safety belt: a Monitor waking the session half an hour after a turn
  // that really did come back empty finds the notice where it was, and that
  // notice is true.
  it("fuori dalla finestra il cartello resta", () => {
    const vecchia = lapide({ timestamp: new Date(ORA - HEADSTONE_WINDOW_MS - 1000).toISOString() });
    expect(isReusableHeadstone(vecchia, ORA)).toBe(false);
  });

  it("dentro la finestra si riusa, al bordo compreso", () => {
    const atEdge = lapide({ timestamp: new Date(ORA - HEADSTONE_WINDOW_MS).toISOString() });
    expect(isReusableHeadstone(atEdge, ORA)).toBe(true);
  });

  it("una riga NATA DOPO l'ora chiesta non si riusa: l'orologio e' andato storto", () => {
    const futura = lapide({ timestamp: new Date(ORA + 5_000).toISOString() });
    expect(isReusableHeadstone(futura, ORA)).toBe(false);
  });

  it("una data illeggibile non passa", () => {
    expect(isReusableHeadstone(lapide({ timestamp: "boh" }), ORA)).toBe(false);
  });

  // The twin no gate can catch: the notice text lives in `routes/chat.ts`, and
  // this is the only copy chasing it.
  it("il prefisso e' quello che la route scrive davvero", () => {
    expect(CARTELLO.startsWith("⚠️ Nessuna risposta:")).toBe(true);
  });
});
