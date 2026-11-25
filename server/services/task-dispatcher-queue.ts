/**
 * task-dispatcher-queue.ts: what the board shows about the dispatch queue.
 * 
 * The memory queue snapshot and publisher, the manual memory start, the held
 * notes (heavy, cap), the weight absorption and the single release-and-emit path.
 */
import { type Task, type TaskService } from "./tasks";
import { readTaskWeight } from "../../shared/board";
import { DISPATCH_MEM_FLOOR_GB, DISPATCH_MEM_FLOOR_NATIVE_GB } from "./dispatch-capacity";
import { isNodeSessionKey } from "./task-dispatcher-remote-node";
import { createDispatchMemoryQueuePublisher, createDispatchMemoryQueueSnapshot } from "./dispatch-memory-queue";
import { createDispatchMemoryStartController } from "./dispatch-memory-start";
import { providerHoldKey, type DispatchWork } from "../../shared/provider-hold";
import { WAITING_MEMORY, HEAVY_MAX_LOAD_PER_CORE, HEAVY_MAX_OWN_LOAD_PER_CORE, rotateFrom, CHIP_QUEUED, parkedEdgeEvent } from "./task-dispatcher-support";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createQueueSignals(ctx: DispatcherCtx) {
  const { capHeldNoted, clock, deps, evaluateNight, graceTimers, heavyHeldNoted, inFlight, log, pendingResume, shared } = ctx.core;

  /** Queue a message for the turn boundary, keeping the order it was written in. */
  function bufferResume(taskId: string, text: string, commentIds?: string[]): void {
    const ids = (commentIds ?? []).filter((id) => typeof id === "string" && id.length > 0);
    pendingResume.set(taskId, [...(pendingResume.get(taskId) ?? []), { text, at: clock(), commentIds: ids }]);
  }
  /** The card comments a queued batch delivers, in the order they were written. */
  function queuedCommentIds(queued: { commentIds: string[] }[]): string[] {
    return queued.flatMap((q) => q.commentIds);
  }

  /**
   * THE CARDS A PROVIDER'S WALL KEEPS IN TODO RIGHT NOW, and the cards each
   * runtime has at work, for the board's «Frenato» chip (HUBBR-20).
   *
   * A wall alone is not a held card: a card on Automatic starts on another
   * runtime when one is free (`automaticModelAvailable`), so the chip that read
   * only the wall said «Claude's cards wait» while they started. This asks
   * `taskPlanWait` itself, card by card, behind the same gates the tick puts
   * before it (the board's switch, the night, attempts, deferral, blockers).
   */
  function dispatchWork(): DispatchWork {
    const held: DispatchWork["held"] = [];
    // The 24h spend cap stops every card past the gates, whatever its provider.
    const stop = ctx.admission.spendBrake.dayStop();
    const spendHeld: string[] = [];
    const nowIso = new Date(clock()).toISOString();
    let todos: Task[] = [];
    try { todos = deps.svc.list({ scope: "all", status: "todo", rootsOnly: true }); } catch { /* no rows: nothing held */ }
    const boards = new Map<string, ReturnType<typeof deps.svc.getBoardSettings> | null>();
    for (const t of todos) {
      try {
        if (!boards.has(t.projectId)) boards.set(t.projectId, deps.svc.getBoardSettings(t.projectId));
        const settings = boards.get(t.projectId);
        if (!settings || !settings.autoDispatch || settings.dispatchPaused || shared.draining) continue;
        if (settings.nightMode) {
          const action = evaluateNight(settings).decision.action;
          if (action === "wait" || action === "expire") continue;
        }
        if (t.assignedTopicId || t.dispatchAttempts >= settings.dispatchRetryCap) continue;
        if (t.dispatchDeferredUntil && t.dispatchDeferredUntil > nowIso) continue;
        if (deps.svc.isDispatchBlocked(t.id)) continue;
        if (stop) spendHeld.push(t.id);
        // Quiet: a read for the chip, not the tick, so it neither logs the wait nor marks it announced.
        const wait = ctx.hold.taskPlanWait(t, t.model ?? (settings.dispatchModel !== "auto" ? settings.dispatchModel : undefined), true, true);
        if (wait) held.push({ taskId: t.id, projectId: t.projectId, provider: wait.provider });
      } catch { boards.set(t.projectId, null); }
    }
    const working: Record<string, number> = {};
    for (const taskId of inFlight.keys()) {
      try {
        const topicId = deps.svc.get(taskId)?.task.assignedTopicId;
        const runtime = topicId ? deps.topicModelSelection?.(topicId)?.provider : null;
        const key = runtime ? providerHoldKey(runtime) ?? runtime : "claude";
        working[key] = (working[key] ?? 0) + 1;
      } catch { /* the card moved: it is no longer at work here */ }
    }
    return { held, working, spend: stop && spendHeld.length > 0 ? { ...stop, taskIds: spendHeld } : null };
  }

  const memoryQueueSnapshot: ReturnType<typeof createDispatchMemoryQueueSnapshot> = createDispatchMemoryQueueSnapshot({
    svc: deps.svc,
    activeTaskIds: () => [...inFlight.entries()]
      .filter(([, slot]) => !slot.node && !isNodeSessionKey(slot.sessionKey))
      .map(([taskId]) => taskId),
    canWait: (task) => {
      if (task.dispatchError !== WAITING_MEMORY || task.dispatchState !== CHIP_QUEUED) return false;
      try {
        const settings = deps.svc.getBoardSettings(task.projectId);
        if (!settings.autoDispatch || settings.dispatchPaused || shared.draining) return false;
        if (settings.nightMode) {
          const action = evaluateNight(settings).decision.action;
          if (action === "wait" || action === "expire") return false;
        }
        if (task.assignedTopicId || task.dispatchAttempts >= settings.dispatchRetryCap) return false;
        if (task.dispatchDeferredUntil && task.dispatchDeferredUntil > new Date().toISOString()) return false;
        if (deps.svc.isDispatchBlocked(task.id)) return false;
        return !ctx.hold.taskPlanWait(task, task.model ?? (settings.dispatchModel !== "auto" ? settings.dispatchModel : undefined), true, true);
      } catch { return false; }
    },
    boardOrder: (projectIds) => {
      try {
        const dispatchBoards = deps.svc.boardsWithQueuedTodos();
        return dispatchBoards.length ? rotateFrom(dispatchBoards, shared.boardCursor) : projectIds;
      } catch { return projectIds; }
    },
    memoryReading: deps.memoryReading,
    heldMemory: deps.heldMemory,
    memoryHistory: deps.memoryHistory,
    memoryConsumers: deps.memoryConsumers,
    costGB: (task) => ctx.admission.cardPrices.priceFor(task?.projectId, task?.dispatchWeight),
    startGB: () => {
      try {
        const current = ctx.admission.floorVerdict(false).startGB;
        if (Number.isFinite(current)) return current!;
      } catch { /* The last successful threshold remains usable. */ }
      if (shared.lastMemoryStartGB != null) return shared.lastMemoryStartGB;
      return deps.isCliRuntime?.() ? DISPATCH_MEM_FLOOR_GB : DISPATCH_MEM_FLOOR_NATIVE_GB;
    },
  });
  const memoryQueuePublisher = createDispatchMemoryQueuePublisher({
    snapshot: memoryQueueSnapshot,
    getTask: (taskId) => deps.svc.get(taskId)?.task,
    broadcast: (task) => deps.broadcast({ type: "task:updated", projectId: task.projectId, task }),
  });
  function emit(task: Task): void { memoryQueuePublisher.emit(task); }
  function notifyMemoryQueue(): void { memoryQueuePublisher.notify(); }
  const manualMemoryStart: ReturnType<typeof createDispatchMemoryStartController> = createDispatchMemoryStartController({
    getTask: (projectId, taskId) => deps.svc.get(taskId, { projectId })?.task,
    isInFlight: (taskId) => inFlight.has(taskId),
    isRemoteTask: (...args) => ctx.overflow.isRemoteTask(...args),
    isMemoryWaiter: (task) => task.status === "todo"
      && task.dispatchState === CHIP_QUEUED && task.dispatchError === WAITING_MEMORY,
    localMemorySeatTaken: (...args) => ctx.admission.localMemorySeatTaken(...args),
    checksRunning: () => { try { return deps.checksRunning?.() ?? 0; } catch { return 0; } },
    dispatch: (projectId) => ctx.tick.tick(projectId),
    notifyQueue: notifyMemoryQueue,
  });

  /**
   * C'è margine per un task PESANTE adesso?
   *
   * La misura BUONA è il carico nostro (`deps.ownLoad`): quanti core stanno
   * bruciando i processi della nostra flotta. Il load average della macchina è
   * il RIPIEGO, e solo perché un host senza la sonda della flotta non deve
   * restare senza guardia. Non sono due letture della stessa cosa: la notte del
   * 12/08 il load stava fra 37 e 48 mentre i nostri agenti usavano 0,75% su
   * 1200% di CPU. Il carico erano ActivityWatch, il browser, la chat e un
   * player video, e il freno lo ha addebitato a noi tenendo ferma la board.
   *
   * `null` non è «no»: è «non lo so». Senza nessuna delle due sonde il gate non
   * si applica affatto — un host che non sa misurare non deve poter fermare la
   * coda per sempre, che è il modo in cui una guardia diventa una trappola.
   */
  function heavyLoadGate(): { ok: boolean; load1: number; cores: number; own: boolean } | null {
    // Prima la misura nostra. Un errore qui non è «via libera»: si scende al
    // ripiego, perché spegnere il freno per una sonda caduta rimetterebbe i
    // pesanti accanto agli altri proprio senza sapere cosa c'è sulla macchina.
    if (deps.ownLoad) {
      try {
        const own = deps.ownLoad();
        if (own) {
          const c = Math.max(1, own.cores);
          return {
            ok: own.coreUnits < c * HEAVY_MAX_OWN_LOAD_PER_CORE,
            load1: own.coreUnits,
            cores: c,
            own: true,
          };
        }
      } catch (err) {
        log("sonda della flotta caduta: il gate del peso ripiega sul load di sistema", err);
      }
    }
    if (!deps.capacity) return null;
    try {
      const { load1, cores } = deps.capacity();
      const c = Math.max(1, cores);
      return { ok: load1 < c * HEAVY_MAX_LOAD_PER_CORE, load1, cores: c, own: false };
    } catch (err) {
      log("sonda del carico caduta: il gate del peso resta aperto", err);
      return null;
    }
  }

  /**
   * «Aspetti per via del peso», detto una volta per episodio: chip `queued` +
   * una riga nel thread. Stessa disciplina della guardia sulle sessioni esterne
   * — la nota si ripete solo dopo che l'attesa è finita davvero, altrimenti un
   * poll ogni 10s riempirebbe il thread della stessa frase.
   */
  function noteHold(noted: Set<string>, task: Task, why: string, slot?: string): void {
    if (inFlight.has(task.id) || graceTimers.has(task.id)) return;
    if (noted.has(task.id)) return;
    noted.add(task.id);
    try {
      emit(deps.svc.setDispatchState({ taskId: task.id, state: CHIP_QUEUED }));
      // ONE SLOT, not a pile. "In coda: N agent su un tetto di M" is the STATE
      // of the queue, and it changes at every boot and every cap move: 363
      // such notes in twelve hours on 2026-09-04, four on one card, the old
      // ones contradicting the new. The card keeps the current one only.
      //
      // THE SET IS NOT THE GUARD ACROSS PROCESSES: it lives in this closure, so
      // it is born empty at every boot, and on this machine a boot is 35 minutes
      // away from the last one while the `addComment` dedupe window is 10
      // seconds. A caller whose wait outlives a restart (the provider wall of
      // days) passes its own `slot`, and gets both defences: `once` for the
      // identical text, the slot for the same note reworded by another day.
      deps.svc.addComment({
        taskId: task.id, author: "system", content: why, kind: "service",
        replaces: slot ?? (why.startsWith("In coda:") ? "In coda:" : undefined),
        once: slot ? true : undefined,
      });
    } catch { /* il task può essersi mosso sotto i piedi */ }
  }

  function noteHeavyHold(task: Task, why: string): void {
    noteHold(heavyHeldNoted, task, why);
  }

  /**
   * «Aspetti perché non c'è un posto libero», con i numeri che lo rendono
   * verificabile. Il `break` sul tetto pieno fermava la coda in silenzio: la
   * card restava `queued` e l'unico modo di sapere da cosa era leggere il sort
   * del dispatcher. Il tetto e quanti agenti sono in volo dicono se il freno è
   * la macchina o l'impostazione; quante card sono ferme dice quanto è lunga
   * la fila dietro quella decisione.
   */
  function noteCapHold(task: Task, why: string): void {
    noteHold(capHeldNoted, task, why);
  }

  /**
   * Il peso appena letto dal classificatore, applicato al task — e la decisione
   * che ne segue: si può proseguire, o questo lancio non doveva avvenire?
   *
   * Il classificatore parla al LANCIO; il gate del peso vive nel claim, che è
   * già passato. Alla primissima corsa di un task, quindi, il claim ha deciso
   * senza sapere: se scopre adesso di avere in mano un task pesante, l'unica cosa
   * onesta è rimetterlo in coda e lasciare che sia il claim a decidere, stavolta
   * col peso in mano — far partire l'agente comunque significherebbe metterlo
   * accanto agli altri, che è precisamente ciò che il peso esiste per impedire.
   *
   * Il tentativo si RIMBORSA (`rollbackAttempt`): non è un fallimento, non ha
   * prodotto niente e non ha nemmeno acceso un agente. Farlo pesare sul budget
   * dei ritentativi vorrebbe dire che un task pesante arriva al parcheggio dopo
   * due scoperte invece che dopo due fallimenti veri.
   *
   * Torna `true` se il lancio deve fermarsi. Il rientro in coda avviene UNA
   * volta sola per scoperta: la seconda volta il peso è già sul task, quindi
   * `wasHeavy` è vero e si prosegue — non c'è modo di girare in tondo.
   */
  function absorbWeight(task: Task, weight: string | null | undefined): boolean {
    const read = readTaskWeight(weight);
    const wasHeavy = task.dispatchWeight === "heavy";
    if (read !== task.dispatchWeight) {
      // Best-effort: il promemoria serve al PROSSIMO claim, e non riuscire a
      // scriverlo non è una ragione per non far partire questo turno.
      try { deps.svc.setDispatchWeight({ taskId: task.id, weight: read }); }
      catch (err) { log(`peso non salvato per il task ${task.id}`, err); }
    }
    if (read !== "heavy" || wasHeavy) return false;
    log(`task ${task.id}: pesante, scoperto al lancio → torna in coda prima di aprire l'agente`);
    releaseAndEmit({
      taskId: task.id,
      requeue: true,
      rollbackAttempt: true,
      reason:
        "Questo task è PESANTE (compila / gira la suite / macina): lo si è scoperto leggendolo, cioè dopo che era già partito. " +
        "Torna in coda senza consumare un tentativo e riparte da solo appena la macchina è libera. Un task così prende il turno da solo.",
    });
    return true;
  }

  /**
   * Rilascia un task e annuncia il fronte, se ce n'è uno.
   *
   * `release()` scrive stato + commento di sistema, e il dispatcher lo
   * specchiava con il solo `task:updated` — che nessun layer di notifica
   * ascolta (è un refresh di dati: board, contatori, indice topic→task). Il
   * risultato era un'asimmetria strutturale: il fronte terminale di SUCCESSO
   * (`task:review-ready`) alza banner e web-push da mesi, quello di FALLIMENTO
   * non esisteva. Un task parcheggiato moriva in silenzio, visibile solo a chi
   * per caso guardava la board.
   *
   * La decisione sta in `parkedEdgeEvent`, in un punto solo e non nei nove siti
   * che rilasciano.
   */
  /**
   * `announce: false` parcheggia il task e aggiorna la board (il chip compare
   * su OGNI task, che è la verità), ma non emette il fronte `task:parked` —
   * cioè non fa scattare la push. Serve quando una causa SOLA parcheggia N
   * task in un colpo: la deduplica delle push è per-task (`task-park-<id>`),
   * quindi senza questo una board che non mappa a una directory produceva N
   * notifiche identiche, una per task in coda. L'annuncio lo fa il primo.
   */
  function releaseAndEmit(
    args: Parameters<TaskService["release"]>[0],
    opts?: { announce?: boolean },
  ): Task {
    if (!inFlight.has(args.taskId)) {
      if (shared.memorySeatTaskId === args.taskId) shared.memorySeatTaskId = null;
      manualMemoryStart.clearAdmittedWhenIdle(args.taskId);
      ctx.admission.clearNoCheckReservation(args.taskId);
    }
    // Il topic dell'agente si RITIRA insieme al task, qualunque sia l'esito.
    //
    // `release()` slega il task dal topic — ma il topic resta «aperto» per
    // sempre: nessun umano lo chiuderà mai come tab (non è una sua tab) e il
    // dispatcher pota solo i tentativi di un fan-out, non questo. È così che il
    // topic di un agente parcheggiato a metà luglio è rimasto in giro fino ad
    // agosto, contato fra le conversazioni vive.
    //
    // Si legge PRIMA della release: dopo, il legame non c'è più e non si
    // saprebbe più quale topic ritirare.
    const before = deps.svc.get(args.taskId)?.task;
    const boundTopicId = before?.assignedTopicId ?? null;
    const wasDone = before?.status === "done";
    const task = deps.svc.release(args);
    // Il registro dei token vale finché il task è in mano al dispatcher: al
    // rilascio le sue sessioni sono chiuse, e la base del prossimo giro va
    // riletta dalla tabella (che nel frattempo le contiene tutte).
    ctx.usage.forgetUsage(args.taskId);
    if (boundTopicId) {
      // Best-effort: un topic che non si archivia non deve impedire il rilascio
      // del task — il task è la cosa che qualcun altro sta aspettando.
      try { deps.archiveTopic?.(boundTopicId); }
      catch (err) { log(`archivio del topic ${boundTopicId} fallito al rilascio`, err); }
    }
    emit(task);
    // A release that found the card done changed nothing about its column:
    // no parked edge, so no push for a card that is finished.
    const parked = opts?.announce === false || wasDone ? null : parkedEdgeEvent(task, args);
    if (parked) {
      try { deps.broadcast(parked); } catch { /* best-effort */ }
    }
    return task;
  }

  function clearGrace(taskId: string): void {
    const t = graceTimers.get(taskId);
    if (t) { clearTimeout(t); graceTimers.delete(taskId); }
  }
  return { absorbWeight, bufferResume, clearGrace, dispatchWork, emit, heavyLoadGate, manualMemoryStart, memoryQueueSnapshot, noteCapHold, noteHeavyHold, noteHold, notifyMemoryQueue, queuedCommentIds, releaseAndEmit };
}
