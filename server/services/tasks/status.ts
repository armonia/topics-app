import type { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import type { ServiceOpts, TaskService } from "../tasks";
import type { createTasksShared } from "./shared";
import { TaskServiceError, DELIVERY_SNAPSHOT_COLUMNS, STATUSES, branchStillAhead, clampInt, MACHINE_RETRY_BASE_MS, MACHINE_RETRY_CAP, GLOBAL_SETTINGS_KEY } from "./shared";
import { ACTIVE_DISPATCH_STATES, PARKED_WAITED_OUT, UNRESOLVED_PROJECT_PARK_REASON, LEGACY_UNRESOLVED_PROJECT_PARK_REASON, type TaskStatus, PARKED_STOPPED, readTaskWeight, WAIT_SERIES_MAX_MS, WAIT_STREAK_CAP, waitReasonKey, ARCHIVE_PARKED_LABEL, PARKED_REQUEUE_NOTE_LIKE, PROMOTE_PARKED_LABEL, REQUEUE_PARKED_LABEL, TAKE_OVER_PARKED_LABEL, noteParkedChildrenResolved, type GlobalDispatchCap, type GlobalCapPatch, budgetShare, clampGlobalCap, missingReviewCardFields } from "../../../shared/board";
import { type Task } from "../task-shapes";
import { markTargetNotificationsSeen } from "../../db/notification-log";
import { WORKFLOW_COLUMNS } from "../../../shared/workflow";
import { liveAgentCount } from "../agent-census";
import { agentWaitWindowMinutes } from "../../../shared/agent-wait-cap";
import { PARKED_CHILDREN_CANDIDATES_SQL, PARKED_IN_SERIES_SQL, UNOWNED_BACKLOG_SQL, QUEUED_ROOT_BOARDS_SQL } from "../../lib/task-timer-reads";
import { UNOWNED_BACKLOG_MS } from "../../../shared/created-by";
import { readGlobalCap, readSpendCaps, readChecksMemFloorGB } from "../dispatch-capacity";
import { projectIsPaused } from "../project-pause";
import { isNodeChildRun } from "../node-child-run";
import { checksMemFloorGB } from "../../../shared/checks-memory-floor";

export function createStatusMethods(db: Database, _opts: ServiceOpts, shared: ReturnType<typeof createTasksShared>): Pick<TaskService, "update" | "hasHeavyInFlight" | "liveAgents" | "overflowToMachine" | "countOnMachine" | "countRunningOnMachine" | "claim" | "bumpDispatchAttempt" | "listBlockedBy" | "isDispatchBlocked" | "release" | "deferForWait" | "askParkedChildren" | "sweepParkedChildren" | "waitedOutIfCapped" | "sweepMachineWaitedOut" | "sweepUnresolvedProjectParked" | "sweepWaitedOut" | "sweepUnownedBacklog" | "resolveParkedChildren" | "setDispatchState" | "setDispatchWeight" | "boardsWithQueuedTodos" | "taskIdOfTopic" | "getGlobalAutoDispatch" | "setGlobalAutoDispatch" | "getGlobalCap" | "setGlobalCap" | "getSpendCaps" | "setSpendCaps" | "projectPaused" | "getChecksMemFloorGB" | "setChecksMemFloorGB" | "agentSpend" | "agentSpendClearsAt"> {
  const {
    agentAskOnThread,
    annotateDeliveryClaims,
    assertBlockerValid,
    assertNoLiveDependents,
    checkedStage,
    childLeftFlight,
    getTaskRow,
    hasActiveChildren,
    hasChildrenInFlight,
    hasFreshAgentComment,
    heavyInFlight,
    topicBrief,
    isParentAlive,
    logStatus,
    markReopened,
    noteDuplicatePreview,
    now,
    parkedChildren,
    promoteReviewPreview,
    readGlobalDispatch,
    releaseContainerFromCardContract,
    reviewAskFallback,
    writeSystemDeliveryAsk,
    rowToTask,
    settleReviewApproval,
    uuid,
  } = shared;

/**
   * True when `taskId` is one of the calling agent's own checklist steps. Two
   * strade, e servono entrambe:
   *
   *  a) DISCENDENTE STRETTO di un task assegnato a `topicId` — copre gli step
   *     che l'UMANO aggiunge sotto il task dell'agent (nessuna provenienza
   *     d'agent, ma sono comunque la sua checklist);
   *  b) TASK CON PADRE che `topicId` ha CREATO (`created_by_topic_id`, migration
   *     093) — copre il caso in cui il legame vivo non c'è più.
   *
   * Perché (b): (a) da sola misura la proprietà su `assigned_topic_id`, che è
   * stato di DISPATCH e vive quanto il dispatch, non quanto il turno. Il
   * dispatcher lo azzera a ogni requeue/park (`release`) e lo riscrive su un
   * ALTRO topic al ri-dispatch, mentre il turno dell'agent continua a girare:
   * misurato l'11/08, l'agent ha chiuso due step e poi ha preso 409 su tutti gli
   * altri, consegnando con la checklist aperta (e un task con figli aperti non è
   * approvabile). La provenienza invece è un fatto storico: non cambia mai.
   *
   * STRETTA in entrambe le strade: il task assegnato non fa match in (a), e (b)
   * richiede `parent_task_id IS NOT NULL` — l'agent non può chiudere né il
   * proprio deliverable né un task di primo livello che ha creato lui.
   */
  function isOwnStep(taskId: string, topicId: string): boolean {
    const own = db.prepare(
      "SELECT 1 FROM tasks WHERE id = ? AND parent_task_id IS NOT NULL AND created_by_topic_id = ?",
    ).get(taskId, topicId);
    if (own) return true;
    const r = db.prepare(
      `WITH RECURSIVE anc(id, parent, topic) AS (
         SELECT id, parent_task_id, assigned_topic_id FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id, t.parent_task_id, t.assigned_topic_id
           FROM tasks t JOIN anc a ON t.id = a.parent
       )
       SELECT COUNT(*) AS c FROM anc WHERE topic = ? AND id != ?`,
    ).get(taskId, topicId, taskId) as any;
    return (r?.c ?? 0) > 0;
  }

  /** `taskId` and every card under it, any depth — what one `archive()` call takes down. */
  function descendantIds(taskId: string): string[] {
    return (db.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM tasks WHERE id = ?
         UNION ALL
         SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
       )
       SELECT id FROM subtree`,
    ).all(taskId) as Array<{ id: string }>).map((r) => r.id);
  }

/**
   * I sottotask fermi: non li aspetta nessuno, vanno DETTI.
   *
   * Lo specchio esatto di `hasChildrenInFlight` — `backlog` e `todo` senza un
   * chip attivo addosso — perché sono la stessa domanda e due predicati che
   * possono divergere darebbero un padre che chiede «ho 0 sottotask fermi».
   * Lo `status` viaggia perché la riga lo scrive: la domanda dice DOVE sono
   * fermi, e «in backlog» su un figlio in todo era una bugia.
   */
  /**
   * IL PADRE HA UN TURNO ADDOSSO ADESSO?
   *
   * Il predicato esisteva gia', ma solo dentro `parkedChildRaisedStall`, che e'
   * uno dei TRE punti che devono conoscerlo: il rastrello lo riscrive come
   * esclusione SQL (`status NOT IN (... 'in_progress')`), e `childLeftFlight`
   * non lo aveva affatto. Tre copie di cui una mancante e' il modo esatto in
   * cui il 18/08 tre card dispacciate sono finite in review al PRIMO turno:
   * l'agente creava la sua checklist, spuntava il primo passo, e nel momento in
   * cui quel figlio usciva dal volo `childLeftFlight` chiamava
   * `askParkedChildren` — che sposta la card — mentre il turno era vivo.
   * Sessione con DUE messaggi, zero commit, e una domanda di contabilita' in
   * cima alla colonna di review.
   *
   * Sta qui perche' qui lo legge chi SPOSTA la card, che e' la regola che il
   * rastrello dichiara gia' («questa query stringe il campo, poi
   * `askParkedChildren` applica le sue guardie una per una»).
   */
  function hasLiveTurn(row: { status: string; dispatch_state?: string | null }): boolean {
    return row.status === "in_progress"
      || row.dispatch_state === "working"
      || row.dispatch_state === "starting";
  }

/**
   * Il figlio `childId` si è appena fermato — in `backlog` o in `todo`, che
   * sotto un padre senza turno sono la stessa cosa: se il padre resta senza
   * nessun figlio IN VOLO, da adesso è fermo su qualcosa che non arriverà.
   *
   * Due strade, e la differenza è se c'è un turno vivo:
   *  - padre AL LAVORO → solo l'avviso nel suo thread. Portarlo in review adesso
   *    gli taglierebbe il turno sotto i piedi; la domanda la farà lui a fine
   *    turno (`deliverToReviewBySystem`), che è fra minuti, non fra giorni.
   *  - padre fermo (backlog/todo) → la domanda si alza SUBITO: è il caso
   *    misurato il 12/08, in cui nessun turno sarebbe più arrivato ad accorgersi
   *    di niente e la card sarebbe rimasta ferma per sempre.
   */
  function parkedChildRaisedStall(parentId: string, childId: string, by: string, svc: TaskService): void {
    try {
      const parent = getTaskRow(parentId);
      if (!parent || parent.archived === 1 || parent.status === "done") return;
      if (!hasActiveChildren(parentId) || hasChildrenInFlight(parentId)) return;
      if (!hasLiveTurn(parent)) { svc.askParkedChildren({ taskId: parentId, by }); return; }
      const child = getTaskRow(childId);
      const titolo = child?.text ? `«${child.text}»` : "un sottotask";
      // La COLONNA non si nomina: un figlio in `todo` è fermo quanto uno in
      // `backlog`, e dire «parcheggiato in backlog» su uno step che sta in todo
      // manda a cercarlo dove non è.
      svc.addComment({
        taskId: parentId, author: "system",
        content:
          `Sottotask fermo: ${titolo}. Da qui in avanti non lo prende nessun dispatcher, ` +
          `e questo task non si può chiudere con un sottotask aperto: a fine turno ti chiedo se rimetterlo in coda o archiviarlo.`,
      });
    } catch { /* un avviso non fa mai fallire lo spostamento di una card */ }
  }

// Re-parenting. At creation the walk is unnecessary (a fresh id can never be
// an ancestor of an existing row); MOVING an existing task can close a loop —
// nest A under its own child and the pair disappears from the board, because
// `rootsOnly` shows neither and the detail tree recurses forever.
function assertParentValid(taskId: string, parentId: string): void {
    const self = getTaskRow(taskId);
    const parent = getTaskRow(parentId);
    if (!self) throw new TaskServiceError("not_found", `task ${taskId} not found`);
    if (!parent || parent.project_id !== self.project_id || !isParentAlive(parent)) {
      // Same not_found shape as the create-side guard: no cross-board probing.
      throw new TaskServiceError("not_found", `parent task ${parentId} not found`);
    }
    if (parentId === taskId) {
      throw new TaskServiceError("invalid_input", "a task cannot be its own parent");
    }
    let cur: string | null = parent.parent_task_id ?? null;
    for (let hops = 0; cur && hops < 100; hops++) {
      if (cur === taskId) throw new TaskServiceError("invalid_input", "parent chain would form a cycle");
      cur = (getTaskRow(cur)?.parent_task_id ?? null) as string | null;
    }
  }

/**
   * THE PARK AT THE END OF A WAIT SERIES, shared by its two judges.
   *
   * It was inline in `deferForWait`, which made that function the ONLY reader
   * of `WAIT_SERIES_MAX_MS` in the whole repo — and `deferForWait` runs only
   * when another turn starts and re-declares the wait. With the dispatcher
   * admitting nobody, the series simply grew and nobody looked: measured
   * 2026-09-17 on the live DB, 2 cards past the 4-hour cap by 45 and 31 hours,
   * zero `waited_out` parks ever, and `waited_out` is the only road that
   * reaches a push notification (`push-triggers.ts`).
   *
   * `refundAttempt` is the one thing the two callers do not share. The turn
   * that DECLARES a wait has already spent its attempt on the claim, so
   * `deferForWait` gives it back; the periodic judge claimed nothing, and a
   * refund there would silently hand a card an extra retry it never earned.
   */
  function parkWaitedOut(
    svc: TaskService,
    args: {
      row: { id: string; status: TaskStatus };
      streak: number;
      serieMs: number;
      chiave: string;
      since: string;
      detto: string;
      ts: string;
      refundAttempt: boolean;
    },
  ): Task {
    const { row, streak, serieMs, chiave, since, detto, ts } = args;
    const taskId = row.id;
    // Un tetto sfondato: il task si ferma, ma NON come un fallimento. Non
    // c'è niente da riparare nell'agent, c'è una condizione che non arriva.
    // La durata detta come sta: il tetto sul CONTEGGIO può scattare in pochi
    // minuti (attese corte una dietro l'altra), e scrivere «da un'ora» lì
    // sarebbe una bugia sulla sola cosa che l'umano userà per decidere.
    const ore = Math.round(serieMs / 3_600_000);
    const minuti = Math.round(serieMs / 60_000);
    const quanto = serieMs >= 3_600_000
      ? `da circa ${ore} ${ore === 1 ? "ora" : "ore"}`
      : minuti >= 1
        ? `da ${minuti} ${minuti === 1 ? "minuto" : "minuti"}`
        : "da meno di un minuto";
    // La parola «fallito» non compare, e non per delicatezza: qui non è
    // successa nessuna delle cose che quella parola descrive. Nemmeno
    // negata («non è un fallimento») ci va, perché nominarla la mette in
    // testa a chi legge la card. Si dice cosa è successo e cosa fare.
    const nota =
      `Sono ${streak} ${streak === 1 ? "attesa" : "attese"} di fila per la stessa ragione, ${quanto}` +
      (detto ? `: ${detto}.` : ".") +
      " La condizione non sta arrivando da sola, quindi la decisione torna a te. " +
      "Rimetti il task in Todo per farlo riprovare, oppure sistema ciò che sta aspettando.";
    try { svc.addComment({ taskId, author: "system", content: nota }); } catch { /* dedupe/best-effort */ }
    const rimborso = args.refundAttempt ? "dispatch_attempts = MAX(dispatch_attempts - 1, 0)," : "";
    // Parcheggiato in backlog senza finestra: non deve ripartire da solo,
    // il punto è proprio che qualcuno lo guardi. I contatori restano scritti
    // (li azzera il rientro in Todo) perché sono la ragione del parcheggio.
    db.prepare(
      `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL, ${rimborso}
          status = 'backlog', dispatch_state = ?, dispatch_error = ?,
          dispatch_deferred_until = NULL,
          wait_streak = ?, wait_reason = ?, wait_since = ?, updated_at = ?
        WHERE id = ?`,
    ).run(PARKED_WAITED_OUT, nota, streak, chiave || null, since, ts, taskId);
    // Firma di SISTEMA, non dell'agent: l'agent ha chiesto di aspettare
    // ancora, il parcheggio è il tetto che glielo nega. Attribuirlo a lui
    // direbbe che ha deciso di fermarsi, che è il contrario di quello che
    // ha fatto. Stessa distinzione di `deliverToReviewBySystem`.
    if (row.status !== "backlog") logStatus(taskId, row.status, "backlog", "dispatcher");
    markReopened(taskId, row.status, "backlog", "system", "dispatcher");
    return rowToTask(getTaskRow(taskId));
  }

  return {
update(this: TaskService, { taskId, actor, by, patch, projectId, agentTopicId, statusReason, messageId, origin, asCoordinator, systemAction }): Task {
      const systemClose = actor === "agent" && !!systemAction?.closeProof?.trim();
      const row = getTaskRow(taskId);
      // projectId guard: a session may only touch tasks on its own project.
      // A mismatch is reported as not_found (not 403) so cross-project ids stay
      // indistinguishable from non-existent ones.
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      const current: TaskStatus = row.status;

      // A task model choice configures its next new session. Updating this
      // field cannot migrate an already-bound conversation to another agent.
      if (patch.model !== undefined && row.assigned_topic_id
        && ((patch.model ?? "").trim() || null) !== (row.model || null)) {
        throw new TaskServiceError("invalid_input", "Il modello è fissato alla sessione già assegnata a questo task. Non è possibile cambiarlo dal task dopo l'avvio.");
      }

      // THE WORKFLOW COLUMN (`shared/workflow.ts`). The stage rides on top of
      // the status: naming a column moves the card to its base status, and a
      // status change without a column puts it in the default column of the
      // new status.
      // `nextStage === undefined` = this call does not touch the stage.
      let nextStage: string | null | undefined;
      const wantsStage = patch.stage !== undefined ? ((patch.stage ?? "").trim() || null) : undefined;
      let humanAsk: string | null = patch.humanAsk !== undefined
        ? ((patch.humanAsk ?? "").trim() || null)
        : (row.human_ask ?? null);
      let askFromThread = false;
      // The question for the person is written by the card's own side only: an
      // agent that is neither bound to the card, nor opened it, nor owns it as
      // a step could plant an ask that the owner's next delivery inherits.
      if (patch.humanAsk !== undefined && actor === "agent" && agentTopicId
        && row.assigned_topic_id !== agentTopicId && row.created_by_topic_id !== agentTopicId
        && !isOwnStep(taskId, agentTopicId) && !asCoordinator) {
        throw new TaskServiceError("task_not_yours", "this card is not yours: you cannot write the question for the person on it. Write a comment instead.");
      }
      // A subtask has no column (like at creation and in the system delivery):
      // its status moves, its stage never does.
      if (!row.parent_task_id && (wantsStage !== undefined || (patch.status !== undefined && patch.status !== current))) {
        const columns = WORKFLOW_COLUMNS;
        // A question the agent already wrote in the thread is the `human_ask`,
        // read BEFORE the summary below enters the thread and hides it.
        if (!humanAsk && patch.status === "review") askFromThread = !!(humanAsk = agentAskOnThread(taskId));
        if (wantsStage) {
          // A stage move by an agent: only on its own card, on one it opened, or on its own step.
          if (actor === "agent") {
            const mine = !!agentTopicId && (
              row.assigned_topic_id === agentTopicId || row.created_by_topic_id === agentTopicId || isOwnStep(taskId, agentTopicId));
            if (!mine) {
              throw new TaskServiceError("task_not_yours", "this card is not yours: you cannot move it to another column. Write a comment instead.");
            }
          }
          nextStage = checkedStage(columns, wantsStage, patch.status);
          const col = columns.find((c) => c.id === wantsStage)!;
          if (patch.status === undefined && col.base !== current) patch = { ...patch, status: col.base };
        } else {
          // No column named (or `null`): the default column of the status.
          nextStage = null;
        }
      }
      // Into review without a question for the person: the card says one anyway (`reviewAskFallback`).
      if (!row.parent_task_id && patch.status === "review" && current !== "review" && !humanAsk) {
        humanAsk = reviewAskFallback(row, null, patch.description);
        askFromThread = !!humanAsk;
      }

      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status)) throw new TaskServiceError("invalid_input", `invalid status "${patch.status}"`);
        // Il task NON è più tuo: un agente a cui il dispatcher ha tolto il task
        // non può riprenderselo.
        //
        // `release()` azzera `assigned_topic_id` quando parcheggia o rimette in
        // coda — ma il TURNO dell'agente non muore con quella riga: continua a
        // girare, e la sua `update_task(status)` passava senza che nessuno
        // controllasse se quel task gli appartenesse ancora. Misurato: un task
        // parcheggiato alle 22:48 è tornato `in_progress` 79 secondi dopo ed è
        // rimasto lì SETTE GIORNI — nessun reaper lo guardava, perché per il DB
        // stava lavorando, e falsava anche la capacità di dispatch.
        //
        // La proprietà si misura come già fa il carve-out dei sottotask: o il
        // task è legato al tuo topic, o lo è un suo antenato (i passi della tua
        // checklist restano tuoi). Fuori da lì, rifiuto esplicito.
        //
        // Solo quando `agentTopicId` c'è: gli altri chiamanti (umano, sistema,
        // dispatcher) non hanno un topic con cui rivendicare niente, e questa
        // guardia non li riguarda.
        //
        // Due forme di "non è tuo", e servono entrambe:
        //  a) il task è legato a un ALTRO topic — è di un altro agente;
        //  b) il task non è legato a nessuno MA porta la firma di un rilascio
        //     del dispatcher (`queued` dopo un requeue, `failed`/`blocked` dopo
        //     un park). È il caso misurato: `release()` azzera il legame, e il
        //     turno che continua a girare tornava a prenderselo.
        //
        // Un task MAI dispacciato ha `assigned_topic_id` e `dispatch_state`
        // entrambi nulli: quello resta lavorabile: bloccarlo sarebbe impedire a
        // una sessione di lavorare su un task che nessuno le ha tolto.
        const releasedByDispatcher =
          row.assigned_topic_id == null
          && (row.dispatch_state === "queued" || row.dispatch_state === "failed"
            || row.dispatch_state === "blocked" || row.dispatch_state === PARKED_STOPPED);
        const boundElsewhere = row.assigned_topic_id != null && row.assigned_topic_id !== agentTopicId;
        if (
          actor === "agent" && agentTopicId
          && (boundElsewhere || releasedByDispatcher)
          && !isOwnStep(taskId, agentTopicId)
        ) {
          throw new TaskServiceError(
            "task_not_yours",
            "questo task non è più assegnato a te (rimesso in coda o parcheggiato dal dispatcher): non puoi cambiarne lo stato. Se hai lavoro da consegnare, scrivilo come commento.",
          );
        }
        // The gate: an agent may never mark done — it hands off to review.
        // ONE carve-out: its own checklist steps (strict descendants of the
        // task bound to its topic) close directly — they are the agent's plan,
        // not the deliverable the human reviews.
        // A system rule may close a card only with its verified proof, which the caller wrote in the thread.
        if (patch.status === "done" && actor === "agent" && !systemClose && !(agentTopicId && isOwnStep(taskId, agentTopicId))) {
          throw new TaskServiceError(
            "agent_cannot_complete",
            "agents deliver to 'review' for human approval; only a human moves 'review' → 'done' (exception: subtask steps of YOUR assigned task). Set status to 'review' instead.",
          );
        }
        // Una card chiusa da un UMANO non la riapre un agente.
        //
        // Misurato l'11/08: undici card uscite da `done` in sei ore, quasi tutte
        // per mano di agenti. Nessuna persa, ma `done` è la colonna su cui ci si
        // fida: se una decisione presa da Attilio (approvare la review, o
        // trascinare la card) viene ribaltata da un turno che sta girando, la
        // fiducia va — e l'umano non l'ha nemmeno saputo.
        //
        // Il discrimine è CHI aveva chiuso, non che tipo di task sia: uno step
        // di checklist chiuso dall'agente stesso (`done_actor = 'agent'`, mai
        // passato da una review) resta suo e si riapre senza attriti; è il caso
        // legittimo e frequente — il padre che rifà un proprio sottotask.
        if (
          current === "done" && patch.status !== "done"
          && actor === "agent" && row.done_actor === "human"
        ) {
          throw new TaskServiceError(
            "reopen_needs_human",
            "questa card è stata chiusa da una decisione umana (approvazione in review o spostamento sulla board): non puoi riaprirla. Se il lavoro va rifatto, scrivi un commento con il motivo e chiedi la riapertura.",
          );
        }
        // A parent is not done while its subtasks are open — for ANY actor.
        // Complete or archive the children first (structural invariant, not a
        // board setting).
        if (patch.status === "done" && hasActiveChildren(taskId)) {
          throw new TaskServiceError(
            "open_subtasks",
            "task has open subtasks. Complete or archive them before marking it done.",
          );
        }
        // Agent entering review → open a pending review approval for the human.
        if (patch.status === "review" && actor === "agent" && !systemAction && current !== "review") {
          // A DELIVERY IS DECLARED, NOT GUESSED.
          //
          // The gate used to accept any fresh agent comment — one written after
          // this turn started, so a stale one could not unlock it. That is not
          // enough, and the gap is the whole defect: the last thing an agent
          // writes before delivering is the chronicle of its own work,
          // «terzo commit: il rosso di check:security chiuso alla fonte», allow-italian: verbatim from a real card
          // and that is what the review card opened with. Reported as: the
          // cards in review should carry a useful explanation as their last
          // message, and only useless git things showed up.
          //
          // Telling plumbing from explanation by reading the text would be a
          // rubric: a machine judging prose, wrong in silence on both sides.
          // So the agent SAYS which one is the delivery, in the same call that
          // moves the card. No summary, no review — and there is no deadlock in
          // that refusal: at the end of the turn `deliverToReviewBySystem` still
          // carries the card over, marked `delivered_by = 'system'`, which is
          // the state the board already knows how to show.
          const summary = (patch.summary ?? "").trim();
          if (!summary) {
            throw new TaskServiceError(
              "review_needs_summary",
              "una consegna si dichiara: richiama update_task con `summary` = 1-2 frasi su COSA hai fatto in questo turno e DOVE si guarda (anche \"niente di nuovo\" col perché). È quella la riga che la card mostra al reviewer: la cronaca dei commit non la sostituisce.",
            );
          }
          // The summary enters the thread BEFORE the status moves: a card must
          // never be able to sit in review without the line that explains it.
          this.addComment({ taskId, author: by, content: summary, projectId: projectId ?? row.project_id, kind: "delivery", messageId: messageId ?? null });
          // The report is there. Now we look at whether what it says holds up.
          annotateDeliveryClaims(taskId, projectId ?? row.project_id, (a) => this.addComment(a));
          // A WARNING, never a refusal: the card still reaches review, and the
          // agent reads the note at its next turn. Fixed headings matched by
          // exact text (`REVIEW_CARD_RULE`), so there is no prose to misread.
          // Root cards only: a subtask's summary is read by its parent agent,
          // never by the person, the same scope as the stage move above.
          const missing = row.parent_task_id ? [] : missingReviewCardFields(summary);
          if (missing.length) {
            try {
              this.addComment({
                taskId, author: "system", kind: "service", projectId: projectId ?? row.project_id,
                content: `Consegna non leggibile dalla card: mancano ${missing.join(", ")}. Alla prossima consegna scrivi il riassunto nei cinque campi.`, // allow-italian: reviewer-facing note
              });
            } catch { /* best-effort */ }
          }
          db.prepare(
            `INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at)
             VALUES (?, ?, ?, 'review', ?, 'done', 'pending', ?)`,
          ).run(uuid(), taskId, by, current, now());
        }
      }

      const sets: string[] = [];
      const params: any[] = [];
      const put = (col: string, val: any) => { sets.push(`${col} = ?`); params.push(val); };

      if (patch.text !== undefined) put("text", patch.text);
      if (patch.description !== undefined) put("description", patch.description);
      if (patch.bar !== undefined) put("bar", patch.bar?.trim() || null);
      if (patch.createdSource !== undefined) put("created_source", patch.createdSource?.trim().slice(0, 160) || null);
      if (patch.channelTopicId !== undefined) {
        const link = patch.channelTopicId?.trim() || null;
        // A link to a chat that does not exist would show nothing and open a ghost tab.
        if (link && !topicBrief(link)) throw new TaskServiceError("invalid_input", `channel chat ${link} not found`);
        put("channel_topic_id", link);
      }
      if (patch.priority !== undefined) {
        put("priority", patch.priority);
        // An explicit write (human OR the agent fulfilling "auto") settles it.
        put("priority_auto", 0);
      }
      if (patch.assignedTo !== undefined) put("assigned_to", patch.assignedTo);
      if (patch.dueDate !== undefined) put("due_date", patch.dueDate);
      if (patch.scheduled !== undefined) {
        const by = patch.scheduled?.by?.trim() || null;
        put("scheduled_by", by);
        put("scheduled_at", by ? (patch.scheduled?.at ?? null) : null);
        // Out of the queue: a 'queued' chip on it would promise an agent that never comes.
        if (by && row.dispatch_state === "queued") put("dispatch_state", null);
      }
      if (patch.kanbanOrder !== undefined) put("kanban_order", patch.kanbanOrder);
      if (patch.outputUrl !== undefined) {
        const url = (patch.outputUrl ?? "").trim();
        // http(s) only: the review panel renders this in an iframe — never
        // file:// (LFI) or javascript: (XSS). Empty clears.
        if (url && !/^https?:\/\//i.test(url)) {
          throw new TaskServiceError("invalid_input", "output_url must be an http(s) URL");
        }
        put("output_url", url || null);
      }
      let explicitPreview: string | null = null;
      if (patch.previewImage !== undefined) {
        const p = (patch.previewImage ?? "").trim();
        // Path assoluto su disco, mai un URL: il client lo rende via
        // /api/media (allowlist-gated). Empty clears.
        if (p && !isAbsolute(p)) {
          throw new TaskServiceError("invalid_input", "preview_image must be an absolute file path");
        }
        put("preview_image", p || null);
        explicitPreview = p || null;
        // Un'anteprima NUOVA supera il ritiro: lo stato si spegne qui, che è la
        // cosa che una nota nel thread non sa fare. Il ritiro lo riaccende solo
        // chi ritira (`retirePreview`), mai un azzeramento qualsiasi.
        if (p) { put("preview_retired_at", null); put("preview_retired_reason", null); }
      }
      if (patch.model !== undefined) {
        const m = (patch.model ?? "").trim();
        put("model", m || null);
        put("model_effort", null);
      }
      // AICTRL-01: separate from model/provider on purpose (AICTRL-04) — never
      // reuses the model column's own null-clears-to-auto encoding.
      if (patch.topicsRouting !== undefined) {
        put("topics_routing", patch.topicsRouting === null ? null : (patch.topicsRouting ? 1 : 0));
      }
      // WHERE it runs. Empty string and null both mean «this machine»: the
      // picker clears the choice by sending the empty value, and a card with
      // no node is the ordinary case, not a missing one (KANBAN-76).
      if (patch.machineId !== undefined) {
        const node = (patch.machineId ?? "").trim();
        put("machine_id", node || null);
        // A person chose the machine: the overflow's «moved because the Mac
        // was full» no longer describes it.
        put("overflowed_at", null);
      }
      if (patch.stayLocal !== undefined) put("stay_local", patch.stayLocal ? 1 : 0);
      // A person's mark holds for good: it clears any deadline the dispatcher set.
      if (patch.stayLocalUntil !== undefined) put("stay_local_until", patch.stayLocalUntil);
      else if (patch.stayLocal !== undefined) put("stay_local_until", null);
      if (patch.overflowSkip !== undefined) {
        put("overflow_skip_machine", patch.overflowSkip?.machineId ?? null);
        put("overflow_skip_until", patch.overflowSkip?.until ?? null);
      }
      if (patch.blockedByTaskId !== undefined) {
        if (patch.blockedByTaskId) assertBlockerValid(taskId, patch.blockedByTaskId);
        put("blocked_by_task_id", patch.blockedByTaskId || null);
      }
      if (patch.parentTaskId !== undefined) {
        if (patch.parentTaskId) {
          assertParentValid(taskId, patch.parentTaskId);
          // NON `isAgentWorking`: quello include `queued`, che altrove ("zitto,
          // sta lavorando") è la risposta giusta ma qui è la sbagliata. Una card
          // in coda non ha ancora nessuna sessione — nidificarla la toglie
          // semplicemente dalla coda, che è esattamente ciò che si vuole
          // accorpando. Il rifiuto riguarda un turno che sta GIRANDO: quello sì
          // resterebbe orfano, perché un sottotask non lo dispaccia più nessuno.
          if (row.dispatch_state === "working" || row.dispatch_state === "starting" || row.status === "in_progress") {
            throw new TaskServiceError(
              "invalid_input",
              "task has live work: a subtask is never dispatched on its own, so stop the agent before nesting it under a parent",
            );
          }
          // Un sottotask non è in coda per niente: il chip 'queued' resterebbe
          // acceso su una card che il dispatcher non guarderà mai più.
          if (row.dispatch_state === "queued") put("dispatch_state", null);
        }
        put("parent_task_id", patch.parentTaskId || null);
      }
      if (patch.reuseBlockerContext !== undefined) put("reuse_blocker_context", patch.reuseBlockerContext ? 1 : 0);
      if (patch.planFirst !== undefined) put("plan_first", patch.planFirst ? 1 : 0);
      // AN ARCHIVED CARD THAT GOES BACK TO DONE KEEPS THE DAY IT WAS CLOSED.
      //
      // Archiving 2939 closed cards put 49 back in backlog (card 47b63de2):
      // `release` writes status in raw SQL and left `completed_at` where it was.
      // Putting them back with a PATCH stamped them closed today — 2026-07-14
      // became 2026-10-26 on a22b3191, and every count of cards closed today
      // with it. An archived card is not worked on: done there is a restore,
      // not a new closing. The explicit date is the way back for a card whose
      // date has already been overwritten.
      if (patch.completedAt !== undefined) {
        if (!row.archived) {
          throw new TaskServiceError("invalid_input", "completedAt si scrive solo su una card archiviata: su una card viva la data di chiusura la mette il passaggio a done");
        }
        if ((patch.status ?? current) !== "done") {
          throw new TaskServiceError("invalid_input", "completedAt vale solo per una card in done");
        }
      }
      const closedAt = () =>
        patch.completedAt ?? (row.archived && row.completed_at ? row.completed_at : now());
      if (patch.status === undefined && patch.completedAt !== undefined) put("completed_at", patch.completedAt);
      if (patch.status !== undefined) {
        put("status", patch.status);
        put("completed_at", patch.status === "done" ? closedAt() : null);
        // Chi chiude, e chi riapre — i due fatti che la board deve poter dire da
        // sé (il thread non basta: chi guarda la colonna vede solo il buco).
        if (patch.status === "done") {
          put("done_actor", systemClose ? "system" : actor);
          // Ciclo chiuso: la card è di nuovo fatta, non è più «riaperta».
          put("reopened_at", null); put("reopened_by", null); put("reopened_actor", null);
        } else if (current === "done" || (current === "review" && patch.status !== "review")) {
          // USCIRE DA REVIEW È UNA RIAPERTURA QUANTO USCIRE DA DONE.
          //
          // Questo ramo si accendeva solo su `done`, e la chiusura automatica del
          // dispatcher legge proprio il campo che scrive qui («chi riapre una card
          // atterrata sta chiedendo un SEGUITO»). Il 12/08 alle 18:26 Attilio ha
          // chiesto un cambio di rotta nel thread e ha trascinato `d6baaf5e` da
          // `review` a `in corso`: per il campo nessuno aveva riaperto niente, e
          // il mattino dopo la card è stata chiusa sopra la consegna di cinque
          // giorni prima. Il segnale non può dipendere da quale casella ha
          // attraversato il dito.
          //
          // `done_actor` invece si spegne solo uscendo da `done`: una card in
          // review non ne ha uno, e azzerarlo qui vorrebbe dire cancellare la
          // decisione di chi l'aveva chiusa in un salto che non la tocca.
          if (current === "done") put("done_actor", null);
          // `actor` è l'asse dei PERMESSI, non quello dell'attribuzione: il land
          // andato in conflitto ritira la card da `done` con `actor: "human"`
          // proprio per poterlo fare (routes/tasks.ts, ramo "conflict"), ma la
          // firma vera è `by: "system"`. Leggendo l'attore, il chip avrebbe detto
          // «riaperta da te» di un ritiro che l'umano non ha deciso — cioè la
          // stessa bugia che questa card esiste per togliere, un livello più giù.
          const signature = by || "system";
          const reopenedActor = signature === "system" || signature === "dispatcher" ? "system" : actor;
          // Il marchio dell'umano non lo cancella la macchina passandoci sopra.
          // Da quando anche `review` è una partenza, una card già segnata «riaperta
          // da Attilio» può riconsegnare e poi rientrare in coda per mano del
          // sistema: sovrascrivere qui vorrebbe dire spegnere il cancello che
          // protegge la sua richiesta, con un UPDATE che nessuno ha deciso.
          if (reopenedActor === "human" || row.reopened_actor !== "human") {
            put("reopened_at", now()); put("reopened_by", signature); put("reopened_actor", reopenedActor);
          }
        }
        // Una card che RIENTRA in coda non porta con sé la consegna di prima.
        //
        // Lo scatto della consegna (`delivery_branch` / `delivery_commit`) e il
        // verdetto sull'atterraggio descrivono un lavoro CONSEGNATO. Da `done` o
        // da `review` verso la coda quel lavoro non è più ciò che la card sta
        // chiedendo: o è stato rifiutato, o l'umano l'ha riaperta per chiedere
        // dell'altro. Tenerlo vuol dire far parlare la card di un frutto che non
        // le appartiene più, e chi legge quel campo decide cose grosse — il
        // dispatcher ci CHIUDE sopra una card («è già su main, niente da
        // rifare»), e senza questa riga la richiesta nuova moriva sul commit
        // vecchio: chiusa a ogni tick, e senza via d'uscita, perché solo una
        // nuova consegna riscrive quel campo e per consegnare serve il dispatch
        // che il cancello blocca.
        //
        // Stessa lista che azzera `recordDelivery`: la TESTIMONIANZA cade col
        // suo commit, altrimenti il prossimo verdetto nascerebbe già «visto».
        if ((current === "done" || current === "review") && patch.status !== "done" && patch.status !== "review") {
          // The branch outlives its snapshot: the next run, here or on another
          // machine, starts FROM it (df5fd8c5 restarted from main without it).
          // A branch already on main is no base: main itself is newer.
          if (row.delivery_branch) put("prior_branch", branchStillAhead(row) ? row.delivery_branch : null);
          // The tip that was sent back: a resumed turn handing in this same commit did no work.
          if (row.delivery_commit) put("prior_commit", row.delivery_commit);
          if (row.delivery_branch) put("past_delivery_branches", `${row.past_delivery_branches ?? ""} ${row.delivery_branch}`.trim());
          // The uncommitted files outlive their count too: they are still in
          // this machine's worktree, and the overflow must not leave them behind.
          if (row.delivery_uncommitted_files != null) put("prior_uncommitted_files", row.delivery_uncommitted_files || null);
          for (const col of DELIVERY_SNAPSHOT_COLUMNS) put(col, null);
          put("landing_state", null); put("landing_checked_at", null); put("landing_witnessed", 0);
        }
        // A card leaving the flow keeps no live chip: dragging review → done
        // used to strand "delivered"/"serve te" on a closed card (only
        // reviewDecision cleared it).
        if (patch.status === "done") put("dispatch_state", null);
        // E CHI ESCE DA TODO ESCE DALLA CODA.
        //
        // Il claim del dispatcher pesca `status = 'todo'` e basta (il CAS di
        // riga 3667). Una card trascinata fuori da Todo non verrà quindi
        // guardata mai più — ma il chip `queued` restava acceso, e un chip che
        // dice «in coda» su una card che nessuno metterà in coda promette una
        // partenza che non arriva. Con lui restava acceso il bottone «Ferma»,
        // cioè l'offerta di interrompere un agente mai nato.
        //
        // Misurato il 19/08 sull'API vera: `todo/queued` → PATCH `backlog` →
        // `backlog/queued`. È la segnalazione «l'ho spostato in backlog e non è
        // successo nulla».
        //
        // Si spegne SOLO `queued`. `starting`/`working` sono un turno che sta
        // girando davvero: quello non lo chiude un trascinamento, lo chiude chi
        // lo possiede (`/stop`, che taglia il turno prima di parcheggiare).
        // Stesso ragionamento — e stessa riga — del nesting qui sopra.
        if (patch.status !== "todo" && current === "todo" && row.dispatch_state === "queued") {
          put("dispatch_state", null);
          // AND ITS REASON WITH IT. `dispatch_error` is what the chip says out
          // loud — «tetto agenti pieno», «nessuno slot libero» — and it was
          // left behind: the badge went out and the explanation for a queue
          // that no longer exists stayed on the row, ready to be rendered by
          // any surface that reads the reason rather than the state.
          put("dispatch_error", null);
        }
        // A person sending a card to backlog by hand, when it already sits there
        // under the "project folder not found" park, says it is held on purpose:
        // the sign goes, so the automatic return does not requeue it.
        if (patch.status === "backlog" && current === "backlog" && actor === "human"
          && row.dispatch_state === "blocked" && (row.dispatch_error === UNRESOLVED_PROJECT_PARK_REASON
            || row.dispatch_error === LEGACY_UNRESOLVED_PROJECT_PARK_REASON)) {
          put("dispatch_state", null);
          put("dispatch_error", null);
        }
        // A task arriving in review is a hand-off, not live work: settle a
        // lingering in-flight chip ('queued'/'starting'/'working') to
        // 'delivered' so a review card never shows the "agent al lavoro" UI
        // (which also double-renders the feedback input — steer + review). An
        // already-settled chip ('needs_input'/'delivered') is kept as-is; the
        // dispatcher's own delivery detection still refines it when it observes
        // a question (→ needs_input).
        //
        // `queued` NO: quello lo spegne la riga qui sopra. Una card mai
        // dispacciata, portata in review a mano, non ha consegnato niente — e
        // «consegnato» su lavoro che nessuno ha fatto è la stessa bugia del
        // chip «in coda» su una card fuori dalla coda. Nessun chip è la
        // risposta vera, e l'invariante di questo blocco (mai la UI «agent al
        // lavoro» su una card in review) regge lo stesso.
        if (patch.status === "review" && (row.dispatch_state === "working" || row.dispatch_state === "starting")) {
          put("dispatch_state", "delivered");
        }
        // Chi ha consegnato. Una card in review consegnata dall'agente e una
        // portata lì dal sistema pongono al reviewer due domande diverse, e oggi
        // hanno lo stesso aspetto. `deliverToReviewBySystem` scrive 'system' per
        // conto suo; qui passa solo chi ha spinto il bottone davvero.
        // `delivered_reason` si azzera: è la causa di QUESTA consegna, e questa
        // non è di sistema.
        if (patch.status === "review" && current !== "review") {
          put("delivered_by", systemAction ? "system" : actor);
          put("delivered_reason", systemAction?.reason ?? null);
          if (systemAction && humanAsk) put("dispatch_state", "needs_input");
        }
        // A HUMAN dragging a task into todo is a fresh mandate: reset the
        // retry budget. Without this, a task parked at the cap could never be
        // re-dispatched — the claim filter skipped it and the card stranded
        // on "in coda" forever. Agents don't get to refresh their own retries.
        //
        // E IL BUDGET NON ERA L'UNICA COSA CHE TENEVA FERMA LA CARD. La finestra
        // di rinvio (`dispatch_deferred_until`) la scrive l'agente quando dichiara
        // un'attesa, e il CAS del claim la rifiuta finché non è passata: fino a 24
        // ore. Azzerare i tentativi e lasciare quella significava un bottone
        // «rimetti in Todo» che rimette la card in una colonna dove nessuno la
        // prende, senza dire perché — e il chip vecchio (`failed`, `blocked`,
        // `waiting`) rimasto sopra continuava a raccontare il parcheggio di prima.
        // Le tre colonne si azzerano INSIEME, come già fa `resolveParkedChildren`
        // sui figli che rimette in coda: sono un mandato nuovo, non un residuo.
        if (patch.status === "todo" && actor === "human") {
          put("dispatch_attempts", 0);
          put("dispatch_deferred_until", null);
          put("dispatch_error", null);
          // IL CHIP SI SPEGNE PERCHE' RACCONTA UN PARCHEGGIO VECCHIO
          // (`failed`, `blocked`, `waiting`): quello e' il residuo che questo
          // blocco sta togliendo. `queued` non e' un residuo, e' la coda di
          // ADESSO — e su una card GIA' in Todo questo blocco scatta anche per
          // un riordino (cambio di priorita', trascinamento dentro la stessa
          // colonna), che spegneva il badge «in coda» di una card in coda
          // davvero. Su una card che ARRIVA in Todo si spegne comunque: li'
          // qualunque chip precedente descrive il mandato di prima.
          if (current !== "todo" || row.dispatch_state !== "queued") put("dispatch_state", null);
        }
        // E con lo stesso gesto finisce la SERIE DI ATTESE. È la risposta alla
        // domanda che il park `waited_out` ha posto: l'umano ha guardato e ha
        // detto «riprova». Senza questo azzeramento il task ripartirebbe con la
        // serie già sfondata e si riparcheggerebbe alla prima attesa, cioè il
        // bottone «rimetti in Todo» non rimetterebbe in todo un bel niente.
        //
        // Vale anche su review e done, e non per simmetria: lì il task ha
        // SMESSO di aspettare (ha consegnato, o è chiuso). Una serie lasciata
        // aperta tornerebbe a mordere al primo riavvio del lavoro, contando
        // insieme attese separate da giorni.
        if ((patch.status === "todo" && actor === "human") || patch.status === "review" || patch.status === "done") {
          // A human gesture (or a delivery) also resets the automatic requeues:
          // the cap counts the machine's own rounds, not the card's lifetime.
          put("auto_requeues", 0);
          put("wait_source", null);
          put("wait_streak", 0);
          put("wait_reason", null);
          put("wait_since", null);
          // Same reset, same reason: a delivery that actually reaches review
          // (or a card closed) is not a card still bouncing off the preview
          // gate — see `visible_preview_bounces` in `deliverToReviewBySystem`.
          if (patch.status === "review") put("visible_preview_bounces", 0);
        }
        // A CLOSED CARD DOES NOT WEAR A FAILURE.
        //
        // `dispatch_error` is the LAST turn that did not get there ("the turn
        // ended without reaching review after 2 attempts"): true while the card
        // is still trying, a lie the moment it is done, because the work landed.
        // Nothing used to clear it, and the chip that reads it (`!dispatchState
        // && dispatchError`) never looked at the status: 44 cards sat in Done
        // wearing a red 'stopped' badge. The chip now guards on the status, and
        // this clears the field at the source, so the two surfaces cannot
        // diverge again and the row stops carrying an answer to a dead question.
        if (patch.status === "done") put("dispatch_error", null);
      }
      // DA QUANDO ASPETTA UNA RISPOSTA. `updated_at` non lo dice: si muove a
      // ogni commento, etichetta, ri-audit dell'atterraggio, quindi una card
      // ferma da tre giorni su cui qualcuno ha scritto una riga sembra appena
      // arrivata. Il timbro sta QUI accanto all'azzeramento dell'attesa perche'
      // e' la stessa transizione vista dall'altro lato: la card smette di
      // aspettare la macchina e comincia ad aspettare una persona.
      //
      // A OGNI ingresso, non solo al primo: una card respinta e riconsegnata
      // ricomincia ad aspettare da capo, e mostrare l'attesa precedente sarebbe
      // una misura vera di una domanda sbagliata.
      if (patch.status === "review" && current !== "review") put("review_at", now());
      // The column, written only when it changes something (a reduced schema
      // without it keeps working on the default workflow).
      if (nextStage !== undefined && (nextStage !== null || row.stage != null)) put("stage", nextStage);
      // The question for the person belongs to one delivery: back to work drops it.
      if (patch.humanAsk !== undefined || askFromThread) put("human_ask", humanAsk);
      else if (row.human_ask != null && patch.status !== undefined && patch.status !== "review" && patch.status !== "done") put("human_ask", null);
      // A card moved to another machine (or pinned to this Mac) no longer waits for the old node: the series named a
      // machine it will not go to, and kept counting hours (10/11: 1dc60129 «cloud claude non risponde» for 7 h after
      // being pinned here; 966dc257 and c5aab453 still «PC non pronto» after the empty-run requeue to the Mac).
      if (((patch.machineId !== undefined && (patch.machineId ?? null) !== (row.machine_id ?? null)) || (patch.stayLocal === true && !row.stay_local))
        && (row.wait_reason != null || row.wait_since != null) && patch.status === undefined) {
        put("wait_streak", 0);
        put("wait_reason", null);
        put("wait_since", null);
        put("wait_source", null);
      }
      put("updated_at", now());

      db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params, taskId);
      // A PERMANENT `stayLocal` (no `stayLocalUntil`) gets a reason on the
      // thread, not only on the row: `task-dispatcher-remote-node-empty.ts`
      // is the one place the DISPATCHER pins a card for good, and it already
      // writes its own explanation there — skip it here (`by === "dispatcher"`)
      // or this comment would double up. Every OTHER caller (the PATCH route,
      // the TaskDetail toggle, the composer checkbox) reaches this same spot,
      // so a permanent pin set by a person never goes unexplained, even
      // without a reason typed in (`stayLocalReason` falls back to a generic
      // line rather than staying silent).
      if (patch.stayLocal === true && patch.stayLocalUntil === undefined && by !== "dispatcher") {
        const reason = (patch.stayLocalReason ?? "").trim();
        try {
          this.addComment({
            taskId, author: by, kind: "service",
            content: reason
              ? `«Solo Mac», senza scadenza: ${reason}`
              : "«Solo Mac», senza scadenza: pin manuale, nessuna ragione scritta.",
          });
        } catch { /* best-effort: the pin stands without its line */ }
      }
      if (patch.parentTaskId) releaseContainerFromCardContract(patch.parentTaskId);
      // Un task che ESCE da review si porta dietro la sua richiesta di
      // approvazione: va chiusa qui.
      //
      // `reviewDecision` era l'UNICO punto che la risolveva, ma non e' l'unica
      // strada per uscire da review — c'e' il trascinamento sulla board, c'e'
      // `update({status})` da MCP, c'e' l'archiviazione. Su ognuna di quelle la
      // riga restava 'pending' per sempre: misurate 13 approvazioni appese su
      // 48, di cui 9 su task gia' 'done'. Gonfiavano il conteggio dei "pending"
      // e nessuno le avrebbe mai chiuse, perche' il task non e' piu' in review e
      // `reviewDecision` lo rifiuta.
      //
      // L'esito NON e' sempre lo stesso: arrivare a 'done' e' cio' che
      // l'approvazione chiedeva, quindi 'approved'; ogni altra destinazione
      // rende la domanda priva di oggetto — 'expired', non 'rejected', perche'
      // nessun umano ha detto no. 'expired' e' gia' ammesso dal CHECK della
      // tabella e finora non lo usava nessuno.
      if (patch.status !== undefined && current === "review" && patch.status !== "review") {
        settleReviewApproval(taskId, patch.status === "done" ? "approved" : "expired", by, now());
        // The bell was ringing for a "needs review" card nobody reviews any
        // more: the subject of the notification moved on, the row did not. 74
        // `task-review` rows out of 400 unseen, measured on 2026-08-29. It goes
        // here, next to the approval, because this is the ONLY line every exit
        // from review crosses - the board drag, `update({status})` over MCP,
        // archiving.
        markTargetNotificationsSeen("task", taskId);
      }
      // Status history: every applied transition lands in the thread with its
      // author — the timeline answers "chi l'ha spostato e quando".
      if (patch.status !== undefined && patch.status !== current) logStatus(taskId, current, patch.status, by, statusReason, origin);
      // Hand-off into review without an explicit preview: promote the
      // delivery comment's evidence (comment-first delivery order).
      if (patch.status === "review") promoteReviewPreview(taskId);
      // Anteprima messa a mano: nessun gate (l'agente ha SCELTO quel file, e un
      // rifiuto qui sarebbe il quarto cancello di review che non vogliamo) —
      // ma il riciclo di un'evidenza altrui va almeno detto.
      if (explicitPreview) noteDuplicatePreview(taskId, explicitPreview);
      // PARCHEGGIARE UN FIGLIO CHE IL PADRE ASPETTA SI DICE SUBITO. Lo stallo
      // nasce qui, non dieci minuti dopo: da questo istante nessun dispatcher
      // prenderà più quel sottotask, e il padre che lo aspetta aspetta il nulla.
      // Prima lo scopriva solo il turno successivo del padre, e solo se ne aveva
      // uno.
      //
      // E VALE ANCHE PER `todo`, che è la porta da cui è entrato il guasto del
      // 13/08: uno step lasciato in todo SEMBRA in coda, ma la coda non lo
      // servirà mai (il tick lista `rootsOnly`). È fermo come uno in backlog, e
      // il momento in cui diventa fermo è questo.
      // A child that was ALREADY parked (backlog or todo, no dispatch chip on it) and moves to the other
      // parked column raises nothing: the stall existed before and the parent was told then. Asking again
      // turned the 23 backlog -> todo moves of 25/11 into a question on two container parents (cards
      // 5904a1cf, ca2134e0) that nobody had worked.
      const wasParked = (current === "backlog" || current === "todo")
        && !(ACTIVE_DISPATCH_STATES as readonly string[]).includes(String(row.dispatch_state ?? ""));
      if ((patch.status === "backlog" || patch.status === "todo") && current !== patch.status && row.parent_task_id && !wasParked) {
        parkedChildRaisedStall(row.parent_task_id as string, taskId, by, this);
      }
      // E il verso opposto: un figlio che si chiude esce dagli aperti, e il
      // padre può essere rimasto senza niente in volo.
      if (patch.status === "done" && current !== "done" && row.parent_task_id) {
        childLeftFlight(row.parent_task_id as string, by, this);
      }
      return rowToTask(getTaskRow(taskId));
    },

