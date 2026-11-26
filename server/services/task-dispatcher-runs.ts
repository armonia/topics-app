/**
 * task-dispatcher-runs.ts: the life of one run slot.
 * 
 * Begin, bind, own and end a run, the slot/retry/command waits that hang off it,
 * the drain switch, the remote node lane and the human-hold subscription.
 */
import { type Task } from "./tasks";
import { onHumanHoldChange } from "../lib/human-hold-events";
import { setHeldResumeBlock } from "./dispatch-block-signal";
import { createRemoteNodeLane } from "./task-dispatcher-remote-node";
import { BACKGROUND_WORK_CAP_MS } from "../providers/claude/background-work";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createRunTracking(ctx: DispatcherCtx) {
  const { clock, commandWaits, delegatedPolicy, deps, heldOffNoted, heldWritten, inFlight, log, retryWaits, slotWaits, waitingForSlot, shared } = ctx.core;

  /**
   * THE REMOTE LANE, whole, in `task-dispatcher-remote-node.ts`. What stays
   * here are its five seams: launch, liveness sweep, burial, poll, and the
   * requeue after a restart.
   */
  const remote: ReturnType<typeof createRemoteNodeLane> = createRemoteNodeLane({
    client: deps.node, svc: deps.svc, broadcast: deps.broadcast, captureDelivery: deps.captureDelivery, measureDelivery: deps.measureDelivery, saveNodeMedia: deps.saveNodeMedia,
    log, emit: (...args) => ctx.queue.emit(...args), inFlight, beginRun, endRun, ownsRun, bindRunSession, releaseAndEmit: (...args) => ctx.queue.releaseAndEmit(...args), deferWait: (...args) => ctx.events.deferWait(...args),
    delegatedPolicyForTask: deps.delegatedPolicyForTask,
    recordDelegatedPhase: deps.recordDelegatedPhase,
    languageOf: (...args) => ctx.kickoff.langFor(...args),
  });
  function drainBlock(): string | null {
    return shared.draining
      ? `Riavvio del server in arrivo (${shared.draining}): nessun turno nuovo parte finché non è ripartito. Questa card riprende da sola dopo, sulla stessa sessione. Niente è andato perso.`
      : null;
  }

  /** What will wake the session on its own: a command, a sub-agent, or nothing. */
  function wakeOwedBy(sessionKey: string): "command" | "subagent" | null {
    try { if (deps.awaitsCommandWake?.(sessionKey) === true) return "command"; } catch { /* not owed */ }
    try { if (deps.awaitsSubagentWake?.(sessionKey) === true) return "subagent"; } catch { /* not owed */ }
    return null;
  }
  function commandWakeOwed(sessionKey: string): boolean {
    return wakeOwedBy(sessionKey) !== null;
  }

  /**
   * The card's session is owed a command's wake: the card waits for it. True
   * when it does. `sinceLastRow`: no turn end of ours started this wait (a
   * restart, a turn that ended without us), so its silence began at the
   * session's last row, not now.
   */
  function awaitCommandWake(task: Task, sinceLastRow = false): boolean {
    // A delegated run answers to its own deadline and its single attempt.
    if (!task.assignedTopicId || delegatedPolicy(task) !== undefined) return false;
    const sessionKey = "topic:" + task.assignedTopicId.slice(0, 8);
    if (!commandWakeOwed(sessionKey)) return false;
    if (!commandWaits.has(task.id)) {
      let since = clock();
      if (sinceLastRow) {
        try { since = Math.min(since, deps.lastSessionRowAt?.(sessionKey) ?? since); } catch { /* from now */ }
      }
      commandWaits.set(task.id, { sessionKey, since });
      // The wake's turn is booked from here when the wait ends: after a
      // restart the ledger is empty, and a row born at the end counts it as 0.
      ctx.usage.anchorUsage(task.id, sessionKey, task.model ?? null);
    }
    return true;
  }

  /**
   * The waits that are over, because the wake's turn came and went, the
   * command was stopped, the card left the column, or the session stayed quiet
   * past the cap: the card goes on as after any turn (`onTurnEnd`). A turn in
   * flight on the session, the wake's or a person's, holds the wait and its
   * end restarts the clock.
   */
  function pollCommandWaits(): void {
    for (const [taskId, w] of [...commandWaits]) {
      let busy = false;
      try { busy = deps.isSessionBusy?.(w.sessionKey) === true; } catch { busy = false; }
      if (busy) { w.since = clock(); continue; }
      let t: Task | undefined;
      try { t = deps.svc.get(taskId)?.task; } catch { continue; }
      if (t?.status === "in_progress" && commandWakeOwed(w.sessionKey) && clock() - w.since < BACKGROUND_WORK_CAP_MS) continue;
      commandWaits.delete(taskId);
      if (t?.status !== "in_progress" && t?.status !== "review") continue;
      // The wake's turn was not ours, so no turn end of ours booked its
      // tokens; when the card delivered from it, none ever would.
      ctx.usage.bookUsageFloor(taskId, w.sessionKey);
      ctx.turnEnd.onTurnEnd(taskId, undefined, { end: "end_turn" }, true);
    }
  }

  /** Il ritentativo non serve piu' (o sta partendo): via il timer e la voce. */
  function clearRetryWait(taskId: string): void {
    const t = retryWaits.get(taskId);
    if (t) { clearTimeout(t); retryWaits.delete(taskId); }
  }

  /**
   * L'attesa non ha più senso: via il timer, via la memoria del suo commento.
   *
   * Il messaggio che teneva in mano NON muore col timer: `inherit` lo passa al
   * turno che sta partendo (lo consegna `onTurnEnd`, come per i messaggi
   * arrivati a turno vivo). Senza, un secondo resume che trova il posto libero
   * spegnerebbe l'attesa e con essa la risposta dell'umano che l'aveva aperta.
   * Quando invece il task è uscito da `in_progress` non c'è nessun turno a cui
   * darlo, ed è la stessa fine che faceva prima.
   */
  function clearSlotWait(taskId: string, inherit: boolean): void {
    setHeldResumeBlock(taskId, null);
    const wait = slotWaits.get(taskId);
    if (wait) {
      clearTimeout(wait.timer);
      slotWaits.delete(taskId);
      if (inherit && wait.message.trim()) ctx.queue.bufferResume(taskId, wait.message, wait.commentIds);
    }
    waitingForSlot.delete(taskId);
    heldWritten.delete(taskId);
  }

  /** Claim the slot for a new run. Returns its id — the owner's proof. */
  function beginRun(taskId: string, sessionKey: string): number {
    heldOffNoted.delete(taskId);
    const runId = shared.nextRunId++;
    // Un turno che PARTE rende senza senso il ritentativo che lo aspettava: se
    // restasse in `retryWaits` bloccherebbe il recupero orfani fino allo scadere
    // del timer, e piu' tardi farebbe partire un secondo resume su un turno
    // vivo. L'invariante e' «una voce nel registro se e solo se c'e' un timer
    // che serve ancora», la stessa di `slotWaits`.
    clearRetryWait(taskId);
    commandWaits.delete(taskId);
    inFlight.set(taskId, { runId, sessionKey, sessionAt: Date.now(), deadSweeps: 0 });
    return runId;
  }
  /** Setup finished: the run now has a real session to probe. */
  function bindRunSession(taskId: string, runId: number, sessionKey: string): void {
    const slot = inFlight.get(taskId);
    if (!slot || slot.runId !== runId) return;
    slot.sessionKey = sessionKey;
    slot.sessionAt = Date.now();
    slot.deadSweeps = 0;
  }
  /** True while this run is still the task's owner (not buried, not superseded). */
  function ownsRun(taskId: string, runId: number): boolean {
    return inFlight.get(taskId)?.runId === runId;
  }
  /** Release the slot — but only if it's still ours (a zombie never evicts a live run). */
  function endRun(taskId: string, runId: number): void {
    if (!ownsRun(taskId, runId)) return;
    inFlight.delete(taskId);
    ctx.admission.cardWeights.finish(taskId);
    if (shared.memorySeatTaskId === taskId) shared.memorySeatTaskId = null;
    ctx.queue.manualMemoryStart.clearAdmittedWhenIdle(taskId);
    ctx.admission.clearNoCheckReservation(taskId);
    ctx.queue.notifyMemoryQueue();
  }

  /**
   * «Questo task aspetta te» ANCHE a metà turno.
   *
   * Il chip `needs_input` esisteva solo a fine turno, quando l'ultima parola
   * dell'agente è un blocco ```question. Ma un agente ha un secondo modo di
   * chiedere — `ask_user_question`, o una richiesta di permesso, aperti MENTRE
   * il turno è vivo — e lì la card restava `working`: la board diceva «sto
   * lavorando» sopra una sessione dove non lavorava nessuno, e l'unico modo di
   * accorgersene era aprire il tab per caso. È il difetto più caro che questa
   * campagna ha trovato, perché non urla: parcheggia in silenzio.
   *
   * Qui la board impara l'attesa dalla porta unica (`human-hold-events`), senza
   * pollare e senza che i bridge sappiano cos'è un task. Nessun vocabolario
   * nuovo: `needs_input` significa già «serve te», e sommato allo stato
   * `in_progress` si legge «in corso, ma aspetta te» — che è esattamente il
   * fatto.
   */
  function taskWaitingOnSession(sessionKey: string): string | null {
    for (const [taskId, slot] of inFlight) if (slot.sessionKey === sessionKey) return taskId;
    return null;
  }

  /**
   * L'attesa è TRANSITORIA, e non si scrive in `dispatch_state`.
   *
   * La prima versione la persisteva (`setDispatchState(needs_input)`), e quella
   * riga ha introdotto un guasto peggiore di quello che curava: la porta del
   * recupero orfani è `ACTIVE_DISPATCH_STATES` (qui sopra: solo `working` e
   * `starting`), perché un chip `needs_input` significava «l'ha messa qui una
   * persona, non toccarla». Un task fermo su una domanda a metà turno usciva
   * quindi da quella porta: server riavviato — e con `TOPICS_SERVER_WATCH=1`
   * basta salvare un file sotto `server/` — e restava `in_progress` +
   * `needs_input` PER SEMPRE, senza reattach, senza resume, senza un commento
   * che lo dicesse. Prima della modifica quel task veniva ripreso. Misurato con
   * l'harness dei test veri: chip `working` → 1 turno rilanciato; chip
   * `needs_input` → 0 turni, e ancora 0 dopo tre reconcile.
   *
   * La causa vera è una collisione di vocabolario: `needs_input` era già
   * «parcheggiata da un umano». Quindi l'attesa a metà turno prende la strada
   * che questo file usa già per i fatti che vivono quanto il processo —
   * `task:usage-live` (qui sotto): un evento, non una colonna. È anche più
   * corretto nel merito: dopo un riavvio le mappe di `ask-user-bridge` e
   * `permission-bridge` sono vuote, cioè l'attesa NON esiste più, e un chip
   * persistito starebbe mentendo.
   */
  function broadcastAwaitingHuman(taskId: string, projectId: string, waiting: boolean, source: "ask" | "permission"): void {
    try {
      deps.broadcast({ type: "task:awaiting-human", projectId, taskId, waiting, source });
    } catch { /* best-effort */ }
  }
  const unsubscribeHumanHold: ReturnType<typeof onHumanHoldChange> = onHumanHoldChange(({ sessionKey, phase, source }) => {
    const taskId = taskWaitingOnSession(sessionKey);
    if (!taskId) return; // una chat qualunque: non è roba della board
    try {
      const task = deps.svc.get(taskId)?.task;
      // Solo mentre il turno è davvero in volo: a consegna fatta il chip lo
      // decide `onTurnEnd`, e un'attesa annunciata dopo sarebbe rumore.
      if (!task || task.status !== "in_progress") return;
      broadcastAwaitingHuman(taskId, task.projectId, phase === "held", source);
    } catch { /* best-effort: un annuncio mancato non deve uccidere un pannello */ }
  });
  return { awaitCommandWake, beginRun, bindRunSession, clearRetryWait, clearSlotWait, drainBlock, endRun, ownsRun, pollCommandWaits, remote, taskWaitingOnSession, unsubscribeHumanHold, wakeOwedBy };
}
