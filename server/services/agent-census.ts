// agent-census.ts — quanti agenti sono VIVI su questa macchina adesso.
//
// PERCHÉ ESISTE. Fino a ieri la risposta era una sola query, scritta dentro il
// claim: «conta le righe `tasks` in_progress con un chip di dispatch vivo».
// Reggeva perché un task dispatchato era esattamente UN processo: l'agente di
// board leggeva, provava, scriveva e committava da solo, e il tetto di
// concorrenza contando le card contava anche i processi.
//
// Il modello del coordinatore rompe quell'uguaglianza. La sessione del task
// decide e delega: il lavoro vero gira in sessioni FIGLIE, lanciate da lì con
// `spawn_agent`. Una card sola può quindi valere tre processi, e il tetto che
// conta le card non è più un tetto: con «Agenti in parallelo = 3» si arriva a
// nove `claude` vivi senza che nessuna riga della board se ne accorga. È
// esattamente la ragione per cui i tool di fan-out erano stati tolti al profilo
// dispatch, e riaccenderli senza questo modulo li rimetterebbe fuori governo.
//
// LA DEFINIZIONE, in una riga: un agente vivo è un TASK dispatchato oppure una
// SESSIONE FIGLIA di un task dispatchato. Nient'altro. Le chat interattive
// dell'umano e i loro sotto-agenti non entrano nel conto: quel tetto governa il
// dispatch automatico, non ciò che una persona apre a mano, e contarle
// significherebbe che aprire una chat spegne la board.
//
// DUE LETTORI, UNA DEFINIZIONE. Il claim (`TaskService.claim`) chiede «c'è
// posto per un altro task?»; la rotta di spawn chiede «c'è posto per un'altra
// figlia?». Sono la stessa domanda su due porte, e due copie della query
// sarebbero due tetti che divergono al primo cambio di predicato.

import type { Database } from "bun:sqlite";

/** Il chip di dispatch che dice «questo task ha un agente dentro un turno adesso». */
const LIVE_DISPATCH_STATES = "('starting','working')";

/**
 * «Il task ha ancora una sessione sua», che NON è la stessa domanda del chip.
 *
 * Il chip dice se un turno è in volo; questo dice se la sessione esiste ancora.
 * Fra un turno e l'altro un task dispatchato passa per `needs_input` (sta
 * aspettando una risposta) e per `waiting` (attesa dichiarata): il chip lì è
 * spento, ma il coordinatore riprenderà da dove aveva lasciato, e le sue
 * sessioni di lavoro devono trovarsi ancora al loro posto. Raccoglierle col
 * predicato del chip vorrebbe dire ammazzare il lavoro ogni volta che il
 * coordinatore fa una domanda: proprio il caso che questa campagna esiste per
 * rendere comodo.
 *
 * Fuori da `in_progress` invece la sessione non torna: consegna in review,
 * parcheggio, archiviazione, fallimento. Quello è il momento della cascata.
 */
const PARENT_ALIVE = "t.status = 'in_progress' AND t.archived = 0";

/** The prefix every chat session key carries. */
export const TOPIC_SESSION_KEY_PREFIX = "topic:";

/**
 * How many characters of the topic id production puts in the session key.
 *
 * MEASURED on the live `data/topics.db` (read-only): 975 of 978 topics carry
 * `topic:` + the FIRST 8 CHARACTERS of the id, and every one of the 29
 * `terminal_sessions.parent_session_key` values is 14 characters long, i.e.
 * `topic:` + 8. The three exceptions are seeded topics whose id is itself
 * shorter than the slice. Not one row is in the `topic:` + full-uuid form.
 */
export const TOPIC_SESSION_KEY_ID_CHARS = 8;

/**
 * Lo `sessionKey` della chat di un task: è la forma che il dispatcher lega al
 * topic (`bindTopic`) e quella che il bridge MCP passa a ogni rotta.
 *
 * IT TRUNCATES, and that is the whole point of this helper existing. The key
 * on disk is `topic:` + the first 8 characters of the id — the shape written by
 * `server/lib/session-control-core.ts:85`, `server/routes/topics.ts:1115` and
 * `client/src/state/pane/adapters/paneConfig.ts:399`. Every SQL predicate in
 * this module and every fixture in its test derive the shape from HERE, because
 * the alternative was measured: the tests built keys with the full id, the
 * sweeps joined on the full id, both agreed with each other, and the pair was
 * wrong about every row production had ever written.
 */
export function topicSessionKey(topicId: string): string {
  return TOPIC_SESSION_KEY_PREFIX + topicId.slice(0, TOPIC_SESSION_KEY_ID_CHARS);
}