hasHeavyInFlight(): boolean {
      return heavyInFlight();
    },

liveAgents(scope): number {
      return liveAgentCount(db, scope?.projectId ?? null);
    },

overflowToMachine({ taskId, machineId, localMachineId }): Task | null {
      const ts = now();
      const res = db.prepare(
        `UPDATE tasks SET machine_id = ?, overflowed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'todo' AND assigned_topic_id IS NULL AND archived = 0
            AND (stay_local = 0 OR (stay_local_until IS NOT NULL AND stay_local_until <= ?))
            AND (machine_id IS NULL OR machine_id = ?)
            AND delegated_start_capability_id IS NULL
            AND (claude_task_id IS NULL OR claude_task_id NOT LIKE 'node-run:%')
            AND COALESCE(delivery_uncommitted_files, 0) = 0 AND COALESCE(prior_uncommitted_files, 0) = 0`,
      ).run(machineId, ts, ts, taskId, ts, localMachineId ?? "");
      if (res.changes === 0) return null;
      const row = getTaskRow(taskId);
      return row ? rowToTask(row) : null;
    },

// A seat is held only by a run the primary still believes is open
// (`node_run_open`), or by a `todo` card not yet launched there (no run
// opened yet, so nothing to check it against). A card the primary itself
// put in `waiting` says it is free to run anywhere EXCEPT when it is
// waiting on this very machine (`wait_source = 'machine'`, the silent-node
// retry in `task-dispatcher-remote-node.ts`): any other wait (a person, a
// condition elsewhere) releases the seat at once instead of holding it
// until the deferral window elapses. 26/11: a card closed on the primary
// but still carrying `machine_id` counted as busy on a node that had
// nothing left running for it.
countOnMachine(machineId: string): number {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE machine_id = ? AND archived = 0
            AND (COALESCE(dispatch_state, '') != 'waiting' OR COALESCE(wait_source, 'agent') = 'machine')
            AND (
              (status = 'in_progress' AND node_run_open = 1)
              OR (status = 'todo' AND node_run_open = 0)
            )`,
      ).get(machineId) as { n: number } | null;
      return row?.n ?? 0;
    },

countRunningOnMachine(machineId: string, exceptTaskId?: string): number {
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE machine_id = ? AND status = 'in_progress' AND archived = 0 AND id != ?",
      ).get(machineId, exceptTaskId ?? "") as { n: number } | null;
      return row?.n ?? 0;
    },

claim({ taskId, cap, maxAttempts, agentId, scope, machineIdle, noCheckExemption, remote }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // PESO — due regole, entrambe dentro il claim perché è l'unico punto in cui
      // la decisione è atomica rispetto agli altri claim (bun:sqlite è sincrono e
      // monoprocesso, quindi read-then-CAS qui non ha corse).
      //
      //  1. Un heavy in volo blocca OGNI altro claim, non solo gli altri heavy:
      //     il senso del peso è che quel task si prenda la macchina da solo, e
      //     tre task leggeri che gli partono accanto sono esattamente ciò che
      //     rende lunga la compilazione. Vale a macchina intera, non per board.
      //  2. Un heavy parte solo a macchina scarica. Il carico non lo legge questo
      //     modulo (resta puro): lo passa il chiamante. `undefined` = nessuna
      //     sonda ⇒ nessun gate, il comportamento storico.
      //
      // Entrambe si applicano PRIMA del conteggio degli slot: un no del peso non
      // è «non c'è posto», è «non adesso», e il chiamante lo dice diversamente.
      // A node's spawn_agent child shares the machine with a heavy turn (node-child-run.ts).
      const child = isNodeChildRun(rowToTask(row));
      if (!remote && heavyInFlight() && !noCheckExemption && !child) return null;
      if (noCheckExemption && readTaskWeight(row.dispatch_weight) === "heavy") return null;
      if (!remote && !child && readTaskWeight(row.dispatch_weight) === "heavy" && machineIdle === false) return null;
      // Concurrency cap: count the AGENTI VIVI, not the card. Per-board by
      // default; scope 'global' counts across EVERY board so a machine-wide cap
      // holds no matter how many boards dispatch at once. The task itself is
      // still `todo` here, so it is not in the count. bun:sqlite is synchronous
      // + single-process, so this read-then-CAS is atomic w.r.t. other claims.
      //
      // La popolazione contata sta in `agent-census.ts` e comprende le SESSIONI
      // FIGLIE dei task dispatchati. Contare solo le lines `tasks` reggeva
      // finché un task era un processo; col modello del coordinatore una card
      // vale N processi, e un tetto che non li vede lascia partire un altro
      // task su una macchina già piena. Il claim e la rotta di spawn leggono la
      // stessa funzione apposta: due query diverse sarebbero due tetti.
      if (!remote && liveAgentCount(db, scope === "global" ? null : row.project_id) >= cap) return null;
      const ts = now();
      const res = db.prepare(
        `UPDATE tasks
            SET assigned_agent_id = ?, status = 'in_progress',
                in_progress_at = ?, dispatch_state = 'starting',
                dispatch_attempts = dispatch_attempts + 1, dispatch_error = NULL,
                dispatch_deferred_until = NULL, updated_at = ?
          WHERE id = ? AND status = 'todo' AND assigned_topic_id IS NULL AND dispatch_attempts < ?
            AND (dispatch_deferred_until IS NULL OR dispatch_deferred_until <= ?)
            -- A scheduled run outside Topics does this card's work: an agent on top would do it twice.
            AND scheduled_by IS NULL
            AND (blocked_by_task_id IS NULL OR EXISTS (
                  SELECT 1 FROM tasks bk
                   WHERE bk.id = tasks.blocked_by_task_id AND (bk.status = 'done' OR bk.archived = 1)))`,
      ).run(agentId ?? null, ts, ts, taskId, maxAttempts, ts);
      if (res.changes !== 1) return null; // lost the race / not todo / attempts exhausted
      logStatus(taskId, "todo", "in_progress", "dispatcher");
      return rowToTask(getTaskRow(taskId));
    },

bumpDispatchAttempt({ taskId, maxAttempts }): Task | null {
      const res = db.prepare(
        `UPDATE tasks
            SET dispatch_attempts = dispatch_attempts + 1, updated_at = ?
          WHERE id = ? AND status = 'in_progress' AND assigned_topic_id IS NOT NULL AND dispatch_attempts < ?`,
      ).run(now(), taskId, maxAttempts);
      if (res.changes !== 1) return null; // cap hit, moved, or claim gone
      return rowToTask(getTaskRow(taskId));
    },

listBlockedBy(taskId): Task[] {
      const rows = db.prepare(
        "SELECT * FROM tasks WHERE blocked_by_task_id = ? AND archived = 0",
      ).all(taskId) as any[];
      return rows.map(rowToTask);
    },

isDispatchBlocked(taskId): boolean {
      const r = db.prepare(
        `SELECT 1 AS b FROM tasks t
          WHERE t.id = ? AND t.blocked_by_task_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tasks bk
                             WHERE bk.id = t.blocked_by_task_id AND (bk.status = 'done' OR bk.archived = 1))`,
      ).get(taskId);
      return !!r;
    },

release(this: TaskService, { taskId, requeue, reason, by, parkState, rollbackAttempt, keepStatus, keepInTodo }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // A DONE CARD STAYS DONE. Measured 12/11 on 403aad1f: closed at 13:04, a
      // remote-run path released it with `requeue` at 13:05 (`reopenedBy:
      // dispatcher`), the next claim started an agent on finished work, which
      // then asked whether to close it. Several callers release without looking
      // at the column (mirror retirement, weekly limit, restart requeue, empty
      // node run): the guard lives here, once, for all of them. The link to the
      // topic is still cleared and the reason still lands as a note (the GC
      // writes why it unbound or abandoned a worktree); the column and the
      // reopen mark are not touched.
      if (row.status === "done") {
        if (reason && reason.trim()) {
          try { this.addComment({ taskId, author: by ?? "system", content: reason }); } catch { /* dedupe/best-effort */ }
        }
        db.prepare(
          `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL,
              dispatch_state = NULL, dispatch_error = NULL, updated_at = ? WHERE id = ?`,
        ).run(now(), taskId);
        return rowToTask(getTaskRow(taskId));
      }
      // Note first (so the "worked in topic X" trail survives clearing the link).
      if (reason && reason.trim()) {
        try { this.addComment({ taskId, author: by ?? "system", content: reason }); } catch { /* dedupe/best-effort */ }
      }
      const ts = now();
      // IN REVIEW NON ASPETTA UN AGENTE, ASPETTA UNA PERSONA.
      //
      // Un park (`requeue: false`) scriveva `backlog` senza guardare da dove
      // veniva la card. Il 12/08 quattro card in `review` sono finite in backlog
      // marcate `failed` con la stessa riga — «il branch del worktree non esiste
      // più» — perché il loro lavoro ERA ATTERRATO: il land pota il ramo, il GC
      // trova la riga fantasma e parcheggia. Il backlog non lo dispaccia
      // nessuno, quindi la decisione umana non era rimandata: era sparita dalla
      // colonna dove l'umano la guarda, e proprio per le card chiuse bene.
      //
      // Il park continua a fare l'unica cosa che serviva davvero — sciogliere il
      // legame col topic, così niente riprende in una cartella che non c'è più —
      // ma lo stato resta `review`. Nemmeno il timbro `failed` ci va: non è
      // fallito niente, e dipingere di rosso una card in attesa dice il falso a
      // chi la guarda per decidere.
      //
      // `keepStatus` è la stessa risposta chiesta esplicitamente: il GC che
      // scioglie una riga fantasma di una card la cui consegna è GIÀ SU MAIN non
      // ha trovato un guasto, ha trovato la fine normale della storia — e quella
      // card può stare in qualunque colonna.
      const parkKeepsStatus = !requeue && (keepStatus === true || row.status === "review");
      // A park that stays VISIBLE in the queue column: the card leaves the
      // dispatch loop through its own state (`failed` + spent attempts), not by
      // moving to backlog, where nobody looks (retry budget spent).
      const parkInTodo = !requeue && !parkKeepsStatus && keepInTodo === true;
      const status: TaskStatus = requeue || parkInTodo ? "todo" : parkKeepsStatus ? (row.status as TaskStatus) : "backlog";
      // Requeue shows the 'in coda' chip; a park carries an EXPLICIT state so the
      // board can tell a genuine FAILURE ('failed') from a config BLOCK ('blocked')
      // — both used to collapse to null and read as a manual "fermato".
      const state = requeue ? "queued" : parkKeepsStatus ? null : (parkState ?? null);
      // A restart-orphan requeue rolls back the interrupted attempt: the server
      // restarting is never the agent's fault, so it must not erode the retry
      // budget (that was the "il task torna in backlog per errore" after deploys).
      const rollbackSql = rollbackAttempt ? "dispatch_attempts = MAX(dispatch_attempts - 1, 0), " : "";
      // La ragione è già nel thread come commento, qui sopra. Su una card che
      // resta in review non va anche in `dispatch_error`: quel campo è il tooltip
      // di un chip che non c'è, e una card in attesa di una persona non porta
      // addosso un errore.
      const errText = parkKeepsStatus ? null : (reason ?? null);
      db.prepare(
        `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL, ${rollbackSql}
            status = ?, dispatch_state = ?, dispatch_error = ?, updated_at = ? WHERE id = ?`,
      ).run(status, state, errText, ts, taskId);
      if (row.status !== status) logStatus(taskId, row.status, status, by ?? "dispatcher");
      markReopened(taskId, row.status, status, "system", by ?? "dispatcher");
      return rowToTask(getTaskRow(taskId));
    },

