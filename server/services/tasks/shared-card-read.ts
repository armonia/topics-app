/**
 * What a card carries when it is read: thread excerpts, labels, queue rank and the topic columns.
 */

import type { Database } from "bun:sqlite";
import { type SubtaskWork, deriveSubtaskWork, isUnattributedSubtask, type CardComment } from "../../../shared/board";
import { type LabelSource, type TaskLabel, type TaskLabelRow, isTaskLabel } from "../../../shared/task-labels";
import { UNASSIGNED_PROJECT_ID, commentAsksHuman } from "./shared-constants";
import type { QueueRank } from "./shared-types";
import type { SharedCore } from "./shared-core";

export type SharedCardRead = ReturnType<typeof createSharedCardRead>;

export function createSharedCardRead(db: Database, { idParam, rowToComment }: SharedCore) {


/**
   * Chi lavora un sottotask che non ha né topic né chip: risalendo i padri.
   *
   * Sta in `rowToTask` accanto a `resolveBlocker` per due ragioni. La prima: il
   * client non può risolverlo da sé — la sua lista è un progetto, `rootsOnly`,
   * non archiviati, e il padre di un sottotask quasi mai ci sta dentro. La
   * seconda: `rowToTask` è il mappatore UNICO, quindi metterlo qui è l'unico
   * modo perché `list`, `get`, `update` e `boundRootOf` dicano tutti la stessa
   * cosa; riempirlo nei soli `list`/`get` (come i contatori dei sottotask) lo
   * lascerebbe spento sul payload di ritorno di ogni scrittura.
   *
   * Costa ZERO sul caso normale: la guardia `isUnattributedSubtask` esclude
   * tutto tranne la forma ambigua — 1 riga viva su ~1.276 alla misura dell'11/08
   * — e solo lì parte la risalita, UNA query sola su `idx_tasks_parent`, con la
   * catena misurata profonda 2.
   *
   * NON è `boundRootOf`, che pure risale gli stessi padri: quella cerca il primo
   * antenato con un TOPIC, al lavoro o no. Qui la differenza è tutta: un padre
   * con un topic ma tornato in `backlog`/`blocked` è esattamente il caso da
   * segnalare, e `boundRootOf` lo darebbe per buono.
   *
   * La query porta su la catena e il verdetto lo dà `isAncestorAtWork` in JS —
   * non un `WHERE` che riscrive quel predicato in SQL. `ACTIVE_DISPATCH_STATES`
   * è dichiarato una volta in `shared/board` proprio perché era una lista
   * copiata in cinque posti: una sesta copia dentro una stringa SQL non la
   * vedrebbe nemmeno il compilatore.
   *
   * Il tetto sulla profondità non è per la catena vera (2), è perché una che si
   * richiude su sé stessa qui aprirebbe una CTE infinita: il cancello di
   * `parent_task_id` (migration 034) dice che un id nuovo non può essere
   * antenato di una riga esistente, ma un ciclo scritto da una migration futura
   * non deve poter appendere il server.
   */
  const MAX_ANCESTOR_DEPTH = 32;


function resolveSubtaskWork(r: any): SubtaskWork | null {
    const task = {
      status: r.status,
      parentTaskId: r.parent_task_id ?? null,
      assignedTopicId: r.assigned_topic_id ?? null,
      dispatchState: r.dispatch_state ?? null,
    };
    if (!isUnattributedSubtask(task)) return null;

    // CROSS JOIN pins the chain (a handful of ancestors) as the outer loop.
    // With planner stats on `tasks` and none on a CTE, a plain JOIN let
    // SQLite scan every task and probe the chain: 26 -> 1,133 pages.
    const rows = db.prepare(
      `WITH RECURSIVE chain(id, parent, depth) AS (
         SELECT id, parent_task_id, 0 FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id, t.parent_task_id, c.depth + 1
           FROM tasks t JOIN chain c ON t.id = c.parent
          WHERE c.depth < ?
       )
       SELECT t.id, t.text, t.status, t.dispatch_state, t.archived
         FROM chain c CROSS JOIN tasks t ON t.id = c.id
        WHERE c.depth > 0
        ORDER BY c.depth ASC`,
    ).all(r.id, MAX_ANCESTOR_DEPTH) as any[];

    return deriveSubtaskWork(task, rows.map((a) => ({
      id: a.id, text: a.text, status: a.status,
      dispatchState: a.dispatch_state ?? null, archived: !!a.archived,
    })));
  }


/**
   * Quanti commenti «di conversazione» viaggiano sulla card (vedi
   * `recentComments`). La card ne DISEGNA due — l'ultima parola e la richiesta
   * umana che risponde — ma per trovare la seconda deve guardare indietro oltre
   * la prima: `selectCardComments` risale il thread finché non trova una
   * richiesta, e con due sole lines una risposta in due tempi («ci provo» +
   * l'esito) lasciava la card senza contesto.
   */
  const CARD_COMMENTS_DEPTH = 3;


/**
   * «Parola vera», in SQL: 1 quando la riga e' la voce di qualcuno, 0 quando e'
   * contabilita' della macchina.
   *
   * E' il gemello di `contorno()` — qui sotto in `cardCommentsFor`, e in
   * `client/src/components/Board/cardComments.ts`. Le tre copie devono dire la
   * stessa cosa: se questa fosse piu' larga, la finestra trasporterebbe una
   * nota che il client poi scarta, e la card resterebbe muta come prima.
   */
  const SQL_PAROLA =
    "CASE WHEN COALESCE(c.kind, 'comment') = 'review-note' THEN 0 " +
    "     WHEN c.author = 'system' AND c.content NOT LIKE '%```question%' THEN 0 " +
    "     ELSE 1 END";


/**
   * «Questa riga l'ho scritta IO», in SQL.
   *
   * Serve alla finestra, e per una ragione misurata: `CARD_COMMENTS_DEPTH` ne
   * porta tre, e su una card viva le note della macchina si accumulano DOPO
   * l'ultima cosa che ho detto. Su `a41af39a` (20/08) fra il mio messaggio e la
   * cima c'erano 26 lines, su `235afe11` 17, su `b673a253` 16: il mio messaggio
   * stava in posizione SETTE e alla card non arrivava mai — non perche' il
   * client lo scartasse, ma perche' il server non glielo mandava.
   *
   * Chiesto cosi': «da review dovrei SEMPRE vedere l'ultimo suo e mio
   * messaggio». Senza questa riga il «sempre» valeva solo per i thread corti.
   *
   * Il gemello di `isHumanComment` (client) tenuto stretto come quello: solo
   * `kind = 'comment'`, perche' il server firma `user` anche la propria
   * narrazione quando una leva l'ha tirata una persona (Stop, archiviazione),
   * e quelle non sono parole mie.
   */
  const SQL_MIA =
    "CASE WHEN c.author = 'user' AND COALESCE(c.kind, 'comment') = 'comment' THEN 1 ELSE 0 END";


/**
   * "This row IS THE DELIVERY", in SQL.
   *
   * Same reason as `SQL_MIA`, from the other side of the thread: the summary is
   * written on the move into review and the machine speaks right after it — the
   * `review-note` with the preview, system notifications, the checks outcome.
   * `rn_parola = 1` is not enough to carry it: if the agent writes again after
   * delivering (a follow-up, a rework note), THAT is the last real word and the
   * summary drops out of the window. The card prefers it over recency, so it
   * has to be able to SEE it.
   */
  const SQL_IS_DELIVERY =
    "CASE WHEN COALESCE(c.kind, 'comment') = 'delivery' THEN 1 ELSE 0 END";


/**
   * Quanto testo di un commento viaggia sulla card, e sono DUE misure perché la
   * card ne disegna due in modo diverso.
   *
   * L'ULTIMA parola del thread la card la stampa intera, formattata, senza
   * clamp: quella tiene 1.200 caratteri (misurato il 15/08 sul DB di questa
   * macchina: 1.538 commenti idonei, 544 KB, il più lungo 4.020 caratteri —
   * sopra il tetto ci finisce il 6% di loro). Quelle PRIMA di lei compaiono
   * come riga di contesto, sotto la risposta che stanno spiegando.
   *
   * ── PERCHÉ IL CONTESTO NON È PIÙ 200 ──────────────────────────────────────
   * Erano 200 quando quella riga era «una riga sola tagliata con `truncate`»,
   * e allora bastavano. Non lo è più da un pezzo: il client la ripiega su tre
   * lines con un «mostra di più» che scatta a 190 caratteri
   * (`RICHIESTA_PIEGA_CHARS`), e la sua doc promette «il testo c'è tutto,
   * basta un click».
   *
   * Quella promessa era falsa, e di molto. Misurati i messaggi umani su questa
   * macchina: 1.215 lines, mediana 520 caratteri, p90 1.776 — il 76% sopra i
   * 200. Il bottone «mostra di più» apriva su un testo che il SERVER aveva già
   * buttato: tre lines e poi il vuoto, senza che niente lo dicesse.
   *
   * Ora il contesto tiene 620, che è `COMMENTO_PIEGA_CHARS` del client: la
   * soglia oltre la quale la card offre «mostra di più». Sotto quel numero il
   * testo c'è davvero tutto e il bottone non compare; sopra, il bottone apre su
   * qualcosa invece che sul vuoto.
   *
   * IL NUMERO NON È SCELTO, È IL PIÙ ALTO CHE STA NEL BUDGET. C'è un cancello
   * sul peso del payload della board (`tests/integration/board-payload-weight`),
   * e il suo commento nomina proprio questo errore fra i modi di sfondarlo:
   * «togliendo il taglio del testo». Misurato per gradi sulla sua fixture:
   * 200/400/620 passano, 800 sfonda (2.701 byte per task contro un tetto di
   * 2.600), e 1.200 sfonda di brutto (2.968). Alzare il tetto per far entrare
   * la mia scelta sarebbe stato spegnere il cancello invece di rispettarlo.
   *
   * Cosa compra: i messaggi umani interi passano dal 24% al 54% (1.215 lines su
   * questa macchina). Il resto arriva tagliato ma con il pieghevole che ha
   * qualcosa da aprire, che è il contratto che il client dichiara.
   *
   * Il costo in lines è misurato e trascurabile (vedi `cardCommentsFor`: 84
   * lines in più su 1.980, query invariata a 57 ms su 18.579 commenti).
   *
   * Il dettaglio del task porta il thread intero: qui basta ciò che si legge su
   * una scheda.
   */
  const CARD_COMMENT_CHARS = 1200;


const CARD_CONTEXT_CHARS = 620;


/**
   * Il taglio del testo di un commento, CHE NON PUÒ SPEZZARE UNA ```question.
   *
   * Il blocco domanda non è prosa: `parseQuestionBlock` lo legge e ne ricava i
   * bottoni di risposta rapida della card. Tagliato a metà non fallisce, torna
   * `null` — la card perde i bottoni e stampa il recinto grezzo, senza che
   * niente diventi rosso. Quindi il tetto vale sulla prosa, e un recinto aperto
   * prima del tetto viaggia fino alla sua chiusura (il più lungo sul disco il
   * 15/08 misurava 1.132 caratteri, sotto il tetto: la guardia è per quello che
   * non lo è).
   */
  const FENCE = "```";


const QUESTION_FENCE = "```question";


function cardCommentContent(content: string, max: number): string {
    if (content.length <= max) return content;
    const open = content.indexOf(QUESTION_FENCE);
    if (open >= 0 && open < max) {
      const close = content.indexOf(FENCE, open + QUESTION_FENCE.length);
      if (close >= 0) return `${content.slice(0, Math.max(max, close + FENCE.length))}…`;
    }
    return `${content.slice(0, max)}…`;
  }


/**
   * Chi DISEGNA i commenti sulla card: la colonna review, e nessun altro.
   *
   * Il gate della card è `task.status === 'review'` (Board/Card.tsx: sia il ramo
   * dell'agente sia la domanda di sistema stanno dentro quel ramo). Attaccarli a
   * tutti significava spedirli per 455 schede su 467 — 731 KB su un feed di 2 MB
   * — perché ne leggesse 11. Il predicato guarda solo la RIGA, così ogni porta
   * (lista, dettaglio, scrittura ribaltata sul WS) risponde la stessa cosa per
   * lo stesso task.
   */
  //
  // AND IN PROGRESS, since 2026-09-03: the kickoff asks the agent to comment as
  // soon as the work is framed, and it does (measured: 6 rows on one working
  // card, 2 on another), yet from the kanban the progress was a stopwatch. The
  // card draws ONE, the agent's last word (`progressWord`, client side).
  const drawsCardComments = (r: { status?: string }): boolean => r.status === "review" || r.status === "in_progress";


/** Quanti caratteri di `description` viaggiano nella lista (vedi `descriptionPreview`). */
  const DESCRIPTION_PREVIEW_CHARS = 240;


function rankQueue(nowIso: string): QueueRank {
    const rows = db.query(
      `SELECT t.priority AS priority, t.created_at AS created_at
         FROM tasks t
         LEFT JOIN board_settings bs ON bs.project_id = t.project_id
        WHERE t.archived = 0 AND t.status = 'todo'
          AND t.parent_task_id IS NULL
          AND t.project_id != ?
          AND t.assigned_topic_id IS NULL
          AND t.dispatch_attempts < COALESCE(bs.dispatch_retry_cap, 2)
          AND (t.dispatch_deferred_until IS NULL OR t.dispatch_deferred_until <= ?)
          AND t.scheduled_by IS NULL
          AND (t.blocked_by_task_id IS NULL OR EXISTS (
                 SELECT 1 FROM tasks bk
                  WHERE bk.id = t.blocked_by_task_id AND (bk.status = 'done' OR bk.archived = 1)))
        ORDER BY t.priority DESC, t.created_at ASC`,
    ).all(UNASSIGNED_PROJECT_ID, nowIso) as Array<{ priority: number; created_at: string }>;
    // Il confronto in JS è lo stesso di SQLite: `created_at` è ISO-8601 ASCII e
    // la collazione di default è BINARY, quindi `<` sulle stringhe ordina come
    // l'`ORDER BY` che ha appena prodotto queste lines.
    const bound = (p: number, c: string, orEqual: boolean): number => {
      let lo = 0; let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const r = rows[mid]!;
        const primaDiNoi = r.priority > p
          || (r.priority === p && (orEqual ? r.created_at <= c : r.created_at < c));
        if (primaDiNoi) lo = mid + 1; else hi = mid;
      }
      return lo;
    };
    return {
      ahead: (p, c) => bound(p, c, false),
      behind: (p, c) => rows.length - bound(p, c, true),
    };
  }


