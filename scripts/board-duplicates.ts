// Quante card di una board dicono la stessa cosa, e quanta storia si potrebbe
// archiviare. Legge il DB in SOLA LETTURA e non scrive niente: e' una misura,
// non una pulizia.
//
//   bun run scripts/board-duplicates.ts \
//     [--db data/topics.db] [--project topics-app-ar3jt5] [--days 14] [--verbose]
//
// Stampa, per la board scelta:
//   - quante card vive ci sono, e quante di quelle sono aperte (non `done`);
//   - quanti gruppi di doppioni, e quante card sparirebbero fondendoli, sia
//     sulle sole card aperte sia su tutte;
//   - quante `done` sono piu' vecchie di `--days` (candidate all'archiviazione).
//
// Il conto sulle sole card APERTE e' quello che conta: e' il lavoro che qualcuno
// deve ancora leggere. Il conto su tutte include la storia, che pesa sulla
// lista ma non sul lavoro.
//
// Serve anche da controprova del cancello alla creazione (POST
// /api/sessions/:key/tasks risponde 409 su un doppione): se questo numero
// cresce nel tempo, il cancello non sta tenendo.

export {}; // top-level await richiede un modulo

import { Database } from "bun:sqlite";
import { findDuplicateGroups, type SimilarTask } from "../shared/task-similarity";

const argv = process.argv.slice(2);
function opt(name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const DB_PATH = opt("db", "data/topics.db");
const PROJECT = opt("project", "topics-app-ar3jt5");
const DAYS = Math.max(1, Number(opt("days", "14")) || 14);
const VERBOSE = argv.includes("--verbose");

// Sola lettura, sempre: questo script gira contro il DB VIVO di produzione, e
// una scrittura per sbaglio qui vale piu' di qualunque numero stampato.
const db = new Database(DB_PATH, { readonly: true });

type Row = { id: string; text: string; status: string; created_at: string; completed_at: string | null; updated_at: string };
const rows = db
  .prepare(
    `SELECT id, text, status, created_at, completed_at, updated_at
       FROM tasks WHERE project_id = ? AND archived = 0 AND parent_task_id IS NULL`,
  )
  .all(PROJECT) as Row[];

const aperte = rows.filter((r) => r.status !== "done");
const fatte = rows.filter((r) => r.status === "done");
const conta = (list: Row[]) => {
  const groups = findDuplicateGroups(list.map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at })) as SimilarTask[]);
  return { groups, fuse: groups.reduce((n, g) => n + g.duplicates.length, 0) };
};

const soglia = new Date(Date.now() - DAYS * 86_400_000).toISOString();
const vecchie = fatte.filter((r) => (r.completed_at ?? r.updated_at) < soglia);

// Archiviare una card se la porta dietro tutto il sottoalbero (`archive()`
// cascata, soft-delete). E' la ragione per cui il conto delle sole radici
// sottostima: 47 radici possono valere 188 card sulla lista.
const cascata = vecchie.length
  ? (db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT value FROM json_each(?)
           UNION ALL
           SELECT t.id FROM tasks t JOIN sub s ON t.parent_task_id = s.id WHERE t.archived = 0
         )
         SELECT COUNT(*) AS c FROM sub`,
      )
      .get(JSON.stringify(vecchie.map((r) => r.id))) as any)?.c ?? 0
  : 0;

// Quante card VIVE ha la board in tutto, sottotask compresi: e' il numero che
// un umano vede scorrendo, e quello da cui si misura ogni alleggerimento.
const totaleVive = (db
  .prepare("SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND archived = 0")
  .get(PROJECT) as any)?.c ?? 0;

const suAperte = conta(aperte);
const suTutte = conta(rows);

console.log(`board ${PROJECT} (${DB_PATH}, sola lettura)`);
console.log(`  card vive in tutto:          ${totaleVive}  (radici ${rows.length}, sottotask ${totaleVive - rows.length})`);
console.log(`  radici aperte / done:        ${aperte.length} / ${fatte.length}`);
console.log(`  doppioni fra le radici APERTE: ${suAperte.groups.length} gruppi, ${suAperte.fuse} card fuse`);
console.log(`  doppioni fra TUTTE le radici:  ${suTutte.groups.length} gruppi, ${suTutte.fuse} card fuse`);
console.log(`  radici done piu' vecchie di ${DAYS}gg: ${vecchie.length}, che col sottoalbero valgono ${cascata} card`);
console.log(`  card che uscirebbero dalla lista: ${suTutte.fuse + cascata} su ${totaleVive}`);

if (VERBOSE) {
  for (const g of suTutte.groups) {
    console.log(`\n[min ${g.minScore.toFixed(2)}] ${g.survivor.text}`);
    for (const d of g.duplicates) console.log(`    + ${d.text}`);
  }
}
db.close();