deferForWait(this: TaskService, { taskId, reason, minutes, by, source }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // A done card waits for nothing: same rule as `release`.
      if (row.status === "done") return rowToTask(row);
      const askedMins = clampInt(minutes ?? 15, 1, 1440);
      const ts = now();
      const detto = reason && reason.trim() ? reason.trim() : "";
      // The count: same reason ⇒ it goes on, new reason ⇒ it restarts from one.
      // `waitReasonKey` normalizza, perché un turno nuovo riscrive a mano quasi
      // la stessa frase e «quasi» non deve valere come «un'altra attesa».
      const chiave = waitReasonKey(detto);
      const stessa = !!row.wait_streak && (row.wait_reason ?? "") === chiave;
      const streak = stessa ? (row.wait_streak as number) + 1 : 1;
      // The series CLOCK ignores the words: if the card was already waiting it
      // keeps running whatever the reason. Card 60c4b56a: five waits in three
      // days on one condition, reworded each time, and the time cap never
      // fired. Real progress resets the series elsewhere (delivery, subtasks).
      const alreadyWaiting = Number(row.wait_streak) > 0 && !!row.wait_since;
      const since = alreadyWaiting ? (row.wait_since as string) : ts;
      const serieMs = Math.max(0, Date.parse(ts) - Date.parse(since));
      // IL TENTATIVO SI RIMBORSA, e questa è la riga che chiude il guasto.
      //
      // Il turno che dichiara l'attesa il tentativo l'ha già speso: l'ha preso
      // la claim, PRIMA che l'agent potesse sapere che avrebbe dovuto aspettare.
      // Lasciarglielo addosso significa che un tetto pensato per i turni morti
      // (default 2) conta le attese, e alla terza la spazzata dei tentativi
      // esauriti parcheggia la card come `failed`. Rimborsando, `dispatch_attempts`
      // torna al valore che aveva prima della claim: un'attesa dichiarata non
      // lascia traccia sul contatore dei fallimenti, perché non è un fallimento.
      // A limitare le attese ci pensano i loro tetti, qui sotto.
      const rimborso = "dispatch_attempts = MAX(dispatch_attempts - 1, 0),";

      // Who declared the wait decides whether the resulting park comes back by
      // itself (`sweepMachineWaitedOut`). Written before the caps so the park
      // right below reads it too.
      db.prepare("UPDATE tasks SET wait_source = ? WHERE id = ?").run(source === "machine" ? "machine" : "agent", taskId);
      // A machine wait still parks at its caps (it comes back by itself). An
      // agent wait never parks: it stays in todo and the window GROWS with
      // each repeat instead of landing in backlog.
      const isMachine = source === "machine";
      if (isMachine && (streak > WAIT_STREAK_CAP || serieMs >= WAIT_SERIES_MAX_MS)) {
        return parkWaitedOut(this, { row, streak, serieMs, chiave, since, detto, ts, refundAttempt: true });
      }
      const mins = isMachine ? askedMins : Math.max(askedMins, agentWaitWindowMinutes(streak));

      const note =
        (detto ? `In attesa: ${detto}. ` : "In attesa di una condizione esterna. ") +
        `Rilascio lo slot, il task torna in coda e riprovo tra ~${mins} min` +
        (streak > 1 ? ` (attesa ${streak}).` : ".");
      // Note first (author = the agent by default) so the "perché è fermo" trail
      // survives clearing the topic link.
      try { this.addComment({ taskId, author: by ?? "agent", content: note }); } catch { /* dedupe/best-effort */ }
      // Back to todo, slot freed (topic/agent cleared), chip `waiting`, and a
      // deferral window that keeps it out of the claim until it elapses.
      // The slot is freed and the topic link with it: the worktree's branch, if
      // it carries commits, is the only thread back to that work (a rerun
      // otherwise starts from main without it, card f3c5a186). A card that
      // never had a worktree keeps whatever `prior_branch` it had.
      let ownBranch: string | null = null;
      try {
        const root = row.assigned_topic_id
          ? _opts.repoRootFor?.({ taskId, projectId: row.project_id as string | undefined, assignedTopicId: row.assigned_topic_id as string })
          : null;
        ownBranch = root ? (_opts.branchAheadOf?.(root) ?? null) : null;
      } catch { /* best-effort: the wait itself must not fail */ }
      db.prepare(
        `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL, ${rimborso}
            status = 'todo', dispatch_state = 'waiting', dispatch_error = ?,
            dispatch_deferred_until = ?, prior_branch = COALESCE(?, prior_branch),
            wait_streak = ?, wait_reason = ?, wait_since = ?, updated_at = ?
          WHERE id = ?`,
      ).run(note, new Date(Date.parse(ts) + mins * 60_000).toISOString(), ownBranch, streak, chiave || null, since, ts, taskId);
      if (row.status !== "todo") logStatus(taskId, row.status, "todo", by ?? "agent");
      markReopened(taskId, row.status, "todo", "agent", by ?? "agent");
      return rowToTask(getTaskRow(taskId));
    },