/**
 * SQL: does the session key in `keyExpr` address the topic id in `idExpr`?
 *
 * Both arguments are COLUMN EXPRESSIONS or bound-parameter names written by
 * this module — never user input — so the interpolation carries no injection
 * surface; the alternative (spelling the disjunction out at each call site) is
 * exactly the copy-per-query that let the two sweeps drift apart.
 *
 * It accepts the truncated form AND the full-id form: three legacy rows still
 * carry the second one, and a predicate that reaps has to err toward matching a
 * parent that exists, never toward declaring it gone.
 *
 * The 8-character prefix is not unique in principle, so callers must use this
 * inside EXISTS/NOT EXISTS rather than a JOIN: a colliding prefix would
 * otherwise duplicate a child row into the result, and one dead namesake would
 * be enough to have a live parent's child collected.
 */
export function topicSessionKeyMatchesSql(keyExpr: string, idExpr: string): string {
  return `(${keyExpr} = '${TOPIC_SESSION_KEY_PREFIX}' || substr(${idExpr}, 1, ${TOPIC_SESSION_KEY_ID_CHARS})
        OR ${keyExpr} = '${TOPIC_SESSION_KEY_PREFIX}' || ${idExpr})`;
}

/** `LIKE` guard that cheaply skips every non-chat parent before the EXISTS. */
const IS_TOPIC_KEY = `ts.parent_session_key LIKE '${TOPIC_SESSION_KEY_PREFIX}%'`;

/** «Questa figlia appartiene a un task» — la stessa riga per tutte le query. */
const OWNED_BY_TASK = `EXISTS (
  SELECT 1 FROM tasks t
   WHERE t.assigned_topic_id IS NOT NULL
     AND ${topicSessionKeyMatchesSql("ts.parent_session_key", "t.assigned_topic_id")})`;

/**
 * Quanti TASK hanno un agente vivo. `projectId` assente = a macchina intera
 * (lo scope `global` del claim: N board non possono moltiplicarsi in N×tetto).
 */
export function dispatchedTaskCount(db: Database, projectId?: string | null): number {
  const sql = projectId
    ? `SELECT COUNT(*) AS c FROM tasks
        WHERE project_id = ? AND status = 'in_progress'
          AND dispatch_state IN ${LIVE_DISPATCH_STATES} AND archived = 0`
    : `SELECT COUNT(*) AS c FROM tasks
        WHERE status = 'in_progress'
          AND dispatch_state IN ${LIVE_DISPATCH_STATES} AND archived = 0`;
  const stmt = db.prepare(sql);
  const row = (projectId ? stmt.get(projectId) : stmt.get()) as { c?: number } | undefined;
  return row?.c ?? 0;
}

/**
 * Quante SESSIONI FIGLIE di task dispatchati sono vive.
 *
 * `status = 'active'` è il predicato di vita della tabella: una sessione che
 * muore viene cancellata, e una che perde il bridge diventa `dormant`. Contare
 * anche le dormienti terrebbe occupato un posto per un processo che non esiste
 * più, cioè il verso sbagliato in cui sbagliare: la board si fermerebbe da
 * sola.
 *
 * La join è a UN livello apposta, e non è una semplificazione: le figlie di
 * board hanno profondità massima 1 (vedi `boardSpawnRefusal`), quindi un
 * secondo livello sarebbe una riga di SQL per un caso che la stessa porta
 * rifiuta di creare.
 */
export function boardChildCount(db: Database, projectId?: string | null): number {
  const scope = projectId ? "AND t.project_id = ?" : "";
  // EXISTS, non JOIN: la chiave porta solo 8 caratteri dell'id, quindi due
  // task con lo stesso prefisso conterebbero la stessa figlia due volte.
  const sql = `SELECT COUNT(*) AS c
                 FROM terminal_sessions ts
                WHERE ts.status = 'active'
                  AND ${IS_TOPIC_KEY}
                  AND EXISTS (
                        SELECT 1 FROM tasks t
                         WHERE t.assigned_topic_id IS NOT NULL
                           AND ${topicSessionKeyMatchesSql("ts.parent_session_key", "t.assigned_topic_id")}
                           AND ${PARENT_ALIVE}
                           ${scope})`;
  const stmt = db.prepare(sql);
  const row = (projectId ? stmt.get(projectId) : stmt.get()) as { c?: number } | undefined;
  return row?.c ?? 0;
}

/** Task dispatchati + loro figlie vive: il numero che il tetto governa. */
export function liveAgentCount(db: Database, projectId?: string | null): number {
  return dispatchedTaskCount(db, projectId) + boardChildCount(db, projectId);
}

