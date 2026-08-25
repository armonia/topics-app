/**
 * @covers USAGE-TMP-01
 *
 * LA PULIZIA DEI TEMPORANEI NON DEVE POTER CANCELLARE UNA SCRITTURA IN VOLO.
 *
 * Il 25/08 questa riga ha ucciso un server al boot e con lui 253 test. Quattro
 * shard e2e condividevano `data/usage/` (l'isolamento valeva solo per lo
 * SQLite, vedi `start-test-server.sh`), e `initUsageStore` cancellava all'avvio
 * OGNI file che contenesse `.tmp.`. Il temporaneo di `atomicWrite` si chiama
 * `summary.json.tmp.<pid>.<epochMs>`: la pulizia di uno shard ha cancellato il
 * file che un altro aveva scritto UN'ISTRUZIONE prima, e il suo `renameSync` e'
 * uscito ENOENT.
 *
 * La regola non e' «i miei si', gli altri no» — sarebbe una regola sulla
 * PROPRIETA', e un processo morto ieri lascerebbe sporcizia per sempre. E'
 * sull'ETA': orfano vuol dire VECCHIO. E cio' che non si riesce a datare si
 * TIENE, perche' i due errori non costano uguale — qualche kilobyte fermo
 * contro una scrittura viva distrutta.
 */
import { describe, test, expect } from "bun:test";
import { isOrphanTmp, ORPHAN_TMP_AGE_MS } from "./store";

const NOW = 1_787_672_873_909;
const OTHER = 4242;
const MINE = 91487;

describe("isOrphanTmp", () => {
  test("IL CASO CHE HA UCCISO LO SHARD: un temporaneo appena scritto da un ALTRO processo si tiene", () => {
    const appena = `summary.json.tmp.${OTHER}.${NOW - 5}`;
    expect(isOrphanTmp(appena, MINE, NOW)).toBe(false);
  });

  test("un temporaneo VECCHIO di un altro processo e' orfano", () => {
    const vecchio = `summary.json.tmp.${OTHER}.${NOW - ORPHAN_TMP_AGE_MS - 1}`;
    expect(isOrphanTmp(vecchio, MINE, NOW)).toBe(true);
  });

  test("sul confine dell'eta' si cancella: la soglia e' inclusiva, e non lascia un limbo", () => {
    const alConfine = `summary.json.tmp.${OTHER}.${NOW - ORPHAN_TMP_AGE_MS}`;
    expect(isOrphanTmp(alConfine, MINE, NOW)).toBe(true);
  });

  test("il MIO temporaneo e' orfano a qualunque eta': l'ho lasciato io, morendo", () => {
    const mioFresco = `summary.json.tmp.${MINE}.${NOW - 5}`;
    expect(isOrphanTmp(mioFresco, MINE, NOW)).toBe(true);
  });

  test("cio' che non si riesce a DATARE si tiene, invece di indovinare", () => {
    expect(isOrphanTmp("summary.json.tmp.qualcosa.dialtro", MINE, NOW)).toBe(false);
    expect(isOrphanTmp(`summary.json.tmp.${OTHER}.`, MINE, NOW)).toBe(false);
    expect(isOrphanTmp(`summary.json.tmp.${OTHER}`, MINE, NOW)).toBe(false);
  });

  test("un file che non e' un temporaneo non si tocca, per quanto somigli", () => {
    expect(isOrphanTmp("summary.json", MINE, NOW)).toBe(false);
    expect(isOrphanTmp("2026-08-25.json", MINE, NOW)).toBe(false);
    expect(isOrphanTmp("summary.json.migrated", MINE, NOW)).toBe(false);
    // «tmp» senza i punti attorno non e' il marcatore: e' una parola nel nome.
    expect(isOrphanTmp("tmp-summary.json", MINE, NOW)).toBe(false);
  });

  test("vale per i giornalieri come per il riassunto: il nome davanti non conta", () => {
    const giornaliero = `2026-08-25.json.tmp.${OTHER}.${NOW - 5}`;
    expect(isOrphanTmp(giornaliero, MINE, NOW)).toBe(false);
    expect(isOrphanTmp(`2026-08-25.json.tmp.${OTHER}.${NOW - 120_000}`, MINE, NOW)).toBe(true);
  });
});
