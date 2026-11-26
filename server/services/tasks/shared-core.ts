/**
 * Clock, ids, row lookups, comment mapping and the small guards every other task-service module leans on.
 */

import type { Database } from "bun:sqlite";
import type { ServiceOpts } from "../tasks";
import type { TaskService } from "../tasks";
import { existsSync } from "node:fs";
import { type TaskComment, type TaskActionOrigin, formatStatusEvent, type TaskStatus } from "../../../shared/board";
import { RUNS_HERE_SQL } from "../agent-census";
import { INCOMPLETE_CARD_NOTICE_PREFIX, agentCardGaps } from "../../../shared/agent-card-contract";
import { type WorkflowColumn, agentAskInThread } from "../../../shared/workflow";
import { checkStage } from "../board-workflow";
import { waitsLineAsk } from "../../../shared/waits-on-person";
import { UNASSIGNED_PROJECT_ID, AUTO_PROJECT_ID, TaskServiceError } from "./shared-constants";

export type SharedCore = ReturnType<typeof createSharedCore>;

export function createSharedCore(db: Database, opts: ServiceOpts) {

  // `agentAskOnThread` needs to call back into the fully
  // assembled TaskService (same as `svc: TaskService` params elsewhere), but
  // it is called bare, with no caller to pass `this`/`svc` through. The
  // core wires this once, right after building `service`, via `bindService`.
  let serviceRef: TaskService | undefined;

  function bindService(s: TaskService): void { serviceRef = s; }


const now = opts.now ?? (() => new Date().toISOString());


const uuid = opts.uuid ?? (() => crypto.randomUUID());


const fileExists = opts.fileExists ?? existsSync;


const writeDeliverySheet = opts.writeDeliverySheet;


/**
   * L'ultima parola VERA del thread di una card, o `null`.
   *
   * «Vera» come sulla card: si saltano `status` (cronologia delle transizioni)
   * e `service` (contabilita' del dispatcher), perche' non sono parole di
   * nessuno — e' lo stesso taglio di `isThreadSpeech`, che il client applica
   * prima di decidere cosa mostrare. Se le due divergessero, la scheda
   * scriverebbe una riga che la card non mostra.
   */
  function lastWordOfThread(taskId: string): string | null {
    try {
      const r = db.prepare(
        `SELECT content FROM task_comments
          WHERE task_id = ? AND COALESCE(kind, 'comment') NOT IN ('status', 'service')
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ).get(taskId) as { content?: string } | undefined;
      const t = (r?.content ?? "").trim();
      return t || null;
    } catch { return null; }
  }


/**
   * Una nota della MACCHINA nel thread (`kind: 'review-note'`): il canale che
   * il client rende come annotazione di review e che NON sveglia l'agente —
   * lo stesso che usa `preview-manager`. Inserimento diretto e non via
   * `addComment`, che ri-chiamerebbe la promozione da cui questa nota nasce.
   * Deduplicata sul contenuto: la promozione gira a ogni transizione in review
   * e a ogni commento con allegati, e la stessa nota non va ripetuta.
   */
  function reviewNote(taskId: string, content: string): void {
    try {
      const dupe = db.prepare(
        "SELECT id FROM task_comments WHERE task_id = ? AND kind = 'review-note' AND content = ? LIMIT 1",
      ).get(taskId, content);
      if (dupe) return;
      const ts = now();
      db.prepare(
        "INSERT INTO task_comments (id, task_id, author, content, mentions, media, kind, created_at) VALUES (?, ?, ?, ?, NULL, NULL, 'review-note', ?)",
      ).run(uuid(), taskId, "system", content, ts);
      db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, taskId);
    } catch { /* best-effort */ }
  }


// The global start switch (row '*'). Closure helper — never `this` — so the
// methods survive being destructured off the service.
const readGlobalDispatch = (): boolean => {
    // `app_settings` e non piu' la riga '*' di `board_settings`: e' una
    // preferenza di MACCHINA, e stava in una tabella per progetto solo per
    // ragioni storiche. Finche' e' stata li', lo zero di default sulle lines
    // per-progetto ha avuto l'aria di una scelta e ha prodotto due diagnosi
    // sbagliate (11/08 e 15/08). Vedi la migration
    // 20260816112635-board-settings-drop-dead-auto-dispatch.
    // Best-effort come ogni altra lettura di preferenza in questo file: un DB
    // senza `app_settings` (gli schemi minimi dei test, un host a meta'
    // migrazione) vale «spento», non un'eccezione. Il verso conta: l'errore
    // opposto sarebbe far esplodere il tick del dispatcher su una tabella
    // mancante, cioe' fermare tutto per una preferenza.
    try {
      const r = db.query("SELECT auto_dispatch FROM app_settings LIMIT 1").get() as { auto_dispatch?: number | null } | undefined;
      return r ? !!r.auto_dispatch : false;
    } catch {
      return false;
    }
  };


// C'è un task pesante con un agente vivo ADESSO? Closure e non `this`, come
// sopra: il claim lo chiama, e il claim deve sopravvivere a essere destrutturato.
// Un pesante che aspetta SOLO la CI remota non macina niente qui: `ci` entra
// in checks_json (onCiWait) solo dopo i check locali, quindi finche' i check
// girano sul Mac il blocco resta (09/11: 14 card ferme 20 min dietro una CI).
const heavyInFlight = (): boolean =>
    !!db.query(
      `SELECT 1 AS h FROM tasks
        WHERE status = 'in_progress' AND dispatch_state IN ('starting','working')
          AND archived = 0 AND dispatch_weight = 'heavy' AND ${RUNS_HERE_SQL}
          AND NOT (checks_state = 'running' AND json_valid(checks_json)
                   AND json_extract(checks_json, '$.ci') IS NOT NULL) LIMIT 1`,
    ).get();


/**
   * UNA LISTA DI ID COME PARAMETRO UNICO: `json_each(?)`, non una fila di `?`.
   *
   * Due ragioni, nessuna cosmetica. `bun:sqlite` tiene compilata solo la SQL
   * passata a `db.query`, e la chiave della cache è il TESTO: un
   * `IN (?, ?, …)` costruito sulla lunghezza del lotto è una stringa diversa a
   * ogni lista, quindi non si riuserebbe mai. E il tetto dei 999 parametri di
   * SQLite sparisce senza doverlo spezzare a mano: 467 radici ci stavano,
   * 2.135 task no.
   */
  const idParam = (ids: Iterable<string>): string => JSON.stringify([...new Set(ids)]);


/**
   * A GROUPING PARENT IS NOT A WORK CARD. A card born in backlog that no turn
   * ever touched becomes a container the moment a child is hung under it (same
   * predicate as PARKED_CHILDREN_CANDIDATES_SQL in task-timer-reads.ts): the
   * agent-card contract asks a work card for a bar and a source, a container
   * has nothing to finish on its own. Measured 08/11: 15 grouping parents,
   * each born with "Incomplete card" in its thread and the chip on top. The
   * flag goes, and with it the system comment the birth wrote.
   */
  function releaseContainerFromCardContract(parentId: string): void {
    const released = db.prepare(
      `UPDATE tasks SET created_missing = NULL
        WHERE id = ? AND created_missing IS NOT NULL
          AND status = 'backlog' AND dispatch_attempts = 0
          AND in_progress_at IS NULL AND delivered_by IS NULL AND dispatch_state IS NULL`,
    ).run(parentId);
    if (Number(released.changes ?? 0) === 0) return;
    db.prepare("DELETE FROM task_comments WHERE task_id = ? AND author = 'system' AND content LIKE ?")
      .run(parentId, `${INCOMPLETE_CARD_NOTICE_PREFIX}%`);
  }


/**
   * What an agent's card still lacks, recomputed from the row so it shrinks as
   * the card is completed. Only a card born subject to the contract
   * (`created_missing` not NULL) is ever flagged: old cards stay as they were.
   */
  function liveCardGaps(r: { created_missing?: unknown; description?: string | null; description_preview?: string | null; bar?: string | null; created_source?: string | null; project_id?: string }): { createdMissing?: string[] } {
    if (r.created_missing == null) return {};
    const gaps = agentCardGaps({
      // The lean list carries the 800-char SQL preview instead of the body: enough to judge context.
      description: r.description ?? r.description_preview, bar: r.bar, source: r.created_source,
      hasDirectory: r.project_id !== AUTO_PROJECT_ID && r.project_id !== UNASSIGNED_PROJECT_ID,
    });
    return gaps.length ? { createdMissing: gaps } : {};
  }


/**
   * Fill board-badge counters onto already-built tasks: direct-children
   * progress, the human interaction count (user 'comment' messages), and —
   * since `collaborator-activity` — the most recent collaborator identity
   * (`lastActorPersonName`/`lastActorDeviceName`).
   *
   * Tutte e tre le aggregazioni sono LEGATE AGLI ID IN MANO. Erano due scansioni
   * intere e senza filtro, su ogni lista e su ogni opening di task: quella su
   * `task_comments` (11.994 lines il 15/08, la tabella che cresce più in fretta)
   * non aveva nemmeno un indice utilizzabile — `idx_task_comments_task` è su
   * `task_id` soltanto, quindi il filtro su autore e tipo era comunque una
   * scansione. L'indice che la copre è
   * `idx_task_comments_task_author_kind`.
   */
  let stageColumn: boolean | null = null;


/** Does `tasks` have the workflow column? Read once: a reduced test schema may not. */
  function tasksHaveStage(): boolean {
    if (stageColumn !== null) return stageColumn;
    try { stageColumn = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).some((c) => c.name === "stage"); } catch { stageColumn = false; }
    return stageColumn;
  }


/**
   * `guest:<deviceId>` → the person and device that actually wrote the row, or
   * null when nothing resolves (revoked device, deleted person, non-guest
   * author). Never touches `task_comments`: the identity is looked up fresh
   * every read, the same choice `shared/comment-author.ts` documents for the
   * `agent:` prefix — the row is not worth a migration, the label is derived.
   */
  function resolveGuestActor(author: string | null | undefined): { personName: string | null; deviceName: string | null } | null {
    if (typeof author !== "string" || !author.startsWith("guest:")) return null;
    const deviceId = author.slice("guest:".length).trim();
    if (!deviceId) return null;
    try {
      const row = db.prepare(`
        SELECT d.name AS device_name, p.display_name AS person_name
          FROM devices d
          LEFT JOIN people p ON p.id = d.person_id
         WHERE d.id = ?`).get(deviceId) as { device_name?: string; person_name?: string } | undefined;
      if (!row) return null;
      return { personName: row.person_name ?? null, deviceName: row.device_name ?? null };
    } catch {
      // Schema older than the devices/people tables: no identity to resolve.
      return null;
    }
  }


function rowToComment(r: any): TaskComment {
    let mentions: string[] = [];
    if (r.mentions) { try { mentions = JSON.parse(r.mentions); } catch { mentions = []; } }
    let media: string[] = [];
    if (r.media) { try { media = JSON.parse(r.media); } catch { media = []; } }
    // Every kind the client can act on has to survive the round-trip. A kind
    // missing from this list is written to disk and read back as a plain
    // comment, which is silent: the row still renders, just without whatever
    // the mark was for. That is exactly how 'service' - the dispatcher's own
    // bookkeeping, marked at the source so the thread can fold it - came back
    // unmarked from both `addComment` and `get()`, leaving the fold with
    // nothing to fold. Unknown values still fall back to 'comment', so a typo
    // at a call site costs a visible row rather than a hidden one.
    const kind: TaskComment["kind"] =
      r.kind === "status" ? "status"
        : r.kind === "review-note" ? "review-note"
          : r.kind === "service" ? "service"
            : r.kind === "delivery" ? "delivery"
              : "comment";
    const guestActor = resolveGuestActor(r.author);
    return {
      id: r.id, taskId: r.task_id, author: r.author, content: r.content, mentions, media, createdAt: r.created_at, kind,
      messageId: r.message_id ?? null, origin: r.origin ?? null, quiet: r.quiet === 1 ? true : null,
      actorPersonName: guestActor?.personName ?? null,
      actorDeviceName: guestActor?.deviceName ?? null,
    };
  }


let commentOriginColumn: boolean | null = null;


function supportsCommentOrigin(): boolean {
    if (commentOriginColumn === null) {
      const columns = db.prepare("PRAGMA table_info(task_comments)").all() as Array<{ name?: string }>;
      commentOriginColumn = columns.some((column) => column.name === "origin");
    }
    return commentOriginColumn;
  }


/**
   * Append a status-transition event to the thread (kind='status'). Direct
   * INSERT — no dedupe, no question composing: transitions are deliberate
   * writes and each one IS the history entry ("chi l'ha spostato e quando").
   * The task's own status write already bumped updated_at (change signal).
   *
   * `reason` risponde alla terza domanda, quella che mancava: PERCHÉ. Una card
   * che esce da `done` perché il land è andato in conflitto era indistinguibile
   * da un umano che l'ha ritirata a mano — stessa riga, stesso autore. Il
   * formato lo scrive `formatStatusEvent`, e nessuno lo compone a mano.
   */
  function logStatus(taskId: string, from: string, to: string, by: string, reason?: string | null, origin?: TaskActionOrigin): void {
    try {
      const recordedOrigin = origin ?? ((by === "system" || by === "dispatcher" || by === "verifier") ? "system" : null);
      if (supportsCommentOrigin()) {
        db.prepare(
          "INSERT INTO task_comments (id, task_id, author, content, kind, created_at, origin) VALUES (?, ?, ?, ?, 'status', ?, ?)",
        ).run(uuid(), taskId, by || "system", formatStatusEvent(from, to, reason), now(), recordedOrigin);
      } else {
        db.prepare(
          "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?, ?, ?, ?, 'status', ?)",
        ).run(uuid(), taskId, by || "system", formatStatusEvent(from, to, reason), now());
      }
    } catch { /* history is best-effort — never fail the transition itself */ }
  }


function getTaskRow(taskId: string): any {
    return db.query("SELECT * FROM tasks WHERE id = ?").get(taskId);
  }


/**
   * Validate a blocked-by edge `taskId → blockerId`. The blocker must exist
   * and be alive; self-blocks and cycles (walking the blockers' own chain)
   * are rejected: a cycle would deadlock the whole dispatch queue.
   *
   * The two ends may sit on DIFFERENT boards, on purpose: the waiting counter
   * resolves dependents outside the blocker's own project (`tasks.test.ts`,
   * the "N waiting" counter), and an agent dispatched on a per-task directory has a
   * board of its own. What that costs is a refusal to archive quoting a card
   * the person cannot see on screen, so `assertNoLiveDependents` names the
   * other board in its message instead of the edge being forbidden here.
   */
  function assertBlockerValid(taskId: string, blockerId: string): void {
    const blocker = getTaskRow(blockerId);
    if (!blocker || blocker.archived) {
      throw new TaskServiceError("not_found", `blocker task ${blockerId} not found`);
    }
    if (blockerId === taskId) {
      throw new TaskServiceError("invalid_input", "a task cannot be blocked by itself");
    }
    let cur: string | null = blocker.blocked_by_task_id ?? null;
    for (let hops = 0; cur && hops < 100; hops++) {
      if (cur === taskId) throw new TaskServiceError("invalid_input", "blocked-by chain would form a cycle");
      cur = (getTaskRow(cur)?.blocked_by_task_id ?? null) as string | null;
    }
  }


/**
   * Archiving `taskId` must not silently unblock a live dependent:
   * `isDispatchBlocked` reads `blocker.archived = 1` the same as `blocker.status
   * = 'done'`. Walks the WHOLE subtree `archiveSubtree` is about to take down:
   * a root-only check misses a non-done CHILD that is itself still the blocker
   * of a card outside the subtree (`?withChildren=1`, a grandchild in
   * `status.ts`/`worktree.ts`). Dependents INSIDE the same subtree are not
   * blockers: they archive together, in the same call. `extraExclude` covers a
   * sibling batch archived in the same decision (`resolveParkedChildren`),
   * where an internal `blockedByTaskId` between two parked children must not
   * block the batch either.
   *
   * `detachingOpenChildren` is the board DELETE without `?withChildren=1`,
   * which UNHOOKS the open direct children instead of archiving them: they
   * stay on the board as root cards, so their own subtrees are not going away
   * and a dependent of theirs is no reason to refuse. Checking them anyway made
   * a single waiting card enough to keep an ancestor from ever being archived.
   */
  function assertNoLiveDependents(
    taskId: string,
    extraExclude: Iterable<string> = [],
    opts: { detachingOpenChildren?: boolean } = {},
  ): void {
    // What the archive will REALLY take down. Mirrors the route's own order:
    // detach first, archive after, so the detached children and everything
    // under them never enter the set.
    const pruned = opts.detachingOpenChildren
      ? (db.prepare(
          "SELECT id FROM tasks WHERE parent_task_id = ? AND archived = 0 AND status != 'done'",
        ).all(taskId) as Array<{ id: string }>).map((r) => r.id)
      : [];
    const descendantRows = db.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
          WHERE t.id NOT IN (SELECT value FROM json_each(?))
       )
       SELECT t.id, t.status FROM subtree s JOIN tasks t ON t.id = s.id`,
    ).all(taskId, JSON.stringify(pruned)) as Array<{ id: string; status: string }>;
    if (descendantRows.length === 0) return;
    // A member already `done` had already unblocked its dependents before this
    // call (`isDispatchBlocked` reads done the same as archived): archiving it
    // changes nothing, so it is never the reason to reject.
    const nonDoneIds = descendantRows.filter((r) => r.status !== "done").map((r) => r.id);
    if (nonDoneIds.length === 0) return;
    const exclude = new Set(descendantRows.map((r) => r.id));
    for (const id of extraExclude) exclude.add(id);
    const placeholders = nonDoneIds.map(() => "?").join(", ");
    const liveDependents = db.prepare(
      `SELECT id, text, project_id AS projectId, blocked_by_task_id AS blockerId FROM tasks
         WHERE blocked_by_task_id IN (${placeholders}) AND archived = 0 AND status != 'done'`,
    ).all(...nonDoneIds) as Array<{ id: string; text: string; projectId: string; blockerId: string }>;
    // A dependent whose own PARENT CHAIN is already archived is dead work, not
    // live work: `archived` is written per row, so a card reopened under an
    // archived ancestor (or born under one) keeps `archived = 0` while being
    // invisible on the board. Counting it would make its blocker's ancestor
    // impossible to archive for good, with nothing on screen to act on.
    const insideArchivedBranch = (id: string): boolean => {
      let parent = getTaskRow(id)?.parent_task_id as string | null | undefined;
      for (let hops = 0; parent && hops < 100; hops++) {
        const row = getTaskRow(parent);
        if (!row) return false;
        if (row.archived) return true;
        parent = row.parent_task_id as string | null | undefined;
      }
      return false;
    };
    const outside = liveDependents.filter((r) => !exclude.has(r.id) && !insideArchivedBranch(r.id));
    if (outside.length > 0) {
      // NAME the cards. A count alone leaves the person hunting the board for
      // which card is holding the archive, and with a deep subtree the blocker
      // is often not the card they clicked but a grandchild of it: both ends of
      // every edge go in the message, with the title, so the refusal says what
      // to go and do (review feedback, 26/11).
      const ownBoard = getTaskRow(taskId)?.project_id as string | undefined;
      const shown = outside.slice(0, 3).map((r) => {
        const title = (r.text || "").trim().slice(0, 60) || r.id;
        const via = r.blockerId === taskId ? "" : ` (via ${r.blockerId})`;
        // A dependent on ANOTHER board is not on the screen the person is
        // looking at: without its board the refusal sends them hunting.
        const board = ownBoard && r.projectId !== ownBoard ? ` on board ${r.projectId}` : "";
        return `"${title}" [${r.id}]${board}${via}`;
      }).join(", ");
      const rest = outside.length > 3 ? `, and ${outside.length - 3} more` : "";
      throw new TaskServiceError(
        "blocks_live_dependent",
        `archiving ${taskId} would leave ${outside.length} unfinished card(s) waiting on a blocker (blockedByTaskId) that goes away: ${shown}${rest}. Finish or archive those cards first, or point them at another blocker.`,
      );
    }
  }


/**
   * Un padre può ancora ADOTTARE?
   *
   * Archiviato no, e questo si guardava già. CHIUSO nemmeno, e questo mancava:
   * annidare uno step sotto una card in Done costruisce un vicolo cieco con una
   * chiamata perfettamente legittima. Nessun dispatcher prende gli step, il
   * padre è chiuso quindi nessuno ne apre più l'albero, e la sonda dei figli
   * parcheggiati esce subito su un padre `done`. Il cancello su `done` impedisce
   * di CHIUDERE un padre con figli aperti; senza questo, la stessa coppia si
   * otteneva dall'altro verso — prima chiudi, poi attacca.
   */
  function isParentAlive(parent: any): boolean {
    return !parent.archived && parent.status !== "done";
  }


/**
   * Archiviazione a cascata: archiviare un padre archivia TUTTO il sottoalbero
   * (soft-delete voluto: un sottotask orfano di un padre archiviato sarebbe una
   * riga irraggiungibile, che la board non può più mostrare in contesto).
   * Unica implementazione, condivisa da `archive()` e da `merge()`: due copie
   * significherebbero due semantiche che divergono al primo ritocco.
   */
  function archiveSubtree(taskId: string, ts: string): void {
    db.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
       )
       UPDATE tasks SET archived = 1, updated_at = ?,
         dispatch_state = CASE WHEN dispatch_state = 'queued' THEN NULL ELSE dispatch_state END
       WHERE id IN (SELECT id FROM subtree)`,
    ).run(taskId, ts);
    // The dispatcher skips archived cards: leaving 'queued' made them look like
    // a stuck queue (10/11, 11 cards "queued" for the PC for weeks).
  }


/** `checkStage` (board-workflow.ts), its refusal as the service's error. */
  function checkedStage(columns: readonly WorkflowColumn[], stage: string, status: TaskStatus | undefined): string | null {
    const r = checkStage(columns, stage, status);
    if ("error" in r) throw new TaskServiceError("invalid_input", r.error);
    return r.stage;
  }


/**
   * The question a card carries into review when nobody wrote one: the
   * «aspetta: attilio — …» line of its description, else the move the
   * delivery itself names (a branch to look at, the system's next move).
   * Without it the card sat in review asking nothing, and nobody knew what to
   * decide (10/11: e9a68aa7 had the line, 887341aa and cd972f2f a node delivery).
   */
  // Never an invented question: a card with no line and no declared move stays without one, so the auto-land
  // (which refuses a card that asks something) still takes a green invisible delivery.
  function reviewAskFallback(row: { description?: string | null }, hint?: string | null, description?: string | null): string | null {
    const line = waitsLineAsk(description ?? row.description);
    if (line) return line;
    if (hint && hint.trim()) return hint.trim().split("\n")[0]!.slice(0, 240);
    return null;
  }


/** `agentAskInThread` (shared/workflow.ts) on this card's thread. */
  function agentAskOnThread(taskId: string): string | null {
    try { return agentAskInThread(serviceRef!.get(taskId)?.comments ?? []); } catch { return null; }
  }


/**
   * The question a delivery the SYSTEM makes carries (the turn ended without
   * one, the parked-children question): `humanAsk` is what the thread or the
   * system asks the person, else the fallback above. Written only when it
   * changes something, like `update()`; the stage goes back to the plain
   * Review column.
   */
  function writeSystemDeliveryAsk(taskId: string, humanAsk: string | null, fallback?: string | null): void {
    const row = getTaskRow(taskId);
    if (!row || row.parent_task_id) return;
    // A card that reaches the person says what it asks (10/11, `solido`: three cards in review with no question)
    if (!humanAsk) humanAsk = reviewAskFallback(row, fallback);
    if (row.stage == null && row.human_ask == null && !humanAsk) return;
    db.prepare("UPDATE tasks SET stage = NULL, human_ask = ? WHERE id = ?").run(humanAsk, taskId);
  }
  return {
    agentAskOnThread,
    archiveSubtree,
    assertBlockerValid,
    assertNoLiveDependents,
    bindService,
    checkedStage,
    commentOriginColumn,
    fileExists,
    getTaskRow,
    heavyInFlight,
    idParam,
    isParentAlive,
    lastWordOfThread,
    liveCardGaps,
    logStatus,
    now,
    readGlobalDispatch,
    releaseContainerFromCardContract,
    resolveGuestActor,
    reviewAskFallback,
    reviewNote,
    rowToComment,
    serviceRef,
    stageColumn,
    supportsCommentOrigin,
    tasksHaveStage,
    uuid,
    writeDeliverySheet,
    writeSystemDeliveryAsk,
  };
}
