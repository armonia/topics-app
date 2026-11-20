/**
 * task-dispatcher-launch.ts: turning a claimed card into a running turn.
 */
import { reusedSessionRouteConflict, reusedSessionRouting, taskModelMatchesSession, taskModelSelection, taskModelValue } from "../../shared/task-coding-models";
import { classifyTurnError, type TurnEndInfo } from "../providers/stop-reason";
import { effectiveDelegatedSettings, runWithDelegatedDeadline } from "./task-dispatcher-delegated";
import { DEFAULT_RETRY_CAP, DEFAULT_AUTO_EFFORT, ATTEMPT_STATS_DEADLINE_MS, withDeadline, CHIP_WORKING, CHIP_FAILED, CHIP_BLOCKED, REUSED_SESSION_ROUTE_REASON, rolePrompt } from "./task-dispatcher-support";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createLaunch(ctx: DispatcherCtx) {
  const { attemptCap, beginDelegated, clock, delegatedPolicy, deps, log, noCheckExemptions, recordDelegated } = ctx.core;

  // end-allow-emdash

  /** Launch one already-claimed task: (worktree?) → topic → turn → reconcile. */
  async function launch(
    taskId: string,
    settings: { useWorktree: boolean; timeoutMin: number; idleMin: number; effort: string; mcp: string; model?: string; provider?: string; topicsRouting?: boolean; topicsRoutingStored?: boolean | null },
    resolved: { path: string; projectStoreId: string | null },
  ): Promise<void> {
    const beforeLaunch = deps.svc.get(taskId)?.task;
    if (!beforeLaunch) { ctx.admission.clearNoCheckReservation(taskId); return; }
    const delegated = delegatedPolicy(beforeLaunch);
    if (delegated === null) {
      ctx.queue.releaseAndEmit({
        taskId,
        requeue: false,
        rollbackAttempt: true,
        parkState: CHIP_BLOCKED,
        reason: "Delegated start authorization is no longer valid.",
      });
      return;
    }
    if (delegated) settings = effectiveDelegatedSettings(settings, delegated);
    // THE REMOTE LANE COMES FIRST, and nothing under it may run for a card that
    // names a node: no worktree, no topic, no turn (KANBAN-76). The decision is
    // synchronous: an `await` here would postpone the slot of every LOCAL card
    // by one microtask, and `tick` launches without waiting for it.
    const remoteRun = ctx.runs.remote.remoteLaunch(taskId, settings);
    if (remoteRun) { await remoteRun; return; }
    if (delegated && !deps.abortTurn) {
      ctx.queue.releaseAndEmit({
        taskId,
        requeue: false,
        rollbackAttempt: true,
        parkState: CHIP_BLOCKED,
        reason: "Delegated duration enforcement is unavailable.",
      });
      return;
    }
    let delegatedDeadlineAt: number | undefined;
    if (delegated) {
      try {
        delegatedDeadlineAt = beginDelegated(beforeLaunch, "dispatch");
      } catch (err) {
        log(`delegated begin failed for task ${taskId}`, err);
        ctx.queue.releaseAndEmit({
          taskId,
          requeue: false,
          rollbackAttempt: true,
          parkState: CHIP_BLOCKED,
          reason: "Delegated dispatch authorization could not be persisted.",
        });
        return;
      }
    }
    const runId = ctx.runs.beginRun(taskId, "");
    let worktreeId: string | undefined;
    // LO STORICO DEL TENTATIVO. `task_attempts` esisteva con diciannove colonne
    // e ZERO righe: la scriveva solo il fan-out, e il dispatch normale — cioe'
    // la quasi totalita' dei lanci — non lasciava traccia. Il costo si e' visto
    // quando e' servito capire perche' il 40% delle uscite dalla review torna
    // indietro: senza storico dei tentativi non c'e' modo di sapere perche' una
    // card ha rimbalzato quattro volte, e ogni vista costruita su questa tabella
    // mostrava zero sembrando che andasse tutto bene.
    //
    // Best-effort in ogni punto, e non e' pigrizia: lo storico e' una TRACCIA,
    // e una traccia che fa fallire il lavoro che sta tracciando e' peggio di
    // nessuna traccia. Se la scrittura esplode, il dispatch prosegue.
    let attemptId: string | null = null;
    const attemptStore = deps.attempts;
    try {
      const task = deps.svc.get(taskId)?.task;
      if (!task) return;

      // Context reuse (opt-in on the task): ride the BLOCKER agent's topic —
      // same conversation, same worktree/cwd the topic already carries — so
      // the dependent task starts with all the context the blocker built.
      let reuseTopicId: string | null = null;
      if (task.reuseBlockerContext && task.blockedByTaskId) {
        try { reuseTopicId = deps.svc.get(task.blockedByTaskId)?.task?.assignedTopicId ?? null; } catch { /* fresh topic below */ }
      }

      // Il classificatore PRIMA del worktree, e l'ordine è la parte che conta:
      // fra le due cose che legge c'è il peso, e un peso scoperto adesso può
      // rimandare in coda il task. Rimandarlo dopo aver aperto un worktree
      // vorrebbe dire aprirlo e cancellarlo a ogni scoperta (o dimenticarselo
      // dietro, che è il modo in cui si orfanano le cartelle). Qui non è ancora
      // nato niente da disfare.
      //
      // Concrete task model > concrete board model > general Auto. A legacy
      // provider alias restricts the automatic catalog, not the final model.
      // Reused topics retain their binding and never call the classifier.
      const requestedSelection = task.model ?? settings.model ?? undefined;
      const requested = taskModelSelection(requestedSelection);
      let chosenModel: string | undefined = requested.model;
      let chosenProvider: string | undefined = requested.provider;
      const reusedSession = reuseTopicId ? deps.topicModelSelection?.(reuseTopicId) : null;
      // MSEL-06: the reuse gate reads the STORED preference (task, then board):
      // one never written adopts the session's switch instead of being parked.
      const storedRouting = settings.topicsRoutingStored === undefined ? settings.topicsRouting : settings.topicsRoutingStored;
      if (reuseTopicId && (chosenModel || deps.topicModelSelection)
        && !taskModelMatchesSession(requestedSelection, reusedSession, storedRouting)) {
        // The reused topic keeps its own switch: when the model matches, the
        // switch or the route is what differs, and the reason names it.
        const route = reusedSessionRouteConflict(requestedSelection, reusedSession, storedRouting);
        ctx.queue.releaseAndEmit({
          taskId, requeue: false, parkState: CHIP_BLOCKED,
          reason: route && (!chosenModel || chosenModel === reusedSession?.model)
            ? REUSED_SESSION_ROUTE_REASON[route]
            : chosenModel
              ? "Il modello scelto per questo task non coincide con la sessione precedente. Disattiva il riuso della sessione o scegli lo stesso modello prima di avviare il task."
              : "La sessione precedente non è disponibile come agente di coding. Disattiva il riuso della sessione prima di avviare il task.",
        });
        return;
      }
      if (reuseTopicId && reusedSession) {
        settings = { ...settings, topicsRouting: reusedSessionRouting(requestedSelection, reusedSession, storedRouting) };
        // A session from before the column existed holds `null`: write the
        // value it runs with now, as createTopic does for a new one.
        if (reusedSession.topicsRouting == null) {
          try { deps.setTopicRouting?.(reuseTopicId, settings.topicsRouting!); } catch { /* the turn still runs; the next reuse retries */ }
        }
      }
      // L'effort segue la stessa regola del modello: la board può fissarlo e
      // allora comanda lei; su "auto" lo sceglie il classificatore task per
      // task. È la leva più cara che abbiamo — stesso lavoro: `medium` 61,1k
      // token, `xhigh` 108,8k — quindi tenerla fissa per una board intera
      // significa pagarla uguale su un typo e su un refactor.
      const modelIsConcrete = !!requested.model;
      const reuseAutomaticEffort = settings.effort === "auto" && !!task.modelEffort && modelIsConcrete;
      let chosenEffort = reuseAutomaticEffort
        ? task.modelEffort!
        : settings.effort === "auto" ? DEFAULT_AUTO_EFFORT : settings.effort;
      // A concrete task or board model is a complete model decision. Its
      // automatic effort falls back to medium until a paired value exists;
      // never ask a provider-only classifier to judge another model's effort.
      if (!modelIsConcrete && !reuseTopicId && deps.pickAutoModel) {
        const picked = await deps.pickAutoModel(task, requestedSelection, { effort: settings.effort, topicsRouting: settings.topicsRouting });
        // Il peso PRIMA di tutto il resto: se questo lancio non doveva avvenire,
        // deve fermarsi qui — prima del worktree, prima del topic, prima
        // dell'agente. (Il modello non si persiste in quel caso: al prossimo giro
        // il giudice ripete la lettura, che costa un haiku, e in cambio modello e
        // peso restano una decisione sola invece di due mezze decisioni salvate a
        // metà.)
        if (settings.effort === "auto") chosenEffort = picked.effort ?? DEFAULT_AUTO_EFFORT;
        if (ctx.queue.absorbWeight(task, picked.weight)) return;
        chosenProvider = picked.provider;
        chosenModel = picked.model ?? undefined;
        // Persist only after topic binding below. Until then a pending setup
        // retains Auto, so retry cannot lose the effort half of the plan.
      }

      if (ctx.hold.deferHeldLaunch(task, chosenModel)) return;

      if (!reuseTopicId && settings.useWorktree) {
        if (!deps.createWorktree || !resolved.projectStoreId) {
          // Worktree required but impossible → park with a clear, actionable error
          // rather than run the agent in the live repo alongside the human's WIP.
          ctx.queue.releaseAndEmit({
            taskId,
            requeue: false,
            parkState: CHIP_BLOCKED,
            reason:
              "Auto-dispatch fermato: worktree richiesto ma il progetto non è un repo git registrato. " +
              "Disattiva 'worktree isolato' nelle impostazioni del board per eseguire in-place.",
          });
          return;
        }
        worktreeId = await deps.createWorktree(resolved.projectStoreId, task.baseBranch ? { baseBranch: task.baseBranch } : undefined);
        if (ctx.hold.deferHeldLaunch(task, chosenModel)) {
          await ctx.fanout.cleanupWorktree(worktreeId, { preserveWork: true });
          return;
        }
      }

      let kickoff = ctx.kickoff.buildKickoff(task);
      if (reuseTopicId) {
        kickoff =
          "New task in the SAME session as the previous one: the context you built is shared on purpose, reuse it where it helps.\n\n" + kickoff;
      }

      // Plan-first is opt-in only (the "piano prima" toggle). The dispatcher used
      // to auto-flip it on a fuzzy/under-specified task to save retry budget, but
      // that surprised the human ("piano" appearing though they never set it), so
      // it's gone by request — a task goes plan-first only when explicitly asked.

      // Catch-all decision FIRST (before any cwd override): a project-less task
      // resolves to the shared catch-all dir. Then give it a PRIVATE per-task
      // cwd so its topic's projectPath is unique — that's what lets the task's
      // own splittable workspace claim the agent's browser panes. `standalone`
      // must be read from the catch-all decision, NOT post-override path
      // equality (which the per-task dir would make false → phantom project).
      const isCatchAll = !!deps.catchAllProjectPath && resolved.path === deps.catchAllProjectPath;
      const cwd = isCatchAll && deps.catchAllTaskDir ? deps.catchAllTaskDir(taskId) : resolved.path;

      const { topicId, sessionKey } = reuseTopicId
        ? { topicId: reuseTopicId, sessionKey: "topic:" + reuseTopicId.slice(0, 8) }
        : deps.createTopic({
            name: task.text.slice(0, 60),
            projectPath: cwd,
            worktreeId,
            systemPrompt: rolePrompt(ctx.kickoff.langFor(task.projectId)),
            effort: chosenEffort,
            model: chosenModel,
            provider: chosenProvider,
            // AICTRL-05: gia' risolto dal chiamante, task > board > prefisso legacy. allow-italian: dice che qui non si risolve piu' niente
            topicsRouting: settings.topicsRouting,
            // Catch-all task → standalone session: keeps its (now per-task) cwd
            // but never renders a phantom project node in the sidebar.
            standalone: isCatchAll,
            // MCP scoping: 'bridge-only' (the default) spawns the session with
            // ONLY the topics bridge (dispatch tool profile) — the global MCP
            // fleet's schemas never enter the agent's per-call context.
            mcpPolicy: settings.mcp === "inherit" ? undefined : "bridge-only",
          });
      ctx.runs.bindRunSession(taskId, runId, sessionKey);
      if (delegated) delegatedDeadlineAt = beginDelegated(task, "dispatch", sessionKey);

      // Il tentativo nasce QUI e non prima: adesso ci sono il topic, il ramo e
      // il modello davvero scelto (il classificatore ha gia' parlato), cioe' le
      // cose per cui questa riga esiste. Crearla in cima vorrebbe dire una riga
      // con tre colonne su cinque vuote per ogni lancio che si ferma prima —
      // e i lanci che si fermano prima sono un fatto normale (peso scoperto
      // tardi, capacita' finita).
      //
      // `idx` e' il numero del tentativo cosi' come lo legge un umano, e si
      // ricava dalle RIGHE gia' scritte, non da `dispatchAttempts`: quel
      // contatore e' gia' stato incrementato dal claim quando si arriva qui, e
      // usarlo farebbe nascere il primo tentativo col numero 2. Contare le
      // righe risponde alla domanda giusta — «quanti ne ho gia' registrati» —
      // ed e' anche l'unica fonte che resta coerente se una scrittura salta.
      if (attemptStore) {
        try {
          let gia = 0;
          // ONE live attempt per card on a single launch. A row left `running`
          // by a session this launch replaces (the server died mid-turn, the
          // card was re-dispatched on a new topic) is not a sibling: at the
          // next boot the fan-out recovery counted it as one and closed the
          // round on a live card (1929291c, 2026-09-04 18:03, sent to review
          // "senza riassunto" while its agent was working).
          try {
            const prev = attemptStore.list(taskId);
            gia = prev.length;
            for (const stale of prev) {
              if (stale.state !== "running") continue;
              attemptStore.finish(stale.id, { state: "failed", error: "sostituito da un nuovo lancio sulla stessa card" });
            }
          } catch { /* prima riga */ }
          const a = attemptStore.create({
            taskId,
            idx: gia + 1,
            model: chosenModel ?? null,
          });
          attemptId = a.id;
          let branch: string | null = null;
          try { branch = worktreeId ? (deps.worktreeBranch?.(worktreeId) ?? null) : null; } catch { /* etichetta, non un requisito */ }
          attemptStore.bind(a.id, { topicId, worktreeId: worktreeId ?? null, branch });
        } catch (err) { log(`storico: tentativo non registrato per ${taskId}`, err); }
      }
      const noCheckReservationGB = noCheckExemptions.get(taskId);
      if (noCheckReservationGB != null) {
        const noCheckAttemptId = attemptId ?? attemptStore?.list(taskId).find((attempt) => attempt.state === "running")?.id;
        try { attemptStore?.setNoLocalChecksReservation?.(taskId, noCheckReservationGB); }
        catch (err) { log(`prenotazione senza check non persistita per ${taskId}`, err); }
        if (noCheckAttemptId) ctx.admission.noteNoCheckExemptionStart(taskId, noCheckAttemptId, noCheckReservationGB);
      }

      // Point the claim at the REAL topic (claim bound a placeholder) and flip
      // the chip to working. assigned_topic_id is the "apri tab" deep-link target.
      // `freshSession`: il topic e' NUOVO (non un riuso del bloccante), quindi
      // il budget dei tentativi riparte — questo e' il primo turno di questa
      // conversazione. Senza, la card ripartiva su una sessione vergine col
      // budget gia' speso e moriva al primo turno annunciando di averne fatti
      // quattro (misurato il 18/08 su `eef64e32`: tre dispatch, tre topic, e al
      // terzo la sessione aveva due messaggi).
      deps.svc.bindTopic({ taskId, topicId, freshSession: !reuseTopicId });
      if (chosenModel && !reuseTopicId) {
        deps.svc.setModel({
          taskId,
          model: modelIsConcrete && requestedSelection
            ? requestedSelection
            : chosenProvider ? taskModelValue(chosenProvider, chosenModel) : chosenModel,
          effort: settings.effort === "auto" ? chosenEffort : undefined,
        });
      }

      // DIRLO: il cambio di worktree era muto, e l'umano non sapeva dove
      // cercarlo se la GC l'avesse tenuto aperto per sporco. Un commento di
      // sistema con il nuovo ramo e l'eventuale vecchio e' l'unica traccia
      // leggibile nel thread — senza, la card sembrava "ancora in coda".
      //
      // La nota esce SOLO per un worktree NUOVO (non per il riuso del bloccante):
      // il riuso e' trasparente per definizione e la nota lo renderebbe rumore.
      // Il vecchio ramo viene cercato nell'ultimo tentativo registrato: `release()`
      // azzera gia' `assigned_topic_id` prima che il nuovo dispatch cominci, quindi
      // il vecchio topic e' irraggiungibile da qui tranne che dallo storico.
      if (!reuseTopicId && worktreeId) {
        try {
          const newBranch = deps.worktreeBranch?.(worktreeId) ?? worktreeId;
          let note = `Nuovo worktree: \`${newBranch}\``;
          const setup = deps.worktreeSetupResult?.(worktreeId);
          if (setup && setup.status !== "not-configured") {
            const label = setup.status === "succeeded" ? "riuscito" : setup.status === "timed-out" ? "scaduto" : "fallito";
            note += `\nSetup ${label}${setup.exitCode === null ? "" : ` (exit ${setup.exitCode})`}.`;
            if (setup.output.length) note += `\n\`${setup.output.join("\n").replaceAll("`", "'")}\``;
          }
          if (attemptStore) {
            try {
              const prev = attemptStore.list(taskId);
              if (prev.length >= 2) {
                // L'ultimo e' il tentativo appena aperto; quello prima e' il precedente.
                const prevAttempt = prev[prev.length - 2];
                const prevBranch = prevAttempt?.worktreeId
                  ? (deps.worktreeBranch?.(prevAttempt.worktreeId) ?? prevAttempt.worktreeId)
                  : null;
                if (prevBranch) note += ` (precedente: \`${prevBranch}\`)`;
              }
            } catch { /* storico non disponibile: la nota esce comunque */ }
          }
          deps.svc.addComment({ taskId, author: "system", content: note });
        } catch { /* best-effort: la nota non blocca il dispatch */ }
      }

      ctx.queue.emit(deps.svc.setDispatchState({ taskId, state: CHIP_WORKING }));

      const timeoutMs = Math.max(1, settings.timeoutMin) * 60_000;
      const idleMs = Math.max(1, settings.idleMin) * 60_000;
      const t0 = Date.now();
      const usage0 = ctx.usage.anchorUsage(taskId, sessionKey, chosenModel ?? null);
      ctx.usage.startLiveTurn(task, sessionKey, t0, usage0, chosenModel ?? null);
      let turnEnd: TurnEndInfo | undefined;
      try {
        // Kickoff = the ONE turn that needs the full context envelope (grounds
        // the fresh session in the project). A reused-blocker topic also gets
        // full — it's a new task, worth re-grounding.
        turnEnd = (await runWithDelegatedDeadline({
          resolvePolicy: () => delegatedPolicy(task),
          sessionKey,
          persistedDeadlineAt: delegatedDeadlineAt,
          clock,
          abortTurn: deps.abortTurn,
          run: () => deps.runTurn(sessionKey, kickoff, { timeoutMs, idleMs, contextMode: "full" }),
        })) || undefined;
      } catch (err) {
        log(`turn failed for task ${taskId}`, err);
        turnEnd = classifyTurnError(err);
      }
      // I TOKEN si scrivono PRIMA della guardia di proprietà: sono stati
      // bruciati comunque, e chi li ha bruciati è questa sessione. Il pavimento
      // è assoluto e monotono, quindi scriverli qui e riscriverli dopo non è un
      // doppio conteggio — mentre non scriverli affatto era la perdita
      // definitiva (il turno dopo si ri-ancorava più avanti).
      ctx.usage.bookUsageFloor(taskId, sessionKey, chosenModel ?? null);
      // Buried by the liveness net while this promise hung on a dead child: the
      // net already closed the turn (accounting + recovery) and a fresh run may
      // own the task by now. A zombie books no TIME and touches no worktree —
      // the replacement run is working in it. (An abandoned worktree, if the
      // recovery ends up parking the task, is the worktree GC's job.)
      if (!ctx.runs.ownsRun(taskId, runId)) return;
      ctx.usage.endLiveTurn(taskId);
      ctx.usage.recordTurnMs(taskId, t0);
      // THE STATS COME BEFORE onTurnEnd. onTurnEnd schedules the continuation
      // nudge on a zero timer, and resume() drops a nudge while this run still
      // holds the slot: with the git stat awaited after it, 8 of 8 first turns
      // on 2026-09-04 lost their nudge and waited 60 s for the poll to resume
      // them "da capo" with a note about a recycling that never happened.
      // Bounded: a git that hangs must not hold the slot either.
      const stats = attemptId && attemptStore && worktreeId && deps.attemptStats
        ? await withDeadline(deps.attemptStats(worktreeId).catch(() => null), ATTEMPT_STATS_DEADLINE_MS)
        : null;
      if (!ctx.runs.ownsRun(taskId, runId)) return;
      ctx.turnEnd.onTurnEnd(taskId, Date.now() - t0, turnEnd);
      if (delegated) {
        const after = deps.svc.get(taskId)?.task;
        if (after?.status === "review" || after?.status === "done") {
          recordDelegated(taskId, "completed", { outcome: after.status });
        } else if (after?.status === "backlog") {
          recordDelegated(taskId, "failed", { outcome: turnEnd?.cause ?? turnEnd?.end ?? "stopped" });
        }
      }
      // La fotografia dell'esito, con lo stesso significato che ha nel fan-out:
      // com'e' finito QUESTO turno, non come sta il disco adesso. `cancelled`
      // dal timeout non e' `delivered`: e' il caso che ha aperto tutto questo —
      // due card tagliate a 1.800.0xx ms tonde sembravano pronte e non lo erano.
      if (attemptId && attemptStore) {
        try {
          const usage = sessionKey ? ctx.usage.sessionUsage(sessionKey) : null;
          attemptStore.finish(attemptId, {
            // `undefined` vale `end_turn`, ed e' la stessa convenzione di
            // `onTurnEnd` dieci righe sopra: chi non sa com'e' finito il turno
            // sceglie l'ipotesi benevola, «l'agente ha finito». Leggerlo come
            // fallimento marchierebbe come falliti i turni sani di ogni host
            // che non riporta lo stop reason.
            state: !turnEnd || turnEnd.end === "end_turn" ? "delivered" : "failed",
            commit: stats?.commit ?? null,
            filesChanged: stats?.filesChanged ?? null,
            insertions: stats?.insertions ?? null,
            deletions: stats?.deletions ?? null,
            summary: ctx.kickoff.lastAgentWords(sessionKey),
            // Il motivo per cui il turno e' finito, quando non e' finito da se':
            // 'cancelled' col timeout, l'errore classificato altrimenti. E'
            // l'unica colonna che distingue «ha consegnato» da «e' scaduto».
            error: turnEnd && turnEnd.end !== "end_turn" ? (turnEnd.detail || turnEnd.end) : null,
            agentMs: Date.now() - t0,
            agentTokens: usage && usage0 ? Math.max(0, usage.billableTokens - usage0.billableTokens) : 0,
          });
        } catch (err) { log(`storico: esito del tentativo non salvato per ${taskId}`, err); }
      }
      // The worktree holds the agent's work: keep it when the task advanced to
      // review/done (it's the deliverable), delete it when the attempt was
      // discarded (requeued/parked) so retries don't orphan a worktree each time.
      const after = deps.svc.get(taskId)?.task?.status;
      if (worktreeId && (after === "todo" || after === "backlog")) await ctx.fanout.cleanupWorktree(worktreeId, { preserveWork: true });
    } catch (err) {
      log(`launch failed for task ${taskId}`, err);
      const pending = ctx.hold.pendingProviderReason(err);
      if (pending && !attemptId) {
        ctx.hold.deferPendingProvider(taskId, pending);
        if (worktreeId) await ctx.fanout.cleanupWorktree(worktreeId, { preserveWork: true });
        return;
      }
      const permanent = attemptId ? null : ctx.hold.permanentSetupBlock(err);
      if (permanent) {
        // A non-routable ON target, or a refused worktree, is a permanent
        // mismatch, not a flaky setup: requeuing would just re-throw the same
        // error forever. Park with the exact reason instead — AICTRL-01's hard
        // gate, never a silent retry.
        ctx.queue.releaseAndEmit({ taskId, requeue: false, rollbackAttempt: true, parkState: CHIP_BLOCKED, reason: permanent });
        if (worktreeId) await ctx.fanout.cleanupWorktree(worktreeId, { preserveWork: true });
        return;
      }
      // Il setup e' esploso (worktree/topic/bind): se il tentativo era gia'
      // nato, si chiude come fallito invece di restare `running` per sempre —
      // una riga eternamente in corso e' peggio di nessuna riga, perche'
      // `runningCount` la conta e il fan-out gate ci crede.
      if (attemptId && attemptStore) {
        try { attemptStore.finish(attemptId, { state: "failed", error: err instanceof Error ? err.message : String(err) }); }
        catch { /* la traccia non fa fallire il recupero */ }
      }
      // Setup threw (worktree/topic/bind). Park if attempts are exhausted, else
      // requeue — mirror onTurnEnd so a flaky setup can't strand a task in todo.
      try {
        const failTask = deps.svc.get(taskId)?.task;
        const cap = failTask ? attemptCap(failTask) : DEFAULT_RETRY_CAP;
        const exhausted = (failTask?.dispatchAttempts ?? cap) >= cap;
        ctx.queue.releaseAndEmit({
          taskId,
          requeue: !exhausted,
          parkState: CHIP_FAILED,
          // The card says WHY, in the error's own words: a bare "failed" hid a
          // wrong model name for six hours.
          reason: exhausted
            ? `Avvio agent fallito ripetutamente. Parcheggiato in backlog. Motivo: ${startErrorText(err)}`
            : `Avvio agent fallito, rimesso in coda. Motivo: ${startErrorText(err)}`,
        });
      } catch { /* best-effort */ }
      if (worktreeId) await ctx.fanout.cleanupWorktree(worktreeId, { preserveWork: true });
    } finally {
      ctx.runs.endRun(taskId, runId);
    }
  }
  return { launch };
}

/** The message of a start failure, trimmed to what fits a card chip. */
export function startErrorText(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
  return text.length > 400 ? `${text.slice(0, 399)}…` : text || "errore sconosciuto";
}
