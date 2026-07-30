import { describe, expect, test } from "bun:test";
import { isEmptyAssistantTurn } from "./empty-turn";

describe("isEmptyAssistantTurn", () => {
  test("il segnaposto appena creato è vuoto", () => {
    // Esattamente la riga che `createPartialMessage` scrive all'inizio di uno
    // stream: è questa che restava in chat quando si premeva stop subito.
    expect(isEmptyAssistantTurn({ role: "assistant", content: "", thinking: null, toolCalls: null, blocks: null, media: null })).toBe(true);
  });

  test("lo spazio bianco non è contenuto", () => {
    expect(isEmptyAssistantTurn({ content: "   \n\t " })).toBe(true);
  });

  test("mezza frase è lavoro: si tiene", () => {
    expect(isEmptyAssistantTurn({ content: "Sto guard" })).toBe(false);
  });

  test("solo ragionamento, nessun testo: si tiene", () => {
    // Fermare durante il thinking lascia comunque qualcosa da leggere.
    expect(isEmptyAssistantTurn({ content: "", thinking: "L'utente vuole…" })).toBe(false);
  });

  test("una tool call fatta è roba fatta, anche senza testo", () => {
    expect(isEmptyAssistantTurn({ content: "", toolCalls: [{ id: "t1", name: "Read" }] })).toBe(false);
    // …e dalla riga del DB arriva come stringa JSON, non come array.
    expect(isEmptyAssistantTurn({ content: "", toolCalls: '[{"id":"t1"}]' })).toBe(false);
  });

  test("array serializzati vuoti valgono quanto null", () => {
    // `[]` finiva in colonna quando un turno partiva e non arrivava niente:
    // trattarlo come "pieno" avrebbe reso il fix inefficace proprio nel caso
    // che deve coprire.
    expect(isEmptyAssistantTurn({ content: "", toolCalls: "[]", blocks: "[]", media: "[]" })).toBe(true);
    expect(isEmptyAssistantTurn({ content: "", toolCalls: "null" })).toBe(true);
  });

  test("blocchi presenti: si tiene", () => {
    expect(isEmptyAssistantTurn({ content: "", blocks: [{ kind: "text", text: "ciao" }] })).toBe(false);
  });

  test("media presenti: si tiene", () => {
    expect(isEmptyAssistantTurn({ content: "", media: ["/tmp/a.png"] })).toBe(false);
  });

  test("una colonna illeggibile NON viene scambiata per vuota", () => {
    // Se il JSON è corrotto non si sa cosa c'è dentro: davanti al dubbio si
    // tiene la riga. Cancellare è irreversibile, mostrare una bolla in più no.
    expect(isEmptyAssistantTurn({ content: "", toolCalls: "{rotto" })).toBe(false);
  });

  test("un messaggio dell'utente non è affare di questa regola", () => {
    expect(isEmptyAssistantTurn({ role: "user", content: "" })).toBe(false);
  });
});