askParkedChildren(this: TaskService, { taskId, by, evenIfLive }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) return null;
      // Una card chiusa o archiviata non ha domande da fare; una GIÀ in review la
      // sta già facendo, e rifarla a ogni giro sarebbe il rumore che spegne le
      // domande vere.
      if (row.archived === 1 || row.status === "done" || row.status === "review") return null;
      // A parent in the QUEUE is a promise of work, not a stall: the agent it
      // gets reads the open subtasks in its kickoff and works them. Asking "who
      // will work them?" moved three queued parents to review, each with a
      // question on top, twelve seconds after their sub-cards were put back to
      // todo (2026-09-04 10:09). "In the queue" is a todo card that carries the
      // `queued` chip or has never had a turn; a todo card that already spent
      // one and came back without a chip is what the rake exists for.
      if (row.status === "todo" && (row.dispatch_state === "queued" || Number(row.dispatch_attempts ?? 0) === 0)) return null;
      // IL PADRE STA LAVORANDO: la domanda non si fa adesso.
      //
      // Spostare in review una card con un turno vivo gli taglia il turno sotto
      // i piedi — lo dice gia' la docstring di `parkedChildRaisedStall`, che per
      // questo la guardia ce l'aveva. Mancava qui, cioe' nell'unico punto che la
      // card la MUOVE davvero, e `childLeftFlight` ci arrivava senza nessuna
      // protezione: bastava che l'agente spuntasse il primo passo della propria
      // checklist perche' la sua card finisse in review a turno in corso.
      // La domanda non si perde: la fa `deliverToReviewBySystem` a fine turno,
      // che passa `evenIfLive` proprio perche' li' il turno e' finito per
      // davvero. Fra minuti, non fra giorni.
      if (!evenIfLive && hasLiveTurn(row)) return null;
      if (!hasActiveChildren(taskId) || hasChildrenInFlight(taskId)) return null;
      const parked = parkedChildren(taskId);
      if (parked.length === 0) return null;
      const ts = now();
      const elenco = parked.map((c) => `«${c.text.length > 60 ? `${c.text.slice(0, 59)}…` : c.text}»`).join(", ");
      // La domanda sta su UNA riga: il blocco `question` appiattisce gli a capo
      // (contratto del parser delle risposte rapide), quindi l'elenco dei figli
      // viaggia in linea e non come lista.
      // «fermi», non «parcheggiati in backlog»: da quando il predicato conta
      // anche i figli in `todo`, la colonna non è più la notizia — lo è il fatto
      // che nessun turno li muoverà. Nominare una colonna sbagliata manderebbe a
      // cercarli dove non sono.
      // GIA' RIMESSI IN CODA UNA VOLTA? Allora quel bottone non si offre piu'.
      //
      // SI CONTA IL FATTO SCRITTO, non l'etichetta del bottone. Il confronto era
      // `content = REQUEUE_PARKED_LABEL`, e nessuno scrive mai un commento il cui
      // corpo INTERO sia quel testo: il conto era zero sempre, la terza uscita non
      // si offriva mai, e all'umano tornava per sempre lo stesso bottone circolare
      // — cioè esattamente l'anello che quell'uscita esiste per rompere. Il fatto
      // che viene davvero scritto è la nota di `resolveParkedChildren`, e il
      // pattern arriva da `shared/board.ts`, dalla stessa costante che la compone.
      //
      // L'ANELLO, visto tre volte in una notte sulle stesse card: «rimetti in
      // coda» porta i figli in `todo`, ma un figlio in `todo` conta come fermo
      // (nessun tick lo prende: il dispatcher lista `rootsOnly`), quindi alla
      // fine del turno successivo la domanda riparte identica. Chi risponde
      // ripremeva lo stesso bottone e tornava esattamente qui.
      //
      // Offrire due volte un'uscita che si e' gia' dimostrata circolare non e'
      // dare una scelta: e' far girare a vuoto chi decide. Alla seconda volta la
      // domanda lo DICE, e lascia le uscite che portano fuori davvero.
      const giaRimessi = (db.query(
        "SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ? AND content LIKE ?",
      ).get(taskId, PARKED_REQUEUE_NOTE_LIKE) as { n: number } | undefined)?.n ?? 0;
      // IL SUGGERIMENTO, che è la differenza fra chiedere e chiedere a freddo.
      //
      // Chi rivede non ha in mano ciò che il servizio ha già: quali step hanno
      // lavoro proprio. Con del lavoro sotto, l'uscita è PROMUOVERLI — la coda
      // serve i task, non i figli — e archiviarli butterebbe la lista di ciò che
      // restava da fare; nudi, sono la decomposizione del titolo e archiviarli
      // non toglie niente. La frase lo dice e l'ordine dei bottoni lo mostra: il
      // primo è quello suggerito. Chi decide resta chi decide.
      const withWork = parked.filter((c) => c.own_work === 1).length;
      const lettura = withWork > 0
        ? `${withWork} su ${parked.length} hanno lavoro proprio (sessione, tentativi o commenti): promuoverli a task li rende servibili dalla coda, archiviarli butterebbe cio' che restava da fare.`
        : `Nessuno dei ${parked.length} ha lavoro proprio: sono la decomposizione del titolo, e archiviarli non perde niente.`;
      const question = giaRimessi > 0
        ? `Fermo di nuovo sugli stessi ${parked.length} sottotask (${elenco}), e rimetterli in coda l'ha gia' fatto: ` +
          `non basta, perche' uno step lo muove solo l'agente di questa card dentro il proprio turno e quel turno non li ha toccati. ${lettura} ` +
          `Li promuovo a task, archivio cio' che non serve piu', oppure la prendi in mano tu?`
        : `Fermo su ${parked.length} sottotask che non lavorerà nessuno (${elenco}): uno step lo muove solo l'agente di questa card ` +
          `dentro il proprio turno, e con un sottotask aperto questo task non si può chiudere. ${lettura} ` +
          `Li promuovo a task indipendenti, li rimetto in coda, o archivio ciò che non serve più?`;
      // I BOTTONI, nell'ordine in cui vanno letti: il suggerito per primo.
      //
      // «Rimetti in coda» non compare piu' alla seconda volta: si e' gia'
      // dimostrata circolare su questa card (vedi sopra), e riproporla e' far
      // girare a vuoto chi decide.
      const opzioni = giaRimessi > 0
        ? [PROMOTE_PARKED_LABEL, ARCHIVE_PARKED_LABEL, TAKE_OVER_PARKED_LABEL]
        : withWork > 0
          ? [PROMOTE_PARKED_LABEL, REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL]
          : [ARCHIVE_PARKED_LABEL, PROMOTE_PARKED_LABEL, REQUEUE_PARKED_LABEL];
      // PREDICATO review_needs_summary, PORTA DI SISTEMA.
      //
      // PRIMA di cio' che parla all'umano, e non dopo: l'ULTIMA parola del
      // thread e' quella a cui si risponde. Una domanda porta le sue opzioni
      // (`questionOptions`) e il client legge l'ultimo commento; una nota di
      // contabilita' appesa dopo la seppelliva, e sette casi di
      // `tasks.parked-stall.test.ts` sono diventati rossi leggendo `[]` dove
      // c'erano due bottoni. Il rosso era il sintomo: il guasto vero e' che
      // chi apriva la card trovava per ultima una riga di macchina invece
      // della decisione che gli si chiede.
      //
      // Dentro `update()` il predicato BLOCCA (l'agente puo' riprovare). Qui
      // non puo' — il turno e' finito — ma il fatto si ANNOTA: chi rivede sa
      // subito che l'agente non ha dichiarato nulla. `kind='service'`:
      // contabilita', non conversazione.
      //
      // QUI resta 'service' anche dopo che l'altro punto e' passato a
      // 'comment', e la differenza e' cio' che viene dopo: li' la nota e'
      // l'ultima cosa che il thread ha da dire, qui subito sotto arriva una
      // DOMANDA con i suoi bottoni. Promuoverla le ruberebbe la cima della
      // card — cioe' l'unica cosa che tiene ferma la review.
      if (!hasFreshAgentComment(taskId)) {
        try {
          this.addComment({
            taskId, author: "system", kind: "service",
            content: "Consegna senza riassunto: il turno e' finito prima che l'agente commentasse.",
          });
        } catch { /* best-effort */ }
      }
      try {
        this.addComment({
          taskId, author: "system", content: question,
          questionOptions: opzioni,
        });
      } catch { /* dedupe/best-effort: la domanda resta comunque nello stato */ }
      // Stessa forma di una consegna di sistema — review + `needs_input` + firma
      // `system` — perché è la stessa cosa: una card che aspetta una persona.
      // `delivered_reason` dice QUALE persona serve, e la card lo scrive da sé.
      db.prepare(
        "UPDATE tasks SET status = 'review', dispatch_state = 'needs_input', dispatch_error = ?, " +
          "dispatch_deferred_until = NULL, wait_streak = 0, wait_reason = NULL, wait_since = NULL, " +
          "review_at = ?, " +
          "delivered_by = 'system', delivered_reason = 'parked_children', updated_at = ? WHERE id = ?",
      ).run(question, ts, ts, taskId);
      if (row.status !== "review") logStatus(taskId, row.status, "review", by ?? "dispatcher");
      markReopened(taskId, row.status, "review", "system", by ?? "dispatcher");
      // A question for a person by construction.
      writeSystemDeliveryAsk(taskId, question);
      // L'approvazione pendente serve al flusso di review: la risposta rapida
      // arriva su quella porta, ed è anche ciò che la chiude quando il task esce.
      try {
        db.prepare(
          `INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at)
           VALUES (?, ?, 'dispatcher', 'review', ?, 'done', 'pending', ?)`,
        ).run(uuid(), taskId, row.status, ts);
      } catch { /* un'approvazione già pendente va benissimo */ }
      return rowToTask(getTaskRow(taskId));
    },

