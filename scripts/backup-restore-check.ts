#!/usr/bin/env bun
/**
 * La barra del backup: esce 0 solo se la copia piu' recente SI RIPRISTINA.
 *
 * Uno snapshot non provato non e' un backup. Qui la copia piu' recente viene
 * decompressa in una cartella scratch, passa `PRAGMA integrity_check`, poi
 * `initDatabase` ci gira sopra e le migration registrate devono arrivare al
 * numero dei file in `server/db/migrations/` (188 il 22/10/2026).
 *
 * Esce non-zero anche se la copia piu' recente e' vecchia di piu' di
 * MAX_AGE_DAYS: il caso reale era un ultimo backup di 8 giorni prima, e un
 * lavoro che non gira piu' non deve restare verde per colpa di una copia vecchia.
 *
 *   bun run scripts/backup-restore-check.ts   (stessa cartella dati dello snapshot)
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { closeDatabase, initDatabase } from "../server/db";
import { backupsDirOf, liveDbPath, listSnapshots } from "./db-snapshot";

const MAX_AGE_DAYS = 2;
const REPO_ROOT = resolve(import.meta.dir, "..");

/** Lancia se la copia non si ripristina. Ritorna il numero di migration registrate. */
export function restoreCheck(backupsDir: string, now: Date = new Date()): number {
  const latest = listSnapshots(backupsDir)[0];
  if (!latest) throw new Error(`nessuno snapshot in ${backupsDir}`);
  const ageDays = (now.getTime() - Date.parse(latest.slice(7, 17))) / 86_400_000;
  if (ageDays > MAX_AGE_DAYS) throw new Error(`${latest} e' vecchio di ${Math.floor(ageDays)} giorni`);

  const scratch = mkdtempSync(join(tmpdir(), "topics-restore-check-"));
  const prevDataDir = process.env.DATA_DIR;
  try {
    const restored = join(scratch, "topics.db");
    writeFileSync(restored, Bun.zstdDecompressSync(readFileSync(join(backupsDir, latest))));

    const probe = new Database(restored, { readonly: true });
    try {
      const verdict = probe.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
      if (verdict.length !== 1 || verdict[0].integrity_check !== "ok") {
        throw new Error(`integrity_check: ${verdict.map((r) => r.integrity_check).slice(0, 3).join("; ")}`);
      }
    } finally {
      probe.close();
    }

    // DATA_DIR vince su ogni altra radice: il DB aperto e' la copia, mai quello vivo.
    process.env.DATA_DIR = scratch;
    const db = initDatabase(REPO_ROOT);
    const applied = (db.query("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n;
    const expected = readdirSync(join(REPO_ROOT, "server", "db", "migrations")).filter((f) => /^\d+-.+\.sql$/.test(f)).length;
    if (applied !== expected) throw new Error(`migration registrate ${applied}, attese ${expected}`);
    return applied;
  } finally {
    closeDatabase();
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const n = restoreCheck(backupsDirOf(liveDbPath()));
    console.log(`[backup-restore-check] ok: integrity_check ok, ${n} migration`);
  } catch (err) {
    console.error(`[backup-restore-check] ROSSO: ${(err as Error).message}`);
    process.exit(1);
  }
}
