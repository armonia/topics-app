/**
 * @covers WIRE-01
 */
import { describe, test, expect } from "bun:test";
import { createLineFolder } from "./ndjson-lines";

describe("createLineFolder", () => {
  test("taglia sui newline e tiene la coda incompleta per il chunk dopo", () => {
    const righe: string[] = [];
    const fold = createLineFolder((l) => righe.push(l));
    fold(Buffer.from("uno\ndu"));
    expect(righe).toEqual(["uno"]);
    fold(Buffer.from("e\ntre\n"));
    expect(righe).toEqual(["uno", "due", "tre"]);
  });

  test("una riga senza newline finale NON viene emessa (non è ancora una riga)", () => {
    const righe: string[] = [];
    const fold = createLineFolder((l) => righe.push(l));
    fold(Buffer.from("mezza"));
    expect(righe).toEqual([]);
  });

  test("righe vuote comprese: due newline di fila danno una riga vuota", () => {
    const righe: string[] = [];
    const fold = createLineFolder((l) => righe.push(l));
    fold(Buffer.from("a\n\nb\n"));
    expect(righe).toEqual(["a", "", "b"]);
  });

  // Regressione: il replay ora arriva A FETTE, e una fetta cade su un confine
  // di byte qualsiasi. Con `chunk.toString()` una `à` spezzata a metà diventa
  // due U+FFFD, il JSON della riga non parsa più e la riga si perde nel catch
  // del chiamante — muta, senza un errore da nessuna parte.
  test("un carattere multibyte spezzato fra due chunk arriva intero", () => {
    const righe: string[] = [];
    const fold = createLineFolder((l) => righe.push(l));
    const buf = Buffer.from('{"t":"perché ✅"}\n', "utf8");
    // Taglio dentro la sequenza UTF-8 della `é` (2 byte) — cercata, non a caso.
    const taglio = buf.indexOf(Buffer.from("é", "utf8")) + 1;
    fold(buf.subarray(0, taglio));
    fold(buf.subarray(taglio));
    expect(righe).toEqual(['{"t":"perché ✅"}']);
  });

  test("byte per byte: il risultato è identico a un chunk unico", () => {
    const testo = '{"a":1}\n{"b":"àèìòù"}\n{"c":[1,2,3]}\n';
    const buf = Buffer.from(testo, "utf8");
    const righe: string[] = [];
    const fold = createLineFolder((l) => righe.push(l));
    for (const b of buf) fold(Buffer.from([b]));
    expect(righe).toEqual(testo.split("\n").slice(0, -1));
  });

  // Il motivo per cui questo modulo esiste. Il vecchio taglia-righe faceva
  // `lineBuf = lineBuf.slice(nl + 1)` a OGNI riga: su un replay da megabyte è
  // lavoro quadratico dentro un solo giro di event loop. Qui la soglia è larga
  // (un secondo per 8 MB) apposta: non misura la macchina, esclude il ritorno
  // del quadratico, che a queste taglie costa ordini di grandezza in più.
  test("8 MB in un chunk solo restano lineari (nessun ritorno del quadratico)", () => {
    const riga = JSON.stringify({ type: "stream_event", text: "x".repeat(400) }) + "\n";
    const chunk = Buffer.from(riga.repeat(Math.ceil((8 * 1024 * 1024) / riga.length)), "utf8");
    let n = 0;
    const fold = createLineFolder(() => { n++; });
    const t0 = Date.now();
    fold(chunk);
    const dt = Date.now() - t0;
    expect(n).toBeGreaterThan(15_000);
    expect(dt).toBeLessThan(1_000);
  });
});
