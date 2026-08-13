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
 * LA DOMANDA È UNA SOLA — «arriva un turno che muova questa checklist?» — e non
 * è la colonna in cui la card sta. Uno step non lo dispaccia MAI nessuno da solo
 * (il tick lista `rootsOnly`, «Steps are never dispatch-eligible»): la checklist
 * la muove soltanto l'agente del padre dentro il proprio turno. Quindi un figlio
 * in `todo` sotto un padre senza turno è fermo esattamente quanto uno in
 * `backlog`, e `deriveQueueReason` lo dice già da sé (`parent_review` e
 * `parent_idle`, entrambi `tone: 'stalled'`).
 *
 * DUE ESCLUSIONI, e sono la differenza fra una sonda e un allarme antipanico:
 *  · UN AGENTE STA ARRIVANDO — sul padre (`in_progress`, o chip `queued`/
 *    `starting`/`working`) o su un figlio: c'è un turno che a fine corsa se ne
 *    accorgerà.
 *  · IL PADRE STA GIÀ CHIEDENDO QUESTO: è in `review` con `delivered_reason =
 *    'parked_children'`, la firma di `askParkedChildren`. Solo quella — una
 *    review qualunque NON vale, e prima valeva: sembra che aspetti una persona,
 *    ma quella persona non ha mosse, perché approvare porta a `done` e `done`
 *    con un sottotask aperto è rifiutato (`open_subtasks`). È il vicolo cieco
 *    che ha preso otto card nella notte del 12/08, e la sonda lo escludeva.
 *
 * Ciò che resta è il silenzio: card ferme su una checklist che non si muoverà,
 * che non lo stanno dicendo a nessuno.
 *
 * Sola lettura: apre il DB `readonly` e non scrive niente, mai.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { REQUEUE_PARKED_LABEL } from "../shared/board";