/**
 * Il task di board a cui appartiene una sessione, o `null`.
 *
 * Risponde sia per la chat del task (`topic:<id>` legato al task) sia per una
 * sua figlia (una riga `terminal_sessions` il cui `parent_session_key` è quel
 * `topic:<id>`). È il perno di TUTTO ciò che sta sotto il governo della board:
 * il tetto sullo spawn, la contabilità dei token sul padre e l'instradamento di
 * una domanda nel thread del task chiedono tutti la stessa cosa — «di chi è
 * questa sessione?» — e devono rispondere allo stesso modo.
 *
 * Il task NON deve essere per forza `in_progress`: un figlio che pone una
 * domanda mentre il padre è già in review appartiene ancora a quel task, e
 * negarlo lo lascerebbe muto.
 */
export function boardTaskForSession(
  db: Database,
  sessionKey: string,
): { taskId: string; projectId: string; topicId: string; isChild: boolean } | null {
  // La chiave porta 8 caratteri dell'id, non l'id: confrontarla con
  // `assigned_topic_id` nudo non ha MAI trovato una riga di produzione, e il
  // `null` che ne usciva spegneva in silenzio sia il tetto sia l'instradamento.
  const byKey = (key: string, isChild: boolean) => {
    const row = db
      .prepare(
        `SELECT id, project_id, assigned_topic_id FROM tasks
          WHERE assigned_topic_id IS NOT NULL AND archived = 0
            AND ${topicSessionKeyMatchesSql("$key", "assigned_topic_id")}
          LIMIT 1`,
      )
      .get({ $key: key }) as { id?: string; project_id?: string; assigned_topic_id?: string } | undefined;
    if (!row?.id || !row.project_id || !row.assigned_topic_id) return null;
    return { taskId: row.id, projectId: row.project_id, topicId: row.assigned_topic_id, isChild };
  };

  if (sessionKey.startsWith(TOPIC_SESSION_KEY_PREFIX)) return byKey(sessionKey, false);

  // Una figlia: la riga porta il `parent_session_key` del coordinatore.
  const child = db
    .prepare("SELECT parent_session_key FROM terminal_sessions WHERE id = ?")
    .get(sessionKey) as { parent_session_key?: string | null } | undefined;
  const parent = child?.parent_session_key;
  if (!parent || !parent.startsWith(TOPIC_SESSION_KEY_PREFIX)) return null;
  return byKey(parent, true);
}

/**
 * Le figlie rimaste senza padre: il loro task non ha più un agente vivo.
 *
 * LA CASCATA ESISTEVA GIÀ, ma solo per un padre TERMINALE: quando una sessione
 * di terminale muore, il frame `exit` del bridge le porta via le figlie. La
 * sessione di un task non è una sessione di terminale — è una chat
 * (`topic:<id>`) — e nessun frame `exit` la riguarda: le sue figlie
 * sopravvivevano alla consegna del task, tenendo vivo un `claude` che nessuno
 * guardava e, da oggi, un posto sotto il tetto.
 *
 * È una SPAZZATA e non un aggancio all'uscita apposta: un task smette di essere
 * dispatchato per molte strade diverse (consegna, fallimento, parcheggio,
 * interruzione umana, riavvio del server), e un aggancio per strada è un elenco
 * che al primo ramo nuovo diventa incompleto in silenzio. La domanda «il padre
 * ha ancora un agente vivo?» invece è una sola, e vale su tutte le strade.
 *
 * Le figlie di una sessione che non è di un task non compaiono mai in QUESTA
 * query: quel `parent_session_key` non risolve a nessuna riga di `tasks`. Se ne
 * occupa `orphanChatChildSessions`, che chiede la stessa cosa al topic.
 */
export function orphanBoardChildSessions(db: Database): string[] {
  const rows = db
    .prepare(
      // «Un task la possiede, e nessuno dei task che la possiedono è vivo».
      // Espresso con due EXISTS e non con una JOIN + NOT: con un prefisso di 8
      // caratteri la JOIN può appaiare la stessa figlia a due task, e basterebbe
      // il gemello morto per raccogliere la figlia di un padre ancora al lavoro.
      `SELECT ts.id AS id
         FROM terminal_sessions ts
        WHERE ts.status = 'active'
          AND ${IS_TOPIC_KEY}
          AND ${OWNED_BY_TASK}
          AND NOT EXISTS (
                SELECT 1 FROM tasks t
                 WHERE t.assigned_topic_id IS NOT NULL
                   AND ${topicSessionKeyMatchesSql("ts.parent_session_key", "t.assigned_topic_id")}
                   AND ${PARENT_ALIVE})`,
    )
    .all() as Array<{ id?: string }>;
  return rows.map((r) => r.id).filter((id): id is string => typeof id === "string" && !!id);
}

