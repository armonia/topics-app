/**
 * @covers RETIRE-04
 */
import { describe, expect, test } from "bun:test";
import { isPreviewRetirementNote, isSupersededPreviewNote } from "./preview-retirement";

// Il testo VERO scritto dalla bonifica su 23 card (scripts/check-preview-evidence.ts).
const BONIFICA =
  "⚠️ Anteprima RITIRATA: era byte per byte identica a quella di altre 12 card " +
  "(md5 `e2fefb66`), cioè non era evidenza di questo lavoro. " +
  "La consegna resta in review: allega tu l'anteprima giusta con `update_task(preview_image=…)`.";

// Il testo VERO del cancello sul contenuto (server/services/preview-manager.ts).
const CANCELLO =
  "⚠️ Nessuna anteprima allegata: http://localhost:3400/ ha risposto 503. " +
  "Un'evidenza falsa è peggio di nessuna evidenza.";

describe("isPreviewRetirementNote", () => {
  test("riconosce le due note che affermano «non c'è anteprima»", () => {
    expect(isPreviewRetirementNote({ content: BONIFICA, kind: "review-note" })).toBe(true);
    expect(isPreviewRetirementNote({ content: CANCELLO, kind: "review-note" })).toBe(true);
  });

  test("`output_url rimosso` NON è una nota di ritiro: parla dell'anteprima VIVA", () => {
    const note =
      "⚠️ output_url rimosso: su http://localhost:3400/ risponde un processo che non è " +
      "l'anteprima di questo task. Nessuna anteprima viva disponibile per questo worktree.";
    // Il server sulla porta può restare morto anche con l'immagine allegata:
    // nasconderla sarebbe nascondere un fatto ancora vero.
    expect(isPreviewRetirementNote({ content: note, kind: "review-note" })).toBe(false);
  });

  test("un commento umano che CITA la nota non è la nota", () => {
    const human = "Perché dice «⚠️ Anteprima RITIRATA» se l'ho appena allegata?";
    expect(isPreviewRetirementNote({ content: human, kind: "comment" })).toBe(false);
    // Nemmeno senza kind: il marcatore deve aprire il messaggio, non starci dentro.
    expect(isPreviewRetirementNote({ content: human })).toBe(false);
  });

  test("l'anteprima viva riuscita non è un ritiro", () => {
    expect(isPreviewRetirementNote({ content: "Anteprima viva pronta: http://localhost:3400/", kind: "review-note" })).toBe(false);
  });
});

describe("isSupersededPreviewNote", () => {
  test("con un'anteprima sulla card la nota è falsa e si nasconde", () => {
    expect(isSupersededPreviewNote({ content: BONIFICA, kind: "review-note" }, { previewImage: "/tmp/a.png" })).toBe(true);
  });

  test("senza anteprima la nota vale ancora e RESTA visibile", () => {
    expect(isSupersededPreviewNote({ content: BONIFICA, kind: "review-note" }, { previewImage: null })).toBe(false);
    expect(isSupersededPreviewNote({ content: BONIFICA, kind: "review-note" }, { previewImage: "  " })).toBe(false);
    expect(isSupersededPreviewNote({ content: BONIFICA, kind: "review-note" }, {})).toBe(false);
  });

  test("un'anteprima non rende superato un commento qualsiasi", () => {
    expect(isSupersededPreviewNote({ content: "Fatto, verde su main.", kind: "comment" }, { previewImage: "/tmp/a.png" })).toBe(false);
  });
});
