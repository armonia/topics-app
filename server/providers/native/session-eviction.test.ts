/**
 * LE SESSIONI NATIVE NON SI ACCUMULANO PER SEMPRE.
 *
 * ── Il guasto (19/08/2026) ─────────────────────────────────────────────────
 * La `Map` delle sessioni del runtime nativo non veniva svuotata da nessuno:
 * solo `resetSession` (esplicita) e `stop()` (spegnimento) toglievano qualcosa.
 * Ogni topic che aveva avuto un turno teneva la sua conversazione INTERA nel
 * processo del server finché il server non ripartiva — e su questa macchina
 * nascono ~127 topic al giorno sul runtime nativo.
 *
 * La prova è il codice, non una lettura di RSS: su dieci minuti il processo
 * oscilla fra 284 MB e 2 GB seguendo il carico, quindi nessun campione di RSS
 * dimostra un trattenimento. Quello che dimostra è che non esisteva NESSUNA
 * strada per togliere una sessione ferma — la crescita è senza fondo per
 * costruzione.
 *
 * ── Perché sfrattare è sicuro, e non un compromesso ────────────────────────
 * `sessionFor` ricostruisce la storia dal DB quando la sessione manca — è la
 * stessa strada del riavvio del server, percorsa decine di volte al giorno. Il
 * modello arriva con ogni turno, la radice si ri-deriva. L'unica cosa che NON
 * si può ricostruire è un turno in volo, ed è esattamente la cosa che la regola
 * protegge.
  * @covers RT-08
 */
import { describe, expect, test } from "bun:test";
import { sessionIsEvictable } from "./provider";

const TTL = 15 * 60_000;
const ORA = 1_000_000_000_000; // un istante fisso: niente Date.now() nei casi

describe("sfratto delle sessioni native ferme", () => {
  test("ferma da più del tetto: si sfratta", () => {
    expect(sessionIsEvictable({ lastUsedAt: ORA - TTL - 1 }, ORA, TTL)).toBe(true);
  });

  test("usata di recente: resta", () => {
    expect(sessionIsEvictable({ lastUsedAt: ORA - 1_000 }, ORA, TTL)).toBe(false);
  });

  test("ESATTAMENTE al tetto: resta (il confine è stretto, non largo)", () => {
    // Un `>=` qui sfratterebbe una sessione al millisecondo del tetto. Non è
    // un dramma, ma il confine va deciso e misurato invece di scoperto.
    expect(sessionIsEvictable({ lastUsedAt: ORA - TTL }, ORA, TTL)).toBe(false);
  });

  test("UN TURNO VIVO NON SI TOCCA MAI, per quanto vecchia sia la sessione", () => {
    // È la guardia che conta: un turno lungo (un agente che lavora un'ora) ha
    // `lastUsedAt` fermo all'inizio del turno, quindi senza questa condizione
    // verrebbe sfrattato PROPRIO mentre lavora — e la sua storia in volo, quella
    // sì, non è ricostruibile dal DB.
    expect(sessionIsEvictable({ abort: {}, lastUsedAt: ORA - TTL * 100 }, ORA, TTL)).toBe(false);
  });

  test("IL PREDICATO MORDE: senza la guardia sull'abort il caso sopra passerebbe", () => {
    // Prova che il quarto caso non è verde per caso (cioè perché la sessione è
    // recente): senza `abort` la stessa età viene sfrattata.
    expect(sessionIsEvictable({ lastUsedAt: ORA - TTL * 100 }, ORA, TTL)).toBe(true);
  });
});
