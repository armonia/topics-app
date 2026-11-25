
import type { Database } from "bun:sqlite";

import { parseReviewChecks, serializeReviewChecks } from "./review-checks";

import { parseCreatedBy } from "../../shared/created-by";

import { agentCardGaps, incompleteCardNotice } from "../../shared/agent-card-contract";


import { WORKFLOW_COLUMNS } from "../../shared/workflow";

import { createTasksShared, STATUSES, UNASSIGNED_PROJECT_ID, AUTO_PROJECT_ID, commentAsksHuman, VALID_EFFORT, clampInt, TaskServiceError, GLOBAL_SETTINGS_KEY } from "./tasks/shared";
export {
  UNASSIGNED_PROJECT_ID, AUTO_PROJECT_ID, commentAsksHuman, TaskServiceError,
};
import { createCommentsMethods } from "./tasks/comments";
import { createLandMethods } from "./tasks/land";
import { createDeliveryMethods } from "./tasks/delivery";
import { createWorktreeMethods } from "./tasks/worktree";
import { createStatusMethods } from "./tasks/status";

// The statuses and the thread's shape live in `shared/board.ts`, so the client
// reads them from the same declaration instead of rewriting them. `export type
// … from` re-exports but does NOT bring the names into local scope, and they
// are needed below — hence the separate import. This module is not a door onto
// the `TASK_STATUSES` list: whoever wants it takes it from `shared/board`.
export type { BoardSettingsPatch } from "../../shared/board";
import { MAX_FANOUT, isAgentWorking } from "../../shared/board";

// Il vocabolario delle etichette e la regola che le deriva: una sola
// dichiarazione, letta anche dal client e dalla derivazione alla consegna.
import { CLOSER_LABELS, KIND_LABELS, deriveCloser, deriveKind, isCloserLabel, isKindLabel, isTaskLabel, normalizeLabels, type TaskLabel, type TaskLabelRow } from "../../shared/task-labels";
import { findNeighbours, type Neighbour } from "../../shared/task-similarity";
import type { BoardSettings, BoardSettingsPatch } from "../../shared/board";

import { allWideRows } from "../lib/wide-rows";
import type { Task, CreateTaskInput, ListTasksInput } from "./task-shapes";
import { inheritedSettingsBoardId, mergedBoardIds } from "../../shared/project-family";
import { loadFamilyRows } from "./project-family-rows";
import { readBoardSettingsRow } from "./board-settings-row";

import { withCardAttention } from "../attention/card-sync";
import { CHECKS_RUNNING_SQL } from "../lib/task-timer-reads";

export type Actor = "human" | "agent";

/**
 * The reserved quick-reply vocabulary now lives in `shared/board.ts`, because
 * the same verdict has to be reached in the CLIENT too (the in-app review
 * banner picks its title from it) and the client cannot import from `server/`.
 * Re-exported here so the ~20 call sites that read it from the task service
 * keep one import, and so there is still exactly one definition.
 *
 * - LAND_ACTION_LABEL: the agent is prompted to offer it at delivery when its
 *   work is landable; the review route matches a human's pick and runs the land
 *   instead of resuming the agent. Keep in sync with task-dispatcher.ts (both
 *   import this constant).
 * - PUBLISH_ACTION_LABEL: land AND publish (push → deploy CI). "Going online"
 *   stays a human pick; the agent never pushes.
 * - REQUEUE/ARCHIVE/PROMOTE_PARKED_LABEL: the answers to the PARKED SUBTASK STALL.
 *   Measured on 12/08 across five cards: a child in backlog is dispatched by
 *   nobody (deliberate, `hasChildrenInFlight`), the parent waiting on it gets
 *   stopped so it does not spin (deliberate too), and it ended up parked in
 *   backlog — where "still" is a card's NORMAL look. The stall was
 *   indistinguishable from rest, and only a human could unstick it.
 */
export {
  LAND_ACTION_LABEL, isLandActionLabel, isPublishActionLabel,
} from "../../shared/board";

export type { Task, UpdateTaskPatch } from "./task-shapes";

/**
 * Il patch è DERIVATO da `BoardSettings` in `shared/board.ts`: elencarne i campi
 * a mano voleva dire tenere allineate due liste (e il client ne teneva una terza,
 * già indietro di due campi).
 */
export type UpdateBoardSettingsPatch = BoardSettingsPatch;

const VALID_DISPATCH_MCP = new Set(["bridge-only", "inherit"]);

/**
 * Derive the board `project_id` from an absolute project path.
 *
 * La funzione vive in `shared/board.ts`, dichiarata UNA volta: questo modulo
 * resta la porta da cui il resto del server la importa (routes/tasks.ts,
 * lib/tab-resolver.ts, services/project-path-resolver.ts), ma non ne tiene più
 * una copia. Prima erano quarantanove, tenute insieme da un commento.
 */
export { projectIdForPath } from "../../shared/board";

import type { ServiceOpts, TaskService } from "./tasks-service-types";
export type { ServiceOpts, TaskService };

