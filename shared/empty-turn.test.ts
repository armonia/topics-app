/**
 * @covers EMPTYTURN-01
 */
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

/**
 * LE FRASI CON CUI LA CLI DICE «NIENTE».
 *
 * `(no content)` e `No response requested.` non sono risposte: sono segnaposto
 * che Claude Code emette quando un turno si chiude senza avere nulla da dire —
 * stanno una accanto all'altra nel suo binario, e il suo stesso classificatore
 * di stato le legge come «finito», non come contenuto.
 *
 * Arrivano però nel canale del testo, quindi il predicato le prendeva per una
 * risposta vera. Su un turno chiesto da una persona passa inosservato; su un
 * turno RISVEGLIATO no — un Monitor che si chiude ne sveglia uno per dirlo, e
 * in chat restava una riga che l'utente non aveva chiesto (osservato sulla chat
 * 205d1fbb il 20/08).
 */
describe("isEmptyAssistantTurn — le sentinelle della CLI", () => {
  test("«No response requested.» non è una risposta", () => {
    expect(isEmptyAssistantTurn({ content: "No response requested." })).toBe(true);
  });

  test("«(no content)» nemmeno", () => {
    expect(isEmptyAssistantTurn({ content: "(no content)" })).toBe(true);
  });

  test("spazi attorno non cambiano la risposta", () => {
    expect(isEmptyAssistantTurn({ content: "  No response requested.  " })).toBe(true);
  });

  test("ma se quel turno ha prodotto LAVORO, resta", () => {
    // La sentinella dice «non ho altro da aggiungere», non «non ho fatto
    // niente»: un turno che ha girato tre tool e poi tace ha prodotto, e
    // cancellarlo sarebbe perdita di dati.
    expect(isEmptyAssistantTurn({
      content: "No response requested.",
      toolCalls: [{ id: "t1" }],
    })).toBe(false);
    expect(isEmptyAssistantTurn({
      content: "No response requested.",
      blocks: [{ kind: "tool" }],
    })).toBe(false);
  });

  test("PARLARE della sentinella non è emetterla", () => {
    // Il confronto è sul testo INTERO. Un modello che spiega «la CLI risponde
    // "No response requested." quando…» sta dicendo qualcosa di suo, e quella
    // riga non si tocca.
    expect(isEmptyAssistantTurn({
      content: 'La CLI risponde "No response requested." quando non ha altro da dire.',
    })).toBe(false);
  });
});
