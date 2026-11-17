/**
 * task-dispatcher-fanout.ts: several attempts at one card.
 * 
 * Launching the attempts, reaping them, closing a fan-out and recovering an
 * orphaned one, and the worktree cleanup they share.
 */
import { awaitsHuman } from "../../shared/workflow";
import { type Task } from "./tasks";
import { type SessionUsage } from "./transcript-usage";
import type { TaskAttemptStore } from "./task-attempts";
import { attemptHasWork, formatFanoutComment } from "../../shared/task-attempt";
import { taskModelSelection, taskModelValue } from "../../shared/task-coding-models";
import { classifyTurnError, describeTurnEnd } from "../providers/stop-reason";
import type { DispatcherDeps } from "./task-dispatcher-types";
import { DEFAULT_RETRY_CAP, DEFAULT_AUTO_EFFORT, CHIP_WORKING, CHIP_FAILED, CHIP_BLOCKED, rolePrompt } from "./task-dispatcher-support";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createFanOut(ctx: DispatcherCtx) {
  const { attemptCap, deps, log, shared } = ctx.core;

  /**
   * Un tentativo: worktree → topic → turno → fotografia dell'esito.
   * NON rigetta mai: il fallimento di un tentativo è un DATO del confronto, non
   * un'eccezione che deve travolgere i fratelli ancora in volo.
   */
  // end-allow-emdash

  async function runAttempt(
    task: Task,
    idx: number,
    total: number,
    opts: { timeoutMs: number; idleMs: number; effort: string; autoEffort?: boolean; mcp: string; model?: string; provider?: string; topicsRouting?: boolean | null },
    resolved: { path: string; projectStoreId: string },
  ): Promise<string | undefined> {
    const store = deps.attempts!;
    const attempt = store.create({ taskId: task.id, idx, model: opts.model ?? null });
    let worktreeId: string | null = null;
    let sessionKey = "";
    const t0 = Date.now();
    let usage0: SessionUsage | null = null;
    let failure: string | null = null;
    try {
      worktreeId = await deps.createWorktree!(resolved.projectStoreId, task.baseBranch ? { baseBranch: task.baseBranch } : undefined);
      const routedModel = opts.provider && opts.model ? taskModelValue(opts.provider, opts.model) : opts.model;
      const wait = ctx.hold.taskPlanWait(task, routedModel, true);
      if (wait) {
        try { store.finish(attempt.id, { state: "failed", error: wait.reason }); }
        catch (err) { log(`fan-out: held attempt ${attempt.id} not recorded`, err); }
        await cleanupWorktree(worktreeId, { preserveWork: true });
        return wait.reason;
      }
      let branch: string | null = null;
      try { branch = deps.worktreeBranch?.(worktreeId) ?? null; } catch { /* etichetta, non un requisito */ }
      const topic = deps.createTopic({
        name: `${task.text.slice(0, 44)} · tentativo ${idx}`,
        projectPath: resolved.path,
        worktreeId,
        systemPrompt: rolePrompt(ctx.kickoff.langFor(task.projectId)),
        effort: opts.effort,
        model: opts.model,
        provider: opts.provider,
        topicsRouting: opts.topicsRouting,
        mcpPolicy: opts.mcp === "inherit" ? undefined : "bridge-only",
      });
      sessionKey = topic.sessionKey;
      store.bind(attempt.id, { topicId: topic.topicId, worktreeId, branch });
      if (opts.model) deps.svc.setModel({ taskId: task.id, model: routedModel!, effort: opts.autoEffort ? opts.effort : undefined });
      // Il tentativo 1 tiene il deep-link del task finché l'umano non sceglie:
      // `assigned_topic_id` ha una FK su topics ed è il bersaglio di "Apri la
      // chat". Alla scelta viene ri-puntato sul vincitore.
      if (idx === 1) {
        try { deps.svc.bindTopic({ taskId: task.id, topicId: topic.topicId }); } catch { /* il fan-out vive lo stesso */ }
      }
      usage0 = ctx.usage.anchorUsage(task.id, sessionKey, opts.model ?? null);
      const turnEnd = (await deps.runTurn(sessionKey, ctx.kickoff.buildFanoutKickoff(task, idx, total), {
        timeoutMs: opts.timeoutMs,
        idleMs: opts.idleMs,
        contextMode: "full",
      })) || undefined;
      if (turnEnd && turnEnd.end !== "end_turn") failure = describeTurnEnd(turnEnd);
    } catch (err) {
      const pending = ctx.hold.pendingProviderReason(err);
      if (pending && !sessionKey) {
        store.finish(attempt.id, { state: "failed", error: pending });
        if (worktreeId) await cleanupWorktree(worktreeId, { preserveWork: true });
        return pending;
      }
      // Un cancello duro non è il fallimento di QUESTO tentativo: è la stessa
      // risposta per tutti e N, e va risalita fino a chi può parcheggiare la
      // card col motivo. Sepolta qui — `failed` e `return undefined`, cioè
      // "è partito davvero" per chi legge i risultati — la card tornava in
      // giro senza che nessuno avesse mai detto perché.
      const blocked = ctx.hold.permanentSetupBlock(err);
      if (blocked && !sessionKey) {
        // La riga si chiude PRIMA di risalire: un tentativo eternamente
        // `running` viene contato da `runningCount` e il cancello del fan-out
        // ci crede.
        try { store.finish(attempt.id, { state: "failed", error: blocked }); }
        catch (e) { log(`fan-out: esito del tentativo ${idx} non salvato`, e); }
        if (worktreeId) await cleanupWorktree(worktreeId, { preserveWork: true });
        throw err;
      }
      failure = describeTurnEnd(classifyTurnError(err));
      log(`fan-out: tentativo ${idx} del task ${task.id} caduto`, err);
    }
    // La fotografia si scatta SEMPRE, anche su fallimento: un turno andato in
    // timeout può aver committato lavoro buono, e buttarlo per la ragione
    // sbagliata è esattamente ciò che il fan-out deve evitare.
    let stats: Awaited<ReturnType<NonNullable<DispatcherDeps["attemptStats"]>>> = null;
    if (worktreeId && deps.attemptStats) {
      try { stats = await deps.attemptStats(worktreeId); }
      catch (err) { log(`fan-out: diffstat del tentativo ${idx} non leggibile`, err); }
    }
    const usage = sessionKey ? ctx.usage.sessionUsage(sessionKey) : null;
    try {
      store.finish(attempt.id, {
        state: failure ? "failed" : "delivered",
        commit: stats?.commit ?? null,
        filesChanged: stats?.filesChanged ?? null,
        insertions: stats?.insertions ?? null,
        deletions: stats?.deletions ?? null,
        summary: ctx.kickoff.lastAgentWords(sessionKey),
        error: failure,
        agentMs: Date.now() - t0,
        // Senza una delle due letture il tentativo non ha un consumo: si scrive
        // 0, che e' «non misurato», non «gratis» — il totale del task lo porta
        // comunque il registro qui sotto.
        agentTokens: usage && usage0 ? Math.max(0, usage.billableTokens - usage0.billableTokens) : 0,
      });
    } catch (err) { log(`fan-out: esito del tentativo ${idx} non salvato`, err); }
    // Il costo va anche sul task: un fan-out è costato la SOMMA dei tentativi,
    // ed è quel numero — non un terzo — che deve comparire sulla card. Il
    // registro tiene una riga per SESSIONE e le somma, quindi N tentativi su N
    // sessioni si sommano da soli: è l'unico posto in cui la somma è la
    // risposta giusta, e qui la dà la stessa funzione degli altri.
    if (sessionKey) { ctx.usage.bookUsageFloor(task.id, sessionKey, opts.model ?? null); ctx.usage.recordTurnMs(task.id, t0); }
    return undefined;
  }

  /** Pota worktree e chat dei tentativi di un task (il vincitore, se c'è, resta). */
  async function reapAttempts(taskId: string, opts: { keepSelected: boolean }): Promise<void> {
    const store = deps.attempts;
    if (!store) return;
    let rows;
    try { rows = store.list(taskId); } catch { return; }
    for (const a of rows) {
      if (opts.keepSelected && a.state === "selected") continue;
      if (a.worktreeId) await cleanupWorktree(a.worktreeId);
      // Prima il worktree, poi il topic: un topic vivo su un worktree potato è
      // una sessione congelata (resolveTopicCwd non trova più la directory).
      if (a.topicId) { try { deps.archiveTopic?.(a.topicId); } catch { /* best-effort */ } }
    }
  }

  /** Tutti i tentativi hanno chiuso: confronto nel thread, poi review o park. */
  async function closeFanOut(taskId: string, n: number, opts?: { orphaned?: boolean }): Promise<void> {
    const store = deps.attempts!;
    let rows;
    try { rows = store.list(taskId); } catch (err) { log(`fan-out: rilettura tentativi fallita per ${taskId}`, err); return; }
    const worked = rows.filter(attemptHasWork);
    if (worked.length === 0) {
      // Nessuno ha prodotto niente: è il fallimento di un giro, non una consegna.
      // Mandare l'umano a scegliere fra tre vuoti sarebbe peggio del silenzio.
      await reapAttempts(taskId, { keepSelected: false });
      const cur = deps.svc.get(taskId)?.task;
      const cap = cur ? attemptCap(cur) : DEFAULT_RETRY_CAP;
      // Un riavvio del server non è colpa dell'agent: non consuma un tentativo
      // (stessa regola del recupero orfani del lancio singolo).
      const exhausted = !opts?.orphaned && (cur?.dispatchAttempts ?? cap) >= cap;
      try {
        ctx.queue.releaseAndEmit({
          taskId,
          requeue: !exhausted,
          rollbackAttempt: opts?.orphaned,
          parkState: CHIP_FAILED,
          reason: opts?.orphaned
            ? `Il server è ripartito mentre il fan-out girava e nessuno dei ${n} tentativi aveva committato: rimesso in coda (il riavvio non consuma un tentativo).`
            : `Fan-out chiuso: ${n} ${n === 1 ? "tentativo" : "tentativi"}, nessuno ha prodotto modifiche committate. ` +
              (exhausted ? "Parcheggiato in backlog." : "Rimesso in coda."),
        });
      } catch (err) { log(`fan-out: park fallito per ${taskId}`, err); }
      return;
    }
    try {
      // Il confronto È la ragione della consegna: `deliverToReviewBySystem` lo
      // scrive come commento di sistema e poi porta il task in review. Nessun
      // punteggio, nessun "consigliato": la scelta di merito resta umana.
      const delivered = deps.svc.deliverToReviewBySystem({
        taskId,
        reason: formatFanoutComment(rows),
        cause: "fanout",
      });
      ctx.queue.emit(delivered);
      // Only a card that waits on a PERSON rings (`awaitsHuman`, shared/workflow.ts).
      if (awaitsHuman(delivered)) {
        try {
          deps.broadcast({
            type: "task:review-ready",
            projectId: delivered.projectId,
            taskId: delivered.id,
            taskTitle: delivered.text || "Task",
            reason: "system-delivered",
          });
        } catch { /* best-effort */ }
      }
      // Niente preview qui: il worktree del task è quello del tentativo 1, che
      // può NON essere il vincitore. La preview parte alla scelta (route select).
    } catch (err) { log(`fan-out: consegna in review fallita per ${taskId}`, err); }
  }

  /**
   * Un fan-out interrotto da un riavvio del server: i turni sono morti con il
   * processo, ma i WORKTREE no — quello che i tentativi avevano committato è
   * ancora lì. Si chiude il giro con la fotografia di ciò che è sopravvissuto
   * invece di lasciare i tentativi `running` per sempre (il che bloccherebbe
   * anche il gate sul PATCH dell'agente, che è la cosa più difficile da capire
   * guardando la board).
   */
  async function recoverOrphanedFanOut(taskId: string): Promise<void> {
    const store = deps.attempts!;
    // Occupa lo slot del task: leggere N worktree con git non è istantaneo, e il
    // reconcile ripassa ogni 10s — senza questo partirebbero due recuperi
    // sovrapposti sullo stesso giro.
    const runId = ctx.runs.beginRun(taskId, "");
    try {
      await runOrphanRecovery(taskId, store);
    } finally {
      ctx.runs.endRun(taskId, runId);
    }
  }

  async function runOrphanRecovery(taskId: string, store: TaskAttemptStore): Promise<void> {
    let stale;
    try { stale = store.list(taskId).filter((a) => a.state === "running"); } catch { return; }
    for (const a of stale) {
      let stats: Awaited<ReturnType<NonNullable<DispatcherDeps["attemptStats"]>>> = null;
      if (a.worktreeId && deps.attemptStats) {
        try { stats = await deps.attemptStats(a.worktreeId); } catch { /* nessun numero, nessun dramma */ }
      }
      try {
        store.finish(a.id, {
          state: "failed",
          commit: stats?.commit ?? null,
          filesChanged: stats?.filesChanged ?? null,
          insertions: stats?.insertions ?? null,
          deletions: stats?.deletions ?? null,
          // Le sue ultime parole restano nella sessione anche dopo il riavvio.
          summary: ctx.kickoff.lastAgentWords(a.topicId ? "topic:" + a.topicId.slice(0, 8) : ""),
          error: "il server è ripartito mentre il tentativo lavorava",
        });
      } catch (err) { log(`fan-out: chiusura del tentativo orfano ${a.id} fallita`, err); }
    }
    let total = stale.length;
    try { total = store.list(taskId).length; } catch { /* il conteggio è solo prosa */ }
    await closeFanOut(taskId, total, { orphaned: true });
  }

  /**
   * Lancia un fan-out già claimato: N tentativi in parallelo, poi il confronto.
   * Occupa UN solo slot di `inFlight` (che è per-task, non per-turno) — il costo
   * verso il tetto di concorrenza è pagato in `tick` via `reservedSlots`.
   */
  async function launchFanOut(
    taskId: string,
    n: number,
    settings: { timeoutMin: number; idleMin: number; effort: string; mcp: string; model?: string; topicsRouting?: boolean },
    resolved: { path: string; projectStoreId: string },
  ): Promise<void> {
    const runId = ctx.runs.beginRun(taskId, "");
    shared.reservedSlots += n - 1;
    try {
      const task = deps.svc.get(taskId)?.task;
      if (!task) return;
      // Un giro precedente (rifiutato in review e ri-dispacciato) ha lasciato i
      // suoi worktree in giro: si potano QUI, prima di aprirne altri N.
      await reapAttempts(taskId, { keepSelected: true });
      try { deps.attempts!.clear(taskId); } catch { /* tabella vuota è lo stato voluto */ }

      // UN modello per tutti i tentativi: variarlo fra tentativi renderebbe il
      // confronto un esperimento su due variabili insieme, e il fan-out serve a
      // confrontare STRADE, non provider.
      const requestedSelection = task.model ?? settings.model ?? undefined;
      const requested = taskModelSelection(requestedSelection);
      let chosenModel: string | undefined = requested.model;
      let chosenProvider: string | undefined = requested.provider;
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
      if (!modelIsConcrete && deps.pickAutoModel) {
        const picked = await deps.pickAutoModel(task, requestedSelection, { effort: settings.effort, topicsRouting: settings.topicsRouting });
        // Vale a maggior ragione qui: un task pesante in fan-out sono N
        // macinate in parallelo, cioè il caso peggiore che il peso esiste per
        // evitare. Il `finally` restituisce gli slot prenotati.
        if (settings.effort === "auto") chosenEffort = picked.effort ?? DEFAULT_AUTO_EFFORT;
        if (ctx.queue.absorbWeight(task, picked.weight)) return;
        chosenProvider = picked.provider;
        chosenModel = picked.model ?? undefined;
      }

      if (ctx.hold.deferHeldLaunch(task, chosenModel)) return;

      ctx.queue.emit(deps.svc.setDispatchState({ taskId, state: CHIP_WORKING }));
      try {
        deps.svc.addComment({
          taskId, author: "system", kind: "service",
          content:
            `Fan-out: ${n} agenti partono in parallelo su questo task, ognuno nel proprio worktree e nella propria chat. ` +
            "A fine giro li trovi qui a confronto: ne scegli uno e gli altri vengono buttati.",
        });
      } catch { /* best-effort */ }

      const timeoutMs = Math.max(1, settings.timeoutMin) * 60_000;
      const idleMs = Math.max(1, settings.idleMin) * 60_000;
      // allSettled e non all: un tentativo che esplode in modo imprevisto non
      // deve lasciare i fratelli a girare senza nessuno che ne raccolga l'esito.
      const results = await Promise.allSettled(
        Array.from({ length: n }, (_, i) =>
          runAttempt(task, i + 1, n, { timeoutMs, idleMs, effort: chosenEffort, autoEffort: settings.effort === "auto", mcp: settings.mcp, model: chosenModel, provider: chosenProvider, topicsRouting: settings.topicsRouting }, resolved),
        ),
      );
      // Sepolto dalla rete di liveness mentre giravamo (o rimpiazzato da un run
      // nuovo): non è più roba nostra, e chiudere il fan-out adesso pesterebbe
      // lo stato di chi ci ha sostituito.
      if (!ctx.runs.ownsRun(taskId, runId)) return;
      // `allSettled` non rilancia niente, quindi un cancello duro sarebbe
      // finito qui dentro come un rifiuto qualunque e la card sarebbe tornata
      // in giro muta. Si parcheggia col motivo — lo stesso che il percorso a
      // un agente solo (`launch`) applica da sempre — ma solo se NESSUN
      // fratello è arrivato a girare: dove c'è lavoro vero, il fan-out si
      // chiude normalmente e il motivo resta sulla riga del tentativo.
      const blocked = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected" && !!ctx.hold.permanentSetupBlock(result.reason),
      );
      const started = results.some(result => result.status === "fulfilled" && result.value === undefined);
      if (blocked && !started) {
        ctx.queue.releaseAndEmit({
          taskId, requeue: false, rollbackAttempt: true,
          parkState: CHIP_BLOCKED, reason: ctx.hold.permanentSetupBlock(blocked.reason)!,
        });
        await reapAttempts(taskId, { keepSelected: false });
        return;
      }
      const held = results.map(result => result.status === "fulfilled" ? result.value : undefined);
      // Only an entirely unstarted batch refunds its claim. A sibling already
      // running keeps its work and follows the normal delivery path.
      if (held.every(reason => reason !== undefined)) {
        const queued = ctx.queue.releaseAndEmit({ taskId, requeue: true, rollbackAttempt: true, reason: held[0] });
        ctx.hold.markPlanWait(queued, held[0]!);
        return;
      }
      await closeFanOut(taskId, n);
    } catch (err) {
      log(`fan-out fallito per il task ${taskId}`, err);
      const pending = ctx.hold.pendingProviderReason(err);
      if (pending) {
        ctx.hold.deferPendingProvider(taskId, pending);
        return;
      }
      if (err instanceof Error && 'code' in err
        && err.code === 'task_model_unavailable') {
        ctx.queue.releaseAndEmit({ taskId, requeue: false, rollbackAttempt: true, parkState: CHIP_BLOCKED, reason: err.message });
        return;
      }
      try {
        const failTask = deps.svc.get(taskId)?.task;
        const cap = failTask ? attemptCap(failTask) : DEFAULT_RETRY_CAP;
        const exhausted = (failTask?.dispatchAttempts ?? cap) >= cap;
        ctx.queue.releaseAndEmit({
          taskId,
          requeue: !exhausted,
          parkState: CHIP_FAILED,
          reason: exhausted
            ? "Avvio del fan-out fallito ripetutamente. Parcheggiato in backlog."
            : "Avvio del fan-out fallito, task rimesso in coda.",
        });
      } catch { /* best-effort */ }
      await reapAttempts(taskId, { keepSelected: false });
    } finally {
      shared.reservedSlots = Math.max(0, shared.reservedSlots - (n - 1));
      ctx.runs.endRun(taskId, runId);
    }
  }

  /**
   * Butta il worktree di un tentativo.
   *
   * `preserveWork` è per i percorsi in cui il tentativo è stato SCARTATO senza
   * che nessuno abbia deciso di scartarne il contenuto — rimesso in coda,
   * parcheggiato, avvio fallito. Lì il codice presumeva che non ci fosse niente
   * da perdere; è vero quasi sempre e falso proprio quando fa danno, perché
   * `deleteWorktree` cancella anche il BRANCH (worktree-manager: `mode ===
   * "branch"` ⇒ `git branch -D`). Un agente che aveva committato e poi ha visto
   * il turno troncato dall'infrastruttura perdeva i commit.
   *
   * Con `preserveWork`, un worktree che contiene lavoro NON si tocca affatto:
   * non si prova a salvarne una parte, si lascia in piedi e decide la GC, che
   * ha il contratto completo (`decideWorktreeReap`) e sa tenere, landare o
   * abbandonare. È già quello che il commento sul percorso zombie diceva di
   * fare: «An abandoned worktree, if the recovery ends up parking the task, is
   * the worktree GC's job».
   *
   * SENZA `preserveWork` il comportamento è invariato, e deve restarlo: il reap
   * dei tentativi fan-out perdenti scarta il contenuto DI PROPOSITO — lì l'umano
   * ha scelto un altro tentativo, e tenerne i rami sarebbe una perdita di
   * spazio, non una tutela.
   */
  async function cleanupWorktree(
    worktreeId: string,
    opts: { preserveWork?: boolean } = {},
  ): Promise<void> {
    if (!deps.deleteWorktree) return;
    if (opts.preserveWork && deps.worktreeHasWork) {
      let hasWork = false;
      try { hasWork = await deps.worktreeHasWork(worktreeId); }
      catch { hasWork = true; } // non saperlo non autorizza a distruggere
      if (hasWork) {
        log(`worktree ${worktreeId} NON ripulito: contiene lavoro non su main — lasciato alla GC`);
        return;
      }
    }
    try { await deps.deleteWorktree(worktreeId); }
    catch (err) { log(`worktree cleanup failed for ${worktreeId}`, err); }
  }
  return { cleanupWorktree, launchFanOut, recoverOrphanedFanOut };
}
