// boot-partial-sweep.ts — notifica nella chat quando un turno viene resettato
// al riavvio del server.
//
// PERCHE' E' UN MODULO. Il partial sweep di boot (`server.ts`) tocca ogni
// sessione con `partial=1` e decide se tenerla (figlio vivo nel broker) o
// resettarla (figlio morto). Fino al 2026-08-18, quando resettava non diceva
// niente nella chat: l'utente vedeva solo il cartello "Interrotto" dentro il
// blocco del tool, non un messaggio leggibile nel thread.
//
// Questo modulo isola la logica: inserimento della notifica E decisione
// kept/reset. Si iniettano il database e il set di sessioni vive nel broker;
// non si aprono connessioni, non si fa broadcast. Testabile in isolamento con
// un database in-memory senza avviare il server intero.
//
// QUALE RAMO SCATTA DAVVERO. Il ramo "kept" (figlio vivo nel broker) resta qui
// perche' e' il fail-safe corretto e le chat su provider `claude-code` possono
// ancora prenderlo. Ma per le card sul runtime nativo `topics` e' irraggiungibile
// per costruzione: il nativo non ha `reattach`, un turno nativo vive DENTRO il
// processo del server, e quando il server muore non resta nessun figlio da
// adottare. Misura sul database vivo: 365 riprese in diretta il 13/08, zero dal
// 17/08, 303 riprese da capo il 18/08. Il muro e' il 16/08, quando le card sono
// passate al nativo. Quindi per una card il ramo che scatta e' SEMPRE il reset,
// ed e' esattamente per questo che il reset non puo' piu' essere muto.
//
// IL MESSAGGIO CHE INSERISCE usa il prefisso ⚠️ che il client gia' riconosce
// come "turno in errore" (LEGACY_ERROR_PREFIX in turnError.ts). Questo attiva
// due comportamenti esistenti senza nessun cambiamento al client:
//   1. il banner ambra che spiega cosa e' andato storto;
//   2. il bottone "Riprova" (turnIsOnlyError = true, niente tool_calls).
// Il bottone ripesca l'ultimo messaggio dell'utente e lo reinvia: esattamente
// quello che la task chiedeva come "modo per riprendere senza riscrivere".

/**
 * Il testo del messaggio di notifica.
 *
 * Sta qui (non solo in server.ts) cosi' i test possono asserire sul contenuto
 * esatto senza accoppiare la stringa letterale in piu' posti.
 */
export const RESTART_INTERRUPTED_MARKER =
  "\u26a0\ufe0f Turno interrotto da un riavvio del server. Il messaggio che hai inviato e' ancora qui: premi Riprova per inviarlo di nuovo.";

