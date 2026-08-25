/**
 * @covers DELTA-01
 */
import { describe, expect, test } from "bun:test";
import { normalizeAlternating } from "./normalize-history";

describe("normalizeAlternating", () => {
  test("due utenti di fila (l'assistente in mezzo è stato scartato) diventano un turno solo", () => {
    // Esattamente quello che lasciava una bolla vuota tolta dalla history:
    // domanda, [turno vuoto scartato], domanda successiva.
    expect(normalizeAlternating([
      { role: "user", content: "che ore sono?" },
      { role: "user", content: "e poi?" },
    ])).toEqual([{ role: "user", content: "che ore sono?\n\ne poi?" }]);
  });

  test("una conversazione già alternata non viene toccata", () => {
    const turni = [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
      { role: "user" as const, content: "c" },
    ];
    expect(normalizeAlternating(turni)).toEqual(turni);
  });

  test("l'assistente in testa se ne va: senza la domanda che l'ha prodotto l'API rifiuta", () => {
    expect(normalizeAlternating([
      { role: "assistant", content: "risposta orfana" },
      { role: "user", content: "domanda" },
    ])).toEqual([{ role: "user", content: "domanda" }]);
  });

  test("i turni vuoti spariscono invece di rompere il conto", () => {
    expect(normalizeAlternating([
      { role: "user", content: "domanda" },
      { role: "assistant", content: "   " },
      { role: "user", content: "e poi?" },
    ])).toEqual([{ role: "user", content: "domanda\n\ne poi?" }]);
  });

  test("tre assistenti di fila si fondono in uno", () => {
    expect(normalizeAlternating([
      { role: "user", content: "domanda" },
      { role: "assistant", content: "uno" },
      { role: "assistant", content: "due" },
      { role: "assistant", content: "tre" },
    ])).toEqual([
      { role: "user", content: "domanda" },
      { role: "assistant", content: "uno\n\ndue\n\ntre" },
    ]);
  });

  test("il messaggio nuovo in coda si fonde col turno utente che lo precede", () => {
    // Il percorso vero: history + `{ role: "user", content: message }` in fondo.
    expect(normalizeAlternating([
      { role: "user", content: "prima domanda" },
      { role: "assistant", content: "risposta" },
      { role: "user", content: "domanda rimasta senza risposta" },
      { role: "user", content: "messaggio nuovo" },
    ])).toEqual([
      { role: "user", content: "prima domanda" },
      { role: "assistant", content: "risposta" },
      { role: "user", content: "domanda rimasta senza risposta\n\nmessaggio nuovo" },
    ]);
  });

  test("una sequenza vuota resta vuota", () => {
    expect(normalizeAlternating([])).toEqual([]);
  });
});
