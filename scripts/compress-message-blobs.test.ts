/**
 * LA COMPRESSIONE NON DEVE POTER PERDERE UN MESSAGGIO.
 *
 * `scripts/compress-message-blobs.ts` riscrive `blocks` e `tool_calls` di
 * migliaia di righe: è la tabella che contiene le conversazioni, e un difetto
 * qui non si vede subito e non si torna indietro. Perciò lo script rilegge ogni
 * colonna PRIMA di sostituirla, e questo file prova che quella regola tiene
 * anche sui casi che un giro felice non incontra mai.
 *
 * LA MISURA VERA, per cui esiste tutto questo, sta nel commento dello script:
 * sul DB di produzione, **775 MB in chiaro → 152 MB (5,11x)**, e dopo `VACUUM`
 * il file passa da **848 MB a 213**. Verificato riga per riga su uno snapshot
 * COERENTE (`.backup`, non `cp`): 18.877 righe, tre colonne ciascuna, **zero
 * differenze**.
 *
 * Il primo tentativo, fatto con `cp` a server vivo, dava DUE differenze — ed
 * erano vere: una riga che il server stava riscrivendo mentre la copia era in
 * corso. Un `cp` di un SQLite in uso non è uno snapshot, e chiamarlo tale
 * avrebbe fatto passare quel rumore per una perdita di dati (o, peggio, una
 * perdita vera per rumore).
  * @covers COMPRESS-01
 */
import { describe, it, expect } from "bun:test";
import { encodeCol, decodeCol } from "../shared/message-blob";

/** La stessa soglia dello script: sotto, `encodeCol` restituisce la stringa. */
const SOGLIA = 512;

/** Il giro completo che lo script fa su ogni colonna. */
function completeRound(s: string): { compresso: boolean; identico: boolean } {
  const out = encodeCol(s);
  if (typeof out === "string" || out == null) return { compresso: false, identico: out === s };
  return { compresso: true, identico: decodeCol(out) === s };
}

describe("compressione dei blob dei messaggi", () => {
  it("un blocco JSON tipico torna identico, e pesa molto meno", () => {
    const tipico = JSON.stringify(
      Array.from({ length: 40 }, (_, i) => ({
        kind: "tool",
        toolCall: { id: `t${i}`, name: "Bash", status: "success", output: "riga di output ".repeat(30) },
      })),
    );
    const r = completeRound(tipico);
    expect(r.compresso).toBe(true);
    expect(r.identico).toBe(true);
    expect((encodeCol(tipico) as Uint8Array).length).toBeLessThan(tipico.length / 3);
  });

  it("l'UTF-8 multibyte sopravvive: accenti, emoji, CJK", () => {
    // Il codec passa da `Buffer.from(s, "utf8")` e torna con `.toString("utf8")`.
    // Se un giorno qualcuno ci mettesse in mezzo una codifica a byte singolo,
    // questo è il test che lo direbbe — e i messaggi sono pieni di italiano.
    const testo = "però èàùìò 🎉🚀 日本語のテキスト ".repeat(60);
    expect(completeRound(testo)).toEqual({ compresso: true, identico: true });
  });

  it("una stringa SOTTO soglia non viene toccata e resta sé stessa", () => {
    const corta = "x".repeat(SOGLIA - 1);
    const r = completeRound(corta);
    expect(r.compresso).toBe(false);
    expect(r.identico).toBe(true);
  });

  it("il confine della soglia non perde niente in nessuno dei due versi", () => {
    for (const n of [SOGLIA - 1, SOGLIA, SOGLIA + 1]) {
      const s = "a".repeat(n);
      expect(completeRound(s).identico).toBe(true);
    }
  });

  it("`decodeCol` è l'identità su una stringa già in chiaro", () => {
    // È ciò che rende lo script eseguibile DUE volte senza danni: una riga già
    // compressa esce dalla `SELECT` (che filtra `typeof = 'text'`), e una in
    // chiaro letta da un vecchio lettore continua a leggersi.
    expect(decodeCol("testo in chiaro")).toBe("testo in chiaro");
    expect(decodeCol(null)).toBeNull();
    expect(decodeCol(undefined)).toBeNull();
  });

  it("dati NON comprimibili non vengono corrotti, anche se non guadagnano niente", () => {
    // Base64 di roba casuale: zstd non ha niente da togliere e può persino
    // crescere. L'invariante che conta non è il risparmio, è il ritorno.
    const casuale = Buffer.from(crypto.getRandomValues(new Uint8Array(4096))).toString("base64");
    expect(completeRound(casuale).identico).toBe(true);
  });
});