sweepParkedChildren({ by, eligible } = {}): Task[] {
      const ts = now();
      // I CANDIDATI, non la decisione: questa query stringe il campo, poi
      // `askParkedChildren` applica le sue guardie una per una. Due predicati
      // che decidono la stessa cosa in due punti divergono, e il modo in cui
      // divergerebbero è il peggiore possibile — una domanda alzata su una card
      // che non l'aveva, o taciuta su una che l'aveva.
      //
      // Fuori dal campo, e sono le stesse esclusioni della sonda
      // (`scripts/stalled-parents.ts`): un padre con un turno addosso o in
      // arrivo (se ne accorgerà a fine corsa), uno dentro la propria finestra di
      // rinvio (un turno è previsto, solo più tardi), e uno in review — lì la
      // guardia di `askParkedChildren` esce comunque, ma chiederlo al DB
      // risparmia il giro su ogni card consegnata della board.
      //
      // …E UN PADRE APPENA RIMESSO IN CODA, che è l'anello che questa riga
      // rompe. «Rimetti in coda» (o un umano che trascina la card in Todo)
      // azzera `dispatch_attempts` insieme al resto dello stato di dispatch
      // (vedi `update`, ramo `status === "todo" && actor === "human"`), e da quel
      // momento la card è un candidato pieno: il rastrello passa PRIMA che il
      // dispatcher le dia il turno e la riporta in review con la stessa domanda.
      // Misurato il 15/08 su `5505c6fa`, che di suo si intitola «review che non
      // rientra in coda»: rimessa in coda alle 20:32, di nuovo in review alle
      // 20:49, senza che nessun agente l'avesse toccata. Chi rispondeva vedeva
      // la card tornare indietro da sola e la domanda ricomparire identica.
      //
      // `todo` + zero tentativi vuol dire «in coda, turno mai partito»: quel
      // padre non è fermo, sta aspettando il suo giro, e la domanda giusta gliela
      // farà `deliverToReviewBySystem` alla FINE di quel turno se davvero non
      // avrà toccato i figli. Con un tentativo già speso invece è fermo per
      // davvero, e il rastrello lo prende come prima.
      let candidati: Array<{ id: string; project_id: string }> = [];
      try {
        candidati = db.prepare(PARKED_CHILDREN_CANDIDATES_SQL).all(ts) as Array<{ id: string; project_id: string }>;
      } catch { return []; }
      const chiesti: Task[] = [];
      const ammessa = new Map<string, boolean>();
      for (const c of candidati) {
        if (eligible) {
          let ok = ammessa.get(c.project_id);
          if (ok === undefined) { try { ok = eligible(c.project_id); } catch { ok = false; } ammessa.set(c.project_id, ok); }
          if (!ok) continue;
        }
        try {
          const t = this.askParkedChildren({ taskId: c.id, by: by ?? "dispatcher" });
          if (t) chiesti.push(t);
        } catch { /* una card può essersi mossa sotto: il giro dopo la ripesca */ }
      }
      return chiesti;
    },