export function createTaskService(db: Database, opts: ServiceOpts = {}): TaskService {
  const shared = createTasksShared(db, opts);
  const {
    archiveSubtree,
    assertBlockerValid,
    checkedStage,
    childLeftFlight,
    getTaskRow,
    idParam,
    isParentAlive,
    labelsFor,
    now,
    readGlobalDispatch,
    releaseContainerFromCardContract,
    rowToComment,
    rowToTask,
    rowsToTasks,
    settleReviewApproval,
    uuid,
    withSubtaskCounts,
  } = shared;

  /**
   * Quanto testo SQL porta su, prima che si scelga da dove far partire
   * l'anteprima.
   *
   * Piu' di 240 perche' l'inizio si SCARTA quando e' un preambolo (vedi
   * `anteprimaUtile`): tagliando gia' in SQL a 240, il materiale per saltarlo
   * non arriverebbe mai. Il taglio finale resta 240 — quello che cambia e' da
   * dove si contano.
   *
   * 800 e non 5.000: il tetto esiste perche' la lista non trasporti le
   * descrizioni intere (misurate p90 2.131 caratteri, massimo 5.186, su 1.147
   * lines), che e' la ragione per cui `substr` sta in SQL. Copre un cappello
   * lungo piu' l'elenco che segue, senza riaprire la porta che quel taglio
   * chiudeva.
   */
  const PREVIEW_SQL_CHARS = 800;

  /**
   * LA PROIEZIONE DELLA LISTA: tutte le colonne meno le due grasse.
   *
   * Misurato il 15/08 su `GET /api/all-boards/tasks` (467 radici, 1.435.735
   * byte): `description` pesava 470 KB e `checks_json` altri 217 KB, cioè metà
   * della risposta. La card taglia la descrizione a due lines e i `checks` li
   * disegna solo il dettaglio, che passa da `svc.get` e legge `SELECT *`.
   *
   * L'elenco si CHIEDE al DB invece di scriverlo a mano: una migration che
   * aggiunge una colonna la fa comparire nel payload da sola, mentre una lista
   * fissa lascerebbe `list` indietro rispetto a `get` in silenzio — due letture
   * dello stesso task con campi diversi. Se il PRAGMA non risponde si ricade su
   * `*`: una risposta grassa è meglio di una rotta.
   */
  const listColumnsCache = new Map<string, ListProjection>();
  /**
   * Columns that ride in every board feed and that NOBODY reads off a Task.
   *
   * `listColumns` projects whatever `PRAGMA table_info(tasks)` returns, so every
   * migration that adds a column makes the hottest feed heavier and nothing says
   * so. Measured 2026-08-21 (route bench, 150 samples, passes agreeing):
   * `/api/all-boards/tasks` had gone 1.37 ms (2026-08-15) -> 3.03 ms after twelve
   * new columns; dropping all twelve gave 1.96 ms. These six have zero readers in
   * client/src AND zero reads off a Task in server/: removing them gave 2.86 ms.
   * The other six are read, so they stay. Add a column here, add a reader with it.
   *
   * Not unit-tested on purpose: asserting the fields are absent from a listed
   * Task passes with the filter removed too, because `rowsToTasks` decides what a
   * Task carries. The measurement is the evidence.
   *
   * `interrupted_at` LEFT this list on 2026-09-14: a terminal pane whose session
   * was cut mid-turn reads it to say WHY it is dormant instead of showing a bare
   * "Session ended" (see `client/src/components/Terminal/dormantCause.ts`). One
   * column back in, with its reader, which is exactly the deal above.
   */
  const COLUMNS_WITH_NO_READER = [
    "interrupted_by",
    "interrupted_notified_at",
    "nudge_claimed_at",
    "nudge_fingerprint",
    "nudge_repeats",
  ];

  // `names`: the columns in SELECT order, for `allWideRows` (Bun 1.3.8 lists `columnNames` backwards past 62);
  // `null` on the `*` fallback, whose order only SQLite knows, so that read goes through `.all()`.
  type ListProjection = { sql: string; names: readonly string[] | null };
  function listColumns(withDescription: boolean): ListProjection {
    const key = withDescription ? "full" : "lean";
    const hit = listColumnsCache.get(key);
    if (hit) return hit;
    const preview = `substr(description, 1, ${PREVIEW_SQL_CHARS}) AS description_preview`;
    let projection: ListProjection;
    try {
      const cols = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>)
        .map((c) => c.name)
        .filter((n) => n !== "checks_json" && (withDescription || n !== "description"))
        .filter((n) => !COLUMNS_WITH_NO_READER.includes(n));
      if (!cols.length) throw new Error("no columns");
      projection = { sql: `${cols.join(", ")}, ${preview}`, names: [...cols, "description_preview"] };
    } catch {
      projection = { sql: `*, ${preview}`, names: null };
    }
    listColumnsCache.set(key, projection);
    return projection;
  }

  /** Le etichette di UNA riga: il lotto da uno, per i due scrittori di etichette. */
  function labelsOf(taskId: string): TaskLabelRow[] {
    return labelsFor([taskId]).get(taskId) ?? [];
  }

  /** Direct children of a task (drawer subtask list), board order. */
  function childrenOf(taskId: string): Task[] {
    const rows = db.query(
      "SELECT * FROM tasks WHERE parent_task_id = ? AND archived = 0 ORDER BY kanban_order ASC",
    ).all(taskId) as any[];
    return withSubtaskCounts(rowsToTasks(rows));
  }

  /** `board_settings.dispatch_machine_id` of a board, or null when it has no row or no rule. */
  function boardDispatchMachineId(projectId: string): string | null {
    try {
      const r = db.prepare("SELECT dispatch_machine_id FROM board_settings WHERE project_id = ?").get(projectId) as
        { dispatch_machine_id: string | null } | null;
      return r?.dispatch_machine_id ?? null;
    } catch { return null; } // reduced schema without the column: no rule
  }

  const service: TaskService = {
    ...createCommentsMethods(db, opts, shared),
    ...createLandMethods(db, opts, shared),
    ...createDeliveryMethods(db, opts, shared),
    ...createWorktreeMethods(db, opts, shared),
    ...createStatusMethods(db, opts, shared),
    create(input: CreateTaskInput): Task {
      const text = (input.text ?? "").trim();
      if (!text) throw new TaskServiceError("invalid_input", "task text is required");
      if (!input.projectId) throw new TaskServiceError("invalid_input", "projectId is required");
      // A client that stringified a missing project ("null") would give birth to a card on a board nobody reads.
      if (/^(null|undefined|nan)$/i.test(input.projectId.trim())) throw new TaskServiceError("invalid_input", `invalid projectId "${input.projectId}"`);

      // Default `backlog`, NON `todo`. `todo` è la coda di esecuzione: un task
      // che ci nasce fa partire un agente entro pochi secondi su un board con
      // auto-dispatch. Chi crea un task senza dire dove (MCP, uno script, una
      // integrazione) sta ANNOTANDO, non dando un via — e il default lo
      // trasformava in un ordine di esecuzione. Misurato il 03/08: tre task
      // creati da chat, tre agenti dispacciati in meno di 20 secondi; due si
      // sono fermati solo perché quei progetti non erano repo git, cioè per
      // caso e non per una guardia.
      //
      // "Vai" ora si scrive: `status: "todo"` esplicito. L'interfaccia lo passa
      // già sempre (si crea trascinando nella colonna, che È lo status), quindi
      // il cambio tocca solo i chiamanti esterni — esattamente il caso da
      // correggere.
      const status = input.status ?? "backlog";
      if (!STATUSES.includes(status)) throw new TaskServiceError("invalid_input", `invalid status "${status}"`);
      if (status === "done") throw new TaskServiceError("invalid_transition", "cannot create a task already done");

      // Idempotency: same key → return the existing task, no duplicate.
      if (input.idempotencyKey) {
        const existing = db.prepare("SELECT * FROM tasks WHERE claude_task_id = ?").get(input.idempotencyKey);
        if (existing) return rowToTask(existing);
      }

      // Nesting: the parent must exist on the SAME board and be alive. Same
      // not_found shape as the projectId guard elsewhere (no cross-board probing).
      if (input.parentTaskId) {
        const parent = getTaskRow(input.parentTaskId);
        if (!parent || parent.project_id !== input.projectId || !isParentAlive(parent)) {
          throw new TaskServiceError("not_found", `parent task ${input.parentTaskId} not found`);
        }
      }

      const id = uuid();
      const ts = now();
      const priority = input.priority ?? 2;
      const maxRow = db.prepare("SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?").get(input.projectId) as any;
      const order = (maxRow?.m ?? 0) + 1;

      // Dependency at creation: the blocker must exist (a fresh id can never
      // be inside an existing chain, so the cycle walk is trivially safe).
      if (input.blockedByTaskId) assertBlockerValid(id, input.blockedByTaskId);

      // THE COLUMN IT IS BORN IN. A subtask is a step of its parent's
      // checklist, never a card of the board, so it has no column of its own.
      let birthStage: string | null = null;
      const bornAsk = (input.humanAsk ?? "").trim() || null;
      if (!input.parentTaskId) {
        const columns = WORKFLOW_COLUMNS;
        if (input.stage) birthStage = checkedStage(columns, input.stage, status);
      }

      // THE AGENT-CARD CONTRACT, in the one place every door goes through
      // (board, coordinator, session, steps). A card an agent opens without
      // what it needs is born flagged, not refused.
      const bornSource = input.createdSource?.trim().slice(0, 160) || null;
      const bornBar = input.bar?.trim() || null;
      const bornBy = parseCreatedBy(input.createdBy);
      const bornGaps = bornBy?.startsWith("agent:")
        ? agentCardGaps({
            description: input.description, bar: bornBar, source: bornSource,
            hasDirectory: input.projectId !== AUTO_PROJECT_ID && input.projectId !== UNASSIGNED_PROJECT_ID,
          })
        : null;

      db.prepare(
        `INSERT INTO tasks (id, project_id, text, description, status, priority, kanban_order, assigned_to, chat_id, created_at, completed_at, updated_at, claude_task_id, parent_task_id, plan_first, model, blocked_by_task_id, reuse_blocker_context, created_by_topic_id, priority_auto, machine_id, topics_routing, created_by, stay_local, base_branch, created_source, origin_topic_id, channel_topic_id, bar, created_missing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.projectId, text, input.description ?? null, status, priority, order,
        input.assignedTo ?? null, input.chatId ?? null, ts, ts, input.idempotencyKey ?? null,
        input.parentTaskId ?? null, input.planFirst ? 1 : 0,
        input.model ?? null, input.blockedByTaskId ?? null, input.reuseBlockerContext ? 1 : 0,
        input.createdByTopicId ?? null,
        // "Priorità automatica": no explicit choice at creation = the
        // dispatched agent evaluates and sets one at kickoff.
        input.priority === undefined ? 1 : 0,
        // No explicit machine = the board's default one (NULL when it has none).
        input.machineId === undefined ? boardDispatchMachineId(input.projectId) : input.machineId,
        input.topicsRouting === undefined || input.topicsRouting === null ? null : (input.topicsRouting ? 1 : 0),
        parseCreatedBy(input.createdBy),
        input.stayLocal ? 1 : 0,
        input.baseBranch?.trim() || null,
        bornSource, input.originTopicId?.trim() || null, input.channelTopicId?.trim() || null, bornBar, bornGaps ? bornGaps.join(",") : null,
      );
      if (bornGaps?.length) {
        try {
          service.addComment({ taskId: id, author: "system", content: incompleteCardNotice(bornGaps), projectId: input.projectId });
        } catch { /* best-effort: the flag on the card is what matters */ }
      }
      // A card BORN pinned (`stayLocal` from the composer) has no
      // `stayLocalUntil` either, same as a human toggling it later on an
      // existing card — same reason trail applies (see `update`, above).
      if (input.stayLocal) {
        const reason = (input.stayLocalReason ?? "").trim();
        try {
          service.addComment({
            taskId: id, author: "system", kind: "service", projectId: input.projectId,
            content: reason
              ? `«Solo Mac», senza scadenza: ${reason}`
              : "«Solo Mac», senza scadenza: pin manuale alla nascita, nessuna ragione scritta.",
          });
        } catch { /* best-effort: the pin stands without its line */ }
      }
      // Its own statement, and only when there is a stage: a board on the
      // default workflow writes the same row as before.
      if (birthStage) db.prepare("UPDATE tasks SET stage = ? WHERE id = ?").run(birthStage, id);
      if (bornAsk && status === "review") db.prepare("UPDATE tasks SET human_ask = ? WHERE id = ?").run(bornAsk, id);
      if (input.parentTaskId) releaseContainerFromCardContract(input.parentTaskId);
      return rowToTask(getTaskRow(id));
    },

    get(taskId, opts) {
      const row = getTaskRow(taskId);
      if (!row) return null;
      if (opts?.projectId && row.project_id !== opts.projectId) return null;
      const comments = db.query("SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as any[];
      const [task] = withSubtaskCounts([rowToTask(row)]);
      return { task, comments: comments.map(rowToComment), children: childrenOf(taskId) };
    },

    list(input: ListTasksInput): Task[] {
      const clauses: string[] = [input.archived === true ? "archived = 1" : "archived = 0"];
      const params: any[] = [];
      if (input.scope === "project") {
        if (!input.projectId) throw new TaskServiceError("invalid_input", "scope=project requires projectId");
        const family = input.includeChildBoards ? mergedBoardIds(loadFamilyRows(db), input.projectId) : [input.projectId];
        if (family.length > 1) {
          clauses.push("project_id IN (SELECT value FROM json_each(?))");
          params.push(idParam(family));
        } else {
          clauses.push("project_id = ?");
          params.push(input.projectId);
        }
      }
      // UNO STATO CHE NON ESISTE È UN ERRORE, NON UNA BOARD VUOTA. Le rotte
      // passavano `?status=` così com'era arrivato (`as any`), quindi
      // `?status=in-progress` finiva in SQL come un letterale che non matcha
      // niente e il client riceveva 200 con zero card: una board vuota è una
      // risposta plausibile, quindi il refuso non si vedeva. Il cancello sta
      // QUI, non sulle tre rotte, perché è l'unica porta che tutte attraversano.
      if (input.status !== undefined) {
        if (!STATUSES.includes(input.status)) {
          throw new TaskServiceError("invalid_input", `invalid status "${input.status}"`);
        }
        clauses.push("status = ?");
        params.push(input.status);
      }
      // L'AUTORIZZAZIONE ARRIVA FINO A SQL. Il feed dell'ospite idratava OGNI
      // task del DB per poi tenere i due condivisi: il predicato che decide cosa
      // può vedere stava in JS, a valle del lavoro. Insieme vuoto = nessuna riga,
      // e si esce senza nemmeno interrogare: `IN ()` non è SQL valido, e un
      // `WHERE 0` costerebbe comunque un giro.
      if (input.ids) {
        if (input.ids.length === 0) return [];
        clauses.push("id IN (SELECT value FROM json_each(?))");
        params.push(idParam(input.ids));
      }
      // «Radici» vuol dire tre cose diverse a seconda di chi chiede, e le tre
      // convivono qui perché il taglio è uno solo.
      //
      //  - ARCHIVIO: un task senza padre è una radice; ma anche uno step
      //    archiviato da solo, sotto un genitore ancora vivo, è la radice di ciò
      //    che è stato archiviato — e con il filtro letterale
      //    `parent_task_id IS NULL` sarebbe l'unica riga che nessuna lista
      //    mostra più, né la board né l'archivio. I figli di un archiviato
      //    restano fuori: li riporta indietro il ripristino del padre.
      //  - FEED della board (`includeOrphanSubtasks`): le radici PIÙ gli step
      //    che non sono più la checklist di nessuno. «Nessuno» è una sola
      //    condizione, letta sul padre diretto: chiuso, archiviato, o la riga
      //    non c'è più. Lo step già `done` resta fuori — un passo finito non è
      //    un vicolo cieco, è cronaca.
      //  - DISPATCHER: il filtro letterale, e resta letterale. Lì `rootsOnly` è
      //    una regola di sicurezza, non di lettura.
      //
      // L'archivio per primo perché è una VISTA diversa, non il feed: quando si
      // guardano le lines archiviate, un padre chiuso non è un orfano da
      // ripescare, è il contesto di ciò che si sta guardando.
      if (input.rootsOnly) {
        clauses.push(
          input.archived === true
            ? "(parent_task_id IS NULL OR parent_task_id IN (SELECT id FROM tasks WHERE archived = 0))"
            : input.includeOrphanSubtasks
            ? `(parent_task_id IS NULL OR (status != 'done' AND NOT EXISTS (
                 SELECT 1 FROM tasks p
                  WHERE p.id = tasks.parent_task_id AND p.archived = 0 AND p.status != 'done')))`
            : "parent_task_id IS NULL",
        );
      }
      // Etichette in AND. Un JOIN sull'indice `idx_task_labels_label`, non una
      // `LIKE '%bugfix%'` su una stringa: `bugfix-ui` non matcha `bugfix`, ed è
      // esattamente il motivo per cui le etichette sono lines e non una colonna.
      const wantedLabels = (input.labels ?? []).filter(isTaskLabel);
      if (wantedLabels.length) {
        clauses.push(
          `id IN (SELECT task_id FROM task_labels WHERE label IN (${wantedLabels.map(() => "?").join(", ")})
                   GROUP BY task_id HAVING COUNT(DISTINCT label) = ?)`,
        );
        params.push(...wantedLabels, wantedLabels.length);
      }
      // The cap on `done` (see ListTasksInput.doneLimit) is a subselect and not
      // a slice in JS: rows dropped here are rows SQLite never hydrates and the
      // wire never carries. The subselect repeats the archived/project cut so it
      // picks the N most recent among the ones this same list would return.
      if (input.doneLimit !== undefined && input.doneLimit >= 0) {
        const doneClauses = [input.archived === true ? "archived = 1" : "archived = 0", "status = 'done'"];
        const doneParams: unknown[] = [];
        if (input.scope === "project" && input.projectId) {
          doneClauses.push("project_id = ?");
          doneParams.push(input.projectId);
        }
        clauses.push(
          `(status != 'done' OR id IN (
              SELECT id FROM tasks WHERE ${doneClauses.join(" AND ")}
               ORDER BY COALESCE(completed_at, updated_at) DESC LIMIT ?))`,
        );
        params.push(...doneParams, input.doneLimit);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      // project scope → board order (status then kanban_order); global feed → recency.
      const order = input.scope === "all" ? "updated_at DESC" : "kanban_order ASC";
      // `allWideRows` and not `.all()`: the projection is wider than the 62
      // columns past which bun:sqlite builds each row object four times slower.
      const { sql: columns, names } = listColumns(input.withDescription === true);
      const rows = allWideRows(db.query(`SELECT ${columns} FROM tasks ${where} ORDER BY ${order}`), names, ...params) as any[];
      return withSubtaskCounts(rowsToTasks(rows));
    },

    findDuplicates({ projectId, text, excludeTaskId, limit, rootsOnly }): Neighbour[] {
      const body = (text ?? "").trim();
      if (!body || !projectId) return [];
      // Solo le card VIVE della propria board: una card archiviata e' gia'
      // fuori, e proporla come doppione riporterebbe in vita una decisione
      // che qualcuno ha gia' preso.
      const rows = db.prepare(
        `SELECT id, text, created_at FROM tasks
          WHERE project_id = ? AND archived = 0 AND id != ?
          ${rootsOnly ? "AND parent_task_id IS NULL" : ""}`,
      ).all(projectId, excludeTaskId ?? "") as Array<{ id: string; text: string; created_at: string }>;
      return findNeighbours(
        body,
        rows.map((r) => ({ id: r.id, text: r.text ?? "", createdAt: r.created_at })),
        { limit },
      );
    },

    isArchived(taskId: string): boolean {
      return !!getTaskRow(taskId)?.archived;
    },

    archive({ taskId, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const ts = now();
      // `archiveSubtree` fa la stessa discesa ricorsiva che valiant-hill aveva
      // scritta inline: il ramo l'aveva estratta, e tenere due copie della stessa
      // query e' il modo in cui una delle due smette di essere aggiornata.
      archiveSubtree(taskId, ts);
      // Una card archiviata non ha più una domanda in sospeso, ed era la quarta
      // strada che restava scoperta: la richiesta restava `pending` per sempre,
      // perché il task non è più in review e `reviewDecision` la rifiuta.
      settleReviewApproval(taskId, "expired", "system", ts);
      // Archiviare uno step lo toglie dagli aperti esattamente come chiuderlo:
      // e' la risposta «archivia» ai due bottoni, ed e' anche il modo in cui si
      // sgombera una checklist a mano. Il padre va guardato in entrambi i casi.
      if (row.parent_task_id) childLeftFlight(row.parent_task_id as string, "system", this);
      return rowToTask(getTaskRow(taskId));
    },

    detachOpenChildren({ taskId, projectId }): string[] {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const ts = now();
      const ids = (db.prepare(
        "SELECT id FROM tasks WHERE parent_task_id = ? AND archived = 0 AND status != 'done'",
      ).all(taskId) as Array<{ id: string }>).map((r) => r.id);
      const unhook = db.prepare("UPDATE tasks SET parent_task_id = NULL, updated_at = ? WHERE id = ?");
      for (const id of ids) {
        unhook.run(ts, id);
        // Where it came from goes in its own thread: on the board it is now a
        // root card with no trace of the grouping it sat under.
        try {
          this.addComment({
            taskId: id, author: "system", kind: "service",
            content: `Staccata da «${row.text}», archiviata: ora e' una card a se'.`,
          });
        } catch { /* the note never blocks the detach */ }
      }
      return ids;
    },

    restore({ taskId, projectId }): Task | null {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) return null;
      const ts = now();
      // Due direzioni, e servono entrambe. GIÙ perché `archive` ha marcato tutto
      // il sottoalbero: un ripristino che lascia gli step archiviati riporta una
      // card senza la sua checklist. SU perché un task figlio di un genitore
      // ancora archiviato non lo vede nessuno, e il ripristino sarebbe stato
      // solo una scrittura.
      db.prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
         ),
         chain(id, parent) AS (
           SELECT id, parent_task_id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id, t.parent_task_id FROM tasks t JOIN chain c ON t.id = c.parent
         )
         UPDATE tasks SET archived = 0, updated_at = ?
          WHERE id IN (SELECT id FROM subtree) OR id IN (SELECT id FROM chain)`,
      ).run(taskId, taskId, ts);
      return rowToTask(getTaskRow(taskId));
    },

    boundRootOf(taskId) {
      const r = db.prepare(
        `WITH RECURSIVE chain(id, parent, topic, depth) AS (
           SELECT id, parent_task_id, assigned_topic_id, 0 FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id, t.parent_task_id, t.assigned_topic_id, c.depth + 1
             FROM tasks t JOIN chain c ON t.id = c.parent
         )
         SELECT id FROM chain WHERE topic IS NOT NULL ORDER BY depth ASC LIMIT 1`,
      ).get(taskId) as any;
      return r ? rowToTask(getTaskRow(r.id)) : null;
    },

    taskByIdPrefix(id8) {
      const p = (id8 ?? "").trim();
      // id8 is a hex slice of a uuid → no LIKE metacharacters to escape.
      if (!/^[0-9a-f]{1,32}$/i.test(p)) return null;
      const r = db.prepare(
        `SELECT id, text FROM tasks
          WHERE id LIKE ? || '%'
          ORDER BY archived ASC, updated_at DESC LIMIT 1`,
      ).get(p) as any;
      return r ? { id: r.id, text: r.text ?? "" } : null;
    },

    moveToProject({ taskId, toProjectId, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const target = (toProjectId ?? "").trim();
      if (!target) throw new TaskServiceError("invalid_input", "toProjectId is required");
      if (row.project_id === target) return rowToTask(row);
      // Only the ROOT of a subtree moves: create() pins a subtask to its
      // parent's board, so the subtree travels together or not at all.
      if (row.parent_task_id) {
        throw new TaskServiceError("invalid_transition", "task is a subtask. Move its root task (the subtree moves together).");
      }
      // A dispatched agent works a worktree/topic of the SOURCE project; moving
      // the task under it would strand the binding. Finish or release it first.
      if (row.assigned_topic_id || isAgentWorking(row.dispatch_state)) {
        throw new TaskServiceError("invalid_transition", "task has a live agent. Let it reach review (or park it) before moving boards.");
      }
      const ts = now();
      const maxRow = db.prepare("SELECT COALESCE(MAX(kanban_order), 0) as m FROM tasks WHERE project_id = ?").get(target) as any;
      // Clear any stale dispatch failure state: a 'failed'/'blocked' park (and its
      // dispatch_error) was about the SOURCE board's dispatch context — moving the
      // task to another board invalidates it, so it must not travel as a red
      // "fallito"/"da sistemare" chip. (Live dispatch states are already refused
      // above, so this only ever clears a settled park.)
      db.prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
         )
         UPDATE tasks SET project_id = ?, dispatch_state = NULL, dispatch_error = NULL, updated_at = ? WHERE id IN (SELECT id FROM subtree)`,
      ).run(taskId, target, ts);
      // Re-append the root at the end of the target board; children keep their
      // relative order (kanban_order is just a per-board sort key).
      db.prepare("UPDATE tasks SET kanban_order = ? WHERE id = ?").run((maxRow?.m ?? 0) + 1, taskId);
      return rowToTask(getTaskRow(taskId));
    },

    setUrlProbeStatus({ taskId, status, checkedAt }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare(
        "UPDATE tasks SET url_probe_status = ?, url_probe_checked_at = ?, updated_at = ? WHERE id = ?",
      ).run(status, checkedAt, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

    recordChecks({ taskId, state, commit, runs, progress, ci }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      /* IL PROGRESSO VIAGGIA DENTRO `checks_json`, non in una colonna nuova.
       *
       * Serve solo mentre lo stato e' `running` — un attimo, non un dato
       * storico — e una migration per un valore che vive trenta secondi
       * sarebbe sproporzionata. La forma resta leggibile da chi c'era prima:
       * `runs` e' un array, questo e' un oggetto, e il client distingue i due
       * casi guardando `Array.isArray`. */
      const json = progress
        ? JSON.stringify({ progress, runs: runs ?? [], ...(ci ? { ci } : {}) })
        : (runs && runs.length ? JSON.stringify(runs) : null);
      db.prepare(
        "UPDATE tasks SET checks_state = ?, checks_at = ?, checks_commit = ?, checks_json = ?, updated_at = ? WHERE id = ?",
      ).run(
        state,
        // 'running' non ha un "quando è finito": scriverne uno direbbe una cosa
        // falsa alla riga "verdi alle 14:32".
        state === "running" ? null : now(),
        commit ?? null,
        json,
        now(),
        taskId,
      );
      return rowToTask(getTaskRow(taskId));
    },

    clearChecksCommit(taskId): boolean {
      // `checks_at` and `checks_json` stay: a verdict that was really measured
      // keeps its hour and its output tails. Only the commit pointer goes, and
      // only when there is one - a card that never ran the checks must not get
      // an `updated_at` bump out of this (the dispatcher's clocks read that
      // column, KANBAN-84).
      const res = db.prepare(
        "UPDATE tasks SET checks_commit = NULL, updated_at = ? WHERE id = ? AND checks_commit IS NOT NULL",
      ).run(now(), taskId);
      return Number(res.changes ?? 0) > 0;
    },

    clearStaleChecksRuns(isLive?: (taskId: string) => boolean): string[] {
      const lit = (db.prepare(CHECKS_RUNNING_SQL).all() as Array<{ id: string }>).map((r) => r.id);
      // The live registry decides, the row confirms: a light the gate still
      // knows is a run that is going, or queued behind another card's run, and
      // switching it off would tell the board nothing is being measured while
      // `test:unit` has been running for six minutes.
      const orphaned = isLive ? lit.filter((id) => !isLive(id)) : lit;
      if (!orphaned.length) return [];
      // `checks_at` resta com'era (una corsa senza verdetto non ha un "quando"),
      // e `checks_commit`/`checks_json` pure: sono la traccia dell'ultima misura
      // vera, e cancellarli qui butterebbe via un esito valido.
      const stmt = db.prepare(
        "UPDATE tasks SET checks_state = NULL, updated_at = ? WHERE id = ? AND checks_state = 'running'",
      );
      const cleared: string[] = [];
      for (const id of orphaned) {
        if (Number(stmt.run(now(), id).changes ?? 0) > 0) cleared.push(id);
      }
      return cleared;
    },

    setLabels({ taskId, labels, actor, source, projectId }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const wanted = normalizeLabels(labels);
      const current = labelsOf(taskId);

      // IL CANCELLO. Un agente può alzare la mano, mai abbassarla. `visibile` e
      // `decisione` sì — sono due modi di passare la card a un umano, e passare
      // lavoro a una persona è sempre permesso. `invisibile` no: è l'unica che
      // TOGLIE la revisione umana, e sarebbe l'autorizzazione a chiudersi le
      // card da solo. E non può nemmeno TOGLIERE un'etichetta di chiusura già
      // scritta: sfilare un `visibile` è uscire dalla lista di Attilio per
      // un'altra strada.
      if (actor === "agent") {
        if (wanted.includes("invisibile")) {
          throw new TaskServiceError(
            "label_forbidden",
            "un agente non può marcare `invisibile` il proprio lavoro: chi chiude la card lo deriva il server dal diff (shared/task-labels.ts), o lo corregge un umano",
          );
        }
        const droppedCloser = current.find((c) => isCloserLabel(c.label) && !wanted.includes(c.label));
        if (droppedCloser) {
          throw new TaskServiceError(
            "label_forbidden",
            `un agente non può togliere l'etichetta \`${droppedCloser.label}\`: la revisione umana si chiede, non si revoca`,
          );
        }
      }

      const ts = now();
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM task_labels WHERE task_id = ?").run(taskId);
        const ins = db.prepare("INSERT INTO task_labels (task_id, label, source, created_at) VALUES (?, ?, ?, ?)");
        for (const label of wanted) {
          // Chi non tocca un'etichetta non ne riscrive la provenienza: una
          // `derived` che l'umano lascia dov'è resta `derived`, così la consegna
          // successiva può ricalcolarla.
          const keep = current.find((c) => c.label === label);
          ins.run(taskId, label, keep && keep.source === source ? keep.source : source, ts);
        }
      });
      tx();
      return rowToTask(getTaskRow(taskId));
    },

    deriveLabelsFromDiff({ taskId, files }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) return null;
      const current = labelsOf(taskId);

      /**
       * Che cosa scrivere per UNA famiglia di etichette — `null` = niente.
       *
       * Una correzione a mano di Attilio NON si sovrascrive alla consegna
       * successiva, o la correzione durerebbe quanto il turno seguente: basta
       * UNA etichetta non `derived` nella famiglia perché la famiglia intera sia
       * di chi l'ha scritta. E ciò che è già uguale non si riscrive, o ogni
       * consegna rifarebbe il `created_at` di un dato immutato.
       */
      const pick = (belongs: (l: string) => boolean, wanted: TaskLabel | null): TaskLabel | null => {
        const held = current.filter((c) => belongs(c.label));
        if (held.some((h) => h.source !== "derived")) return null;
        if (!wanted) return null;
        if (held.length === 1 && held[0]!.label === wanted) return null;
        return wanted;
      };

      // Due domande INDIPENDENTI: chi chiude la card, e che genere di lavoro è.
      // Correggere a mano la prima non deve congelare la seconda — prima le due
      // stavano sotto lo stesso `return null` e un `visibile` scritto da Attilio
      // lasciava la card senza genere per sempre.
      const closer = pick(isCloserLabel, deriveCloser(files.map((f) => f.path)));
      const kind = pick(isKindLabel, deriveKind(files));
      if (!closer && !kind) return null;

      const ts = now();
      const tx = db.transaction(() => {
        const del = db.prepare("DELETE FROM task_labels WHERE task_id = ? AND label = ?");
        const ins = db.prepare(
          "INSERT INTO task_labels (task_id, label, source, created_at) VALUES (?, ?, 'derived', ?)",
        );
        // Tutta la famiglia, non la sola gemella: una `decisione` rimasta addosso
        // accanto a una `visibile` nuova sarebbe una card con due risposte alla
        // stessa domanda, e vale identico per due generi insieme.
        if (closer) {
          for (const l of CLOSER_LABELS) del.run(taskId, l);
          ins.run(taskId, closer, ts);
        }
        if (kind) {
          for (const l of KIND_LABELS) del.run(taskId, l);
          ins.run(taskId, kind, ts);
        }
      });
      tx();
      return rowToTask(getTaskRow(taskId));
    },

    getBoardSettings(projectId: string): BoardSettings {
      const r = readBoardSettingsRow(db, projectId);
      // A project merged into a parent (accorpa) without a row of its own takes
      // the parent's DISPLAY settings only (the language of its cards), since its
      // cards are read on the parent's board. Never how it dispatches, merges or
      // deploys: those act on the child's own repository, and a parent's
      // auto-merge or deploy command run there would be a choice nobody made.
      const inheritedLanguage = r ? null : (() => {
        const from = inheritedSettingsBoardId(loadFamilyRows(db), projectId);
        return from ? readBoardSettingsRow(db, from)?.language ?? null : null;
      })();
      return {
        projectId,
        autoDispatch: readGlobalDispatch(),
        // Nessun tetto per board: quello vero è UNO solo e si legge con
        // `getGlobalCap()` (riga '*'). Vedi `BoardSettings` in shared/board.ts.
        dispatchEffort: r?.dispatch_effort ?? "medium",
        dispatchUseWorktree: r ? !!r.dispatch_use_worktree : true,
        dispatchAutoMerge: r ? !!r.dispatch_auto_merge : false,
        deployCommand: r?.deploy_command ?? "", // "" = off, the default
        dispatchTimeoutMin: r?.dispatch_timeout_min ?? 20,
        // Default 5: see `BoardSettings.dispatchIdleMin` in shared/board.ts —
        // this is the passive stall detector's silence threshold, not a kill timer.
        dispatchIdleMin: r?.dispatch_idle_min ?? 5,
        dispatchMcp: r?.dispatch_mcp ?? "bridge-only",
        dispatchModel: r?.dispatch_model ?? "auto",
        // AICTRL-05: default board dello switch; NULL = nessuna scelta su questa board (ordine di risoluzione in shared/board.ts). allow-italian: dice cosa significa NULL in colonna
        dispatchTopicsRouting: r?.dispatch_topics_routing == null ? null : !!r.dispatch_topics_routing,
        dispatchMachineId: r?.dispatch_machine_id ?? null,
        // ON unless a person switched it off: an absent column or row is the default.
        dispatchOverflow: r?.dispatch_overflow == null ? true : !!r.dispatch_overflow,
        dispatchStayLocal: !!r?.dispatch_stay_local,
        language: r?.language ?? inheritedLanguage ?? "inherit",
        // NULL = 1: una board che non ha mai sentito parlare di fan-out dispaccia
        // un agente per task, com'è sempre stato.
        dispatchFanOut: Math.max(1, r?.dispatch_fanout ?? 1),
        dispatchRetryCap: r?.dispatch_retry_cap ?? 2,
        dispatchRetryBackoffS: r?.dispatch_retry_backoff_s ?? 60,
        requireApprovalForDone: r ? !!r.require_approval_for_done : false,
        requireReviewBeforeDone: r ? !!r.require_review_before_done : false,
        reviewChecks: parseReviewChecks(r?.review_checks),
        // Assente o illeggibile = NON in pausa: e' il verso giusto in cui
        // sbagliare, perche' l'errore opposto fermerebbe in silenzio una coda
        // che nessuno ha chiesto di fermare.
        dispatchPaused: r ? !!r.dispatch_paused : false,
        nightMode: r ? !!r.night_mode : false,
        nightModeUntil: r?.night_mode_until ?? "",
        nightModeStartedAt: r?.night_mode_started_at ?? null,
      };
    },

    updateBoardSettings(projectId: string, patch: UpdateBoardSettingsPatch): BoardSettings {
      if (!projectId) throw new TaskServiceError("invalid_input", "projectId is required");
      if (patch.dispatchEffort !== undefined && !VALID_EFFORT.has(patch.dispatchEffort)) {
        throw new TaskServiceError("invalid_input", `invalid effort "${patch.dispatchEffort}"`);
      }
      if (patch.dispatchMcp !== undefined && !VALID_DISPATCH_MCP.has(patch.dispatchMcp)) {
        throw new TaskServiceError("invalid_input", `invalid dispatchMcp "${patch.dispatchMcp}"`);
      }
      // Ensure a row exists. `max_agents` is seeded, never patched: on a project
      // row the column is DEAD (no reader — the one cap lives on the '*' row),
      // and the explicit 2 only matters when `projectId` IS the reserved '*'
      // key, where it must land on the same global default as
      // `setGlobalAutoDispatch` instead of the legacy column default of 5.
      db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 2)").run(projectId);
      // autoDispatch e' l'interruttore GLOBALE: si scrive in `app_settings`, cosi'
      // ribaltarlo da una board qualsiasi (o dalla board globale) lo ribalta
      // ovunque. Prima finiva sulla riga riservata '*' di questa stessa tabella,
      // ed e' quella convivenza che rendeva credibile lo zero delle altre lines.
      if (patch.autoDispatch !== undefined) {
        try { db.prepare("UPDATE app_settings SET auto_dispatch = ?").run(patch.autoDispatch ? 1 : 0); } catch { /* schema minimo: vedi readGlobalDispatch */ }
        // La riga '*' si materializza lo stesso, e non e' un residuo: e' dove
        // vive il TETTO globale, e nasce col 2 esplicito. Senza, accendere
        // l'interruttore lascerebbe il tetto al default della colonna legacy
        // (5), cioe' un ON alzerebbe di sua iniziativa il numero di agenti che
        // la macchina si prende. L'auto-dispatch ha traslocato, il tetto no.
        db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 2)").run(GLOBAL_SETTINGS_KEY);
      }
      const sets: string[] = [];
      const params: any[] = [];
      // Nessun `max_agents` / `max_agents_auto` qui: il tetto si scrive con
      // `setGlobalCap` sulla riga '*', ed è l'unico che decide qualcosa.
      if (patch.dispatchEffort !== undefined) { sets.push("dispatch_effort = ?"); params.push(patch.dispatchEffort); }
      if (patch.dispatchUseWorktree !== undefined) { sets.push("dispatch_use_worktree = ?"); params.push(patch.dispatchUseWorktree ? 1 : 0); }
      if (patch.dispatchAutoMerge !== undefined) { sets.push("dispatch_auto_merge = ?"); params.push(patch.dispatchAutoMerge ? 1 : 0); }
      // "" is an explicit, valid value ("off"), not "leave alone".
      if (patch.deployCommand !== undefined) { sets.push("deploy_command = ?"); params.push(String(patch.deployCommand ?? "").trim()); }
      if (patch.dispatchTimeoutMin !== undefined) { sets.push("dispatch_timeout_min = ?"); params.push(clampInt(patch.dispatchTimeoutMin, 1, 120)); }
      if (patch.dispatchIdleMin !== undefined) { sets.push("dispatch_idle_min = ?"); params.push(clampInt(patch.dispatchIdleMin, 1, 60)); }
      if (patch.dispatchMcp !== undefined) { sets.push("dispatch_mcp = ?"); params.push(patch.dispatchMcp); }
      // 'auto' (or empty) collapses to NULL so the classifier keeps picking; any other
      // string pins the board to that model id. No allowlist here — the model set is
      // provider-driven (see /api/claude/models); an unknown id simply fails at spawn.
      if (patch.dispatchModel !== undefined) { sets.push("dispatch_model = ?"); params.push(patch.dispatchModel && patch.dispatchModel !== "auto" ? patch.dispatchModel : null); }
      // Nullable come `topics_routing` sul task: null resta null, non collassa su false. allow-italian: la regola di scrittura della colonna
      if (patch.dispatchTopicsRouting !== undefined) {
        sets.push("dispatch_topics_routing = ?");
        params.push(patch.dispatchTopicsRouting === null ? null : (patch.dispatchTopicsRouting ? 1 : 0));
      }
      // Empty or null clears it: a board with no rule runs its cards here.
      if (patch.dispatchMachineId !== undefined) {
        sets.push("dispatch_machine_id = ?");
        params.push((patch.dispatchMachineId ?? "").trim() || null);
      }
      if (patch.dispatchOverflow !== undefined) { sets.push("dispatch_overflow = ?"); params.push(patch.dispatchOverflow ? 1 : 0); }
      if (patch.dispatchStayLocal !== undefined) { sets.push("dispatch_stay_local = ?"); params.push(patch.dispatchStayLocal ? 1 : 0); }
      if (patch.language !== undefined) { sets.push("language = ?"); params.push(patch.language && patch.language !== "inherit" ? patch.language : null); }
      // Tetto a 5: oltre, il fan-out non è più "confronto fra alternative" ma un
      // modo di saturare la macchina — e ogni tentativo è un agente vero che
      // occupa uno slot del tetto globale.
      if (patch.dispatchFanOut !== undefined) { sets.push("dispatch_fanout = ?"); params.push(clampInt(patch.dispatchFanOut, 1, MAX_FANOUT)); }
      // Accendere la modalità notturna STAMPA l'istante: senza, «fino alle
      // 10:00» non si sa se sia stamattina o domani mattina. Spegnendola si
      // cancella, così un riaccendere non eredita una scadenza vecchia.
      if (patch.dispatchPaused !== undefined) {
        sets.push("dispatch_paused = ?"); params.push(patch.dispatchPaused ? 1 : 0);
      }
      if (patch.nightMode !== undefined) {
        sets.push("night_mode = ?"); params.push(patch.nightMode ? 1 : 0);
        sets.push("night_mode_started_at = ?"); params.push(patch.nightMode ? now() : null);
      }
      if (patch.nightModeUntil !== undefined) {
        const v = String(patch.nightModeUntil ?? "").trim();
        sets.push("night_mode_until = ?"); params.push(v || null);
      }
      if (patch.dispatchRetryCap !== undefined) { sets.push("dispatch_retry_cap = ?"); params.push(clampInt(patch.dispatchRetryCap, 1, 5)); }
      if (patch.dispatchRetryBackoffS !== undefined) { sets.push("dispatch_retry_backoff_s = ?"); params.push(clampInt(patch.dispatchRetryBackoffS, 10, 600)); }
      // NULL, non `[]`: "gate spento" è UNO stato solo, e due modi di scriverlo
      // sono due modi di leggerlo sbagliato.
      if (patch.reviewChecks !== undefined) { sets.push("review_checks = ?"); params.push(serializeReviewChecks(patch.reviewChecks)); }
      if (sets.length) db.prepare(`UPDATE board_settings SET ${sets.join(", ")} WHERE project_id = ?`).run(...params, projectId);
      return this.getBoardSettings(projectId);
    },

  };
  shared.bindService(service);
  // Every method that can move a card writes its state to the attention store
  // (`server/attention/card-sync.ts`): the store announces review and park.
  return withCardAttention(db, service, commentAsksHuman);
}
