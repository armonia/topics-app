/**
 * Lo snapshot giornaliero del DB e la prova che si ripristina.
 *
 * Cosa conta, qui: non che `VACUUM INTO` giri, ma che il comando della barra
 * (`restoreCheck`) diventi ROSSO quando la copia non regge. Ogni test rosso
 * corrisponde a un modo in cui un backup finto passerebbe per buono:
 *  - un byte in meno nel file compresso;
 *  - una pagina del DB con indice e tabella che non concordano (la decompressione
 *    riesce, il DB si apre, solo `integrity_check` lo vede);
 *  - l'ultimo snapshot vecchio di giorni, cioe' il lavoro notturno fermo.
 * La retention si prova sui NOMI: il 15esimo giorno esce, un lunedi' oltre la
 * finestra resta, il nono lunedi' esce.
 * @covers SCHEMA-07
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDatabase, initDatabase } from "../../server/db";
import { listSnapshots, pruneCandidates, pruneSnapshots, snapshotDb } from "../../scripts/db-snapshot";
import { restoreCheck } from "../../scripts/backup-restore-check";
import { PROJECT_ROOT, testTmpDir } from "./helpers";

const ROOT = testTmpDir("db-snapshot");
const SOURCE = path.join(ROOT, "source");
const prevDataDir = process.env.DATA_DIR;
let migrationFiles = 0;

beforeAll(() => {
  process.env.DATA_DIR = SOURCE;
  const db = initDatabase(PROJECT_ROOT);
  // Tabella con indice: il suo contenuto e' cio' che il test sul DB corrotto altera.
  db.run("CREATE TABLE snapshot_probe (v TEXT)");
  db.run("CREATE INDEX snapshot_probe_v ON snapshot_probe (v)");
  for (let i = 0; i < 200; i++) db.run("INSERT INTO snapshot_probe (v) VALUES (?)", [`needle-${1000 + i}`]);
  closeDatabase();
  migrationFiles = readdirSync(path.join(PROJECT_ROOT, "server/db/migrations")).filter((f) => /^\d+-.+\.sql$/.test(f)).length;
});

afterAll(() => {
  closeDatabase();
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
});

const freshBackups = (label: string) => path.join(testTmpDir(label), "backups");
const sourceDb = () => path.join(SOURCE, "topics.db");

describe("snapshot e ripristino", () => {
  test("lo snapshot e' di oggi, integro, e arriva a tutte le migration", () => {
    const dir = freshBackups("snap-ok");
    const target = snapshotDb(sourceDb(), dir);
    expect(readdirSync(dir)).toEqual([path.basename(target)]); // nessun temporaneo rimasto
    expect(Date.now() - statSync(target).mtimeMs).toBeLessThan(86_400_000);
    expect(migrationFiles).toBeGreaterThan(0);
    expect(restoreCheck(dir)).toBe(migrationFiles);
  });

  test("un byte in meno nel file compresso: rosso", () => {
    const dir = freshBackups("snap-truncated");
    const target = snapshotDb(sourceDb(), dir);
    const bytes = readFileSync(target);
    writeFileSync(target, bytes.subarray(0, bytes.length - 1));
    expect(() => restoreCheck(dir)).toThrow();
  });

  test("tabella e indice che non concordano: rosso per integrity_check", () => {
    const dir = freshBackups("snap-mismatch");
    const target = snapshotDb(sourceDb(), dir);
    const raw = Buffer.from(Bun.zstdDecompressSync(readFileSync(target)));
    const at = raw.indexOf("needle-1100");
    expect(at).toBeGreaterThan(0);
    raw.write("needle-XXXX", at);
    writeFileSync(target, Bun.zstdCompressSync(raw));
    // Il DB corrotto si apre e risponde: e' la sola integrity_check a vederlo.
    expect(() => restoreCheck(dir)).toThrow(/integrity_check/);
  });

  test("registro con migration che questo codice non conosce: rosso", () => {
    const dir = freshBackups("snap-future");
    const target = snapshotDb(sourceDb(), dir);
    const file = path.join(dir, "future.db");
    writeFileSync(file, Bun.zstdDecompressSync(readFileSync(target)));
    const db = new Database(file);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, '9999-from-the-future.sql', 'x')");
    db.close();
    writeFileSync(target, Bun.zstdCompressSync(readFileSync(file)));
    expect(() => restoreCheck(dir)).toThrow(/migration registrate/);
  });

  test("l'ultimo snapshot vecchio di giorni: rosso", () => {
    const dir = freshBackups("snap-stale");
    snapshotDb(sourceDb(), dir, new Date(Date.now() - 5 * 86_400_000));
    expect(() => restoreCheck(dir)).toThrow(/vecchio/);
  });

  test("senza snapshot: rosso", () => {
    expect(() => restoreCheck(freshBackups("snap-none"))).toThrow(/nessuno snapshot/);
  });
});

describe("retention", () => {
  const days = (count: number, startIso: string) =>
    Array.from({ length: count }, (_, i) => {
      const d = new Date(Date.parse(`${startIso}T00:00:00Z`) + i * 86_400_000);
      return `topics-${d.toISOString().slice(0, 10)}.db.zst`;
    });

  test("il 15esimo giorno esce, i primi 14 restano", () => {
    // Il piu' vecchio e' un martedi' (2026-09-08): non e' un lunedi', nessuno lo salva.
    const names = days(15, "2026-09-08").reverse();
    expect(pruneCandidates(names)).toEqual([names[14]]);
  });

  test("un lunedi' oltre la finestra resta, fino a otto; il nono esce", () => {
    const recent = days(14, "2026-09-08").reverse();
    // Dieci lunedi' settimanali, dal piu' recente: 2026-08-31 e indietro.
    const mondays = Array.from({ length: 10 }, (_, i) => `topics-${new Date(Date.parse("2026-08-31T00:00:00Z") - i * 7 * 86_400_000).toISOString().slice(0, 10)}.db.zst`);
    const doomed = pruneCandidates([...recent, ...mondays]);
    expect(doomed).toEqual(mondays.slice(8));
  });

  test("la potatura sposta nel cestino il file e lascia stare i nomi estranei", () => {
    const dir = freshBackups("snap-prune");
    mkdirSync(dir, { recursive: true });
    const names = days(15, "2026-09-08").reverse();
    for (const n of [...names, "attic-2026-09-08.json.zst", "topics.db.bak-pre-x"]) writeFileSync(path.join(dir, n), "x");
    expect(pruneSnapshots(dir)).toEqual([names[14]]);
    expect(existsSync(path.join(dir, names[14]))).toBe(false);
    expect(listSnapshots(dir)).toHaveLength(14);
    expect(readdirSync(dir)).toContain("attic-2026-09-08.json.zst");
    expect(readdirSync(dir)).toContain("topics.db.bak-pre-x");
  });
});