waitedOutIfCapped(this: TaskService, { taskId }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) return null;
      if (row.archived === 1) return null;
      // Only the two columns where a wait is still RUNNING. `review` and `done`
      // clear the series on the way in (see `update`), and `backlog` is where
      // this park already put it: re-parking would rewrite the note forever.
      if (row.status !== "todo" && row.status !== "in_progress") return null;
      // An agent's wait is never judged by the caps: it stays in todo.
      if (row.wait_source !== "machine") return null;
      const since = (row.wait_since ?? null) as string | null;
      if (!since) return null;
      const ts = now();
      const nowMs = Date.parse(ts);
      // `serieMs` is what the NOTE reports — how long the series has actually
      // been running — and it stays measured from `wait_since` whatever the
      // cap decides below. The two must not be the same number: reporting the
      // overdue time instead would claim four hours on a series that has been
      // alive for twelve.
      const serieMs = nowMs - Date.parse(since);
      if (!Number.isFinite(serieMs)) return null;
      // A CAP ON A SERIES STILL RUNNING, AND THIS IS WHERE IT ENDS.
      //
      // `deferForWait` writes `dispatch_deferred_until` on every declaration
      // and `claim` nulls it. So on a row that still carries `wait_since`, a
      // NULL window means exactly one thing: a turn has already restarted
      // since the last declaration and did not ask to wait again. The series
      // is over, whatever the column says — no dispatcher requeue clears
      // `wait_since` (only human→todo, review and done do), so it outlives
      // the very turn that STOPPED waiting.
      //
      // Reading it as "no window, so measure from `wait_since`" is what parked
      // a card that `origin/main` starts: the live shape (`c4d48d3e`, streak 1,
      // `wait_since` five hours old, window NULL) came out `backlog` /
      // `waited_out` with zero turns against `in_progress` / working with one.
      //
      // The window is the sign, not `task_attempts.created_at` or
      // `in_progress_at`: those answer "when did the last turn start", which on
      // a streak of two or more is ALWAYS later than `wait_since` — that is
      // what a series IS — so comparing them against `wait_since` would switch
      // the whole backstop off instead of bounding it.
      //
      // Nothing is left unguarded by stepping back here. A card whose turns
      // keep dying without declaring anything is not a stuck WAIT, and it has
      // its own backstop: the claim spends an attempt every time (only
      // `deferForWait` refunds one), so `dispatch_attempts` reaches the retry
      // cap and the card parks as `failed` — with a note that is true.
      const wakeMs = Date.parse((row.dispatch_deferred_until ?? "") as string);
      if (!Number.isFinite(wakeMs)) return null;
      // THE WAKE-UP THE AGENT ASKED FOR IS NEVER OVERTAKEN. While the window
      // is still ahead, no turn has had the chance to look at whether the
      // condition arrived, so there is nothing to judge yet. `deferForWait`
      // clamps `minutes` to 1440 and production asks for up to 240, so a lone
      // wait outliving the 4-hour cap is a normal card, not a stuck one.
      if (wakeMs > nowMs) return null;
      // THE DURATION CAP IS A CAP ON A SERIES. With a streak of one there is
      // no series: there is one wait the agent asked for, and the only time
      // nobody looked at the card is the time since its wake-up. Measuring
      // from the declaration instead parks a wait that has not even come due
      // (480 minutes requested, parked at 241) and tells the reader it is one
      // wait in a row. From two waits up the clock is the series itself,
      // which is the quantity `WAIT_SERIES_MAX_MS` was written for.
      const streak = Number(row.wait_streak) || 1;
      const capFrom = streak >= 2 ? Date.parse(since) : wakeMs;
      if (nowMs - capFrom < WAIT_SERIES_MAX_MS) return null;
      // THE REASON WE HAVE IS THE KEY, NOT THE PROSE. The row keeps
      // `waitReasonKey(reason)` — lowercased, whitespace collapsed — because
      // that is what decides whether a new wait continues the series. The
      // original sentence lived in `dispatch_error`, which the dispatcher
      // overwrites with its own hold text every 60 seconds, so the key is the
      // only reason still on the row that describes THIS wait.
      const detto = ((row.wait_reason ?? "") as string).trim();
      return parkWaitedOut(this, {
        row,
        streak,
        serieMs,
        chiave: detto,
        since,
        detto,
        ts,
        // Nothing was claimed here: no turn started, so there is no attempt to
        // give back. Refunding would hand the card a retry it never spent.
        refundAttempt: false,
      });
    },

