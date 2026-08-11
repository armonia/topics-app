/**
 * Prova sul campo del parcheggio delle orfane, SENZA toccare niente.
 *
 * Monta `createOrphanCensusRunner` — la stessa funzione che gira in server.ts —
 * sul database VERO in sola lettura, e con un `park` che registra invece di
 * uccidere. Serve a rispondere alla domanda che i test unitari non possono
 * chiudere: su `ui_state` com'è messo davvero su questa macchina, chi
 * verrebbe parcheggiato?
 *
 * Uso:
 *   bun run scripts/orphan-park-dryrun.ts [percorso/topics.db]
 *
 * Il default è il database che il server ha aperto adesso. Viene aperto in sola
 * lettura: questo script non può scrivere nemmeno sbagliando.
 */

import { Database } from "bun:sqlite";
import { createOrphanCensusRunner } from "../server/services/orphan-census";

const dbPath = process.argv[2] ?? `${process.env.HOME}/Projects/topics-app/data/topics.db`;
const db = new Database(dbPath, { readonly: true });

const uiStateValues = (db.query("SELECT value FROM ui_state").all() as Array<{ value?: string }>)
  .map((r) => r.value ?? "")
  .filter(Boolean);

// Le righe di `terminal_sessions` NON sono il roster vivo — il roster vive in
// memoria nel server — ma sono la cosa più vicina che uno script esterno possa
// guardare, e per una prova a vuoto è esattamente ciò che serve: se il giudizio
// sbaglia su queste, sbaglierebbe anche sulle vive.
const rows = db.query("SELECT id, status, type FROM terminal_sessions").all() as Array<{
  id: string; status: string; type: string;
}>;

console.log(`db: ${dbPath}`);
console.log(`righe ui_state: ${uiStateValues.length} · righe terminal_sessions: ${rows.length}`);
for (const r of rows) console.log(`  · ${r.id.slice(0, 8)} ${r.type} [${r.status}]`);
console.log("");

const parked: string[][] = [];
const run = createOrphanCensusRunner({
  listSessions: () => rows.map((r) => ({ id: r.id, attached: false, isSubAgent: false })),
  listUiStateValues: () => uiStateValues,
  // Non uccide niente: registra e basta. È il punto dello script.
  park: (ids) => { parked.push([...ids]); console.log(`  ⟶ PARCHEGGEREBBE: ${ids.join(", ")}`); },
  enabled: true,
});

// Tre giri, perché la regola vive fra un giro e l'altro: il primo non può
// parcheggiare niente per costruzione (serve la seconda conferma).
for (let i = 1; i <= 3; i++) {
  console.log(`— giro ${i} —`);
  run();
  console.log("");
}

console.log(
  parked.length
    ? `Esito: parcheggerebbe ${parked[0]!.length} sessioni, dal giro 2 in poi.`
    : "Esito: non parcheggerebbe niente.",
);
db.close();
