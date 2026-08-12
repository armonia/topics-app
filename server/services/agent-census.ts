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

/**
 * Lo `sessionKey` della chat di un task: è la forma che il dispatcher lega al
 * topic (`bindTopic`) e quella che il bridge MCP passa a ogni rotta.
 */
export function topicSessionKey(topicId: string): string {
  return `topic:${topicId}`;
}

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
  const sql = `SELECT COUNT(*) AS c
                 FROM terminal_sessions ts
                 JOIN tasks t ON ts.parent_session_key = 'topic:' || t.assigned_topic_id
                WHERE ts.status = 'active'
                  AND ts.parent_session_key IS NOT NULL
                  AND ${PARENT_ALIVE}
                  ${scope}`;
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
  const byTopic = (topicId: string, isChild: boolean) => {
    const row = db
      .prepare("SELECT id, project_id FROM tasks WHERE assigned_topic_id = ? AND archived = 0 LIMIT 1")
      .get(topicId) as { id?: string; project_id?: string } | undefined;
    if (!row?.id || !row.project_id) return null;
    return { taskId: row.id, projectId: row.project_id, topicId, isChild };
  };

  if (sessionKey.startsWith("topic:")) return byTopic(sessionKey.slice("topic:".length), false);

  // Una figlia: la riga porta il `parent_session_key` del coordinatore.
  const child = db
    .prepare("SELECT parent_session_key FROM terminal_sessions WHERE id = ?")
    .get(sessionKey) as { parent_session_key?: string | null } | undefined;
  const parent = child?.parent_session_key;
  if (!parent || !parent.startsWith("topic:")) return null;
  return byTopic(parent.slice("topic:".length), true);
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
 * Le figlie di una sessione che non è di un task non compaiono mai qui: quel
 * `parent_session_key` non risolve a nessuna riga di `tasks`, e le chat
 * dell'umano non sono affare di questo modulo.
 */
export function orphanBoardChildSessions(db: Database): string[] {
  const rows = db
    .prepare(
      `SELECT ts.id AS id
         FROM terminal_sessions ts
         JOIN tasks t ON ts.parent_session_key = 'topic:' || t.assigned_topic_id
        WHERE ts.status = 'active' AND NOT (${PARENT_ALIVE})`,
    )
    .all() as Array<{ id?: string }>;
  return rows.map((r) => r.id).filter((id): id is string => typeof id === "string" && !!id);
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