/**
 * The same question asked of a plain CHAT parent: is the topic that owns this
 * child still there?
 *
 * WHY A SECOND QUERY. `orphanBoardChildSessions` JOINs `tasks`, so a sub-agent
 * spawned from a chat that is not a board task matched NOTHING: it was never
 * cascaded (the bridge only cascades a TERMINAL parent), never parked
 * (`tryParkSession` refuses anything carrying a `parentSessionKey`) and never
 * swept. Its PTY outlived the chat being archived, forever, holding a `claude`
 * nobody could see. Widening the JOIN was not an option: `tasks` is exactly
 * what these rows do not have.
 *
 * The two queries are kept DISJOINT by the `NOT EXISTS` below. A task-owned
 * child answers to the task's lifecycle (`PARENT_ALIVE`), which stays alive
 * across `needs_input` and `waiting` where the topic tells you nothing; asking
 * the topic about it too would collect a coordinator's children the moment
 * someone archived the topic mid-run.
 *
 * A MISSING topic counts as dead on purpose: `parent_session_key` is a plain
 * string, not a foreign key, so a deleted topic leaves the child pointing at
 * nothing, which is the same orphan wearing a different mask.
 */
export function orphanChatChildSessions(db: Database): string[] {
  const rows = db
    .prepare(
      // «Nessun topic VIVO risponde a questa chiave». Il vecchio predicato era
      // `LEFT JOIN ... ON tp.id = substr(key, 7)`, cioè il confronto fra un id
      // intero e i suoi primi 8 caratteri: `tp.id IS NULL` era vero SEMPRE, e
      // ogni figlia di ogni chat viva usciva da qui come orfana ogni 10 secondi.
      // Formulato come NOT EXISTS di un padre vivo, un prefisso ambiguo salva la
      // figlia invece di condannarla.
      `SELECT ts.id AS id
         FROM terminal_sessions ts
        WHERE ts.status = 'active'
          AND ${IS_TOPIC_KEY}
          AND NOT EXISTS (
                SELECT 1 FROM topics tp
                 WHERE ${topicSessionKeyMatchesSql("ts.parent_session_key", "tp.id")}
                   AND tp.archived = 0)
          AND NOT ${OWNED_BY_TASK}`,
    )
    .all() as Array<{ id?: string }>;
  return rows.map((r) => r.id).filter((id): id is string => typeof id === "string" && !!id);
}

/**
 * Ogni figlia rimasta senza padre, per entrambe le forme di padre.
 *
 * È questa che lo spazzino del server chiama: una porta sola perché «il padre
 * c'è ancora?» è una domanda sola, e due chiamate separate nel giro di
 * riconciliazione sarebbero due elenchi che al primo ramo nuovo divergono.
 */
export function orphanChildSessions(db: Database): string[] {
  return [...new Set([...orphanBoardChildSessions(db), ...orphanChatChildSessions(db)])];
}

/** Cosa può impedire a una sessione di board di aprire una figlia. */
export type SpawnRefusal =
  | { ok: true }
  | { ok: false; code: "cap"; live: number; cap: number }
  | { ok: false; code: "depth" };

/**
 * Il cancello dello spawn per una sessione che appartiene a un task.
 *
 * DUE RIFIUTI, e sono due domande diverse.
 *
 *  · `cap` — la macchina è piena. Il tetto è lo STESSO numero che governa il
 *    claim, e conta la stessa popolazione: se una card che ne lancia due
 *    potesse superarlo, il tetto non sarebbe un tetto ma un suggerimento sulle
 *    card. Il conteggio guarda ADESSO, non «quante ne ha già questa card»: due
 *    coordinatori con una figlia ciascuno pesano quanto uno con due.
 *
 *  · `depth` — chi chiede è già una figlia. Profondità 1, e la ragione è che un
 *    albero profondo rende il tetto una funzione del tempo: ogni livello può
 *    riempirlo di nuovo appena qualcuno si libera, e nessuno dei livelli sa di
 *    essere quello che lo sfonda. Un livello solo tiene la contabilità piatta:
 *    il coordinatore sa quante ne ha aperte, perché le ha aperte tutte lui.
 *
 * Una sessione che NON appartiene a nessun task passa senza domande: è una chat
 * dell'umano, e questo modulo non governa quelle.
 */
export function boardSpawnRefusal(
  db: Database,
  args: { parentSessionKey: string; cap: number },
): SpawnRefusal {
  const owner = boardTaskForSession(db, args.parentSessionKey);
  if (!owner) return { ok: true };
  if (owner.isChild) return { ok: false, code: "depth" };
  const live = liveAgentCount(db);
  const cap = Math.max(1, Math.floor(args.cap) || 1);
  if (live >= cap) return { ok: false, code: "cap", live, cap };
  return { ok: true };
}
