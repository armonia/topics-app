/**
 * UN BANCO DI PROVA SOLO, PER TUTTI I TEST DEL SERVIZIO DEI TASK.
 *
 * ── Il difetto ──────────────────────────────────────────────────────────────
 * `tasks.ts` e' il singolo scrittore della board, e i suoi test erano sparsi su
 * NOVE file, ognuno con la propria `freshDb()`. Nove copie dello schema, e le
 * copie derivano: misurato il 18/08, `tasks.parked-stall.test.ts` si scriveva
 * `CREATE TABLE tasks` a mano invece di usare `TASKS_DDL`, ed era indietro di
 * tre colonne — `fingerprint`, `interrupt_claimed_at`, `plan_comment_id`.
 *
 * Un test su uno schema che non e' quello di produzione non e' piu' severo: e'
 * CIECO. Passa perche' non arriva mai al codice che tocca la colonna mancante,
 * e resta verde mentre la stessa query esplode in produzione. Il valore di
 * `TASKS_DDL` — «lo schema del test e' quello vero, colonna per colonna,
 * verificato da `test-schema.test.ts`» — vale zero nei file che lo aggirano.
 *
 * ── Cosa pinna questo cancello ──────────────────────────────────────────────
 * Non i nove file di oggi: chiunque tocchi il servizio domani. Un file nuovo
 * che si scrive lo schema da se' fa rosso qui, prima di poter diventare cieco.
 *
 * L'OROLOGIO invece resta di ciascuno: `commentDedupeMs: 0` in parked-stall e
 * l'orologio che avanza in queue-reason sono scelte che misurano cose diverse,
 * e unificarle vorrebbe dire far mentire i loro test. Lo schema e' un fatto,
 * l'orologio e' un esperimento.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { freshDb } from "./tasks-test-db";

const DIR = import.meta.dir;

/** I file di test del servizio dei tasks: `tasks.test.ts` e `tasks.<tema>.test.ts`. */
function fileDelServizio(): string[] {
  return readdirSync(DIR)
    .filter((n) => (n === "tasks.test.ts" || n.startsWith("tasks.")) && n.endsWith(".test.ts"))
    .filter((n) => n !== "tasks-test-db.test.ts")
    .sort();
}

describe("lo schema dei test del servizio tasks e' uno solo", () => {
  test("i file ci sono (guardia contro un verde a vuoto)", () => {
    // Senza, un rinominare qualsiasi renderebbe verdi i casi sotto misurando
    // zero file: il modo piu' comune in cui un cancello smette di guardare.
    expect(fileDelServizio().length).toBeGreaterThanOrEqual(8);
  });

  test("nessun file si scrive la tabella `tasks` per conto suo", () => {
    const colpevoli = fileDelServizio().filter((n) =>
      /CREATE TABLE\s+(IF NOT EXISTS\s+)?tasks\b/i.test(readFileSync(resolve(DIR, n), "utf8")),
    );
    expect(
      colpevoli,
      "Una copia a mano dello schema resta indietro in silenzio: parked-stall lo era di tre " +
        "colonne. Usa `freshDb` da `./tasks-test-db`, che monta TASKS_DDL.",
    ).toEqual([]);
  });

  test("ogni file passa dal banco condiviso", () => {
    const fuori = fileDelServizio().filter(
      (n) => !readFileSync(resolve(DIR, n), "utf8").includes('from "./tasks-test-db"'),
    );
    expect(fuori, "un file del servizio che non importa il banco si sta costruendo il suo").toEqual([]);
  });

  test("il banco monta le colonne che la copia a mano aveva perso", () => {
    // Il caso che dice PERCHE' il cancello esiste, con i nomi veri del guasto.
    const db = freshDb();
    const cols = new Set(
      (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((r) => r.name),
    );
    for (const c of ["fingerprint", "interrupt_claimed_at", "plan_comment_id"]) {
      expect(cols.has(c), `manca ${c}`).toBe(true);
    }
    db.close();
  });
});