export interface Stall {
  parent: { id: string; text: string; status: string; dispatchState: string | null };
  /** I sottotask fermi: sono card ferme anche loro, e vanno contate. */
  parked: Array<{ id: string; text: string; status: string }>;
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

/**
 * I tre stati in cui un agente sta arrivando o è già qui. La lista canonica sta
 * in `shared/board` (`ACTIVE_DISPATCH_STATES`) e questa stringa la ricopia per
 * l'unico motivo che lo giustifica: dentro una stringa SQL non ci si può
 * annotare. La copia PRECEDENTE ne teneva solo due — `queued` mancava — ed è la
 * differenza fra «nessun turno è previsto» e «il turno parte al prossimo tick».
 */
const AGENT_COMING = `('queued', 'starting', 'working')`;

/** Padri con una checklist aperta che nessun turno lavorerà, e che non lo dicono. */
const PARENTS_SQL = `
  SELECT p.id, p.text, p.status, p.dispatch_state
    FROM tasks p
   WHERE p.archived = 0
     AND p.status != 'done'
     -- NESSUN TURNO IN ARRIVO SUL PADRE. È l'unica cosa che conta, e non lo
     -- stato in cui la card sta: uno step non lo dispaccia mai nessuno da solo
     -- (il tick lista \`rootsOnly\`, e \`onEnterTodo\` esce subito su un figlio),
     -- quindi la checklist la muove SOLO l'agente del padre dentro il proprio
     -- turno. Senza quel turno è ferma, che i figli stiano in backlog o in todo.
     AND p.status != 'in_progress'
     -- COALESCE, non un NOT IN nudo: con dispatch_state NULL il confronto vale
     -- NULL, l'intera WHERE diventa NULL e la riga sparisce — cioè la sonda
     -- avrebbe taciuto proprio sulle card mai dispacciate.
     AND COALESCE(p.dispatch_state, '') NOT IN ${AGENT_COMING}
     -- FINESTRA DI RINVIO ANCORA APERTA = un turno è previsto, solo più tardi.
     -- \`deferForWait\` e il ramo dei sottotask aperti rimandano di 10 minuti, e
     -- \`deriveQueueReason\` chiama quella finestra \`deferred\`, \`tone: 'waiting'\`:
     -- ferma sì, ma riparte da sé. Scaduta la finestra e con la card ancora lì,
     -- nessuno è tornato — e allora è di nuovo silenzio.
     AND COALESCE(p.dispatch_deferred_until, '') <= ?
     -- L'UNICA review che non è muta: quella in cui la domanda sulla card è
     -- proprio questa. \`askParkedChildren\` la firma con \`delivered_reason\`;
     -- \`needs_input\` da solo non basta, lo scrive anche
     -- \`deliverToReviewBySystem\` per qualunque altra causa. Una review
     -- qualsiasi con la checklist aperta è il vicolo cieco misurato il 12/08:
     -- sembra che aspetti una persona, ma quella persona non ha mosse —
     -- approvare porta a \`done\`, e \`done\` con un sottotask aperto è rifiutato
     -- (\`open_subtasks\`).
     AND NOT (p.status = 'review' AND COALESCE(p.delivered_reason, '') = 'parked_children')
     -- L'ALTRA CARD CHE STA CHIEDENDO, e non poteva firmarsi. Su un padre già
     -- in review con una consegna VERA la domanda sui parcheggiati si posa nel
     -- thread e basta: muoverlo scriverebbe \`delivered_by = 'system'\` sopra la
     -- riga che dice al reviewer se sotto c'è un deliverable, quindi il marchio
     -- di sopra lì non c'è. Il marchio è la domanda stessa, e vale finché è più
     -- recente dell'ultimo movimento dei figli parcheggiati: risponderle muove
     -- i figli, e una domanda più vecchia del parcheggio parla di una
     -- configurazione che non c'è più.
     AND NOT EXISTS (
           SELECT 1 FROM task_comments tc
            WHERE tc.task_id = p.id AND tc.author = 'system'
              AND tc.content LIKE '%' || ? || '%'
              AND tc.created_at >= COALESCE(
                    (SELECT MAX(updated_at) FROM tasks
                      WHERE parent_task_id = p.id AND archived = 0 AND status = 'backlog'), ''))
     AND EXISTS (SELECT 1 FROM tasks c
                  WHERE c.parent_task_id = p.id AND c.archived = 0 AND c.status != 'done')
     -- Un figlio col PROPRIO agente addosso si muove per conto suo: finché ce
     -- n'è uno, qualcosa sta andando avanti e la card non è ferma.
     --
     -- IL CHIP, NON LA COLONNA — e vale anche per il figlio in \`review\` o in
     -- \`in_progress\` senza agente. Sembrano mosse visibili («approva il
     -- figlio»), e per il FIGLIO lo sono; per il padre no. Chiudere un figlio
     -- non ridà un turno al padre: \`parkedChildRaisedStall\` scatta quando un
     -- figlio entra in BACKLOG, non quando ne esce, e nessun'altra porta
     -- rimette il padre in coda. Approvato il figlio, il padre resta fermo
     -- esattamente dov'era, con gli altri passi ancora aperti — e stavolta
     -- senza più niente sullo schermo che lo dica. Restano dentro apposta: la
     -- domanda della sonda è sul padre.
     AND NOT EXISTS (SELECT 1 FROM tasks c
                      WHERE c.parent_task_id = p.id AND c.archived = 0 AND c.status != 'done'
                        AND COALESCE(c.dispatch_state, '') IN ${AGENT_COMING})
   ORDER BY p.updated_at`;

/**
 * I figli fermi: TUTTI quelli aperti, non i soli in backlog. Sotto un padre
 * senza turno la colonna del figlio non cambia niente — `todo` non lo rende più
 * vivo di `backlog` — e filtrare su `backlog` stampava «0 figli» proprio sul
 * caso nuovo. Lo `status` viaggia perché la riga lo scrive: scriverlo a mano
 * era una bugia su ogni figlio che in backlog non c'era.
 */
const PARKED_SQL = `
  SELECT id, text, status FROM tasks
   WHERE parent_task_id = ? AND archived = 0 AND status != 'done'
   ORDER BY created_at`;

/** `now` è iniettabile perché la finestra di rinvio si misura da lì, e un test non deve dipendere dall'orologio. */
export function findStalls(db: Database, now: string = new Date().toISOString()): StallReport {
  const rows = db.prepare(PARENTS_SQL).all(now, REQUEUE_PARKED_LABEL) as Array<{
    id: string; text: string; status: string; dispatch_state: string | null;
  }>;
  const stalls: Stall[] = rows.map((r) => ({
    parent: { id: r.id, text: r.text, status: r.status, dispatchState: r.dispatch_state ?? null },
    parked: db.prepare(PARKED_SQL).all(r.id) as Array<{ id: string; text: string; status: string }>,
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
    ...s.parked.map((c) => `    └ ${c.id.slice(0, 8)}  ${c.status}  ${short(c.text)}`),
  ]);
  return [
    `Stalli muti: ${report.parents} padri, ${report.cards} card ferme.`,
    ...righe,
    "",
    "Nessuna di queste checklist si muove da sola: uno step non lo dispaccia mai",
    "nessuno, la lavora solo l'agente del padre dentro il proprio turno. Si aprono",
    "rispondendo alla domanda sulla card del padre («Rimetti in coda i sottotask»",
    "/ «Archivia i sottotask») oppure rimettendo il padre in coda. Se sulla card",
    "quella domanda non c'è, è quella la cosa rotta: è ferma e non lo sta dicendo.",
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
  // `readonly` su un file WAL senza `-shm` vivo — cioè proprio la copia su cui
  // si indaga — muore con `SQLITE_CANTOPEN`, e lo stack di bun non nomina
  // nemmeno il file. Il codice d'uscita è SUO: 1 lo usa già `--gate` per dire
  // «ci sono stalli», e un percorso sbagliato letto come allarme manda a
  // cercare card che non esistono.
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    console.error(
      `Non riesco ad aprire ${dbPath} in sola lettura: ${(e as Error).message}\n` +
      "Se è una copia di un DB in WAL le manca il `-shm`: rifalla con\n" +
      `  sqlite3 -readonly <sorgente>.db ".backup ${dbPath}"\n` +
      "e, se serve ancora, `sqlite3 <copia> \"PRAGMA journal_mode=delete\"`.",
    );
    process.exit(2);
  }
  const report = findStalls(db);
  db.close();
  console.log(has("json") ? JSON.stringify(report, null, 2) : render(report));
  if (has("gate") && report.parents > 0) process.exit(1);
}
