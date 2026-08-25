/**
 * A running script's output buffer: the line folding, the size cap that keeps
 * it circular, and the offset cursor a client reads from.
 *
 * @covers PROCESS-01
 */
import { test, expect } from "bun:test";
import { emptyLogBuffer, appendToLogBuffer, flushLogBuffer, sliceFromCursor } from "./log-cursor";

const BIG = 1_000_000;

test("due chunk consecutivi NON producono una riga vuota in mezzo", () => {
  const b = emptyLogBuffer();
  appendToLogBuffer(b, "hello\n", BIG);
  appendToLogBuffer(b, "world\n", BIG);
  // Il vecchio split lasciava `["hello",""]` e usciva `hello\n\nworld`: è il
  // log a interlinea doppia che si vedeva aprendo qualsiasi processo.
  expect(b.output).toEqual(["hello", "world"]);
  expect(sliceFromCursor(b, 0).output).toBe("hello\nworld");
});

test("una riga tagliata a metà da due chunk resta UNA riga", () => {
  const b = emptyLogBuffer();
  appendToLogBuffer(b, "com", BIG);
  appendToLogBuffer(b, "pilato in 2s\n", BIG);
  expect(b.output).toEqual(["compilato in 2s"]);
});

test("l'ultima riga senza newline si mostra ma non si accumula", () => {
  const b = emptyLogBuffer();
  appendToLogBuffer(b, "fatto\nin corso…", BIG);
  expect(b.output).toEqual(["fatto"]);
  const s = sliceFromCursor(b, 0);
  expect(s.pending).toBe("in corso…");
  // Il cursore NON la conta: quando arriverà completa la si vedrà una volta sola.
  expect(s.offset).toBe(1);
});

test("un blocco intero (BashOutput) non trattiene l'ultima riga", () => {
  const b = emptyLogBuffer();
  appendToLogBuffer(b, "riga importante", BIG, true);
  expect(b.output).toEqual(["riga importante"]);
  expect(b.pendingLine).toBe("");
});

test("dopo un'eviction il cursore assoluto NON perde righe", () => {
  // Buffer minuscolo per forzare la potatura.
  const b = emptyLogBuffer();
  for (let i = 0; i < 5; i++) appendToLogBuffer(b, `riga-${i}\n`, 20);
  expect(b.droppedLines).toBeGreaterThan(0);

  // Un client fermo a 0: col vecchio indice avrebbe ricevuto `slice(0)` e
  // creduto di aver visto tutto. Ora sa quante gliene mancano.
  const s = sliceFromCursor(b, 0);
  expect(s.truncatedLines).toBe(b.droppedLines);
  expect(s.output.split("\n")).toEqual(b.output);
  expect(s.offset).toBe(b.droppedLines + b.output.length);
});

test("un client aggiornato non rivede due volte le stesse righe", () => {
  const b = emptyLogBuffer();
  appendToLogBuffer(b, "a\nb\n", BIG);
  const first = sliceFromCursor(b, 0);
  expect(first.output).toBe("a\nb");
  appendToLogBuffer(b, "c\n", BIG);
  const second = sliceFromCursor(b, first.offset);
  expect(second.output).toBe("c");
  expect(second.truncatedLines).toBe(0);
});

test("il cursore resta valido ATTRAVERSO un'eviction", () => {
  const b = emptyLogBuffer();
  appendToLogBuffer(b, "a\nb\n", BIG);
  const cur = sliceFromCursor(b, 0).offset;   // 2
  // Ora si riempie e si pota: gli indici dell'array scivolano.
  for (let i = 0; i < 6; i++) appendToLogBuffer(b, `lunga-riga-${i}\n`, 30);
  const s = sliceFromCursor(b, cur);
  // Le righe che il client aveva già visto non tornano.
  expect(s.output).not.toContain("a\nb");
  // E ciò che ha perso è dichiarato, non taciuto.
  expect(s.truncatedLines).toBe(Math.max(0, b.droppedLines - cur));
});

test("un cursore più avanti del buffer non produce righe negative", () => {
  const b = emptyLogBuffer();
  appendToLogBuffer(b, "a\n", BIG);
  const s = sliceFromCursor(b, 999);
  expect(s.output).toBe("");
  expect(s.truncatedLines).toBe(0);
});

test("la chiusura committa la riga in sospeso", () => {
  const b = emptyLogBuffer();
  appendToLogBuffer(b, "errore fatale", BIG);
  expect(b.output).toEqual([]);
  flushLogBuffer(b);
  expect(b.output).toEqual(["errore fatale"]);
  // Idempotente: chiuderla due volte non la duplica.
  flushLogBuffer(b);
  expect(b.output).toEqual(["errore fatale"]);
});

test("una riga sola più grande del tetto viene tenuta", () => {
  const b = emptyLogBuffer();
  appendToLogBuffer(b, "x".repeat(100) + "\n", 10);
  expect(b.output).toHaveLength(1);
});
