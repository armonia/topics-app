#!/usr/bin/env bun
/**
 * Merges projects split in two by a symlink — dry run first, for real only after.
 *
 * WHY A MIGRATION IS NEEDED AND THE CODE IS NOT ENOUGH. `canonical-project-path.ts`
 * stops a SECOND identity from being born, but it does not touch what is already
 * written: a project's id is `basename + hash of the path string`
 * (`shared/board.ts`), and the `ui_state` keys use a twin hash
 * (`shared/project-keys.ts`). Rewriting a path by hand would change those ids and
 * leave the `tasks` rows under an id no board reads: the "empty board" already
 * paid for once.
 *
 * WHAT IT DOES. Finds saved paths that are links, computes old and new id, and
 * rewrites in ONE transaction: `tasks.project_id`, the topics' `projectPath`, the
 * per-project `ui_state` keys. Where both identities exist, the old one is folded
 * into the new.
 *
 *   bun scripts/canonicalizza-progetti.ts            list what would change  allow-italian: the file name
 *   bun scripts/canonicalizza-progetti.ts --esegui   do it  allow-italian: the file name and the flag it really takes
 *
 * The default is the dry run: a migration that starts by itself on first run is a
 * migration nobody read.
 */
import { Database } from "bun:sqlite";
import { realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { projectIdForPath } from "../shared/board";
import { projectHash, PROJECT_PANES_PREFIX, PROJECT_LAYOUT_PREFIX } from "../shared/project-keys";

const esegui = process.argv.includes("--esegui");
// The DB lives under the app's dataRoot (`data/topics.db` in development), NOT
// in ~/.topics: there sits a 0-byte topics.db left over from an old path, and
// pointing at it would make a migration that looked at nothing report "nothing
// to merge". `TOPICS_DB` forces it.
const dbPath = process.env.TOPICS_DB
  || [join(process.cwd(), "data", "topics.db"),
      join(homedir(), "Projects", "topics-app", "data", "topics.db")].find((p) => {
        try { return existsSync(p) && Bun.file(p).size > 0; } catch { return false; }
      }) || "";
if (!dbPath) { console.error("nessun database trovato: passa TOPICS_DB=<percorso>"); process.exit(1); }
console.log(`database: ${dbPath}`);
const db = new Database(dbPath);

function canonico(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

// The paths the app knows: the ones bound to topics. They are the same source
// boards and panes are born from, so they suffice to find every double identity.
const percorsi = new Set<string>();
for (const r of db.query<{ project_path: string }, []>(
  "SELECT DISTINCT project_path FROM topics WHERE project_path IS NOT NULL AND project_path != ''").all()) {
  percorsi.add(r.project_path);
}

interface Caso { vecchio: string; nuovo: string; topics: number; tasks: number; chiavi: string[] }
const casi: Caso[] = [];
for (const p of percorsi) {
  const nuovo = canonico(p);
  if (nuovo === p) continue;
  const idV = projectIdForPath(p), idN = projectIdForPath(nuovo);
  const nTopics = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM topics WHERE project_path = ?").get(p)!.n;
  let nTasks = 0;
  try { nTasks = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM tasks WHERE project_id = ?").get(idV)!.n; } catch { /* no tasks table */ }
  const chiavi: string[] = [];
  for (const pref of [PROJECT_PANES_PREFIX, PROJECT_LAYOUT_PREFIX]) {
    const k = pref + projectHash(p);
    const row = db.query<{ key: string }, [string]>("SELECT key FROM ui_state WHERE key = ?").get(k);
    if (row) chiavi.push(k);
  }
  casi.push({ vecchio: p, nuovo, topics: nTopics, tasks: nTasks, chiavi });
  void idN;
}

if (casi.length === 0) console.log("board e topic: niente da fondere, nessun percorso salvato passa da un link.");
else console.log(esegui ? "ESEGUO" : "PROVA (niente viene scritto) — aggiungi --esegui per farlo davvero");
for (const c of casi) {
  console.log(`\n${c.vecchio}\n  -> ${c.nuovo}`);
  console.log(`  topic da rilegare: ${c.topics} · righe tasks da spostare: ${c.tasks}` +
              `${c.chiavi.length ? ` · chiavi ui_state: ${c.chiavi.join(", ")}` : ""}`);
  console.log(`  projectId: ${projectIdForPath(c.vecchio)} -> ${projectIdForPath(c.nuovo)}`);
}

const migra = db.transaction(() => {
  for (const c of casi) {
    const idV = projectIdForPath(c.vecchio), idN = projectIdForPath(c.nuovo);
    try { db.run("UPDATE tasks SET project_id = ? WHERE project_id = ?", [idN, idV]); } catch { /* no tasks table */ }
    db.run("UPDATE topics SET project_path = ? WHERE project_path = ?", [c.nuovo, c.vecchio]);
    for (const pref of [PROJECT_PANES_PREFIX, PROJECT_LAYOUT_PREFIX]) {
      const kV = pref + projectHash(c.vecchio), kN = pref + projectHash(c.nuovo);
      const vecchia = db.query<{ value: string }, [string]>("SELECT value FROM ui_state WHERE key = ?").get(kV);
      if (!vecchia) continue;
      const nuova = db.query<{ value: string }, [string]>("SELECT value FROM ui_state WHERE key = ?").get(kN);
      // Where both exist the new one wins: it is the one the user is looking at
      // right now. The old one goes away — two layouts are not blended at random.
      if (!nuova) db.run("UPDATE ui_state SET key = ? WHERE key = ?", [kN, kV]);
      else db.run("DELETE FROM ui_state WHERE key = ?", [kV]);
    }
  }
});
if (esegui && casi.length > 0) {
  migra();
  console.log("\nboard e topic rilegati.");
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 2 — the references left behind in the UI STATE.
//
// Phase 1 rebinds boards and topics, but the open panes and the sidebar pins
// live inside two JSON blobs (`pane-store-v2`, `sidebar-state`) with the path
// written in, sometimes encoded. After the merge they stayed there: the project
// showed up TWICE, and one of the two copies was the one with a live turn.
//
// Here the link is gone (the directory was really moved), so it cannot be
// resolved: a path that NO LONGER EXISTS and has a namesake in ~/Projects is
// remapped there. That is a heuristic, which is why it is read in the dry run
// before being executed.
// ─────────────────────────────────────────────────────────────────────────────
{
  const BLOB = ["pane-store-v2", "sidebar-state", "panels"];
  const home = homedir();
  const orfani = new Map<string, string>();
  for (const key of BLOB) {
    const row = db.query<{ value: string }, [string]>("SELECT value FROM ui_state WHERE key = ?").get(key);
    if (!row) continue;
    for (const m of row.value.matchAll(/project:((?:%2F|\/)[^"',\]]+)/g)) {
      const p = decodeURIComponent(m[1]);
      if (existsSync(p)) continue;
      const candidato = join(home, "Projects", p.split("/").filter(Boolean).pop() || "");
      if (existsSync(candidato)) orfani.set(p, candidato);
    }
  }
  if (orfani.size === 0) console.log("\nstato UI: nessun riferimento orfano.");
  else {
    console.log(`\nstato UI — ${orfani.size} riferimenti a cartelle che non esistono piu':`);
    for (const [v, n] of orfani) console.log(`  ${v}\n    -> ${n}`);
    if (esegui) {
      const rimappa = db.transaction(() => {
        for (const key of BLOB) {
          const row = db.query<{ value: string }, [string]>("SELECT value FROM ui_state WHERE key = ?").get(key);
          if (!row) continue;
          let v = row.value;
          for (const [vecchio, nuovo] of orfani) {
            v = v.split(vecchio).join(nuovo)
                 .split(encodeURIComponent(vecchio)).join(encodeURIComponent(nuovo));
          }
          // Dedup the pins: after the remap the same entry can show up twice.
          try {
            const o = JSON.parse(v);
            const dedup = (a: unknown) => Array.isArray(a) ? [...new Set(a as string[])] : a;
            if (o?.pinnedItems) o.pinnedItems = dedup(o.pinnedItems);
            if (Array.isArray(o?.pinnedLayout)) {
              for (const riga of o.pinnedLayout) if (riga?.keys) riga.keys = dedup(riga.keys);
            }
            v = JSON.stringify(o);
          } catch { /* non-JSON blob: the textual replacement still holds */ }
          db.run("UPDATE ui_state SET value = ? WHERE key = ?", [v, key]);
        }
      });
      rimappa();
      console.log("stato UI riscritto.");
    }
  }
}
console.log("\nfatto. Riavvia il server Topics perche' rilegga lo stato.");