/** Quali colonne ha davvero lo `topics` di questo database (vedi `buildBatch`). */
  const topicsColumns = (): Set<string> => {
    try {
      return new Set((db.query("PRAGMA table_info(topics)").all() as Array<{ name: string }>).map((c) => c.name));
    } catch { return new Set<string>(); }
  };


let topicsCols: Set<string> | null = null;


const topicsHasModel = (): boolean => (topicsCols ??= topicsColumns()).has("model");


const topicsHasEffort = (): boolean => (topicsCols ??= topicsColumns()).has("effort");


function labelsFor(ids: readonly string[]): Map<string, TaskLabelRow[]> {
    const out = new Map<string, TaskLabelRow[]>();
    const rows = db.query(
      `SELECT task_id, label, source FROM task_labels
        WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY label ASC`,
    ).all(idParam(ids)) as Array<{ task_id: string; label: string; source: string }>;
    for (const r of rows) {
      if (!isTaskLabel(r.label)) continue;
      const list = out.get(r.task_id);
      const row = { label: r.label as TaskLabel, source: r.source as LabelSource };
      if (list) list.push(row); else out.set(r.task_id, [row]);
    }
    return out;
  }


/**
   * Gli ultimi commenti PARLATI di ogni task, sulla card.
   *
   * Senza questi la board apriva un `GET /api/tasks/:id` pieno per ogni card in
   * review solo per sapere cosa c'era scritto in fondo al thread — e quel
   * dettaglio si porta dietro l'INTERO thread (`svc.get`), non tre lines.
   *
   * Viaggiano su OGNI payload, non solo su `list`/`get`, per la stessa ragione
   * di `waitingOnCount` e `blockedBy`: le scritture escono sul WS come
   * `task:updated`, e un campo riempito solo in lettura si spegnerebbe a ogni
   * giro di WS fino al fetch successivo.
   *
   * Escono come `CardComment` — tre campi, testo tagliato — e non come lines
   * intere del thread: chiamati solo per le schede che li disegnano
   * (`drawsCardComments`) e ridotti a ciò che la card legge, sono 731 KB di
   * feed che non partono più.
   *
   * `kind` 'status' e 'service' restano fuori: sono cronologia delle transizioni
   * e contabilità del dispatcher, non le parole di nessuno — lo stesso taglio di
   * `isThreadSpeech`, che è il predicato con cui il client sceglie la coppia da
   * mostrare. `COALESCE` perché le lines scritte prima che `kind` esistesse lo
   * hanno NULL, e `NULL NOT IN (…)` è NULL: senza, sparivano tutte.
   *
   * L'ordine finale è `rn DESC`, non `created_at ASC`: dentro lo stesso secondo
   * (o dentro lo stesso istante di un orologio finto) due lines hanno lo STESSO
   * `created_at`, e ordinare su quello lascia decidere a SQLite. `rn` viene
   * dalla finestra, che il `rowid` lo usa già come spareggio: qui si legge al
   * contrario e la coda del thread esce sempre nello stesso ordine.
   */
  /**
   * WHO IS WAITING ON AN ANSWER, read from the thread instead of from memory.
   *
   * The live hold travels as the transient `task:awaiting-human` event, which is
   * edge-triggered and carried by nothing else: a server restart, a page reload
   * or a client that connects after the edge never learns about it, and the card
   * falls back to whatever chip it had over a turn parked on a question nobody
   * can see. Measured on 2026-09-01: one card sat 36 hours on an unanswered
   * mid-turn question showing only `queued`, and the queue read as broken.
   *
   * The durable fact is the thread, so it is recomputed on every read and cannot
   * survive the answer. It is deliberately NOT persisted into `dispatch_state`:
   * that chip takes the task out of `ACTIVE_DISPATCH_STATES`, the orphan-recovery
   * door, and a restart would strand it `in_progress` for ever - the defect this
   * repo already paid for once.
   */
  function awaitingAnswerFor(ids: readonly string[]): Set<string> {
    const out = new Set<string>();
    if (ids.length === 0) return out;
    try {
      const rows = db.query(
        `SELECT task_id, content FROM (
           SELECT c.task_id AS task_id, c.content AS content, c.created_at AS asked_at,
                  t.in_progress_at AS turn_started,
                  row_number() OVER (
                    PARTITION BY c.task_id ORDER BY c.created_at DESC, c.rowid DESC) AS rn
             FROM task_comments c
             JOIN tasks t ON t.id = c.task_id
            WHERE c.task_id IN (SELECT value FROM json_each(?))
              AND COALESCE(c.kind, 'comment') NOT IN ('status', 'service')
              AND ${SQL_PAROLA} = 1
         ) WHERE rn = 1
             AND (turn_started IS NULL OR asked_at > turn_started)`,
      ).all(idParam(ids)) as Array<{ task_id: string; content: string | null }>;
      // A QUESTION BELONGS TO ITS TURN, and dies with it.
      //
      // Without the `asked_at > turn_started` guard the card kept claiming your
      // attention over a question whose turn had been dead for 36 hours: a fresh
      // agent was dispatched on top of it and working, and the board still read
      // "waiting on you". Reported the moment it shipped, and it is the same
      // staleness `parked-question.ts` already guards for the parked-children
      // variant.
      //
      // The SAME predicate the dispatcher uses to pick the end-of-turn chip: a
      // fence it cannot read counts as a question, never as a delivery.
      for (const r of rows) if (commentAsksHuman(r.content)) out.add(r.task_id);
    } catch { return out; }
    return out;
  }