/** Minimo di database che serve per il sweep e l'inserimento della notifica. */
export interface PartialSweepDb {
  query(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  run(sql: string, params?: unknown[]): { changes: number };
}

/** Il risultato di un singolo giro del partial sweep. */
export interface SweepResult { cleared: number; kept: number }

/**
 * Esegue il partial sweep su un database gia' aperto.
 *
 * La decisione per ogni session_key con partial=1:
 *   - `listConfirmed=false` → nessun reset (fail-safe: non orfaniamo turni forse vivi).
 *   - `listConfirmed=true && liveSessions.has(sk)` → tenuto (il figlio e' vivo nel broker).
 *   - `listConfirmed=true && !liveSessions.has(sk)` → reset + notifica nella chat.
 *
 * La funzione e' pura rispetto al resto del server: non apre connessioni, non
 * fa broadcast, non conosce il broker. Chi la chiama ha gia' risolto queste
 * dipendenze e passa `liveSessions` gia' popolato.
 *
 * `generateId` e `now` sono iniettati per rendere la funzione deterministica
 * in test (comportamento identico a `insertRestartNotification`).
 */
export function runBootPartialSweep(
  db: PartialSweepDb,
  opts: {
    listConfirmed: boolean;
    liveSessions: ReadonlySet<string>;
    generateId?: () => string;
    now?: () => string;
  }
): SweepResult {
  const { listConfirmed, liveSessions, generateId, now } = opts;
  let cleared = 0, kept = 0;

  const skRows = db
    .query("SELECT DISTINCT session_key AS sk FROM messages WHERE partial = 1")
    .all() as Array<{ sk: string }>;

  for (const row of skRows) {
    // Teniamo il segnale mid-turn quando:
    //   - la lista broker non e' confermata (fail-safe), OPPURE
    //   - il figlio e' ancora vivo nel broker (riadozione al riavvio).
    if (!listConfirmed || liveSessions.has(row.sk)) {
      kept++;
      continue;
    }

    const resetChanges = db.run(
      "UPDATE messages SET partial = 0, streamed_at = NULL WHERE session_key = ? AND partial = 1",
      [row.sk]
    ).changes;
    cleared += resetChanges;

    if (resetChanges > 0) {
      insertRestartNotification(db, row.sk, { generateId, now });
    }
  }

  return { cleared, kept };
}

/**
 * Inserisce un messaggio di notifica nella sessione `sessionKey` dopo che il
 * partial sweep ha resettato i suoi messaggi parziali.
 *
 * Richiamata solo quando `resetChanges > 0` — cioe' solo se c'era davvero un
 * messaggio parziale da resettare. Se la query fallisce, l'errore viene
 * rilanciato al chiamante (che puo' scegliere di loggarlo e andare avanti).
 *
 * `generateId` e' iniettato per rendere la funzione deterministica in test.
 * `now` e' iniettato per lo stesso motivo.
 *
 * `text` is the notice to write, RESTART_INTERRUPTED_MARKER by default. It is
 * overridden by whoever has another verdict to put in the thread with the same
 * shape (⚠️ + retry button): the boot resume, when it has spent its attempts on
 * the same chain and has to say so instead of stopping in silence.
 */
export function insertRestartNotification(
  db: PartialSweepDb,
  sessionKey: string,
  opts: { generateId?: () => string; now?: () => string; text?: string } = {},
): void {
  const generateId = opts.generateId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => new Date().toISOString());
  const text = opts.text ?? RESTART_INTERRUPTED_MARKER;

  const maxRow = db.query(
    "SELECT COALESCE(MAX(sort_order), -1) AS mo FROM messages WHERE session_key = ?"
  ).get(sessionKey) as { mo: number } | null;
  const nextOrder = (maxRow?.mo ?? -1) + 1;

  // IL CARTELLO DEVE STARE NEL FILO, altrimenti non lo legge nessuno.
  //
  // La riga nasceva senza `parent_id`, cioè come una SECONDA RADICE della
  // conversazione. `loadActiveThread` (server/utils.ts) cammina da una radice
  // sola seguendo i rami attivi: una seconda radice non viene mai raggiunta,
  // quindi `/api/history` non la serve e in chat non compare. Misurato il
  // 20/08 sul DB vero: 10 cartelli «Turno interrotto da un riavvio» scritti in
  // un giorno, ZERO visibili — fra cui quelli delle chat che l'utente vedeva
  // ferme senza spiegazione.
  //
  // Il padre è l'ULTIMA riga della sessione: il cartello è la cosa successiva
  // accaduta in quella conversazione, ed è esattamente lì che va letto.
  const ultimo = db.query(
    "SELECT id FROM messages WHERE session_key = ? ORDER BY sort_order DESC, rowid DESC LIMIT 1"
  ).get(sessionKey) as { id: string } | null;

  // AND THE VERDICT TRAVELS IN THE BLOCKS, not only in the text.
  //
  // The boot resume (`ripresa-boot.ts`) decides from the BLOCKS of the last
  // message: no blocks, no decision - it has a test called exactly that. This
  // row was born with the sentence in `content` alone, so the mechanism built
  // to resume the turns the boot itself killed could never see the notice the
  // boot itself had written. Both halves had tests, each with its own fake row;
  // nobody asked whether the notice actually written was one the rule accepts.
  // Read in the chat on 2026-08-28: "now it gives me turn interrupted by a
  // restart", and no resume. The mechanism was on, and could not fire.
  const verdict = JSON.stringify([{ kind: "error", text }]);
  db.run(
    `INSERT INTO messages (id, session_key, role, content, blocks, partial, timestamp, sort_order, parent_id, branch_index)
     VALUES (?, ?, 'assistant', ?, ?, 0, ?, ?, ?, 0)`,
    [generateId(), sessionKey, text, verdict, now(), nextOrder, ultimo?.id ?? null]
  );
}
