import type { Database } from "bun:sqlite";
import type { ServiceOpts, TaskService } from "../tasks";
import type { createTasksShared } from "./shared";
import { DELIVERY_SNAPSHOT_COLUMNS, TaskServiceError } from "./shared";
import { type Task } from "../task-shapes";
import { type TaskStatus, isAgentWorking, DEPLOY_ACTION_LABEL } from "../../../shared/board";
import { markTargetNotificationsSeen } from "../../db/notification-log";
import { type MergeOutcome } from "../tasks-service-types";
import { STAGE_CI } from "../../../shared/workflow";
import { listLandingAuditCandidates as listLandingAuditCandidatesQuery } from "../landing-candidates";

export function createLandMethods(db: Database, _opts: ServiceOpts, shared: ReturnType<typeof createTasksShared>): Pick<TaskService, "reviewDecision" | "merge" | "setLandIntent" | "listLandingAuditCandidates" | "recordLandingState" | "settleLanded" | "countUnlanded" | "proposeDeploy" | "beginDeploy" | "finishDeploy"> {
  const {
    archiveSubtree,
    childLeftFlight,
    getTaskRow,
    hasActiveChildren,
    logStatus,
    markReopened,
    now,
    rowToTask,
    settleReviewApproval,
    uuid,
    withSubtaskCounts,
  } = shared;

/**
   * Nota della macchina nel thread (kind='review-note'): informa senza svegliare
   * l'agente e senza contare come sua ultima parola. INSERT diretto, come
   * `logStatus`: qui non servono dedupe, allegati o composizione di domande, e
   * passare dal path umano farebbe di una ricevuta un messaggio a cui
   * rispondere.
   */
  function addNote(taskId: string, author: string, content: string): void {
    try {
      db.prepare(
        "INSERT INTO task_comments (id, task_id, author, content, kind, created_at) VALUES (?, ?, ?, ?, 'review-note', ?)",
      ).run(uuid(), taskId, author || "system", content, now());
    } catch { /* la ricevuta è un di più: non deve far fallire l'operazione */ }
  }

  return {
reviewDecision(this: TaskService, { taskId, by, decision, comment, projectId, origin }): Task {
      const row = getTaskRow(taskId);
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      if (row.status !== "review") throw new TaskServiceError("invalid_transition", "task is not in review");
      // Same structural invariant as update(): approving must not close a
      // parent whose subtasks are still open.
      if (decision === "approve" && hasActiveChildren(taskId)) {
        throw new TaskServiceError(
          "open_subtasks",
          "task has open subtasks. Complete or archive them before approving it to done.",
        );
      }
      const ts = now();

      // Resolve the pending review approval, if any.
      settleReviewApproval(taskId, decision === "approve" ? "approved" : "rejected", by, ts, comment ?? null);

      if (comment && comment.trim()) {
        this.addComment({ taskId, author: by, content: comment, origin });
      }

      const target: TaskStatus = decision === "approve" ? "done" : "in_progress";
      // Clear the dispatch chip on the human decision: an approved (done) card must
      // not keep a stale "working"/"serve te" chip, and a rejected one is about to
      // be re-kicked by the dispatcher (resume sets "working" itself).
      // A reject ALSO resets the attempt budget: it opens a new work cycle on the
      // same session, so the turn-end safety net (auto-continue with the "deliver
      // now" nudge) must be available again. Without this, attempts carried over
      // from the previous cycle arrive already exhausted and the first premature
      // turn-end skips the nudge — the system force-delivers instead of letting
      // the agent reach review on its own.
      if (decision === "reject") {
        // Il rifiuto è la quarta uscita umana da review, e per due volte diceva
        // il contrario di quel che era successo: nessun marchio di riapertura, e
        // lo scatto della consegna lasciato sulla card. Cioè esattamente lo
        // stato che il 13/08 ha fatto chiudere `d6baaf5e` sopra un commit di
        // cinque giorni prima — qui in attesa che la card rientrasse in coda.
        // Le stesse due colonne che `update()` scrive per lo stesso salto: qui
        // non ci passa, perché questa porta scrive lo status a SQL grezzo.
        db.prepare(
          "UPDATE tasks SET status = ?, completed_at = NULL, dispatch_state = NULL, dispatch_attempts = 0, " +
            // Read before the snapshot is cleared (SQLite evaluates SET on the old row).
            "prior_branch = CASE WHEN delivery_branch IS NULL THEN prior_branch " +
            "WHEN landing_state IN ('landed', 'superseded') THEN NULL ELSE delivery_branch END, " +
            "prior_commit = COALESCE(delivery_commit, prior_commit), " +
            "past_delivery_branches = CASE WHEN delivery_branch IS NULL THEN past_delivery_branches " +
            "ELSE TRIM(COALESCE(past_delivery_branches, '') || ' ' || delivery_branch) END, " +
            "prior_uncommitted_files = CASE WHEN delivery_uncommitted_files IS NULL THEN prior_uncommitted_files " +
            "ELSE NULLIF(delivery_uncommitted_files, 0) END, " +
            DELIVERY_SNAPSHOT_COLUMNS.map((c) => `${c} = NULL`).join(", ") + ", " +
            "landing_state = NULL, landing_checked_at = NULL, landing_witnessed = 0, updated_at = ? WHERE id = ?",
        ).run(target, ts, taskId);
        markReopened(taskId, "review", target, "human", by);
        // A PERSON's reject takes back the decision to land: the next delivery is theirs to look at again.
        // The system's own bounces (a red, a conflict in the CI phase) keep it.
        if (by !== "system") db.prepare("UPDATE tasks SET land_intent = NULL, land_intent_at = NULL, land_intent_commit = NULL WHERE id = ?").run(taskId);
      } else {
        // `done_actor = 'human'`: è LA decisione di Attilio, ed è ciò che il
        // cancello di riapertura legge (un agente non la ribalta). Il segno di
        // «riaperta» si azzera: il ciclo si è chiuso qui.
        db.prepare(
          "UPDATE tasks SET status = ?, completed_at = ?, dispatch_state = NULL, done_actor = 'human', " +
            "reopened_at = NULL, reopened_by = NULL, reopened_actor = NULL, " +
            // A closed card has no land pending: the CI phase's decision ends with it.
            "land_intent = NULL, land_intent_at = NULL, land_intent_commit = NULL, updated_at = ? WHERE id = ?",
        ).run(target, ts, ts, taskId);
      }
      // The human decision ends the review round and its column: a stage left
      // behind would decide where the NEXT delivery lands (even a system one).
      if (row.stage != null || row.human_ask != null) db.prepare("UPDATE tasks SET stage = NULL, human_ask = NULL WHERE id = ?").run(taskId);
      logStatus(taskId, "review", target, by, null, origin);
      // As in `update()`: this door writes the status in raw SQL and does not
      // go through there. Approving and rejecting are both "I looked at it".
      markTargetNotificationsSeen("task", taskId);
      // L'approvazione è la porta per cui uno step passa a `done` più spesso di
      // ogni altra, e scrive lo stato a SQL grezzo: senza questa riga il padre
      // non se ne accorgerebbe proprio nel caso più comune.
      if (target === "done" && row.parent_task_id) {
        childLeftFlight(row.parent_task_id as string, by, this);
      }
      return rowToTask(getTaskRow(taskId));
    },

/**
     * Fonde due card che dicono la stessa cosa.
     *
     * La promessa, scritta com'e' verificata in `task-merge.test.ts`: NIENTE
     * viene cancellato. La card assorbita resta come riga archiviata, il suo
     * thread, i suoi sottotask e chi la aspettava passano alla superstite, e le
     * due card si scrivono a vicenda dove e' finito il lavoro.
     *
     * L'ordine dentro la transazione non e' negoziabile, e si puo' falsificare:
     * l'archiviazione passa da `archiveSubtree`, la stessa cascata di
     * `archive()`, quindi i sottotask vanno staccati PRIMA. Spostare la riga
     * `archiveSubtree` sopra `moveChildren` fa diventare rosso «i sottotask
     * passano sotto la superstite, VIVI»: finirebbero sotto la superstite gia'
     * archiviati, cioe' invisibili.
     *
     * Il limite, detto chiaro: la fusione NON e' reversibile con un tasto. Non
     * si perde niente, ma per tornare indietro bisogna sapere quali commenti
     * erano di chi, e questo schema non ha dove scriverlo (servirebbe una
     * tabella, cioe' una migration). Per questo il verdetto lo propone la
     * macchina e il tasto lo preme una persona: vedi `shared/task-similarity.ts`,
     * dove c'e' anche il falso positivo noto.
     */
    merge({ taskId, intoTaskId, by, projectId }): MergeOutcome {
      const loser = getTaskRow(taskId);
      const winner = getTaskRow(intoTaskId);
      if (!loser || (projectId && loser.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }
      if (!winner || (projectId && winner.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${intoTaskId} not found`);
      }
      if (taskId === intoTaskId) {
        throw new TaskServiceError("invalid_input", "una card non si fonde con se stessa");
      }
      if (loser.archived || winner.archived) {
        throw new TaskServiceError("invalid_transition", "una card archiviata non si fonde");
      }
      if (loser.project_id !== winner.project_id) {
        throw new TaskServiceError("invalid_transition", "le due card stanno su board diverse");
      }
      // Stesso gate di moveToProject: un agente vivo lavora un worktree legato
      // a QUESTA card. Archiviarla sotto di lui lascia il worktree orfano.
      if (loser.assigned_topic_id || isAgentWorking(loser.dispatch_state)) {
        throw new TaskServiceError("invalid_transition", "la card ha un agente vivo: falla arrivare in review, o parcheggiala, prima di fonderla");
      }
      // La superstite non puo' stare nel sottoalbero della card che sparisce:
      // finirebbe genitore di se stessa, e il ciclo renderebbe irraggiungibile
      // tutto il ramo.
      const dentro = db.prepare(
        `WITH RECURSIVE subtree(id) AS (
           SELECT id FROM tasks WHERE id = ?
           UNION ALL
           SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
         )
         SELECT COUNT(*) AS c FROM subtree WHERE id = ?`,
      ).get(taskId, intoTaskId) as any;
      if ((dentro?.c ?? 0) > 0) {
        throw new TaskServiceError("invalid_transition", "la superstite e' un sottotask della card da fondere: fondi al contrario");
      }

      // Chi NON va ripuntato sulla superstite: la superstite stessa (si
      // bloccherebbe da sola) e chiunque stia già nella SUA catena di attesa
      // (survivor ← ponte ← assorbita: ripuntare il ponte chiuderebbe l'anello
      // survivor ← ponte ← survivor, e i due resterebbero fermi per sempre).
      // Chi resta escluso continua a puntare la card archiviata, cioè risulta
      // sbloccato: giusto, perché il suo prerequisito è diventato la superstite
      // che lo aspetta a sua volta.
      const noRipunta = new Set<string>([intoTaskId]);
      let risalita: string | null = winner.blocked_by_task_id ?? null;
      for (let hops = 0; risalita && hops < 100; hops++) {
        noRipunta.add(risalita);
        risalita = (getTaskRow(risalita)?.blocked_by_task_id ?? null) as string | null;
      }
      const esclusi = [...noRipunta];

      const ts = now();
      const run = db.transaction(() => {
        const moveChildren = db.prepare(
          "UPDATE tasks SET parent_task_id = ?, updated_at = ? WHERE parent_task_id = ?",
        ).run(intoTaskId, ts, taskId);
        // I commenti mantengono created_at: il thread della superstite resta in
        // ordine cronologico invece di avere un blocco appiccicato in fondo.
        const moveComments = db.prepare("UPDATE task_comments SET task_id = ? WHERE task_id = ?").run(intoTaskId, taskId);
        // Il puntatore `bloccata da` passa alla superstite. Senza questo, la
        // card assorbita risulta ARCHIVIATA, e `isDispatchBlocked` legge
        // `status='done' OR archived=1`: chi la aspettava crede che il
        // prerequisito sia finito e parte, mentre il lavoro è appena stato
        // spostato altrove e non l'ha ancora fatto nessuno.
        const moveBlockers = db.prepare(
          `UPDATE tasks SET blocked_by_task_id = ?, updated_at = ?
            WHERE blocked_by_task_id = ? AND archived = 0
              AND id NOT IN (${esclusi.map(() => "?").join(", ")})`,
        ).run(intoTaskId, ts, taskId, ...esclusi);
        // Caso a parte: la superstite aspettava proprio la card che assorbe. Il
        // prerequisito è diventato lei stessa, quindi non resta niente da
        // aspettare, e un puntatore a una riga archiviata è solo un rudere.
        db.prepare(
          "UPDATE tasks SET blocked_by_task_id = NULL, updated_at = ? WHERE id = ? AND blocked_by_task_id = ?",
        ).run(ts, intoTaskId, taskId);
        // L'archiviazione passa dalla stessa cascata di `archive()`, e per
        // questo l'ordine qui sopra NON è negoziabile: i sottotask si staccano
        // PRIMA, altrimenti la cascata li archivia e finiscono sotto la
        // superstite già invisibili. Invertire le due lines fa diventare rosso
        // «i sottotask passano sotto la superstite, VIVI».
        archiveSubtree(taskId, ts);
        // Il PERDENTE del merge esce dalla board: la sua richiesta di
        // approvazione non ha più oggetto. `expired`, non `rejected` — nessuno
        // ha detto di no.
        settleReviewApproval(taskId, "expired", "system", ts);
        db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, intoTaskId);
        return {
          children: Number(moveChildren.changes ?? 0),
          comments: Number(moveComments.changes ?? 0),
          blockers: Number(moveBlockers.changes ?? 0),
        };
      });
      const moved = run();

      // Le ricevute: kind 'review-note' perche' e' evidenza scritta dalla
      // macchina. Non conta come ultima parola dell'agente e non sveglia
      // nessuno, ma resta nel thread di entrambe le card.
      const short = (id: string) => id.slice(0, 8);
      // Il ripuntamento dei bloccanti cambia CHI aspetta questa card: senza
      // scriverlo, un umano lo scopre solo quando un dispatch parte prima del
      // previsto.
      const anche = moved.blockers === 1
        ? " Anche 1 card che aspettava quella ora aspetta questa."
        : moved.blockers > 1
          ? ` Anche ${moved.blockers} card che aspettavano quella ora aspettano questa.`
          : "";
      addNote(intoTaskId, by, `Assorbita la card ${short(taskId)}, «${loser.text}». Commenti e sottotask sono qui.${anche}`);
      addNote(taskId, by, `Fusa nella card ${short(intoTaskId)}, «${winner.text}».`);

      const [survivor] = withSubtaskCounts([rowToTask(getTaskRow(intoTaskId))]);
      return {
        survivor: survivor!,
        merged: rowToTask(getTaskRow(taskId)),
        movedComments: moved.comments,
        movedChildren: moved.children,
        movedBlockers: moved.blockers,
      };
    },

setLandIntent({ taskId, who, inCi }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const ts = now();
      if (who === null) {
        db.prepare("UPDATE tasks SET land_intent = NULL, land_intent_at = NULL, land_intent_commit = NULL, stage = CASE WHEN stage = ? THEN NULL ELSE stage END, updated_at = ? WHERE id = ?")
          .run(STAGE_CI, ts, taskId);
      } else {
        // A person's decision is never downgraded to the machine's.
        const keep = row.land_intent === "human" ? "human" : who;
        db.prepare("UPDATE tasks SET land_intent = ?, land_intent_at = COALESCE(land_intent_at, ?), land_intent_commit = delivery_commit, updated_at = ? WHERE id = ?")
          .run(keep, ts, ts, taskId);
        if (inCi && row.status === "review") db.prepare("UPDATE tasks SET stage = ?, human_ask = NULL WHERE id = ?").run(STAGE_CI, taskId);
      }
      return rowToTask(getTaskRow(taskId));
    },

listLandingAuditCandidates() {
      return listLandingAuditCandidatesQuery(db, now());
    },

recordLandingState({ taskId, state, checkedAt, witnessed }): void {
      // `witnessed` si ALZA e non si abbassa da qui: solo una riconsegna lo
      // riporta a zero. Una passata periodica che scrivesse `0` sopra un
      // verdetto osservato lo declasserebbe a deduzione, cioè annullerebbe il
      // punto — quindi il parametro assente NON è «no».
      db.prepare(
        "UPDATE tasks SET landing_state = ?, landing_checked_at = ?" +
        (witnessed ? ", landing_witnessed = 1" : "") + " WHERE id = ?",
      ).run(state, checkedAt, taskId);
    },

settleLanded({ taskId, by, reason }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) return null;
      const live = row.status !== "done" || row.dispatch_state !== null || row.dispatch_deferred_until !== null;
      if (!live) return rowToTask(row); // già ferma e chiusa: niente da dire
      const ts = now();
      // IL CANCELLO SUI FIGLI APERTI VALE ANCHE QUI, ed era l'unica porta che lo
      // saltava. `update()` e `reviewDecision` rifiutano `done` su un padre con
      // step aperti perché è uno stato che la board non sa raccontare: la
      // checklist resta appesa sotto una card chiusa, fuori da ogni colonna
      // (il feed è `rootsOnly`), e quel lavoro non lo riprende più nessuno.
      // Questa porta scrive `done` a SQL grezzo, quindi il controllo non lo
      // incontrava: «Landa su main» chiudeva il padre e orfanava i suoi passi.
      //
      // Non chiudere però non vuol dire non fare niente: il merge È avvenuto.
      // Si spegne il chip e la finestra di ri-tentativo — è da lì che la card
      // torna claimabile, e un agente ripartirebbe a rifare ciò che sta già su
      // main — e la card resta dov'è. Il RESOCONTO è di chi ha chiesto il land
      // (`landTask` scrive nel thread quali passi la tengono aperta): qui non si
      // inventa una riga di storico per una transizione che non c'è stata.
      if (row.status !== "done" && hasActiveChildren(taskId)) {
        db.prepare(
          `UPDATE tasks SET dispatch_state = NULL, dispatch_error = NULL,
              dispatch_deferred_until = NULL, updated_at = ? WHERE id = ?`,
        ).run(ts, taskId);
        return rowToTask(getTaskRow(taskId));
      }
      // Il topic assegnato RESTA: è la chat in cui il lavoro è stato fatto, ed è
      // la stessa cosa che una card approvata in review si tiene. A fare danno
      // non era il legame, era il chip di dispatch vivo e la finestra di
      // ri-tentativo — da lì la card è claimabile e l'agente riparte.
      //
      // Chiudere è chiudere: questa porta scrive `done` a SQL grezzo, quindi le
      // due colonne che la board legge per raccontare la colonna vanno messe qui
      // a mano o restano quelle di prima. Una card ferma su `done` con
      // `reopened_actor` acceso e `done_actor` vuoto si legge «riaperta da
      // attilio» sopra una card chiusa: uno stato che `update()` non produce
      // mai, e che dice il contrario di quel che è successo.
      //
      // `COALESCE` e non un'assegnazione: se la card era già stata chiusa da una
      // persona, quel verdetto è suo e non lo si riscrive a nome del sistema.
      db.prepare(
        `UPDATE tasks SET status = 'done', completed_at = ?, dispatch_state = NULL,
            dispatch_error = NULL, dispatch_deferred_until = NULL,
            done_actor = COALESCE(done_actor, 'system'),
            reopened_at = NULL, reopened_by = NULL, reopened_actor = NULL,
            updated_at = ? WHERE id = ?`,
      ).run(row.completed_at ?? ts, ts, taskId);
      // La card è arrivata a `done`, che è ESATTAMENTE ciò che l'approvazione in
      // attesa chiedeva: `approved`. Senza questa riga il land lasciava una
      // richiesta `pending` su una card chiusa, che nessuno avrebbe più risolto
      // (il task non è più in review e `reviewDecision` lo rifiuta) — la stessa
      // perdita che la migration 068 ha dovuto ripulire.
      settleReviewApproval(taskId, "approved", by ?? "system", ts);
      if (row.status !== "done") logStatus(taskId, row.status, "done", by ?? "system", reason);
      return rowToTask(getTaskRow(taskId));
    },

countUnlanded(projectId?: string): number {
      const sql =
        "SELECT COUNT(*) AS n FROM tasks WHERE archived = 0 AND landing_state = 'unlanded'" +
        (projectId ? " AND project_id = ?" : "");
      const r = (projectId ? db.prepare(sql).get(projectId) : db.prepare(sql).get()) as any;
      return r?.n ?? 0;
    },

proposeDeploy(this: TaskService, { taskId, command }): Task | null {
      const row = getTaskRow(taskId);
      if (!row) return null;
      const cmd = (command ?? "").trim();
      if (!cmd) return rowToTask(row);
      const ts = now();
      db.prepare(
        "UPDATE tasks SET deploy_state = 'proposed', deploy_command_at_propose = ?, updated_at = ? WHERE id = ?",
      ).run(cmd, ts, taskId);
      try {
        this.addComment({
          taskId, author: "system",
          content: `Board configurata per il deploy: \`${cmd}\`. Non parte da solo: conferma con il bottone qui sotto per lanciarlo nel checkout main.`,
          questionOptions: [DEPLOY_ACTION_LABEL],
        });
      } catch { /* best-effort: the proposal stands regardless of the comment */ }
      return rowToTask(getTaskRow(taskId));
    },

beginDeploy({ taskId }): { command: string } | null {
      const row = getTaskRow(taskId);
      if (!row) return null;
      const cmd = (row.deploy_command_at_propose ?? "").trim();
      if (!cmd) return null;
      // CAS on the state: a double click (or two humans) claims the run once.
      const res = db.prepare(
        "UPDATE tasks SET deploy_state = 'running', updated_at = ? WHERE id = ? AND deploy_state = 'proposed'",
      ).run(now(), taskId);
      if (res.changes !== 1) return null;
      return { command: cmd };
    },

finishDeploy(this: TaskService, { taskId, ok, detail }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      db.prepare("UPDATE tasks SET deploy_state = ?, updated_at = ? WHERE id = ?")
        .run(ok ? "deployed" : "failed", now(), taskId);
      try {
        this.addComment({
          taskId, author: "system",
          content: ok
            ? `Deploy eseguito.\n\n${detail}`
            : `Deploy fallito.\n\n${detail}`,
        });
      } catch { /* best-effort */ }
      return rowToTask(getTaskRow(taskId));
    }
  };
}