function cardCommentsFor(ids: readonly string[]): Map<string, CardComment[]> {
    const out = new Map<string, CardComment[]>();
    if (ids.length === 0) return out;
    let rows: any[];
    try {
      // LA FINESTRA NON BASTA: SERVE UNA GARANZIA.
      //
      // `rn <= DEPTH` prende le ultime tre lines parlate, e il client poi
      // scarta le note di macchina per trovare la parola vera. Funziona finche'
      // le note dopo una consegna sono meno di tre. Non lo sono: dopo ogni
      // ingresso in review ne arrivano di norma TRE — l'esito dei checks, la
      // nota sull'anteprima, «Non e' su main: <sha> — landa il ramo prima che
      // venga potato» — e il riassunto dell'agente esce dalla finestra prima
      // ancora di partire. Il client filtra correttamente e non trova niente da
      // mostrare: ripiega sulle note, e la card apre con «Non e' su main».
      //
      // Misurato il 2026-08-18 sulla board vera: delle 26 card in review/done
      // lavorate davvero da un agente, 23 avevano il suo riassunto nel thread e
      // ZERO lo mostravano; su 24 l'ultima parola era di sistema. Segnalato:
      // «parecchi task non hanno un commento utile, hanno soltanto un commento
      // di sistema, e questo mi fa capire che c'e' qualcosa di rotto».
      //
      // Quindi la seconda finestra: l'ULTIMA PAROLA VERA entra sempre, quale
      // che sia la sua distanza dal fondo. Costa al massimo una riga per card.
      // Il predicato e' lo stesso `contorno` di qui sotto e del client, scritto
      // in SQL: tre copie della stessa regola sono gia' il difetto di
      // `hasMetaRow`, ma qui la terza serve a NON trasportare cio' che le altre
      // due poi scarterebbero.
      rows = db.query(
        `SELECT * FROM (
           SELECT c.*,
                  row_number() OVER (
                    PARTITION BY c.task_id ORDER BY c.created_at DESC, c.rowid DESC) AS rn,
                  row_number() OVER (
                    PARTITION BY c.task_id, ${SQL_PAROLA}
                    ORDER BY c.created_at DESC, c.rowid DESC) AS rn_parola,
                  -- L'ULTIMA COSA CHE HO DETTO IO viaggia sempre, per quanto
                  -- indietro sia finita sotto le note della macchina.
                  row_number() OVER (
                    PARTITION BY c.task_id, ${SQL_MIA}
                    ORDER BY c.created_at DESC, c.rowid DESC) AS rn_mia,
                  -- AND THE DECLARED DELIVERY, the row the card exists for:
                  -- the machine's notes pile up right underneath it.
                  row_number() OVER (
                    PARTITION BY c.task_id, ${SQL_IS_DELIVERY}
                    ORDER BY c.created_at DESC, c.rowid DESC) AS rn_delivery,
                  ${SQL_IS_DELIVERY} AS delivery,
                  ${SQL_MIA} AS mia,
                  ${SQL_PAROLA} AS parola
             FROM task_comments c
            WHERE c.task_id IN (SELECT value FROM json_each(?))
              AND COALESCE(c.kind, 'comment') NOT IN ('status', 'service')
         ) WHERE rn <= ${CARD_COMMENTS_DEPTH}
              OR (parola = 1 AND rn_parola = 1)
              OR (mia = 1 AND rn_mia = 1)
              OR (delivery = 1 AND rn_delivery = 1)
         ORDER BY task_id ASC, rn DESC`,
      ).all(idParam(ids)) as any[];
    } catch { return out; }
    // CHI RICEVE IL TESTO INTERO E' CHI LA CARD STAMPERA', e non è più «il più
    // recente».
    //
    // La `review-note` la scrive la macchina a OGNI ingresso in review
    // («Consegna SENZA anteprima…», «Anteprima viva pronta — http://…»), quindi
    // arriva sempre DOPO il riassunto di chi ha consegnato. Con la regola
    // vecchia il taglio pieno finiva alla nota e il riassunto — che è ciò che
    // la card disegna (`selectCardComments`) — arrivava mozzato a 200
    // caratteri: misurato sulla board vera il 17/08, sette card su otto
    // troncate a esattamente 201.
    //
    // La regola nuova è la STESSA che usa il client per scegliere: la prima
    // parola vera scendendo dal più recente, e la nota solo se non c'è altro.
    // Due regole diverse sullo stesso fatto sono la forma esatta del difetto
    // già pagato con `hasMetaRow`.
    // `typeof rows` e non un `any[]` nuovo: le lines sono le stesse, e il
    // cricchetto degli `any` conta ogni occorrenza scritta a mano.
    const perTask = new Map<string, typeof rows>();
    for (const r of rows) {
      const l = perTask.get(r.task_id);
      if (l) l.push(r); else perTask.set(r.task_id, [r]);
    }
    for (const [taskId, lines] of perTask) {
      // `rn` numera dal più recente, e le lines arrivano `ORDER BY rn DESC`:
      // la più recente è l'ultima. Fra quelle, la prima che non è una nota.
      const dalPiuRecente = [...lines].reverse();
      // STESSA REGOLA DEL CLIENT, e stavolta per intero: contorno non e' solo
      // la `review-note`. Le NOTIFICHE DI STATO del sistema (`author:
      // 'system'`, `kind: 'comment'`) sono 3984 nel db, la specie piu'
      // numerosa - «l'agent ha lavorato 2 turni ma non ha spostato il task»,
      // «Worktree e branch ripuliti» - e arrivano sempre DOPO il riassunto,
      // perche' il sistema scrive per ultimo. Misurato il 17/08: un riassunto
      // da 1832 caratteri arrivava alla card tagliato a 201, perche' i 1200
      // se li prendeva la notifica.
      //
      // Una DOMANDA del sistema no: il recinto ```question e' la firma di
      // qualcosa che aspetta una risposta, ed e' l'unica cosa che tiene ferma
      // la card. Vedi `contorno()` in client/src/components/Board/cardComments.ts:
      // le due regole devono dire la stessa cosa, o il testo pieno va a una
      // riga che il client non disegna.
      const contorno = (r: (typeof rows)[number]): boolean => {
        const c = rowToComment(r);
        if (c.kind === "review-note") return true;
        if (c.author !== "system") return false;
        return !c.content.includes("```question");
      };
      // A DECLARED DELIVERY BEATS RECENCY, and the full quota follows it.
      //
      // Third copy of the rule that lives in `selectCardComments`: here we
      // decide WHO gets the 1,200 characters, there WHO gets printed. Let the
      // two drift apart and the card draws a row that arrived cut at 200 —
      // exactly the defect already paid for with the `review-note`.
      //
      // A person speaking AFTER the delivery takes it back: that is a rework,
      // and the last word is theirs again.
      const parole = dalPiuRecente.filter((r) => !contorno(r));
      const firstWord = parole.find((r) => {
        const c = rowToComment(r);
        return c.kind === "delivery" || (c.author === "user" && c.kind === "comment");
      });
      const scelta = (firstWord && rowToComment(firstWord).kind === "delivery")
        ? firstWord
        : (parole[0] ?? dalPiuRecente[0]);
      for (const r of lines) {
        const full = rowToComment(r);
        // `rowToComment` normalizza `kind` (una riga scritta prima che la
        // colonna esistesse vale 'comment'): il taglio dei campi viene DOPO, o
        // la card riceverebbe il `kind` grezzo del disco.
        const c: CardComment = {
          author: full.author,
          content: cardCommentContent(full.content, r === scelta ? CARD_COMMENT_CHARS : CARD_CONTEXT_CHARS),
          kind: full.kind,
          ...(full.messageId ? { messageId: full.messageId } : {}),
          ...(full.origin ? { origin: full.origin } : {}),
          ...(full.actorPersonName ? { actorPersonName: full.actorPersonName } : {}),
          ...(full.actorDeviceName ? { actorDeviceName: full.actorDeviceName } : {}),
        };
        const list = out.get(taskId);
        if (list) list.push(c); else out.set(taskId, [c]);
      }
    }
    return out;
  }
  return {
    CARD_COMMENTS_DEPTH,
    CARD_COMMENT_CHARS,
    CARD_CONTEXT_CHARS,
    DESCRIPTION_PREVIEW_CHARS,
    FENCE,
    MAX_ANCESTOR_DEPTH,
    QUESTION_FENCE,
    SQL_IS_DELIVERY,
    SQL_MIA,
    SQL_PAROLA,
    awaitingAnswerFor,
    cardCommentContent,
    cardCommentsFor,
    drawsCardComments,
    labelsFor,
    rankQueue,
    resolveSubtaskWork,
    topicsCols,
    topicsColumns,
    topicsHasEffort,
    topicsHasModel,
  };
}
