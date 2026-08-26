/**
 * @covers USAGE-TMP-01
 *
 * CLEANING UP TEMPORARIES MUST NEVER BE ABLE TO DELETE AN IN-FLIGHT WRITE.
 *
 * On 25/08 this very line killed a server at boot, and 253 tests with it. Four
 * e2e shards shared `data/usage/` (the isolation covered only SQLite, see
 * `start-test-server.sh`), and `initUsageStore` deleted at startup EVERY file
 * whose name held `.tmp.`. The temporary of `atomicWrite` is called
 * `summary.json.tmp.<pid>.<epochMs>`: one shard's cleanup deleted the file
 * another shard had written ONE INSTRUCTION earlier, and that shard's
 * `renameSync` came back ENOENT.
 *
 * The rule is not «mine yes, other people's no» — that would be a rule about
 * OWNERSHIP, and a process that died yesterday would leave dirt behind forever.
 * It is about AGE: orphan means OLD. And whatever cannot be dated is KEPT,
 * because the two mistakes do not cost the same — a few idle kilobytes against
 * a live write destroyed.
 */
import { describe, test, expect } from "bun:test";
import { isOrphanTmp, ORPHAN_TMP_AGE_MS } from "./store";

const NOW = 1_787_672_873_909;
const OTHER = 4242;
const MINE = 91487;

describe("isOrphanTmp", () => {
  test("IL CASO CHE HA UCCISO LO SHARD: un temporaneo appena scritto da un ALTRO processo si tiene", () => {
    const justWritten = `summary.json.tmp.${OTHER}.${NOW - 5}`;
    expect(isOrphanTmp(justWritten, MINE, NOW)).toBe(false);
  });

  test("un temporaneo VECCHIO di un altro processo e' orfano", () => {
    const stale = `summary.json.tmp.${OTHER}.${NOW - ORPHAN_TMP_AGE_MS - 1}`;
    expect(isOrphanTmp(stale, MINE, NOW)).toBe(true);
  });

  test("sul confine dell'eta' si cancella: la soglia e' inclusiva, e non lascia un limbo", () => {
    const alConfine = `summary.json.tmp.${OTHER}.${NOW - ORPHAN_TMP_AGE_MS}`;
    expect(isOrphanTmp(alConfine, MINE, NOW)).toBe(true);
  });

  test("il MIO temporaneo e' orfano a qualunque eta': l'ho lasciato io, morendo", () => {
    const mineFresh = `summary.json.tmp.${MINE}.${NOW - 5}`;
    expect(isOrphanTmp(mineFresh, MINE, NOW)).toBe(true);
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
    // «tmp» without the dots around it is not the marker: it is a word in the name.
    expect(isOrphanTmp("tmp-summary.json", MINE, NOW)).toBe(false);
  });

  test("vale per i giornalieri come per il riassunto: il nome davanti non conta", () => {
    const daily = `2026-08-25.json.tmp.${OTHER}.${NOW - 5}`;
    expect(isOrphanTmp(daily, MINE, NOW)).toBe(false);
    expect(isOrphanTmp(`2026-08-25.json.tmp.${OTHER}.${NOW - 120_000}`, MINE, NOW)).toBe(true);
  });
});
