import type { Database } from "bun:sqlite";
import { markSystemChat } from "../../lib/wake-adoption";
import type { ServiceOpts, TaskService } from "../tasks";
import type { createTasksShared } from "./shared";
import { type Task } from "../task-shapes";
import { TaskServiceError, VALID_EFFORT } from "./shared";

export function createWorktreeMethods(db: Database, _opts: ServiceOpts, shared: ReturnType<typeof createTasksShared>): Pick<TaskService, "boardProjectForTopic" | "taskForTopic" | "bindTopic" | "recordAgentUsage" | "raiseAgentUsage" | "nodeRunOf" | "setNodeRun" | "nodeRunIsOpen" | "closeNodeRun" | "retiredNodeRuns" | "setModel"> {
  const {
    archiveSubtree,
    assertNoLiveDependents,
    getTaskRow,
    logStatus,
    now,
    rowToTask,
    settleReviewApproval,
  } = shared;

  return {
boardProjectForTopic(topicId) {
      if (!topicId) return null;
      // A live dispatch binds exactly one task to the topic; prefer a non-archived
      // one and the most recent if history ever left more than one.
      const r = db.prepare(
        `SELECT project_id FROM tasks
          WHERE assigned_topic_id = ?
          ORDER BY archived ASC, updated_at DESC LIMIT 1`,
      ).get(topicId) as any;
      return r?.project_id ?? null;
    },

taskForTopic(topicId) {
      if (!topicId) return null;
      const r = db.prepare(
        `SELECT id, project_id, text, delivery_branch, delivery_commit, delivery_files_changed,
                (SELECT branch FROM task_attempts
                  WHERE task_id = tasks.id AND topic_id = ?1 AND branch IS NOT NULL
                  ORDER BY idx DESC LIMIT 1) AS attempt_branch
           FROM tasks
          WHERE assigned_topic_id = ?1
          ORDER BY archived ASC, updated_at DESC LIMIT 1`,
      ).get(topicId) as any;
      return r
        ? {
          id: r.id,
          projectId: r.project_id,
          text: r.text ?? "",
          deliveryBranch: r.delivery_branch ?? null,
          deliveryCommit: r.delivery_commit ?? null,
          deliveryFiles: r.delivery_files_changed ?? null,
          attemptBranch: r.attempt_branch ?? null,
        }
        : null;
    },

bindTopic(this: TaskService, { taskId, topicId, freshSession }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // UNA SESSIONE NUOVA E' UN TENTATIVO NUOVO, e il budget riparte da zero.
      //
      // `dispatch_attempts` conta i turni di UN tentativo — e' il freno contro
      // un agente che gira in tondo dentro la stessa conversazione. Fra un
      // dispatch e l'altro, invece, il contatore restava: la card ripartiva su
      // una sessione VERGINE con il budget gia' speso, quindi moriva al primo
      // turno annunciando di averne fatti quattro.
      //
      // Misurato il 18/08 su `eef64e32`: tre dispatch, tre topic diversi
      // (`groovy-frond`, `stellar-weasel`, `stellar-geyser`), e al terzo la
      // sessione aveva DUE messaggi mentre la card scriveva «L'agent ha
      // lavorato 4 turni». Un ciclo che non poteva chiudersi: ogni giro
      // ricominciava il piano e non arrivava mai a lavorarlo.
      //
      // E' la stessa regola che le due uscite UMANE applicano gia', con la
      // stessa ragione scritta accanto (`reviewDecision` rifiuto,
      // `resolveParkedChildren`): «il mandato e' NUOVO, quindi il budget dei
      // tentativi riparte da zero. Senza, il padre tornerebbe in coda gia'
      // esaurito e non lo reclamerebbe piu' nessuno».
      //
      // Il freno NON si allenta: se la sessione e' la STESSA — una ripresa, una
      // continuazione — il contatore resta dov'e', ed e' li' che serve.
      // `freshSession` lo DICE chi lo sa: il dispatcher, che ha appena creato
      // il topic invece di riusarne uno. Dedurlo da «il topic e' cambiato» non
      // funziona — fra un tentativo e l'altro `release` azzera il legame, e il
      // primo attacco di OGNI tentativo sarebbe `null -> topic`, cioe' anche
      // quello che la rivendicazione ha appena contato.
      //
      // `1` e non `0`: questo turno e' il PRIMO della sessione nuova, e conta.

      // IL TENTATIVO MUORE, LA CHECKLIST NO: I `done` SI ARCHIVIANO, GLI APERTI
      // CAMBIANO PADRONE.
      //
      // Misurato il 18/08 su `eef64e32`: dopo il re-dispatch i quattro sottotask
      // del topic precedente (`groovy-frond`) erano ancora nella checklist del
      // padre, tre segnati `done` per lavoro che era stato buttato via e uno
      // `in_progress` che mandava il padre in attesa di nessuno (deadlock
      // silenzioso: la card restava in coda per sempre perche' uno step si muove
      // solo dall'agente di quella card, e quell'agente non esiste piu').
      //
      // I due guasti NON sono lo stesso guasto, e non hanno la stessa cura:
      //
      //  · un `done` e' una BUGIA. Descrive lavoro che il worktree nuovo non ha;
      //    l'agente che arriva lo legge come fatto e non lo rifa'. Si archivia.
      //  · un aperto e' un PIANO. Dice cosa restava da fare, ed e' l'unica cosa
      //    di buono che il tentativo morto lascia. Archiviarlo faceva ripartire
      //    il nuovo agente dal foglio bianco, a ricostruire la stessa lista.
      //
      // Quindi gli aperti restano, ma cambiano padrone: `status` torna a `todo`
      // (l'`in_progress` era di un turno che non gira piu') e
      // `created_by_topic_id` passa al topic NUOVO. Il secondo pezzo e' quello
      // che scioglie il deadlock, ed e' il motivo per cui `isOwnStep` guarda la
      // PROVENIENZA e non solo il legame di dispatch: `assigned_topic_id` lo
      // azzera `release` mentre il turno gira ancora, e senza la provenienza
      // aggiornata l'agente nuovo vedeva lo step e prendeva 409 nel chiuderlo.
      //
      // Ricorsivo sull'ALBERO, non sui figli diretti: uno step annidato del
      // tentativo morto avrebbe lo stesso problema un livello piu' sotto, e
      // sarebbe l'unico rimasto che nessuno puo' chiudere.
      //
      // Idempotente: se il topic e' lo stesso (ripresa) o non c'era (primo
      // dispatch), non si tocca niente.
      const oldTopicId = row.assigned_topic_id as string | null;
      if (freshSession && oldTopicId && oldTopicId !== topicId) {
        const ts = now();
        // L'albero INTERO sotto il task, filtrato sulla provenienza: quello che
        // ha creato un altro topic (un umano, un altro agente) non si tocca.
        // Il task stesso e' escluso: e' il deliverable, non uno step.
        const staleOf = (): Array<{ id: string; text: string; status: string }> =>
          db.prepare(
            `WITH RECURSIVE subtree(id) AS (
               SELECT id FROM tasks WHERE id = ?
               UNION ALL
               SELECT t.id FROM tasks t JOIN subtree s ON t.parent_task_id = s.id
             )
             SELECT t.id, t.text, t.status FROM tasks t
              WHERE t.id IN (SELECT id FROM subtree WHERE id != ?)
                AND t.created_by_topic_id = ?
                AND t.archived = 0
              ORDER BY t.kanban_order ASC`,
          ).all(taskId, taskId, oldTopicId) as Array<{ id: string; text: string; status: string }>;

        const archiviati = staleOf().filter((c) => c.status === "done");
        // Prima gli archiviati, e in cascata: un aperto che pendeva da uno step
        // `done` se ne va con lui invece di restare appeso a un padre sparito.
        // Review feedback 26/11, point 2: this cascade used to skip the live-dependent
        // gate entirely. A reopened grandchild that is itself the blocker of an
        // unrelated card must not vanish silently just because this reconciliation
        // is automatic. On a rejection here there is no user to answer a 409 to, so
        // the stale card is simply left in place rather than retried forever.
        for (const c of archiviati) {
          try {
            assertNoLiveDependents(c.id);
          } catch {
            continue;
          }
          archiveSubtree(c.id, ts);
        }
        // Poi si rilegge: quello che e' ancora aperto DOPO la cascata e' quello
        // che il nuovo agente eredita davvero.
        const ereditati = staleOf().filter((c) => c.status !== "done");
        for (const c of ereditati) {
          // Le colonne sono ESATTAMENTE quelle che `resolveParkedChildren`
          // azzera quando rimette in coda un figlio, e per la stessa ragione:
          // e' un mandato NUOVO, non un residuo. Lasciare la finestra di rinvio
          // o il chip vecchio vuol dire uno step che dice «in coda» sopra una
          // coda che non lo serve, che e' il modo in cui una card si ferma
          // senza dirlo a nessuno.
          db.prepare(
            "UPDATE tasks SET status = 'todo', created_by_topic_id = ?, dispatch_state = NULL, " +
              "dispatch_error = NULL, dispatch_attempts = 0, dispatch_deferred_until = NULL, " +
              "updated_at = ? WHERE id = ?",
          ).run(topicId, ts, c.id);
          // La riga di stato la scrive CHI SPOSTA, sempre: senza, la storia
          // dello step mostra una colonna cambiata e nessuno che l'ha cambiata.
          // Il `from` e' quello vero e non una costante — uno step gia' in
          // `todo` non si e' mosso, e scrivergli «todo -> todo» sarebbe mettere
          // nella sua storia un passaggio mai avvenuto (stessa regola, e stessa
          // riga, di `resolveParkedChildren`).
          if (c.status !== "todo") logStatus(c.id, c.status, "todo", "system");
          // Uno step in `review` stava aspettando una decisione. Tirandolo
          // fuori, quella approvazione non ha piu' oggetto: se resta `pending`
          // non la chiude piu' niente, perche' `reviewDecision` rifiuta un task
          // che in review non c'e' piu'. E' la stessa chiusura che
          // `resolveParkedChildren` fa sul padre quando la domanda decade.
          if (c.status === "review") settleReviewApproval(c.id, "expired", "system", ts);
        }
        if (archiviati.length > 0 || ereditati.length > 0) {
          const lines: string[] = [`Sessione cambiata (topic \`${oldTopicId}\` -> \`${topicId}\`).`];
          if (archiviati.length > 0) {
            lines.push(
              `${archiviati.length} ${archiviati.length === 1 ? "sottotask completato archiviato" : "sottotask completati archiviati"}: ` +
                `segnavano lavoro del tentativo precedente, che non esiste piu'.`,
            );
          }
          if (ereditati.length > 0) {
            lines.push(
              `${ereditati.length} ${ereditati.length === 1 ? "sottotask incompleto ereditato" : "sottotask incompleti ereditati"} ` +
                `dal nuovo agente: rimessi in todo, sono il piano che il tentativo precedente lascia.`,
            );
            lines.push(ereditati.map((c) => `- ${c.text}`).join("\n"));
          }
          try {
            this.addComment({ taskId, author: "system", content: lines.join("\n") });
          } catch { /* best-effort: la nota non blocca il bind */ }
        }
      }

      db.prepare(
        "UPDATE tasks SET assigned_topic_id = ?, chat_id = ?" +
          (freshSession ? ", dispatch_attempts = 1" : "") +
          ", updated_at = ? WHERE id = ?",
      ).run(topicId, topicId, now(), taskId);
      markSystemChat(db, topicId, "task");
      return rowToTask(getTaskRow(taskId));
    },

recordAgentUsage({ taskId, addMs, addTokens, addCacheReadTokens }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const ms = Math.max(0, Math.trunc(addMs || 0));
      const tok = Math.max(0, Math.trunc(addTokens || 0));
      const cr = Math.max(0, Math.trunc(addCacheReadTokens || 0));
      db.prepare(
        "UPDATE tasks SET agent_ms = agent_ms + ?, agent_tokens = agent_tokens + ?, agent_cache_read_tokens = agent_cache_read_tokens + ?, updated_at = ? WHERE id = ?",
      ).run(ms, tok, cr, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

raiseAgentUsage({ taskId, tokens, cacheReadTokens, costCents, unpricedCostTokens }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const tok = Math.max(0, Math.trunc(tokens || 0));
      const cr = Math.max(0, Math.trunc(cacheReadTokens || 0));
      // THE MONEY, and it is written in two places on purpose: the cumulative
      // column on the card (what this card cost) and a DATED row in the ledger
      // (what was spent, when). A rolling 24h window is not derivable from the
      // first one - «the cards touched today» would carry yesterday's spend of
      // those same cards - and the card's own number is not derivable from the
      // ledger without a sum on every read.
      //
      // Only the DELTA of the floor becomes a ledger row: `raiseAgentUsage` is
      // called several times per turn with the same absolute total, so booking
      // the total every time would multiply the window by the number of calls.
      const cents = Math.max(0, Math.trunc(costCents ?? 0));
      const unpriced = Math.max(0, Math.trunc(unpricedCostTokens ?? 0));
      if (costCents != null || unpricedCostTokens != null) {
        const before = db.prepare("SELECT COALESCE(agent_cost_cents, 0) AS c FROM tasks WHERE id = ?")
          .get(taskId) as { c: number } | null;
        const prevCents = Math.max(0, Math.trunc(before?.c ?? 0));
        db.prepare("UPDATE tasks SET agent_cost_cents = MAX(COALESCE(agent_cost_cents, 0), ?) WHERE id = ?")
          .run(cents, taskId);
        const deltaCents = Math.max(0, cents - prevCents);
        // The unpriced share rides on the same row: a booking that could not be
        // priced moves no cents but must still leave a trace, or the panel would
        // show a cap that quietly ignores part of the spend.
        //
        // Its «what I knew before» is the SUM of the ledger and not a column on
        // the card, because that sum IS the absolute total: one more column
        // would be the same number written twice, free to diverge.
        const seenUnpriced = unpriced > 0
          ? (db.prepare("SELECT COALESCE(SUM(unpriced_cost_tokens), 0) AS u FROM agent_spend WHERE task_id = ?")
              .get(taskId) as { u: number } | null)?.u ?? 0
          : 0;
        const deltaUnpriced = Math.max(0, unpriced - Math.max(0, Math.trunc(seenUnpriced)));
        if (deltaCents > 0 || deltaUnpriced > 0) {
          db.prepare("INSERT INTO agent_spend (task_id, at, cents, unpriced_cost_tokens) VALUES (?, ?, ?, ?)")
            .run(taskId, now(), deltaCents, deltaUnpriced);
        }
      }
      // `COALESCE` prima di `MAX`, e non è una cintura: lo `max()` scalare di
      // SQLite torna NULL se UNO degli argomenti è NULL, quindi su una card che
      // non ha mai contato niente (`agent_tokens` NULL) il pavimento avrebbe
      // CANCELLATO il numero invece di alzarlo. Visto in un test, non letto.
      db.prepare(
        "UPDATE tasks SET agent_tokens = MAX(COALESCE(agent_tokens, 0), ?), agent_cache_read_tokens = MAX(COALESCE(agent_cache_read_tokens, 0), ?), updated_at = ? WHERE id = ?",
      ).run(tok, cr, now(), taskId);
      return rowToTask(getTaskRow(taskId));
    },

nodeRunOf(taskId) {
      const row = db.prepare("SELECT node_run_id FROM tasks WHERE id = ?").get(taskId) as { node_run_id: string | null } | null;
      return row?.node_run_id ?? null;
    },

setNodeRun(taskId, runId) {
      db.prepare("UPDATE tasks SET node_run_id = ?, node_run_open = ? WHERE id = ?").run(runId, runId ? 1 : 0, taskId);
    },

nodeRunIsOpen(taskId) {
      const row = db.prepare("SELECT node_run_open FROM tasks WHERE id = ?").get(taskId) as { node_run_open: number } | null;
      return row?.node_run_open === 1;
    },

closeNodeRun(taskId) {
      db.prepare("UPDATE tasks SET node_run_open = 0 WHERE id = ?").run(taskId);
    },

retiredNodeRuns() {
      const rows = db.prepare(
        `SELECT id, node_run_id, machine_id, delegated_start_capability_id FROM tasks
          WHERE node_run_id IS NOT NULL AND (status = 'done' OR COALESCE(archived, 0) = 1)`,
      ).all() as { id: string; node_run_id: string; machine_id: string | null; delegated_start_capability_id: string | null }[];
      return rows.map((r) => ({ taskId: r.id, runId: r.node_run_id, machineId: r.machine_id, capabilityId: r.delegated_start_capability_id }));
    },

setModel({ taskId, model, effort }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      const normalizedModel = model || null;
      const sets = ["model = ?", "updated_at = ?"];
      const params: Array<string | null> = [normalizedModel, now()];
      if (effort !== undefined) {
        if (effort !== null && (!VALID_EFFORT.has(effort) || effort === "auto")) {
          throw new TaskServiceError("invalid_input", `invalid task model effort: ${effort}`);
        }
        sets.splice(1, 0, "model_effort = ?");
        params.splice(1, 0, effort);
      } else if (normalizedModel !== (row.model ?? null)) {
        // An effort belongs to its resolved model. Callers that change a model
        // without a fresh automatic judgment must not inherit the old model's.
        sets.splice(1, 0, "model_effort = NULL");
      }
      params.push(taskId);
      db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      return rowToTask(getTaskRow(taskId));
    }
  };
}
