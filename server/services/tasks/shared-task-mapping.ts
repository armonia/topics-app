/**
 * Row to Task: the batched reads, the queue reason and the mappers every list and update goes through.
 */

import type { Database } from "bun:sqlite";
import type { ServiceOpts } from "../tasks";
import { DISPATCH_CHIP_QUEUED, isAgentWorking, QUEUE_REASON_UNKNOWN, type QueueReason, WAITING_MEMORY_REASON, deriveQueueReason, readTaskWeight } from "../../../shared/board";
import { readElsewhere } from "../task-elsewhere";
import { currentDispatchBlock, currentMemoryWait, heldResumeBlock } from "../dispatch-block-signal";
import { type Task } from "../task-shapes";
import { awaitsHumanSql } from "../../../shared/workflow";
import { channelKindOfIcon, type ChannelKind, type ChannelPlace } from "../../../shared/channel-origin";
import { agentOfPath } from "../../../shared/agent-home";
import { channelPlaceOf } from "../channel-place";
import { parseChecksJson, parseChecksProgress, parseChecksCi } from "../tasks-checks";
import { UNASSIGNED_PROJECT_ID } from "./shared-constants";
import type { TaskBatch } from "./shared-types";
import type { SharedCore } from "./shared-core";
import type { SharedPreviews } from "./shared-previews";
import type { SharedCardRead } from "./shared-card-read";