sweepMachineWaitedOut(this: TaskService, { eligible } = {}): Task[] {
      // A CARD PARKED BY THE MACHINE GOES BACK BY ITSELF. The `waited_out` park
      // asks a human to decide, which is right for a wait an agent named; for a
      // silent node or a PC that does not wake up the condition usually comes
      // back on its own, and the card sat in backlog for hours (2026-11-10:
      // 1dc60129, parked while the cloud node came back). Here it returns to
      // todo after a doubling delay (30, 60, 120 min), at most
      // `MACHINE_RETRY_CAP` times: if the node is still silent the card goes
      // through the wait caps again and re-parks, until the cap stops the loop.
      const ts = now();
      const nowMs = Date.parse(ts);
      let rows: Array<{ id: string; project_id: string; updated_at: string; auto_requeues: number }> = [];
      try {
        rows = db.prepare(
          `SELECT id, project_id, updated_at, auto_requeues FROM tasks
            WHERE archived = 0 AND status = 'backlog' AND dispatch_state = ?
              AND wait_source = 'machine' AND auto_requeues < ?`,
        ).all(PARKED_WAITED_OUT, MACHINE_RETRY_CAP) as typeof rows;
      } catch { return []; }
      const out: Task[] = [];
      for (const r of rows) {
        const n = Number(r.auto_requeues) || 0;
        if (nowMs - Date.parse(r.updated_at) < MACHINE_RETRY_BASE_MS * 2 ** n) continue;
        if (eligible) { let ok = false; try { ok = eligible(r.project_id); } catch { ok = false; } if (!ok) continue; }
        const res = db.prepare(
          `UPDATE tasks SET status = 'todo', dispatch_state = NULL, dispatch_error = NULL, dispatch_attempts = 0,
              dispatch_deferred_until = NULL, wait_streak = 0, wait_reason = NULL, wait_since = NULL,
              auto_requeues = auto_requeues + 1, updated_at = ?
            WHERE id = ? AND status = 'backlog' AND dispatch_state = ? AND wait_source = 'machine'`,
        ).run(ts, r.id, PARKED_WAITED_OUT);
        if (!res.changes) continue;
        logStatus(r.id, "backlog", "todo", "dispatcher");
        try {
          this.addComment({
            taskId: r.id, author: "system", kind: "service",
            content: `Rimessa in coda da sola (giro ${n + 1} di ${MACHINE_RETRY_CAP}): era ferma per una condizione della macchina, che può essere tornata.`,
          });
        } catch { /* the note never blocks the requeue */ }
        const t = getTaskRow(r.id);
        if (t) out.push(rowToTask(t));
      }
      return out;
    },

sweepWaitedOut({ eligible, busy } = {}): Task[] {
      // THE CANDIDATES, not the decision - the same split as
      // `sweepParkedChildren`: the query narrows the field, `waitedOutIfCapped`
      // applies its guards one by one. Two predicates answering one question
      // drift apart, and here they would drift by parking a card that was
      // still inside the cap.
      //
      // The same clock as `waitedOutIfCapped` (`now()`, injectable), never
      // `Date.now()`: two clocks make a query that selects cards the judge then
      // discards, and under a fake clock the two answers never meet.
      //
      // `dispatch_deferred_until` is in the query for the same reason and not
      // as an optimisation, and it carries BOTH of the judge's window rules: a
      // wake-up still ahead is the single most common shape here (a 240-minute
      // wait is a normal note on the live DB), and a NULL window is a card a
      // turn has already restarted on — the shape the live row `c4d48d3e`
      // carries. Leaving either in the candidate list means offering the judge,
      // ten seconds at a time, cards it is going to refuse.
      const ts = now();
      const cutoff = new Date(Date.parse(ts) - WAIT_SERIES_MAX_MS).toISOString();
      let candidati: Array<{ id: string; project_id: string }> = [];
      try {
        candidati = db.prepare(PARKED_IN_SERIES_SQL).all(cutoff, ts) as Array<{ id: string; project_id: string }>;
      } catch { return []; }
      const parkedCards: Task[] = [];
      const ammessa = new Map<string, boolean>();
      for (const c of candidati) {
        if (busy) {
          let busyNow = false;
          try { busyNow = busy(c.id); } catch { busyNow = true; }
          if (busyNow) continue;
        }
        if (eligible) {
          let ok = ammessa.get(c.project_id);
          if (ok === undefined) { try { ok = eligible(c.project_id); } catch { ok = false; } ammessa.set(c.project_id, ok); }
          if (!ok) continue;
        }
        try {
          const t = this.waitedOutIfCapped({ taskId: c.id });
          if (t) parkedCards.push(t);
        } catch { /* a card may have moved underneath: the next pass picks it up */ }
      }
      return parkedCards;
    },

sweepUnresolvedProjectParked(this: TaskService, { resolvable }): Task[] {
      // A card parked because its board mapped to no directory comes back once
      // the board maps again. The match is on the exact park reason, so a card
      // parked for any other cause, or moved to backlog by hand (which clears
      // the chip), is never touched.
      const ts = now();
      let rows: Array<{ id: string; project_id: string }> = [];
      try {
        rows = db.prepare(
          `SELECT id, project_id FROM tasks
            WHERE archived = 0 AND status = 'backlog' AND dispatch_state = 'blocked' AND dispatch_error = ?`,
        ).all(UNRESOLVED_PROJECT_PARK_REASON) as typeof rows;
      } catch { return []; }
      const out: Task[] = [];
      const answers = new Map<string, boolean>();
      for (const r of rows) {
        let ok = answers.get(r.project_id);
        if (ok === undefined) { try { ok = resolvable(r.project_id); } catch { ok = false; } answers.set(r.project_id, ok); }
        if (!ok) continue;
        const res = db.prepare(
          `UPDATE tasks SET status = 'todo', dispatch_state = NULL, dispatch_error = NULL, dispatch_attempts = 0, updated_at = ?
            WHERE id = ? AND status = 'backlog' AND dispatch_state = 'blocked' AND dispatch_error = ?`,
        ).run(ts, r.id, UNRESOLVED_PROJECT_PARK_REASON);
        if (!res.changes) continue;
        logStatus(r.id, "backlog", "todo", "dispatcher");
        try {
          this.addComment({ taskId: r.id, author: "system", kind: "service", content: "Rimessa in coda da sola: la cartella del progetto si trova di nuovo." });
        } catch { /* the note never blocks the requeue */ }
        const t = getTaskRow(r.id);
        if (t) out.push(rowToTask(t));
      }
      return out;
    },

sweepUnownedBacklog(): Task[] {
      // Same clock as the rest of the service (`now()`, injectable), so a test
      // with a fake clock and the live server read the same minute.
      const ts = now();
      const cutoff = new Date(Date.parse(ts) - UNOWNED_BACKLOG_MS).toISOString();
      let candidates: Array<{ id: string; project_id: string }> = [];
      try {
        candidates = db.prepare(UNOWNED_BACKLOG_SQL).all(cutoff) as Array<{ id: string; project_id: string }>;
      } catch { return []; }
      const alerted: Task[] = [];
      for (const c of candidates) {
        // The stamp goes in the SAME statement that re-checks the predicate's
        // moving parts, so two passes (or a card that just got an owner) cannot
        // both report it. `updated_at` stays put: the stamp is not a touch.
        const res = db.prepare(
          `UPDATE tasks SET unowned_alerted_at = ?
            WHERE id = ? AND status = 'backlog' AND assigned_to IS NULL AND assigned_topic_id IS NULL
              AND (unowned_alerted_at IS NULL OR unowned_alerted_at < updated_at)`,
        ).run(ts, c.id);
        if (!res.changes) continue;
        const row = getTaskRow(c.id);
        if (row) alerted.push(rowToTask(row));
      }
      return alerted;
    },

