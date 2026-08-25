/**
 * La prova che serve non è «il testo semplice passa» — quella la supererebbe
 * anche `buffer` grezzo. È il RIDISEGNO IN PLACE: cursore che torna indietro,
 * riga cancellata e riscritta. È lì che il buffer grezzo mente e lo schermo no.
 *
 * @covers TERM-06
 */
import { describe, test, expect } from "bun:test";
import { renderScreen, screenToText, trimTrailingBlank } from "./terminal-screen";

const ESC = "\x1b";
const CSI = `${ESC}[`;

describe("renderScreen", () => {
  test("testo semplice: le righe arrivano in ordine", async () => {
    const s = await renderScreen("uno\r\ndue\r\ntre\r\n", { cols: 40, rows: 10 });
    expect(s.lines).toEqual(["uno", "due", "tre"]);
  });

  test("RIDISEGNO IN PLACE: si vede l'ultima versione, non tutte", async () => {
    // Un menu che sposta la selezione: scrive due righe, torna su, e le
    // riscrive con la freccia spostata. Il buffer GREZZO conterrebbe entrambe
    // le versioni e non direbbe quale è quella buona.
    const stream =
      "> Alpha\r\n  Beta\r\n" +
      `${CSI}2A` +        // cursore su di 2
      `${CSI}2K` + "\r" + "  Alpha\r\n" +
      `${CSI}2K` + "\r" + "> Beta\r\n";
    const s = await renderScreen(stream, { cols: 40, rows: 10 });
    expect(s.lines).toEqual(["  Alpha", "> Beta"]);
    // E la prova che il grezzo non basta: contiene ANCORA la vecchia selezione.
    expect(stream).toContain("> Alpha");
    expect(screenToText(s)).not.toContain("> Alpha");
  });

  test("cancellazione dello schermo: ciò che c'era prima sparisce", async () => {
    const s = await renderScreen(`prima${CSI}2J${CSI}H` + "dopo", { cols: 40, rows: 6 });
    expect(screenToText(s)).toContain("dopo");
    expect(screenToText(s)).not.toContain("prima");
  });

  test("il cursore dice dove sta il programma", async () => {
    // CUP: riga 3, colonna 5 (1-based nella sequenza, 0-based nel risultato).
    const s = await renderScreen(`${CSI}3;5H`, { cols: 40, rows: 10 });
    expect(s.cursor).toEqual({ row: 2, col: 4 });
  });

  test("le righe vuote in CODA si tagliano, quelle in MEZZO no", async () => {
    const s = await renderScreen("a\r\n\r\nb\r\n", { cols: 20, rows: 12 });
    expect(s.lines).toEqual(["a", "", "b"]);
  });

  test("trimTrailingBlank: false restituisce lo schermo intero", async () => {
    const s = await renderScreen("a\r\n", { cols: 20, rows: 5, trimTrailingBlank: false });
    expect(s.lines).toHaveLength(5);
  });

  test("la larghezza conta: rigiocare stretti manda a capo dove il programma non l'aveva fatto", async () => {
    const testo = "x".repeat(30);
    const largo = await renderScreen(testo, { cols: 40, rows: 5 });
    const stretto = await renderScreen(testo, { cols: 10, rows: 5 });
    expect(largo.lines).toHaveLength(1);
    expect(stretto.lines.length).toBeGreaterThan(1);
  });

  test("flusso vuoto: schermo vuoto, non un errore", async () => {
    const s = await renderScreen("", { cols: 20, rows: 5 });
    expect(s.lines).toEqual([]);
    expect(s.cursor).toEqual({ row: 0, col: 0 });
  });

  test("dimensioni assurde ricadono sui default invece di rompersi", async () => {
    const s = await renderScreen("ciao", { cols: 0, rows: -3 });
    expect(s.cols).toBeGreaterThan(0);
    expect(s.rows).toBeGreaterThan(0);
    expect(s.lines).toEqual(["ciao"]);
  });
});

describe("trimTrailingBlank", () => {
  test("toglie solo la coda", () => {
    expect(trimTrailingBlank(["a", "", "b", "", "  ", ""])).toEqual(["a", "", "b"]);
  });
  test("tutto vuoto → niente", () => {
    expect(trimTrailingBlank(["", "  ", ""])).toEqual([]);
  });
});
