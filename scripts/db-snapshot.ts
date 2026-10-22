#!/usr/bin/env bun
/**
 * Snapshot giornaliero del database: `VACUUM INTO` su un file temporaneo,
 * compressione zstd, rename atomico in `<cartella dati>/backups/`.
 *
 * PERCHE'. Fino a questo script l'unico backup completo era una copia a mano
 * sullo stesso disco, e l'unico periodico salvava la sola tabella `ui_state`
 * (server/services/ui-state-backup.ts). Con `TOPICS_SERVER_WATCH=1` creare una
 * migration applica subito il suo SQL al DB vivo: senza uno snapshot di ieri
 * una migration di dati sbagliata non ha ritorno.
 *
 * `VACUUM INTO` e' consistente a server acceso (WAL incluso, nessuna pagina
 * libera) e non blocca chi scrive: vedi docs/backup-pre-migration-policy.md.
 * Un snapshot e' provato solo da `scripts/backup-restore-check.ts`.
 *
 * Retention: gli ultimi 14 giorni, piu' 8 lunedi' piu' vecchi di quella
 * finestra. La potatura usa `trash`, mai `rm`, e tocca soltanto i file con il
 * nome di uno snapshot (`topics-AAAA-MM-GG.db.zst`).
 *
 *   bun run scripts/db-snapshot.ts   (DATA_DIR / TOPICS_DATA_DIR come li legge il server)
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join, resolve } from "path";
import { resolveDataDir, stateDirTarget } from "../server/lib/data-dir";

const KEEP_DAILY = 14;
const KEEP_WEEKLY = 8;
const SNAPSHOT_NAME = /^topics-(\d{4}-\d{2}-\d{2})\.db\.zst$/;

/** Lo stesso percorso di `initDatabase` (server/utils.ts). */
export function liveDbPath(): string {
  const root = resolve(import.meta.dir, "..");
  return join(resolveDataDir(stateDirTarget(root)), "topics.db");
}

export const backupsDirOf = (dbPath: string): string => join(dirname(dbPath), "backups");

/** Nomi degli snapshot, dal piu' recente. */
export function listSnapshots(backupsDir: string): string[] {
  try {
    return readdirSync(backupsDir).filter((f) => SNAPSHOT_NAME.test(f)).sort().reverse();
  } catch {
    return [];
  }
}

export function snapshotDb(dbPath: string, backupsDir: string, now: Date = new Date()): string {
  mkdirSync(backupsDir, { recursive: true });
  const day = now.toLocaleDateString("sv-SE");
  const rawTmp = join(backupsDir, `.topics-${day}.db.tmp`);
  const zstTmp = join(backupsDir, `.topics-${day}.db.zst.tmp`);
  const target = join(backupsDir, `topics-${day}.db.zst`);
  rmSync(rawTmp, { force: true });
  // Senza `create` un percorso sbagliato fallisce invece di snapshottare un DB vuoto.
  const db = new Database(dbPath, { readwrite: true, create: false });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    db.run("VACUUM INTO ?", [rawTmp]);
  } finally {
    db.close();
  }
  writeFileSync(zstTmp, Bun.zstdCompressSync(readFileSync(rawTmp)));
  rmSync(rawTmp);
  renameSync(zstTmp, target);
  return target;
}

const isMonday = (name: string): boolean =>
  new Date(`${name.match(SNAPSHOT_NAME)![1]}T00:00:00Z`).getUTCDay() === 1;

/** Cosa tenere: la finestra giornaliera piu' i lunedi' che stanno oltre. */
export function pruneCandidates(names: string[]): string[] {
  const older = names.slice(KEEP_DAILY);
  const weekly = new Set(older.filter(isMonday).slice(0, KEEP_WEEKLY));
  return older.filter((n) => !weekly.has(n));
}

const trash = (path: string): void => {
  const r = spawnSync("trash", [path]);
  if (r.status !== 0) throw new Error(`trash ${path} exit ${r.status}`);
};

export function pruneSnapshots(backupsDir: string, remove: (path: string) => void = trash): string[] {
  const doomed = pruneCandidates(listSnapshots(backupsDir));
  for (const name of doomed) remove(join(backupsDir, name));
  return doomed;
}

if (import.meta.main) {
  const dbPath = liveDbPath();
  const dir = backupsDirOf(dbPath);
  const target = snapshotDb(dbPath, dir);
  const pruned = pruneSnapshots(dir);
  console.log(`[db-snapshot] ${target}${pruned.length ? `, potati ${pruned.length}` : ""}`);
}