export function createSharedTaskMapping(db: Database, _opts: ServiceOpts, { heavyInFlight, idParam, liveCardGaps, now, readGlobalDispatch, tasksHaveStage }: SharedCore, { previewImagesFor, previewOf, rejectedPaths }: SharedPreviews, { awaitingAnswerFor, cardCommentsFor, drawsCardComments, labelsFor, rankQueue, resolveSubtaskWork, topicsHasEffort, topicsHasModel }: SharedCardRead) {


function buildBatch(rows: readonly any[], opts: { reasonsOnly?: boolean } = {}): TaskBatch {
    const ids = rows.map((r) => r.id as string);
    // `reasonsOnly`: the caller reads only `queueReasonOf`, so the facts a card face draws (labels,
    // comments, the open question, preview images) are not paid for.
    const light = opts.reasonsOnly === true;
    const b: TaskBatch = {
      nowIso: new Date().toISOString(),
      labels: light ? new Map() : labelsFor(ids),
      waitingOn: new Map(),
      topics: new Map(),
      blockers: new Map(),
      parentStatus: new Map(),
      retryCap: new Map(),
      openChildren: new Map(),
      comments: light ? new Map() : cardCommentsFor(rows.filter(drawsCardComments).map((r) => r.id as string)),
      // Only the two columns where a hold can be open, so a board of closed
      // cards pays nothing: a review card already carries its comments and the
      // client reads the question straight out of those.
      awaiting: light ? new Set() : awaitingAnswerFor(
        rows.filter((r) => r.status === "todo" || r.status === "in_progress").map((r) => r.id as string),
      ),
      previewImages: light ? new Map() : previewImagesFor(ids),
      queue: null,
      nodeNames: new Map(),
      // Only the In-progress cards no agent is in: the `no_agent` branch.
      elsewhere: readElsewhere(db, rows.filter((r) => r.status === "in_progress" && !isAgentWorking(r.dispatch_state))),
      peopleNames: new Map(),
      deviceNames: new Map(),
      autoDispatch: false,
      heavy: false,
      queueReadable: true,
    };

    // Quanti task VIVI aspettano ciascuno di questi. Una GROUP BY sull'indice
    // `idx_tasks_blocked_by` (migration 042) al posto di una COUNT per riga.
    for (const r of db.query(
      `SELECT blocked_by_task_id AS bid, COUNT(*) AS n FROM tasks
        WHERE blocked_by_task_id IN (SELECT value FROM json_each(?))
          AND archived = 0 AND status != 'done'
        GROUP BY blocked_by_task_id`,
    ).all(idParam(ids)) as Array<{ bid: string; n: number }>) b.waitingOn.set(r.bid, r.n);

    const blockerIds = rows.map((r) => r.blocked_by_task_id).filter(Boolean) as string[];
    if (blockerIds.length) {
      // Anche ARCHIVIATI: un bloccante archiviato non blocca più, ma dirlo è
      // compito del client (`archived: true`), non di un `null` muto.
      for (const r of db.query(
        "SELECT id, text, status, archived FROM tasks WHERE id IN (SELECT value FROM json_each(?))",
      ).all(idParam(blockerIds)) as any[]) {
        b.blockers.set(r.id, { id: r.id, text: r.text, status: r.status, archived: !!r.archived });
      }
    }

    const topicIds = rows.map((r) => r.assigned_topic_id).filter(Boolean) as string[];
    if (topicIds.length) {
      // Le due colonne si CHIEDONO prima di leggerle: gli stub `topics` degli
      // harness ne hanno una sola (uno ha `effort` e non `model`, un altro il
      // contrario), e una `SELECT id, model, effort` fallisce per intero — cioè
      // spegne il modello sulla card per una colonna che serviva all'altro
      // campo. Erano due letture separate, ciascuna col suo try/catch, apposta.
      try {
        for (const t of db.query(
          `SELECT id${topicsHasModel() ? ", model" : ""}${topicsHasEffort() ? ", effort" : ""}
             FROM topics WHERE id IN (SELECT value FROM json_each(?))`,
        ).all(idParam(topicIds)) as any[]) {
          b.topics.set(t.id, { model: t.model ?? null, effort: t.effort ?? null });
        }
      } catch { /* niente tabella `topics` del tutto: come prima, si tace */ }
    }

    try {
      b.autoDispatch = readGlobalDispatch();
      // Tutta la tabella in una lettura: `board_settings` ha una riga per board
      // più la riga globale, e il JOIN per riga costava più della tabella intera.
      for (const s of db.query("SELECT project_id, dispatch_retry_cap FROM board_settings").all() as any[]) {
        if (s.dispatch_retry_cap != null) b.retryCap.set(s.project_id, s.dispatch_retry_cap);
      }
      const parentIds = rows.map((r) => r.parent_task_id).filter(Boolean) as string[];
      if (parentIds.length) {
        for (const p of db.query(
          "SELECT id, status FROM tasks WHERE id IN (SELECT value FROM json_each(?))",
        ).all(idParam(parentIds)) as Array<{ id: string; status: string }>) b.parentStatus.set(p.id, p.status);
      }
      // Il conto dei figli aperti si paga SOLO in review, come prima: è la
      // domanda «approvarla la chiuderebbe?», e fuori da lì non se la pone
      // nessuno.
      const reviewIds = rows.filter((r) => r.status === "review").map((r) => r.id as string);
      if (reviewIds.length) {
        for (const c of db.query(
          `SELECT parent_task_id AS pid, COUNT(*) AS n FROM tasks
            WHERE parent_task_id IN (SELECT value FROM json_each(?))
              AND archived = 0 AND status != 'done'
            GROUP BY parent_task_id`,
        ).all(idParam(reviewIds)) as Array<{ pid: string; n: number }>) b.openChildren.set(c.pid, c.n);
      }
      // The nodes named by these cards, in one read. Outside the `try` there is
      // nothing to protect: a database without a `machines` table is a reduced
      // harness schema, and there the chip falls back to the id rather than
      // making the whole batch unreadable.
      const machineIds = [...new Set(rows.map((r) => r.machine_id).filter(Boolean) as string[])];
      if (machineIds.length) {
        try {
          for (const m of db.query(
            "SELECT id, name FROM machines WHERE id IN (SELECT value FROM json_each(?))",
          ).all(idParam(machineIds)) as Array<{ id: string; name: string }>) b.nodeNames.set(m.id, m.name);
        } catch { /* no `machines` table: the chip says the id, which still points at something */ }
      }
      const personIds = [...new Set(rows.map((r) => r.run_initiator_person_id).filter(Boolean) as string[])];
      if (personIds.length) {
        try {
          for (const p of db.query("SELECT id, display_name FROM people WHERE id IN (SELECT value FROM json_each(?))")
            .all(idParam(personIds)) as Array<{ id: string; display_name: string }>) b.peopleNames.set(p.id, p.display_name);
        } catch { /* Reduced task harnesses do not model collaborator identities. */ }
      }
      const deviceIds = [...new Set(rows.map((r) => r.run_initiator_device_id).filter(Boolean) as string[])];
      if (deviceIds.length) {
        try {
          for (const d of db.query("SELECT id, name FROM devices WHERE id IN (SELECT value FROM json_each(?))")
            .all(idParam(deviceIds)) as Array<{ id: string; name: string }>) b.deviceNames.set(d.id, d.name);
        } catch { /* Reduced task harnesses do not model collaborator identities. */ }
      }
      const inCoda = rows.filter((r) => r.status === "todo" && !r.parent_task_id);
      if (inCoda.length) b.queue = rankQueue(b.nowIso);
      // `heavyInFlight` era in fondo a due `&&` per non pagarlo su una riga
      // normale: qui la stessa disciplina è «solo se nel lotto c'è almeno una
      // card col chip `queued`», e vale una lettura per lotto invece che per riga.
      if (inCoda.some((r) => r.dispatch_state === DISPATCH_CHIP_QUEUED)) b.heavy = heavyInFlight();
    } catch {
      b.queueReadable = false;
    }
    return b;
  }


function queueReasonOf(r: any, b: TaskBatch): QueueReason | null {
    // `review` entra qui insieme a `todo` per un caso solo: la checklist
    // congelata. Non è una ragione di coda ed è giusto che stia nella stessa
    // funzione — è la stessa domanda, «perché questa card non si muove», e
    // averla in due posti significherebbe due risposte che possono divergere.
    if (r.status === "done") return null;
    if (!b.queueReadable) return QUEUE_REASON_UNKNOWN;
    // La fila si conta solo per chi la sta davvero facendo. Fuori da `todo`
    // «3 davanti» non è un'attesa più corta o più lunga: è un numero su una
    // coda di cui questa card non fa parte.
    const inCoda = r.status === "todo" && !r.parent_task_id;
    const heldResume = r.status === "in_progress" && r.dispatch_state === DISPATCH_CHIP_QUEUED && !r.parent_task_id;
    try {
      return deriveQueueReason(
        {
          status: r.status,
          parentTaskId: r.parent_task_id ?? null,
          dispatchState: r.dispatch_state ?? null,
          dispatchAttempts: r.dispatch_attempts ?? 0,
          dispatchDeferredUntil: r.dispatch_deferred_until ?? null,
          dispatchError: r.dispatch_error ?? null,
          scheduledBy: r.scheduled_by ?? null,
          deliveredReason: r.delivered_reason ?? null,
          blockedByTaskId: r.blocked_by_task_id ?? null,
          blockedBy: r.blocked_by_task_id ? (b.blockers.get(r.blocked_by_task_id) ?? null) : null,
          assignedTo: r.assigned_to ?? null,
          machineId: r.machine_id ?? null,
          updatedAt: r.updated_at ?? null,
        },
        {
          now: b.nowIso,
          autoDispatch: b.autoDispatch,
          // Resolved here and not in the client: the chip's sentence is composed
          // server side, and a client that has not read `/api/machines` yet
          // would print an id for a node it can name perfectly well.
          nodeName: r.machine_id ? (b.nodeNames.get(r.machine_id) ?? null) : null,
          retryCap: b.retryCap.get(r.project_id) ?? 2,
          ahead: inCoda && b.queue ? b.queue.ahead(r.priority, r.created_at) : 0,
          // Un pesante trattenuto DAL CARICO è il tappo della coda, e la card lo
          // dichiara. Il chip `queued` da solo non basta a riconoscerlo:
          // `noteHeavyHold` lo scrive in DUE rami del tick, e i due non hanno
          // niente in comune se non il chip.
          //
          //  - ramo del CARICO: il pesante è in testa, il gate è chiuso, il
          //    `break` ferma la fila dietro di lui. Lì è davvero lui il tappo,
          //    l'attesa ha un tetto, e abbassargli la priorità sposta la fila.
          //  - ramo `heavyBusy`: c'è già un pesante AL LAVORO, e il tick esce
          //    prima del ciclo mettendo il chip su OGNI todo. Lì l'ordine della
          //    coda è irrilevante, il tetto dell'attesa non si applica e la
          //    priorità non sblocca niente.
          //
          // Si legge dal DB e non da uno stato vivo del tick apposta: il
          // mappatore gira anche fuori dal processo che dispaccia, e una ragione
          // che dipendesse dalla memoria del dispatcher sparirebbe proprio
          // aprendo la card da un'altra finestra.
          heavyHeld: inCoda
            && readTaskWeight(r.dispatch_weight) === "heavy"
            && r.dispatch_state === DISPATCH_CHIP_QUEUED
            && !b.heavy,
          // L'altra metà della stessa distinzione: il ramo `heavyBusy` chipa
          // OGNI todo, non solo i pesanti, quindi qui non si guarda il peso di
          // questa riga ma se c'è un turno pesante in volo.
          heavyInFlight: inCoda && r.dispatch_state === DISPATCH_CHIP_QUEUED && b.heavy,
          behind: inCoda && b.queue ? b.queue.behind(r.priority, r.created_at) : 0,
          // The two blocks that stop the WHOLE machine: the RAM/disk floor and
          // the 24h spend cap. The tick reads them once per round and then
          // skips every card, so no column records them: without this the card
          // fell through to the queue branch and said "in coda, la prossima" on
          // a board that had not moved in hours. Only for a card really in the
          // queue: outside it, this block is not what it waits on
          // (`dispatch-block-signal.ts`). A resume held in the In-progress column
          // says the block that holds ITS resume, written by that hold and
          // believed only while the row carries the same sentence: the published
          // block is refreshed only by a tick that reaches it, and a board with
          // no todos or a paused one leaves it at a floor that has cleared.
          // Una card in attesa di memoria porta il codice, non la frase del
          // pavimento (KANBAN-97): resta un blocco della macchina, o la card
          // ricadrebbe sul ramo dello slot.
          dispatchBlock: inCoda
            ? (r.dispatch_error === WAITING_MEMORY_REASON ? { kind: "resources", reason: WAITING_MEMORY_REASON } : currentDispatchBlock())
            : heldResume ? heldResumeBlock(r.id, r.dispatch_error) : null,
          memoryWait: r.dispatch_error === WAITING_MEMORY_REASON ? currentMemoryWait() : null,
          elsewhere: b.elsewhere.get(r.id) ?? null,
          parentStatus: r.parent_task_id ? (b.parentStatus.get(r.parent_task_id) ?? null) : null,
          projectless: r.project_id === UNASSIGNED_PROJECT_ID,
          openSubtasks: r.status === "review" ? (b.openChildren.get(r.id) ?? 0) : 0,
        },
      );
    } catch {
      return QUEUE_REASON_UNKNOWN;
    }
  }


function mapRow(r: any, b: TaskBatch): Task {
    const topic = r.assigned_topic_id ? b.topics.get(r.assigned_topic_id) : undefined;
    // `description_preview` lo calcola SQL nel percorso `list` (`substr`, così
    // i 470 KB di descrizioni non attraversano la serializzazione); sui percorsi
    // a riga singola, che leggono `SELECT *`, si taglia qui. Una sola forma per
    // il client, due modi di arrivarci.
    const description: string | null = r.description ?? null;
    // UNA SOLA REGOLA PER I DUE PERCORSI. `description_preview` arriva da SQL
    // con piu' materiale del necessario (`PREVIEW_SQL_CHARS`) proprio perche'
    // la scelta di DOVE cominciare si fa qui, in un posto solo: se il taglio
    // finale vivesse in due punti, la card mostrerebbe cose diverse a seconda
    // che la riga venga da una lista o da una scrittura ribaltata sul WS.
    const preview: string | null = r.description_preview !== undefined
      ? (r.description_preview === null ? null : previewOf(r.description_preview))
      : description === null ? null : previewOf(description);
    return {
      id: r.id,
      projectId: r.project_id,
      text: r.text,
      description,
      descriptionPreview: preview,
      status: r.status,
      priority: r.priority,
      kanbanOrder: r.kanban_order,
      assignedTo: r.assigned_to ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      assignedTopicId: r.assigned_topic_id ?? null,
      archived: !!r.archived,
      dispatchState: r.dispatch_state ?? null,
      dispatchAttempts: r.dispatch_attempts ?? 0,
      dispatchError: r.dispatch_error ?? null,
      dispatchDeferredUntil: r.dispatch_deferred_until ?? null,
      waitStreak: r.wait_streak ?? 0,
      waitReason: r.wait_reason ?? null,
      waitSince: r.wait_since ?? null,
      dispatchWeight: readTaskWeight(r.dispatch_weight),
      parentTaskId: r.parent_task_id ?? null,
      urlProbeStatus: (r.url_probe_status as 'live' | 'dead' | 'unknown' | null) ?? null,
      previewImage: r.preview_image ?? null,
      // I due campi RARI si aggiungono solo quando hanno un contenuto: vedi le
      // note sui tipi. Su una lista di 600 task sono ~4 KB risparmiati.
      ...(() => {
        const slides = b.previewImages.get(r.id as string);
        return slides && slides.length ? { previewImages: slides } : {};
      })(),
      ...(r.checks_state === "running"
        ? (() => {
            const p = parseChecksProgress(r.checks_json);
            const ci = parseChecksCi(r.checks_json);
            return { ...(p ? { checksProgress: p } : {}), ...(ci ? { checksCi: ci } : {}) };
          })()
        : {}),

      // THREE FIELDS THAT ALWAYS TRAVELLED AND THAT NOBODY READS.
      //
      // Same rule as the two rare fields just above: they travel only when
      // they have content. On a list of 600 cards a repeated `null` is not
      // information, it is the name of the key - 44 of the 70 keys of this
      // payload are ALWAYS null and on their own weigh 840 bytes per task.
      //
      // Only THREE, and the selection is the important part. The criterion is
      // not "who is null" but "for whom `null` is NOT a state": here they are
      // an external id and two probe timestamps - absent and never-checked are
      // the same thing. All the fields where `null` does say something stayed
      // fixed instead: `checksCommit` (where "null is not a green" is written
      // down in a test), `doneActor`, `waitStreak`/`waitReason`/`waitSince`.
      // Tried removing them: eight red tests, and they were in the right.
      ...(r.claude_task_id ? { claudeTaskId: r.claude_task_id } : {}),
      ...(r.url_probe_checked_at ? { urlProbeCheckedAt: r.url_probe_checked_at } : {}),
      ...(r.landing_checked_at ? { landingCheckedAt: r.landing_checked_at } : {}),

      // NINE MORE FIELDS THAT TRAVELLED EMPTY ON EVERY CARD.
      //
      // Same rule, one round later: event timestamps and external ids ride
      // only when they have a value. Every one of these answers "when did it
      // happen" or "which one is it": absent and never-happened say the same
      // thing, so a repeated `null` here is the name of the key and nothing
      // else. The fields where `null` IS an answer stayed fixed: the state
      // enums (`dispatchState`, `landingState`, `checksState`, `deployState`),
      // `checksCommit`, `doneActor`, `waitStreak`/`waitReason`/`waitSince`,
      // and `parentTaskId`, where null means root.
      ...(r.due_date ? { dueDate: r.due_date } : {}),
      ...(r.scheduled_by ? { scheduled: { by: r.scheduled_by, at: r.scheduled_at ?? null } } : {}),
      ...(r.wake_at ? { wakeAt: r.wake_at } : {}),
      ...(r.chat_id ? { chatId: r.chat_id } : {}),
      ...(r.completed_at ? { completedAt: r.completed_at } : {}),
      ...(r.plan_comment_id ? { planCommentId: r.plan_comment_id } : {}),
      ...(r.in_progress_at ? { inProgressAt: r.in_progress_at } : {}),
      ...(r.interrupted_at ? { interruptedAt: r.interrupted_at } : {}),
      ...(r.output_url ? { outputUrl: r.output_url } : {}),

      previewRetiredAt: r.preview_retired_at ?? null,
      previewRetiredReason: r.preview_retired_reason ?? null,
      // The rejected paths reach the client because that is where what to draw
      // gets decided: the card needs them so the carousel does not redraw the
      // very image the retirement declared false.
      previewRejected: rejectedPaths(r.preview_rejected),
      planFirst: !!r.plan_first,
      agentMs: r.agent_ms ?? 0,
      agentTokens: r.agent_tokens ?? 0,
      agentCacheReadTokens: r.agent_cache_read_tokens ?? 0,
      agentCostCents: r.agent_cost_cents ?? 0,
      priorityAuto: r.priority_auto == null ? true : !!r.priority_auto,
      // Il modello mostrato deve SEMPRE riflettere ciò che ha girato davvero:
      // `tasks.model` può essere nullo («auto») anche dopo il dispatch, ma il
      // TOPIC dell'agente è stato creato col modello risolto.
      model: r.model ?? topic?.model ?? null,
      ...(r.model_effort ? { modelEffort: r.model_effort } : {}),
      topicsRouting: r.topics_routing == null ? null : !!r.topics_routing,
      // WHERE it runs. `null` is «this machine», which is what every card
      // written before the column existed says (KANBAN-76).
      machineId: r.machine_id ?? null,
      // "This Mac only": absent column (old harness) reads as unmarked.
      // A pin with a deadline (`stay_local_until`, set after an empty node run)
      // reads as unmarked once the deadline is past.
      stayLocal: !!r.stay_local && !(r.stay_local_until && r.stay_local_until <= now()),
      ...(r.overflow_skip_machine && r.overflow_skip_until && r.overflow_skip_until > now() ? { overflowSkipMachine: String(r.overflow_skip_machine).split(",").at(-1), overflowSkipMachines: String(r.overflow_skip_machine).split(",") } : {}),
      // Only while it still runs where the overflow sent it.
      ...(r.overflowed_at && r.machine_id ? { overflowedAt: r.overflowed_at } : {}),
      ...(r.base_branch ? { baseBranch: r.base_branch } : {}),
      ...(r.prior_branch ? { priorBranch: r.prior_branch } : {}),
      ...(r.past_delivery_branches ? { pastDeliveryBranches: String(r.past_delivery_branches).split(/\s+/).filter(Boolean) } : {}),
      ...(r.prior_uncommitted_files ? { priorUncommittedFiles: r.prior_uncommitted_files } : {}),
      // WHO opened it; NULL for every card written before the column.
      createdBy: r.created_by ?? null,
      ...(r.created_source ? { createdSource: r.created_source } : {}),
      ...(r.bar ? { bar: r.bar } : {}),
      ...liveCardGaps(r),
      ...openerOf(r),
      ...channelOf(r),
      // The workflow column, only when it is not the default one: a board with
      // the default workflow sends the same row as before.
      ...(r.stage ? { stage: r.stage } : {}),
      ...(r.human_ask ? { humanAsk: r.human_ask } : {}),
      ...(r.land_intent ? { landIntent: r.land_intent } : {}),
      ...(r.land_intent_commit ? { landIntentCommit: r.land_intent_commit } : {}),
      // Delegation metadata is rare. Absence means an ordinary owner run, not
      // a UI state, so five repeated null keys on every board card carry no
      // information. A delegated row still gets the complete audit identity.
      ...(r.machine_id ? { runComputerName: b.nodeNames.get(r.machine_id) ?? r.machine_id } : {}),
      ...(r.delegated_start_capability_id
        ? { delegatedStartCapabilityId: r.delegated_start_capability_id }
        : {}),
      ...(r.run_initiator_person_id
        ? {
            runInitiatorPersonId: r.run_initiator_person_id,
            runInitiatorPersonName: b.peopleNames.get(r.run_initiator_person_id) ?? r.run_initiator_person_id,
          }
        : {}),
      ...(r.run_initiator_device_id
        ? {
            runInitiatorDeviceId: r.run_initiator_device_id,
            runInitiatorDeviceName: b.deviceNames.get(r.run_initiator_device_id) ?? r.run_initiator_device_id,
          }
        : {}),
      // Non c'è una colonna `tasks.effort` e non serve: l'autorità è il TOPIC,
      // che è ciò che viene davvero passato allo spawn. Duplicarla su `tasks`
      // creerebbe due verità libere di divergere.
      effort: r.assigned_topic_id ? (topic?.effort ?? null) : null,
      blockedByTaskId: r.blocked_by_task_id ?? null,
      blockedBy: r.blocked_by_task_id ? (b.blockers.get(r.blocked_by_task_id) ?? null) : null,
      subtaskWork: resolveSubtaskWork(r),
      waitingOnCount: b.waitingOn.get(r.id) ?? 0,
      awaitingAnswer: b.awaiting.has(r.id),
      queueReason: queueReasonOf(r, b),
      deliveryBranch: r.delivery_branch ?? null,
      deliveryCommit: r.delivery_commit ?? null,
      // Only when the column is really there: the list projection does not select it, and a
      // hard `?? null` would turn "not asked for" into "no tip was ever sent back".
      ...(r.prior_commit ? { priorCommit: r.prior_commit as string } : {}),
      // Da quando aspetta una risposta umana (migration 20260816214500).
      reviewAt: r.review_at ?? null,
      // L'ENTITÀ DEL LAVORO, sulla card e non dietro un clic: la colonna review
      // chiedeva «Approva» senza dire cosa si stesse approvando.
      deliveryFilesChanged: r.delivery_files_changed ?? null,
      deliveryInsertions: r.delivery_insertions ?? null,
      deliveryDeletions: r.delivery_deletions ?? null,
      // The work that is NOT on a commit: it is what turns the chip's "nothing
      // committed" into "nothing committed, and N files are waiting there".
      deliveryUncommittedFiles: r.delivery_uncommitted_files ?? null,
      landingState: r.landing_state ?? null,
      deployState: (r.deploy_state as Task["deployState"]) ?? null,
      ...(r.deploy_command_at_propose ? { deployCommandAtPropose: r.deploy_command_at_propose } : {}),
      checksState: r.checks_state ?? null,

      checksAt: r.checks_at ?? null,
      checksCommit: r.checks_commit ?? null,
      // `checks_json` non è nella proiezione della LISTA (217 KB sui 1,4 MB del
      // feed, e la card non li disegna): lì la colonna non c'è e questo resta
      // null. `svc.get` legge `SELECT *` e li porta interi.
      checks: parseChecksJson(r.checks_json),
      deliveredBy: r.delivered_by ?? null,
      deliveredReason: r.delivered_reason ?? null,
      doneActor: r.done_actor ?? null,
      reopenedAt: r.reopened_at ?? null,
      reopenedBy: r.reopened_by ?? null,
      reopenedActor: r.reopened_actor ?? null,
      reuseBlockerContext: !!r.reuse_blocker_context,
      subtaskCount: 0,
      subtaskDoneCount: 0,
      userCommentCount: 0,
      labels: b.labels.get(r.id) ?? [],
      recentComments: b.comments.get(r.id) ?? [],
    };
  }


function rowsToTasks(rows: readonly any[]): Task[] {
    if (rows.length === 0) return [];
    const b = buildBatch(rows);
    return rows.map((r) => mapRow(r, b));
  }


/**
   * The chat a card came from: id and name, only while the topic exists (a
   * deleted chat would open a ghost tab). Display only.
   */
  let openerNameQuery: ReturnType<typeof db.prepare> | null = null;


function topicBrief(id: string): { name: string | null; kind: ChannelKind | null; agent: string | null } | null {
    try {
      // Prepared once: a list of thousands of cards would otherwise compile one statement per row.
      openerNameQuery ??= db.prepare("SELECT name, icon, project_path FROM topics WHERE id = ?");
      const t = openerNameQuery.get(id) as { name?: string | null; icon?: string | null; project_path?: string | null } | null;
      return t ? { name: t.name ?? null, kind: channelKindOfIcon(t.icon), agent: agentOfPath(t.project_path) } : null;
    } catch { return null; }
  }


function openerOf(r: { origin_topic_id?: string | null; created_by_topic_id?: string | null }): { openerTopicId?: string; openerName?: string; openerAgent?: string } {
    const id = r.origin_topic_id ?? r.created_by_topic_id;
    if (!id) return {};
    const t = topicBrief(id);
    // The always-on agent whose chat opened the card (its home folder says which): the card is that agent's work.
    return t ? { openerTopicId: id, ...(t.name ? { openerName: t.name } : {}), ...(t.agent ? { openerAgent: t.agent } : {}) } : {};
  }


  /**
   * The Jarvis channel a card's work came from: the chat linked on purpose
   * (`channel_topic_id`) wins, else the opener chat when it is itself a channel
   * chat. Only while that chat exists and wears a channel mark: a deleted chat
   * would open a ghost tab, and an ordinary chat is not a channel. Display only.
   */
  function channelOf(r: { channel_topic_id?: string | null; origin_topic_id?: string | null; created_by_topic_id?: string | null }): { channel?: { topicId: string; name: string; kind: ChannelKind; place?: ChannelPlace; agent?: string } } {
    for (const id of [r.channel_topic_id, r.origin_topic_id, r.created_by_topic_id]) {
      if (!id) continue;
      const t = topicBrief(id);
      if (t?.kind) {
        let place: ChannelPlace | null = null;
        try { place = channelPlaceOf(t.name ?? ""); } catch { /* the bridge database is optional */ }
        // The agent that answers in that channel (Jarvis, Visione...): read from the chat's home folder.
        return { channel: { topicId: id, name: t.name ?? "", kind: t.kind, ...(place ? { place } : {}), ...(t.agent ? { agent: t.agent } : {}) } };
      }
      // An explicit link names the channel: when it is gone the card is NOT re-attributed to another chat.
      if (id === r.channel_topic_id) return {};
    }
    return {};
  }


function rowToTask(r: any): Task {
    return rowsToTasks([r])[0]!;
  }


function withSubtaskCounts(tasks: Task[]): Task[] {
    if (tasks.length === 0) return tasks;
    const ids = idParam(tasks.map((t) => t.id));
    const byParent = new Map<string, { total: number; done: number }>();
    const rows = db.query(
      `SELECT parent_task_id AS pid,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks
        WHERE parent_task_id IN (SELECT value FROM json_each(?)) AND archived = 0
        GROUP BY parent_task_id`,
    ).all(ids) as Array<{ pid: string; total: number; done: number }>;
    for (const r of rows) byParent.set(r.pid, { total: r.total, done: r.done ?? 0 });
    // Steps at ANY depth that wait on a person (`awaitsHuman`): the columns
    // hold roots only, so a parent sitting in backlog is where a step in review
    // says it, and the Review count adds it to the roots (Kanban equals Plan).
    const reviewByParent = new Map<string, number>();
    try {
      const reviewRows = db.query(
        `WITH RECURSIVE d(root, id) AS (
           SELECT parent_task_id, id FROM tasks
            WHERE parent_task_id IN (SELECT value FROM json_each(?)) AND archived = 0
           UNION
           SELECT d.root, t.id FROM tasks t JOIN d ON t.parent_task_id = d.id WHERE t.archived = 0
         )
         SELECT d.root AS pid, COUNT(*) AS n FROM d JOIN tasks t ON t.id = d.id
          WHERE ${awaitsHumanSql(tasksHaveStage(), "t")}
          GROUP BY d.root`,
      ).all(ids) as Array<{ pid: string; n: number }>;
      for (const r of reviewRows) reviewByParent.set(r.pid, r.n);
    } catch { /* a reduced schema: no step counts as waiting */ }
    // Human message count per task: comments the user sent (kind='comment'),
    // excluding the AI/agent, system notes and auto status events.
    const byTask = new Map<string, number>();
    const mrows = db.query(
      `SELECT task_id AS tid, COUNT(*) AS n
         FROM task_comments
        WHERE task_id IN (SELECT value FROM json_each(?))
          AND author = 'user' AND kind = 'comment'
        GROUP BY task_id`,
    ).all(ids) as Array<{ tid: string; n: number }>;
    for (const r of mrows) byTask.set(r.tid, r.n);
    // The most recent collaborator write per task, one row each via MAX() +
    // GROUP BY rather than a correlated subquery per task — the same shape as
    // the two aggregates above, and for the same reason: this runs on every
    // list/get, so it has to stay a bounded batch, not an N+1.
    const byActor = new Map<string, { personName: string | null; deviceName: string | null }>();
    try {
      const arows = db.query(
        `SELECT c.task_id AS tid, d.name AS device_name, p.display_name AS person_name
           FROM task_comments c
           JOIN devices d ON d.id = substr(c.author, 7)
           LEFT JOIN people p ON p.id = d.person_id
          WHERE c.task_id IN (SELECT value FROM json_each(?))
            AND c.author LIKE 'guest:%'
            AND c.id IN (
              SELECT c2.id FROM task_comments c2
               WHERE c2.task_id = c.task_id AND c2.author LIKE 'guest:%'
               ORDER BY c2.created_at DESC LIMIT 1
            )`,
      ).all(ids) as Array<{ tid: string; device_name?: string; person_name?: string }>;
      for (const r of arows) byActor.set(r.tid, { personName: r.person_name ?? null, deviceName: r.device_name ?? null });
    } catch {
      // Schema older than devices/people (pre-084): no collaborator identity
      // to resolve — every task keeps `lastActorPersonName/DeviceName` null.
    }
    for (const t of tasks) {
      const c = byParent.get(t.id);
      if (c) { t.subtaskCount = c.total; t.subtaskDoneCount = c.done; }
      const inReview = reviewByParent.get(t.id);
      if (inReview) t.subtaskReviewCount = inReview;
      t.userCommentCount = byTask.get(t.id) ?? 0;
      const actor = byActor.get(t.id);
      t.lastActorPersonName = actor?.personName ?? null;
      t.lastActorDeviceName = actor?.deviceName ?? null;
    }
    return tasks;
  }
  return {
    buildBatch,
    channelOf,
    mapRow,
    openerNameQuery,
    openerOf,
    queueReasonOf,
    rowToTask,
    rowsToTasks,
    topicBrief,
    withSubtaskCounts,
  };
}
