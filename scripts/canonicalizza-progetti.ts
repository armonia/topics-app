#!/usr/bin/env bun
/**
 * Fonde i progetti sdoppiati da un symlink — in prova, e solo poi davvero.
 *
 * PERCHÉ SERVE UNA MIGRAZIONE E NON BASTA IL CODICE. `canonical-project-path.ts`
 * impedisce che nasca una SECONDA identità, ma non tocca ciò che è già scritto:
 * l'id di un progetto è `basename + hash della stringa del percorso`
 * (`shared/board.ts`), e le chiavi `ui_state` usano un hash gemello
 * (`shared/project-keys.ts`). Riscrivere un percorso a mano cambierebbe quegli
 * id e lascerebbe le righe `tasks` sotto un id che nessuna board legge: la
 * «board vuota» già pagata una volta.
 *
 * COSA FA. Trova i percorsi salvati che sono link, calcola vecchio e nuovo id, e
 * riscrive in UNA transazione: `tasks.project_id`, il `projectPath` dei topic, le
 * chiavi `ui_state` per-progetto. Dove esistono entrambe le identità, la vecchia
 * confluisce nella nuova.
 *
 *   bun scripts/canonicalizza-progetti.ts            elenca cosa cambierebbe
 *   bun scripts/canonicalizza-progetti.ts --esegui   lo fa
 *
 * Il default è la prova: una migrazione che parte da sola alla prima esecuzione
 * è una migrazione che nessuno ha letto.
 */
import { Database } from "bun:sqlite";
import { realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { projectIdForPath } from "../shared/board";
import { projectHash, PROJECT_PANES_PREFIX, PROJECT_LAYOUT_PREFIX } from "../shared/project-keys";

const esegui = process.argv.includes("--esegui");
// Il DB sta sotto il dataRoot dell'app (`data/topics.db` in sviluppo), NON in
// ~/.topics: li' c'e' un topics.db da 0 byte, residuo di un vecchio percorso, e
// puntarci sopra farebbe dire «niente da fondere» a una migrazione che non ha
// guardato niente. `TOPICS_DB` lo forza.
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

// I percorsi che l'app conosce: quelli legati ai topic. Sono la stessa fonte da
// cui nascono board e pannelli, quindi bastano a trovare ogni identità doppia.
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
  try { nTasks = db.query<{ n: number }, [string]>("SELECT COUNT(*) n FROM tasks WHERE project_id = ?").get(idV)!.n; } catch { /* niente tabella tasks */ }
  const chiavi: string[] = [];
  for (const pref of [PROJECT_PANES_PREFIX, PROJECT_LAYOUT_PREFIX]) {
    const k = pref + projectHash(p);
    const row = db.query<{ key: string }, [string]>("SELECT key FROM ui_state WHERE key = ?").get(k);
    if (row) chiavi.push(k);
  }
  casi.push({ vecchio: p, nuovo, topics: nTopics, tasks: nTasks, chiavi });
  void idN;
}

if (casi.length === 0) { console.log("niente da fondere: nessun percorso salvato passa da un link."); process.exit(0); }

console.log(esegui ? "ESEGUO" : "PROVA (niente viene scritto) — aggiungi --esegui per farlo davvero");
for (const c of casi) {
  console.log(`\n${c.vecchio}\n  -> ${c.nuovo}`);
  console.log(`  topic da rilegare: ${c.topics} · righe tasks da spostare: ${c.tasks}` +
              `${c.chiavi.length ? ` · chiavi ui_state: ${c.chiavi.join(", ")}` : ""}`);
  console.log(`  projectId: ${projectIdForPath(c.vecchio)} -> ${projectIdForPath(c.nuovo)}`);
}

if (!esegui) process.exit(0);

const migra = db.transaction(() => {
  for (const c of casi) {
    const idV = projectIdForPath(c.vecchio), idN = projectIdForPath(c.nuovo);
    try { db.run("UPDATE tasks SET project_id = ? WHERE project_id = ?", [idN, idV]); } catch { /* niente tasks */ }
    db.run("UPDATE topics SET project_path = ? WHERE project_path = ?", [c.nuovo, c.vecchio]);
    for (const pref of [PROJECT_PANES_PREFIX, PROJECT_LAYOUT_PREFIX]) {
      const kV = pref + projectHash(c.vecchio), kN = pref + projectHash(c.nuovo);
      const vecchia = db.query<{ value: string }, [string]>("SELECT value FROM ui_state WHERE key = ?").get(kV);
      if (!vecchia) continue;
      const nuova = db.query<{ value: string }, [string]>("SELECT value FROM ui_state WHERE key = ?").get(kN);
      // Dove esistono entrambe vince quella nuova: è quella che l'utente sta
      // guardando adesso. La vecchia sparisce, non si fondono due layout a caso.
      if (!nuova) db.run("UPDATE ui_state SET key = ? WHERE key = ?", [kN, kV]);
      else db.run("DELETE FROM ui_state WHERE key = ?", [kV]);
    }
  }
});
migra();
console.log("\nfatto. Riavvia il server Topics perché rilegga lo stato.");
