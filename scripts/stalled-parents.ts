#!/usr/bin/env bun
/**
 * LA SONDA DEGLI STALLI MUTI — `bun run probe:stalls [--db <file>] [--json] [--gate]`
 *
 * Conta le card ferme in un vicolo cieco che nessuno vede: un padre i cui unici
 * sottotask APERTI stanno tutti in backlog. Il giro è chiuso per costruzione — un
 * figlio in backlog non lo dispaccia nessuno (voluto: `hasChildrenInFlight`), e un
 * padre con un sottotask aperto non si può chiudere (voluto anche questo) — quindi
 * quelle card non si muovono più da sole. Misurate cinque il 12/08/2026: due padri
 * parcheggiati in backlog e i loro tre figli, ferme da ore, e nessuna lo diceva a
 * nessuno perché «ferma in backlog» è l'aspetto NORMALE di una card in backlog.
 *
 * DUE ESCLUSIONI, e sono la differenza fra una sonda e un allarme antipanico:
 *  · il padre STA LAVORANDO (`in_progress`, o chip `working`/`starting`): i suoi
 *    figli parcheggiati sono la sua checklist rimandata, non uno stallo — c'è un
 *    turno vivo che a fine corsa se ne accorgerà. Sono 3 su questa board adesso.
 *  · il padre STA CHIEDENDO (è in `review`): la domanda è già dove si vedono le
 *    domande, cioè esattamente ciò che questa card ha costruito. Sono 5 adesso.
 * Ciò che resta è il silenzio: padri fermi in backlog o in coda, che non stanno
 * lavorando e non stanno chiedendo. Con la domanda al suo posto il numero è ZERO,
 * ed è per questo che vale come sonda: se torna a salire, un'altra strada porta
 * di nuovo a un vicolo cieco muto.
 *
 * Sola lettura: apre il DB `readonly` e non scrive niente, mai.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";

export interface Stall {
  parent: { id: string; text: string; status: string; dispatchState: string | null };
  /** I sottotask parcheggiati: sono card ferme anche loro, e vanno contate. */
  parked: Array<{ id: string; text: string }>;
}

/**
 * Il numero che conta è quello delle CARD, non dei padri: uno stallo con tre
 * figli tiene ferme quattro card, e chi guarda la board ne vede quattro.
 */
export interface StallReport {
  stalls: Stall[];
  parents: number;
  cards: number;
}

/** Padri non chiusi, senza turno vivo e senza domanda aperta, con figli tutti parcheggiati. */
const PARENTS_SQL = `
  SELECT p.id, p.text, p.status, p.dispatch_state
    FROM tasks p
   WHERE p.archived = 0
     AND p.status NOT IN ('done', 'review', 'in_progress')
     -- COALESCE, non un NOT IN nudo: con dispatch_state NULL il confronto vale
     -- NULL, l'intera WHERE diventa NULL e la riga sparisce — cioè la sonda
     -- avrebbe taciuto proprio sulle card mai dispacciate.
     AND COALESCE(p.dispatch_state, '') NOT IN ('working', 'starting')
     AND EXISTS (SELECT 1 FROM tasks c
                  WHERE c.parent_task_id = p.id AND c.archived = 0 AND c.status != 'done')
     AND NOT EXISTS (SELECT 1 FROM tasks c
                      WHERE c.parent_task_id = p.id AND c.archived = 0
                        AND c.status IN ('todo', 'in_progress', 'review'))
   ORDER BY p.updated_at`;

const PARKED_SQL = `
  SELECT id, text FROM tasks
   WHERE parent_task_id = ? AND archived = 0 AND status = 'backlog'
   ORDER BY created_at`;

export function findStalls(db: Database): StallReport {
  const rows = db.prepare(PARENTS_SQL).all() as Array<{
    id: string; text: string; status: string; dispatch_state: string | null;
  }>;
  const stalls: Stall[] = rows.map((r) => ({
    parent: { id: r.id, text: r.text, status: r.status, dispatchState: r.dispatch_state ?? null },
    parked: db.prepare(PARKED_SQL).all(r.id) as Array<{ id: string; text: string }>,
  }));
  return {
    stalls,
    parents: stalls.length,
    cards: stalls.reduce((n, s) => n + 1 + s.parked.length, 0),
  };
}

export function defaultDbPath(): string {
  return process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "topics.db")
    : join(import.meta.dir, "..", "data", "topics.db");
}

const short = (s: string, n = 64) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export function render(report: StallReport): string {
  if (report.parents === 0) return "Nessuno stallo muto: 0 padri, 0 card ferme.";
  const righe = report.stalls.flatMap((s) => [
    `  ${s.parent.id.slice(0, 8)}  ${s.parent.status}${s.parent.dispatchState ? ` · ${s.parent.dispatchState}` : ""}  ${short(s.parent.text)}`,
    ...s.parked.map((c) => `    └ ${c.id.slice(0, 8)}  backlog  ${short(c.text)}`),
  ]);
  return [
    `Stalli muti: ${report.parents} padri, ${report.cards} card ferme.`,
    ...righe,
    "",
    "Ognuno si apre da sé rispondendo alla domanda sulla card del padre",
    "(«Rimetti in coda i sottotask» / «Archivia i sottotask»). Se la domanda",
    "non c'è, è quella la cosa rotta: il padre è fermo e non lo sta dicendo.",
  ].join("\n");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const has = (n: string) => argv.includes(`--${n}`);
  const opt = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dbPath = opt("db") ?? defaultDbPath();
  const db = new Database(dbPath, { readonly: true });
  const report = findStalls(db);
  db.close();
  console.log(has("json") ? JSON.stringify(report, null, 2) : render(report));
  if (has("gate") && report.parents > 0) process.exit(1);
}