resolveParkedChildren(this: TaskService, { taskId, decision, by }): { task: Task; children: Task[] } | null {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // SI RISPONDE A UNA DOMANDA CHE È ANCORA SULLA CARD. Prima bastava trovare
      // dei figli in backlog, e con i figli fermi in `todo` dentro il predicato
      // quella prova si è girata contro: «rimetti in coda» li porta proprio in
      // `todo`, quindi la seconda risposta li ritrovava tutti e li rimetteva in
      // coda una seconda volta, inventando un esito. La domanda vive in review e
      // muore quando la card ne esce: è lì che si legge se c'è ancora.
      if (row.status !== "review") return null;
      const parked = parkedChildren(taskId);
      if (parked.length === 0) return null;
      const firma = by || "system";
      const ts = now();
      const children: Task[] = [];
      // One decision archives the WHOLE batch together: a `blockedByTaskId`
      // between two parked siblings (step2 waits on step1) must not reject the
      // batch just because the other half has not archived yet (review
      // feedback, 26/11 — `archive` was throwing on the first of the two).
      // The batch is not just the DIRECT parked children: `archive(c)` takes
      // down c's whole subtree, so a grandchild blocked by a sibling (g2,
      // child of step2, blockedBy step1) archives together with it too — and
      // must be excluded from the live-dependent check the same way, or the
      // precheck rejects a card the very same decision is about to archive
      // (review feedback, 26/11, point 2).
      const archiveBatchIds = decision === "archive" ? parked.flatMap((c) => descendantIds(c.id)) : [];
      // Validate the WHOLE batch before archiving ANY of it. The loop below used to
      // archive siblings one at a time with no precheck: the first sibling blocking
      // only an EXTERNAL card (outside this batch) would archive fine, and the next
      // one blocking an external dependent would throw mid-loop, leaving the batch
      // half-archived and the parent stuck in `review` forever (review feedback,
      // 26/11, point 3a).
      if (decision === "archive") {
        for (const c of parked) assertNoLiveDependents(c.id, archiveBatchIds);
      }
      for (const c of parked) {
        if (decision === "requeue") {
          // Budget azzerato: un sottotask parcheggiato può aver bruciato tentativi
          // prima di finire lì, e rimetterlo in coda senza budget sarebbe rimetterlo
          // in una coda che non lo serve.
          db.prepare(
            "UPDATE tasks SET status = 'todo', dispatch_state = NULL, dispatch_error = NULL, " +
              "dispatch_attempts = 0, dispatch_deferred_until = NULL, updated_at = ? WHERE id = ?",
          ).run(ts, c.id);
          // Da DOVE viene lo dice la riga, non una costante: un figlio fermo in
          // `todo` (fermo lo era comunque, nessun turno lo muoveva) non ha
          // cambiato colonna, e scrivere «backlog → todo» avrebbe messo nella
          // sua storia un passaggio che non è mai avvenuto.
          if (c.status !== "todo") logStatus(c.id, c.status, "todo", firma);
          const t = getTaskRow(c.id);
          if (t) children.push(rowToTask(t));
        } else if (decision === "promote") {
          // TOGLIERE IL PADRE È IL GESTO, non spostare la colonna.
          //
          // Un figlio in `todo` conta fermo quanto uno in `backlog`: il tick
          // lista `rootsOnly`, quindi nessun dispatcher lo prende finché ha un
          // padre. Senza `parent_task_id` è una card come le altre e la coda la
          // serve — ed è esattamente ciò che `buildKickoff` ordina all'agente
          // che non riesce a fare un proprio step.
          //
          // Il budget riparte da zero per la stessa ragione di `requeue`: uno
          // step parcheggiato può aver bruciato tentativi prima di finire lì, e
          // rimetterlo in una coda che non lo serve non è promuoverlo.
          db.prepare(
            "UPDATE tasks SET parent_task_id = NULL, status = 'todo', dispatch_state = NULL, dispatch_error = NULL, " +
              "dispatch_attempts = 0, dispatch_deferred_until = NULL, updated_at = ? WHERE id = ?",
          ).run(ts, c.id);
          if (c.status !== "todo") logStatus(c.id, c.status, "todo", firma);
          // Chi lo prende non ha piu' il padre sotto gli occhi: da dove viene lo
          // dice la riga, o il mandato arriva senza il suo contesto.
          try {
            this.addComment({
              taskId: c.id, author: "system", kind: "service",
              content: `Promosso a task indipendente: era un sottotask di «${row.text}», rimasto senza turno.`,
            });
          } catch { /* la nota non fa fallire la promozione */ }
          const t = getTaskRow(c.id);
          if (t) children.push(rowToTask(t));
        } else {
          children.push(this.archive({ taskId: c.id, excludeDependentIds: archiveBatchIds }));
        }
      }
      // The copy lives in `shared/board.ts`, next to the predicate that has to
      // recognise it: this note is signed `user` (a person picked the option),
      // and the review card must not quote it back as the human's request.
      const nota = noteParkedChildrenResolved(decision, parked.length);
      // Il mandato è NUOVO — l'ha appena dato una persona — quindi il budget dei
      // tentativi riparte da zero, esattamente come per un trascinamento in Todo.
      // Senza, il padre tornerebbe in coda già esaurito e non lo reclamerebbe più
      // nessuno: la stessa card ferma di prima, con un chip diverso.
      db.prepare(
        "UPDATE tasks SET dispatch_attempts = 0, dispatch_deferred_until = NULL, " +
          "wait_streak = 0, wait_reason = NULL, wait_since = NULL, updated_at = ? WHERE id = ?",
      ).run(ts, taskId);
      const task = this.release({ taskId, requeue: true, reason: nota, by: firma });
      // La domanda ha avuto risposta: l'approvazione pendente non ha più oggetto
      // (il task non è in review e `reviewDecision` la rifiuterebbe per sempre).
      settleReviewApproval(taskId, "expired", firma, ts);
      return { task, children };
    },

setDispatchState({ taskId, state, error }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare("UPDATE tasks SET dispatch_state = ?, dispatch_error = ?, updated_at = ? WHERE id = ?")
        .run(state, error ?? null, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

setDispatchWeight({ taskId, weight }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // `readTaskWeight` anche in scrittura: un valore che non è uno dei due
      // noti entra come NULL, cioè leggero. Una stringa storta non deve poter
      // diventare un `heavy` che ferma la coda della board.
      db.prepare("UPDATE tasks SET dispatch_weight = ?, updated_at = ? WHERE id = ?")
        .run(readTaskWeight(weight), now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

boardsWithQueuedTodos(): string[] {
      // Una `SELECT DISTINCT` sul taglio del tick — vive, in coda, radici — e
      // nient'altro. `rootsOnly` letterale come nel dispatcher: lì è una regola
      // di sicurezza (uno step non si dispaccia mai da solo), non di lettura.
      return (db.query(QUEUED_ROOT_BOARDS_SQL).all() as Array<{ project_id: string }>).map((r) => r.project_id);
    },

taskIdOfTopic(topicId: string): string | null {
      if (!topicId) return null;
      const bound = db.prepare(
        "SELECT id FROM tasks WHERE assigned_topic_id = ? ORDER BY updated_at DESC LIMIT 1",
      ).get(topicId) as { id?: string } | undefined;
      if (bound?.id) return bound.id;
      // The history table may not exist on a schema older than the fan-out
      // migration: no attempt row is the same answer as no table, which is
      // "nobody can tell", and the pane falls back to its plain overlay.
      try {
        const attempt = db.prepare(
          "SELECT task_id FROM task_attempts WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1",
        ).get(topicId) as { task_id?: string } | undefined;
        return attempt?.task_id ?? null;
      } catch { return null; }
    },

getGlobalAutoDispatch(): boolean {
      return readGlobalDispatch();
    },

setGlobalAutoDispatch(on: boolean): boolean {
      try { db.prepare("UPDATE app_settings SET auto_dispatch = ?").run(on ? 1 : 0); } catch { /* schema minimo: vedi readGlobalDispatch */ }
      // Il tetto globale continua a vivere sulla riga '*': la si semina qui col
      // 2 esplicito, come prima, o accendere l'interruttore lo lascerebbe al
      // default 5 della colonna legacy.
      db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 2)").run(GLOBAL_SETTINGS_KEY);
      return readGlobalDispatch();
    },

getGlobalCap(): GlobalDispatchCap {
      // Una lettura sola per due chiamanti: il tick del dispatcher e la quota di
      // core dello spawn (`agent-job-quota.ts`) devono leggere lo STESSO tetto,
      // NULL compreso — vedi `readGlobalCap`.
      return readGlobalCap(db);
    },

setGlobalCap(patch: GlobalCapPatch): GlobalDispatchCap {
      db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 3)").run(GLOBAL_SETTINGS_KEY);
      if (patch.auto !== undefined) {
        db.prepare("UPDATE board_settings SET max_agents_auto = ? WHERE project_id = ?").run(patch.auto ? 1 : 0, GLOBAL_SETTINGS_KEY);
      }
      if (patch.max !== undefined) {
        // `clampGlobalCap`, non `clampInt(…, 1, 20)`: lo zero di «nessun tetto»
        // deve arrivare al DB com'è. Il clamp a 1 lo trasformava nel tetto più
        // stretto possibile, cioè nell'impostazione opposta a quella chiesta.
        db.prepare("UPDATE board_settings SET max_agents = ? WHERE project_id = ?").run(clampGlobalCap(patch.max), GLOBAL_SETTINGS_KEY);
      }
      if (patch.mode !== undefined) {
        // Only the two spellings the type allows reach the column: anything else
        // would be read back as `count` by `capMode` anyway, and a row that says
        // one thing and means another is the kind of drift this repo has paid for.
        db.prepare("UPDATE board_settings SET max_agents_mode = ? WHERE project_id = ?")
          .run(patch.mode === "resources" ? "resources" : "count", GLOBAL_SETTINGS_KEY);
      }
      // The budget is clamped on the way IN, with the same reader the gate and
      // the slider use, so the value on disk is the value that applies: a field
      // that accepts 5 and enforces 0.95 lies to whoever filled it in.
      if (patch.budgetShare !== undefined) {
        db.prepare("UPDATE board_settings SET machine_budget_share = ? WHERE project_id = ?")
          .run(budgetShare({ budgetShare: patch.budgetShare }), GLOBAL_SETTINGS_KEY);
      }
      return this.getGlobalCap();
    },

getSpendCaps(): { perTaskCents: number; perDayCents: number } {
      // Same row and same read as the concurrency cap: see `readSpendCaps`. Zero
      // (and NULL, on a db that does not have the column yet) = unlimited, which
      // is the state a fresh install is born in.
      return readSpendCaps(db);
    },

projectPaused(projectId: string | null): boolean {
      // One indexed row read, never a quota recomputation (project quota brake).
      return projectIsPaused(db, projectId);
    },

setSpendCaps(patch: { perTaskCents?: number; perDayCents?: number }): { perTaskCents: number; perDayCents: number } {
      db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 3)").run(GLOBAL_SETTINGS_KEY);
      // No upper clamp and no minimum other than zero: the cap is a figure a
      // person chooses, and the only value the code interprets is zero (= off). A
      // negative one would be a cap that blocks everything without saying so, so
      // it counts as zero.
      const clean = (v: number) => Math.max(0, Math.trunc(Number.isFinite(v) ? v : 0));
      if (patch.perTaskCents !== undefined) {
        db.prepare("UPDATE board_settings SET agent_cost_cap_cents = ? WHERE project_id = ?")
          .run(clean(patch.perTaskCents), GLOBAL_SETTINGS_KEY);
      }
      if (patch.perDayCents !== undefined) {
        db.prepare("UPDATE board_settings SET agent_cost_cap_cents_24h = ? WHERE project_id = ?")
          .run(clean(patch.perDayCents), GLOBAL_SETTINGS_KEY);
      }
      return this.getSpendCaps();
    },

getChecksMemFloorGB(): number {
      // Same row and same read as the concurrency cap. NULL (and a db without
      // the column) reads as the DEFAULT and never as zero: zero is the owner
      // switching the brake off, and a missing migration must not say that for
      // them — see `readChecksMemFloorGB`.
      return readChecksMemFloorGB(db);
    },

setChecksMemFloorGB(gb: number): number {
      db.prepare("INSERT OR IGNORE INTO board_settings (project_id, max_agents) VALUES (?, 3)").run(GLOBAL_SETTINGS_KEY);
      // Clamped on the way IN with the same reader the brake and the field use,
      // so the value on disk is the value that applies: a field that accepts 40
      // and enforces 16 lies to whoever filled it in.
      db.prepare("UPDATE board_settings SET checks_mem_floor_gb = ? WHERE project_id = ?")
        .run(checksMemFloorGB({ checksMemFloorGB: gb }), GLOBAL_SETTINGS_KEY);
      return this.getChecksMemFloorGB();
    },

agentSpend(): { cents24h: number; centsTotal: number; unpricedCostTokens24h: number; unpricedCostTokensTotal: number } {
      // The dated ledger, read in two cuts. Wide `catch`: a db without the table
      // yet (minimal harness) has to read "nothing spent", not bring down the
      // route that draws the board header.
      try {
        const since = new Date(Date.parse(now()) - 24 * 60 * 60 * 1000).toISOString();
        const w = db.prepare(
          "SELECT COALESCE(SUM(cents), 0) AS c, COALESCE(SUM(unpriced_cost_tokens), 0) AS u FROM agent_spend WHERE at >= ?",
        ).get(since) as { c: number; u: number } | null;
        const t = db.prepare(
          "SELECT COALESCE(SUM(cents), 0) AS c, COALESCE(SUM(unpriced_cost_tokens), 0) AS u FROM agent_spend",
        ).get() as { c: number; u: number } | null;
        return {
          cents24h: Math.max(0, Math.trunc(w?.c ?? 0)),
          centsTotal: Math.max(0, Math.trunc(t?.c ?? 0)),
          unpricedCostTokens24h: Math.max(0, Math.trunc(w?.u ?? 0)),
          unpricedCostTokensTotal: Math.max(0, Math.trunc(t?.u ?? 0)),
        };
      } catch {
        return { cents24h: 0, centsTotal: 0, unpricedCostTokens24h: 0, unpricedCostTokensTotal: 0 };
      }
    },

    agentSpendClearsAt(capCents: number): number | null {
      // The oldest rows leave the window one at a time: the queue restarts when
      // the ones still inside it sum to less than the cap.
      try {
        const day = 24 * 60 * 60 * 1000;
        const since = new Date(Date.parse(now()) - day).toISOString();
        const rows = db.prepare("SELECT at, cents FROM agent_spend WHERE at >= ? ORDER BY at").all(since) as Array<{ at: string; cents: number }>;
        let inside = rows.reduce((sum, r) => sum + r.cents, 0);
        if (inside < capCents) return null;
        for (const r of rows) {
          inside -= r.cents;
          if (inside < capCents) return Date.parse(r.at) + day;
        }
        return null;
      } catch {
        return null;
      }
    }
  };
}
