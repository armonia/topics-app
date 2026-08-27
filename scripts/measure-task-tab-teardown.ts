/**
 * Misura del backstop `sweepArchivedTaskBrowserState` su una COPIA del db vivo.
 *
 * Perché una copia e non il db vivo: si sta cancellando stato, e la falsificazione
 * si fa su una copia. Lo snapshot lo prende `sqlite3 .backup`, che è consistente
 * anche con il server acceso (il `cp` di un db in WAL non lo è).
 *
 *   bun run scripts/measure-task-tab-teardown.ts <copia.db> [--simula-archivio N]
 *
 * `--simula-archivio N` archivia gli N task NON archiviati che hanno più byte di
 * `ui_state`, poi rigira il ripasso: è la misura di quanto rende l'aggancio
 * all'archiviazione quando l'archiviazione avviene davvero, sui dati veri.
 */
import { Database } from "bun:sqlite";
import { sweepArchivedTaskBrowserState } from "../server/services/task-tab-teardown";

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("uso: bun run scripts/measure-task-tab-teardown.ts <copia.db> [--simula-archivio N]");
  process.exit(1);
}
const simulateIdx = process.argv.indexOf("--simula-archivio");
const simula = simulateIdx > 0 ? Number(process.argv[simulateIdx + 1] ?? 0) : 0;

const db = new Database(dbPath);

interface Census {
  righeTotali: number;
  byteTotali: number;
  righeTaskBrowser: number;
  byteTaskBrowser: number;
}

function censimento(): Census {
  const tot = db
    .query("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) AS b FROM ui_state")
    .get() as { n: number; b: number };
  const tb = db
    .query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(key) + LENGTH(value)), 0) AS b FROM ui_state
       WHERE key LIKE 'task-browser-tabs:%' OR key LIKE 'task-browser-layout:%'`,
    )
    .get() as { n: number; b: number };
  return { righeTotali: tot.n, byteTotali: tot.b, righeTaskBrowser: tb.n, byteTaskBrowser: tb.b };
}

function stampa(titolo: string, c: Census): void {
  const pct = c.byteTotali ? ((c.byteTaskBrowser / c.byteTotali) * 100).toFixed(1) : "0.0";
  console.log(
    `${titolo.padEnd(22)} ui_state ${String(c.righeTotali).padStart(4)} righe / ${String(c.byteTotali).padStart(7)} byte` +
      `   ·   task-browser ${String(c.righeTaskBrowser).padStart(3)} righe / ${String(c.byteTaskBrowser).padStart(6)} byte (${pct}%)`,
  );
}

// Da dove viene il peso, prima di toccare qualsiasi cosa.
console.log("── di chi sono le righe `task-browser-*` ──");
const perState = db
  .query(
    `SELECT COALESCE(t.status, '(task inesistente)') AS stato,
            CASE WHEN t.archived = 1 THEN 'archiviato' ELSE 'in board' END AS dove,
            COUNT(*) AS righe, SUM(LENGTH(u.key) + LENGTH(u.value)) AS byte
       FROM ui_state u
       LEFT JOIN tasks t
         ON t.id = REPLACE(REPLACE(u.key, 'task-browser-tabs:', ''), 'task-browser-layout:', '')
      WHERE u.key LIKE 'task-browser-tabs:%' OR u.key LIKE 'task-browser-layout:%'
      GROUP BY 1, 2 ORDER BY righe DESC`,
  )
  .all() as { stato: string; dove: string; righe: number; byte: number }[];
for (const r of perState) {
  console.log(`  ${r.stato.padEnd(20)} ${r.dove.padEnd(12)} ${String(r.righe).padStart(3)} righe / ${String(r.byte).padStart(6)} byte`);
}
console.log("");

const prima = censimento();
stampa("PRIMA", prima);

const report = sweepArchivedTaskBrowserState({ db });
const dopo = censimento();
stampa("DOPO il ripasso", dopo);
console.log(
  `  → ${report.keysDeleted.length} chiave/i via, ${report.bytesFreed} byte, ` +
    `${report.taskIds.length} task, ${report.contextsReleased.length} contesti da rilasciare`,
);

if (simula > 0) {
  console.log("");
  console.log(`── simulazione: archivio i ${simula} task (non archiviati) più pesanti ──`);
  const grassi = db
    .query(
      `SELECT REPLACE(REPLACE(u.key, 'task-browser-tabs:', ''), 'task-browser-layout:', '') AS id,
              SUM(LENGTH(u.key) + LENGTH(u.value)) AS byte
         FROM ui_state u JOIN tasks t ON t.id = REPLACE(REPLACE(u.key, 'task-browser-tabs:', ''), 'task-browser-layout:', '')
        WHERE (u.key LIKE 'task-browser-tabs:%' OR u.key LIKE 'task-browser-layout:%') AND t.archived = 0
        GROUP BY 1 ORDER BY byte DESC LIMIT ?`,
    )
    .all(simula) as { id: string; byte: number }[];
  for (const g of grassi) db.run("UPDATE tasks SET archived = 1 WHERE id = ?", [g.id]);
  console.log(`  archiviati ${grassi.length} task (${grassi.reduce((n, g) => n + g.byte, 0)} byte di ui_state appesi)`);

  const r2 = sweepArchivedTaskBrowserState({ db });
  const dopo2 = censimento();
  stampa("DOPO l'archivio", dopo2);
  console.log(
    `  → ${r2.keysDeleted.length} chiave/i via, ${r2.bytesFreed} byte, ` +
      `${r2.taskIds.length} task, ${r2.contextsReleased.length} contesti da rilasciare`,
  );
}

db.close();
