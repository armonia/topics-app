/**
 * task-dispatcher-admission.ts: may a new agent start on this machine right now?
 * 
 * The memory floor, the machine budget, the global cap, the pressure axes and the
 * no-check reservations, plus the previews of the same verdicts that the board
 * reads. One verdict function per question so the tick, the resume path and the
 * UI cannot disagree.
 */
import { activeFrozenCount } from "./budget-governor";
import { type Task } from "./tasks";
import { ADMISSION_SPACING_MS, admissionVerdict, budgetShare, capMode, estimatedAgentCost, machineBudget, reservedCost, type AdmissionVerdict, type DispatchAdmission, type GlobalDispatchCap, type MachineBudgetSample } from "../../shared/board";
import { NATIVE_CHILD_FLOOR_GB, NATIVE_CHILD_PRICE_GB, effectiveDispatchCap, type ResourceFloorKind, type ResourceFloorVerdict } from "./dispatch-capacity";
import { reservationForRuntime } from "./dispatch-no-check-exemption";
import { createNoCheckReservationManager } from "./dispatch-no-check-reservations";
import { createCardPrices } from "./dispatch-card-price";
import { createCardWeightMeter } from "./dispatch-card-weight";
import { setMemoryWait } from "./dispatch-block-signal";
import { createSpendBrake, taskSpendMessage } from "./task-dispatcher-spend-cap";
import { isNodeSessionKey } from "./task-dispatcher-remote-node";
import { buildDispatchAdmissionPreview } from "./dispatch-admission-preview";
import { machineBudgetMessage, memoryClause } from "./dispatch-budget-message";
import type { DispatcherCtx, RunSlot } from "./task-dispatcher-context";

export function createAdmission(ctx: DispatcherCtx) {
  const { deps, inFlight, log, noCheckExemptions, spendHeldNoted, shared } = ctx.core;

  /**
   * Il tetto di concorrenza EFFETTIVO, adesso. Era calcolato dentro `tick()`,
   * quindi valeva solo per i dispatch: il `resume` non lo guardava, e ogni
   * rifiuto in review faceva ripartire un agente FUORI dal tetto. Misurato il
   * 09/08: 12 task in corso con il tetto a 6, e metà erano miei rifiuti.
   *
   * Un budget solo per macchina (scope 'global'), così N board non si
   * moltiplicano in N×tetto. È il numero REATTIVO al carico («quanti agenti
   * nuovi ammetto adesso»): la quota di core dello spawn passa dalla stessa
   * `effectiveDispatchCap` ma con il tetto STRUTTURALE, perché la sua domanda è
   * un'altra e usare un freno vivo come divisore lo invertirebbe
   * (`dispatch-capacity.ts`).
   */
  function currentCap(): number {
    let gcap: GlobalDispatchCap = { auto: true, max: 3 };
    try { gcap = deps.svc.getGlobalCap(); } catch { /* defaults */ }
    // In "by resources" mode the NUMBER does not apply. It is the alternative
    // brake, not a second one on top: the person chose "stop when the machine
    // is under pressure" precisely because a fixed count was the wrong
    // question on their machine, and keeping the count too would make the
    // mode a stricter version of what they turned off. The pressure gate
    // (`pressureBlock`) and the hard floor (`admissionBlock`) still hold.
    if (capMode(gcap) === "resources") return Infinity;
    return effectiveDispatchCap(gcap, deps.recommendedCap ? deps.recommendedCap() : null);
  }
  /** Is the '*' row in "by resources" mode right now. Fail closed to `count`:
   *  an unreadable row must not switch the ramp below off. */
  function inResourcesMode(): boolean {
    try { return capMode(deps.svc.getGlobalCap()) === "resources"; } catch { return false; }
  }
  function rampHeld(): boolean {
    return Date.now() - shared.lastAdmissionAt < ADMISSION_SPACING_MS;
  }
  /** The claim that USES a derogation says so, with the card; with no launchable card nothing is written. */
  function noteDerogationUsed(taskId: string): void {
    if (shared.floorExemptPending) {
      shared.floorExemptPending = false;
      log(`pavimento memoria ancora sotto la riga, ma nessun lavoro di Topics è in volo: la card ${taskId} passa per deroga, e il pavimento torna pieno appena è partita`);
    }
    if (shared.budgetExemptPending) {
      shared.budgetExemptPending = false;
      log(`budget superato ma nessun agent al lavoro: il primo parte comunque (card ${taskId})`);
    }
  }
  /** What the board's cards weighed once they ran (`dispatch-card-weight.ts`), fed by the host's minute reading. */
  const cardWeights: ReturnType<typeof createCardWeightMeter> = createCardWeightMeter({ now: () => deps.now?.() ?? Date.now(), checkPeakGB: (taskId) => deps.cardCheckPeakGB?.(taskId) ?? null });
  /** What one more card is priced at in memory, per board (`dispatch-card-price.ts`); no board in hand reads the dearer price. */
  const cardPrices: ReturnType<typeof createCardPrices> = createCardPrices({
    measured: (projectId) => cardWeights.measuredGB(projectId),
    peaks: () => deps.agentMemSamples?.() ?? [],
    isCliRuntime: () => deps.isCliRuntime?.() ?? false,
    board: (projectId) => deps.svc.getBoardSettings(projectId),
    taskOf: (taskId) => deps.svc.get(taskId)?.task,
    observedGB: (taskId) => deps.cardLiveTreeGB?.(taskId) ?? null,
  });
  function agentMemPrice(projectId?: string | null): number {
    return cardPrices.priceFor(projectId);
  }
  /** Launch instants of the LOCAL turns in flight whose memory is still ours to
   *  reserve: a run riding on a node holds nothing on this machine (the same
   *  filter `busyCount` applies), and a card parked on the pull request CI is
   *  charged nothing (KANBAN-76). A PRICE LIST, not a census - `localTurns()`
   *  is the census, and the two must not be confused. */
  function localLaunches(): number[] {
    return localLaunchEntries().map(([, slot]) => slot.sessionAt);
  }
  function localLaunchEntries(): [string, RunSlot][] {
    const offLane = (taskId: string) => { try { return deps.checksOffLane?.(taskId) ?? false; } catch { return false; } };
    return [...inFlight.entries()]
      .filter(([taskId, slot]) => !isNodeSessionKey(slot.sessionKey) && !offLane(taskId));
  }
  /** The memory price list excludes exempt turns; their smaller reservation is charged separately. */
  function regularLocalLaunchEntries(cleanupReservations = true): [string, number][] {
    if (cleanupReservations) releaseInvalidNoCheckReservations();
    return localLaunchEntries()
      .filter(([taskId]) => !noCheckExemptions.has(taskId))
      .map(([taskId, slot]) => [taskId, slot.sessionAt]);
  }
  /**
   * HOW MANY LOCAL TURNS ARE ALIVE ON THIS MACHINE - the census, byte-identical
   * to what `busyCount()` answers and to the `running` the budget axis reads in
   * its sample.
   *
   * NOT `localLaunches().length`. That one also subtracts every card whose
   * checks are off-lane, which is every card waiting on GitHub's CI - the
   * NORMAL state of a delivery for about fifteen minutes, since
   * `server/routes/tasks.ts` releases the lane the moment the local checks pass
   * (KANBAN-93). That agent is alive and resident; counting it zero re-arms the
   * memory floor's exemption on every 10 s tick, which is the 10/09 incident
   * again at the speed of a delivery cycle. Measured against this dispatcher
   * with `held2m` at 4.8 GB: one off-lane card plus two todos started 2 cards,
   * count mode with a cap of 5 started 5, resources mode with `held2m` at
   * 5.5 GB and six todos drained the whole queue. The exemption is for a
   * machine with NONE of our work on it - one card, once.
   */
  function localTurns(): number {
    return [...inFlight.values()].filter((slot) => !isNodeSessionKey(slot.sessionKey)).length;
  }
  function floorVerdict(cleanupReservations = true, projectId?: string | null, priceGB?: number, floorGB?: number): ResourceFloorVerdict {
    const price = priceGB ?? agentMemPrice(projectId);
    const launchEntries = regularLocalLaunchEntries(cleanupReservations);
    const launches = launchEntries.map(([, at]) => at);
    const checks = (() => { try { return deps.checksRunning?.() ?? 0; } catch { return 0; } })();
    const resources = inResourcesMode();
    const exemptTaskIds = noCheckExemptions.taskIds();
    const exemptReservedGB = noCheckExemptions.reservationGB();
    const exemptReservedCards = exemptTaskIds.length;
    const reserved = resources ? 0 : cardPrices.reservedMemGB(launchEntries, Date.now()) + exemptReservedGB;
    // TWO QUESTIONS, AND EACH GETS ITS OWN CENSUS WHOLE.
    //
    // `ourWorkRunning` is the SAME "zero" the budget axis counts for
    // `firstAgentExempt`: `sample.running` (= `busyCount()`) plus pre-review
    // check runs. A run riding on a node holds nothing on this machine, and a
    // board behind an 11 GB shard is not a board that never starts - but a card
    // waiting on the pull request CI IS an agent alive on this Mac, so it is
    // counted by `localTurns()` and not by the reservation's `launches`.
    //
    // `spendingHere` is the PRICE LIST, the same `launches` `reservedGB` is
    // computed from, plus the check runs (a shard spends 4-11 GB while it
    // runs). It decides the line, branch and figure alike. Mixing the two - the
    // census for the branch, the price list for the figure - put the line at
    // `floor + cardGB + 0` = 10 GB whenever the only thing in flight was a card
    // parked on GitHub's CI, which is the normal state of a delivery for about
    // fifteen minutes: measured 7.0, 8.0 and 9.9 GB of `held2m` all held with
    // nothing on this Mac to spend them.
    return deps.resourceBlock?.({
      cardGB: price,
      ...(floorGB != null ? { floorGB } : {}),
      reservedGB: reserved,
      reservedCards: resources ? 0 : launches.length + exemptReservedCards,
      spendingHere: launches.length + exemptReservedCards + Math.max(0, checks) > 0,
      ourWorkRunning: (localMemorySeatTaken() ? 1 : 0) + Math.max(0, checks)
        + noCheckExemptions.untrackedCount(new Set(inFlight.keys())) > 0,
    }) ?? { reason: null, kind: null, memoryFirstCardExempt: false };
  }
  function admissionVerdictNow(): ResourceFloorVerdict {
    try {
      const verdict = floorVerdict();
      if (Number.isFinite(verdict.startGB)) shared.lastMemoryStartGB = verdict.startGB!;
      // The numbers the card waiting for memory prints («servono 7 GB, liberi
      // 1,4»): the same line and the same window this verdict was taken on.
      const held = (() => { try { return deps.heldMemory?.() ?? null; } catch { return null; } })();
      setMemoryWait(Number.isFinite(verdict.startGB) && held?.measurable
        ? { needGB: verdict.startGB!, freeGB: held.heldGB }
        : null);
      const reason = verdict.reason;
      // SI DICE UNA VOLTA, e prima non si diceva affatto. Il chip sulla card
      // scrive «in coda» e il commento accanto rimanda «il perché sta nel log
      // del server» — solo che nel log non ci finiva niente: il messaggio
      // composto qui (RAM o disco sotto il pavimento, con i numeri) moriva in
      // un `return`. Una coda ferma senza motivo visibile in nessun posto è
      // indistinguibile da un dispatcher rotto, e ci ho perso mezz'ora a
      // cercare un bug che non c'era.
      //
      // Una volta per EPISODIO, non per tick: il pavimento si rilegge ogni 10
      // secondi e ripetere la stessa riga allagherebbe il log proprio mentre la
      // macchina è in difficoltà. Quando rientra, si dice anche quello — senza,
      // l'ultima riga del log resterebbe un allarme per sempre.
      //
      // Si confronta il TIPO di blocco, non il testo: il messaggio porta dentro
      // i GB liberi, che cambiano a ogni lettura, quindi un confronto per
      // stringa non dedupica niente — provato sul server vero, tre righe
      // identiche nel senso e diverse nei decimali in trenta secondi.
      // The kind is the RESOURCE, and it comes from the verdict instead of the
      // first word of the sentence. One memory episode goes through three
      // sentences (under the floor, reserved for the agents starting, climbing
      // back towards the restart line), and keying on the whole prefix would log
      // a new "coda ferma" at every swing between them, the flood the hysteresis
      // exists to stop. But the first word also merged the 120 s warm-up with
      // the real floor, and the warm-up is guaranteed at every boot: it got
      // there first and this log never printed the floor's sentence either.
      //
      // THE EXEMPTION IS ONE OF THE STATES, not a line printed beside them, and
      // that is what makes this log honest and quiet at the same time.
      //  - Honest: with the derogation the reading is STILL under the line
      //    (4.8 GB against 6), so "le risorse sono rientrate sopra il pavimento"
      //    was false, and it is precisely the line the board's history gets read
      //    on - the 16/09 audit dated "the queue restarted at 23:38" from it.
      //  - Quiet: the state changes, not the call, so the two reads of the same
      //    tick (this one at the top and `midPassFloor` after a start) print one
      //    line between them. They used to print two in forty seconds, because
      //    an exempt read and a blocked read alternated through `null`.
      const state: ResourceFloorKind | "exempt" | null =
        verdict.kind ?? (verdict.memoryFirstCardExempt ? "exempt" : null);
      if (state !== shared.lastAdmissionBlock) {
        // The derogation is not announced here: nothing may be launchable (every
        // card behind a blocker), and the line would describe an admission that
        // never happened. It is written by the claim that uses it (`noteDerogationUsed`).
        shared.floorExemptPending = state === "exempt";
        if (state && state !== "exempt") log(`coda ferma — ${reason}`);
        else if (!state && shared.lastAdmissionBlock) log("coda ripartita: le risorse sono rientrate sopra il pavimento");
        // The same comparison that decides the log line counts the episode:
        // two truths off one transition cannot drift apart. A real block
        // opens it, anything else (the derogation included) closes it.
        const blocking = !!state && state !== "exempt";
        if (blocking && shared.admissionHoldSince === null) {
          shared.admissionHoldSince = Date.now();
          shared.admissionHoldEpisodes += 1;
        } else if (!blocking && shared.admissionHoldSince !== null) {
          shared.admissionHeldMs += Math.max(0, Date.now() - shared.admissionHoldSince);
          shared.admissionHoldSince = null;
        }
      }
      shared.lastAdmissionBlock = state;
      // The floor was really consulted just now: this is the watermark an
      // episode in flight is measured up to.
      shared.admissionLastSeenAt = Date.now();
      return verdict;
    } catch { return { reason: null, kind: null, memoryFirstCardExempt: false }; }
  }
  /**
   * THE ONE VERDICT, computed once for both readers: the tick that admits (and
   * then moves the hysteresis state) and the capacity route that shows it
   * (`admissionPreview`, which must not move it). Same sample, same price list,
   * same reservation for the turns still warming up: the panel cannot say
   * "would start" on numbers the gate did not decide on.
   */
  function budgetVerdict(
    gcap: GlobalDispatchCap,
    noCheckCandidateReservationGB?: number,
    sampleOverride?: MachineBudgetSample | null,
    projectId?: string | null,
  ): {
    verdict: AdmissionVerdict;
    sample: MachineBudgetSample;
    share: number;
    /** Our footprint and its ceiling, from the very sample the verdict read
     *  (reservation included): the two numbers of the footprint clause. */
    mem: { ourMemGB: number; usableMemGB: number };
  } | null {
    const sample = sampleOverride === undefined ? deps.budgetSample?.() ?? null : sampleOverride;
    if (!sample) return null;
    const share = budgetShare(gcap);
    const fullCost = {
      coreUnits: estimatedAgentCost((() => { try { return deps.agentCostSamples?.() ?? []; } catch { return []; } })()),
      memGB: agentMemPrice(projectId),
    };
    const cost = { ...fullCost, memGB: noCheckCandidateReservationGB ?? fullCost.memGB };
    // WHAT WE HAVE ALREADY PROMISED. An agent's cost lands minutes after its
    // launch (it reads the card before it launches a gate), so the turns in
    // flight are counted at their estimate: on the CPU for the warm-up window,
    // on memory for their whole life (`reservedCost` says why). Without this
    // term every tick decides against the calm that the previous tick has
    // already spent, and the queue drains into swap. `sessionAt` is the
    // launch instant, so the ledger is the in-flight map itself.
    const now = Date.now();
    const reservedCpu = reservedCost(localLaunches(), fullCost, now).coreUnits;
    const reservedMemory = cardPrices.reservedMemGB(regularLocalLaunchEntries(), now)
      + noCheckExemptions.reservationGB();
    // The exemption is for a machine with none of OUR work on it, and a
    // pre-review check run is our work: a queue behind an 11 GB shard run is not
    // a queue that never starts (see `firstAgentExempt`).
    const checks = (() => { try { return deps.checksRunning?.() ?? 0; } catch { return 0; } })();
    const gated: MachineBudgetSample = {
      ...sample,
      running: sample.running + Math.max(0, checks) + noCheckExemptions.untrackedCount(new Set(inFlight.keys())),
      ourMemGB: Math.max(0, sample.ourMemGB) + noCheckExemptions.reservationGB(),
      reservedCoreUnits: reservedCpu,
      reservedMemGB: reservedMemory,
    };
    const verdict = admissionVerdict(gated, share, cost, shared.budgetGate);
    // Read off the same function the verdict read, on the same sample: not a
    // second copy of the arithmetic.
    const mem = { ourMemGB: gated.ourMemGB, usableMemGB: machineBudget(gated, share).usableMemGB };
    return { verdict, sample, share, mem };
  }
  function noCheckBudgetDecision(reservationGB: number): { needed: boolean; allowed: boolean } {
    let gcap: GlobalDispatchCap;
    try { gcap = deps.svc.getGlobalCap(); } catch { return { needed: false, allowed: true }; }
    if (capMode(gcap) !== "resources") return { needed: false, allowed: true };
    // Frozen checks restart before any new card: the no-check exemption does not skip that line.
    if (activeFrozenCount() > 0) return { needed: false, allowed: false };
    const sample = deps.budgetSample?.() ?? null;
    const normal = budgetVerdict(gcap, undefined, sample);
    const candidate = budgetVerdict(gcap, reservationGB, sample);
    if (!normal || !candidate) return { needed: false, allowed: true };
    return {
      needed: normal.verdict.blockedBy === "memory" && !normal.verdict.firstAgentExempt,
      allowed: candidate.verdict.admit,
    };
  }
  /**
   * The capacity route uses the same gate order without mutating hysteresis.
   * With a board it prices that board's usual card; a card flagged heavy keeps
   * the full price whatever the board says (`cardWeightOf`).
   */
  function admissionPreview(projectId?: string | null): DispatchAdmission | null {
    return buildDispatchAdmissionPreview({
      drainBlock: ctx.runs.drainBlock,
      frozenCount: activeFrozenCount,
      floorVerdict: () => floorVerdict(true, projectId),
      globalCap: () => deps.svc.getGlobalCap(),
      budgetVerdict: (cap) => budgetVerdict(cap, undefined, undefined, projectId),
      memoryClause,
    });
  }
  /**
   * The same preview for ONE SUB-AGENT: the door that opens children asks it in
   * "by resources" mode, where the number of agents does not apply. A child is
   * an agent and its light commands (`reservationForRuntime`), not the typical
   * card of a board, which carries a worktree and the repo gates. A native child
   * pays its real cost (a message array in the running server, with a floor of
   * its own); a CLI child is a process and keeps the CLI price and floor.
   */
  function childAdmissionPreview(): DispatchAdmission | null {
    const cli = deps.isCliRuntime?.() ?? false;
    const price = cli ? reservationForRuntime(true) : NATIVE_CHILD_PRICE_GB;
    const floorGB = cli ? undefined : NATIVE_CHILD_FLOOR_GB;
    return buildDispatchAdmissionPreview({
      frozenCount: activeFrozenCount,
      drainBlock: ctx.runs.drainBlock,
      floorVerdict: () => floorVerdict(false, undefined, price, floorGB),
      globalCap: () => deps.svc.getGlobalCap(),
      budgetVerdict: (cap) => budgetVerdict(cap, price),
      memoryClause,
    });
  }
  /**
   * A LIGHT CARD IS HELD BY THE MEMORY GATES ONLY IF IT WOULD STILL BE HELD AT
   * ITS OWN PRICE. The machine verdict above is one state machine per machine
   * (its log lines, its episodes, its hysteresis) and reads the dearer price, so
   * it stays flat; this asks the same two questions again for one board's price,
   * without moving any of that state. Memory only: a full disk, the CPU axis, the
   * spend brake and the drain are not hers to lift. "Light" is any card priced
   * under the machine verdict's price: a light board, or a board whose cards were
   * measured lighter (`dispatch-card-weight.ts`).
   */
  function lightMemoryPass(t: Pick<Task, "projectId" | "dispatchWeight">): boolean {
    const projectId = t.projectId;
    try {
      if (cardPrices.priceFor(projectId, t.dispatchWeight) >= agentMemPrice()) return false;
      if (spendBrake.dayBlock()) return false;
      if (floorVerdict(false, projectId).reason) return false;
      const gcap = deps.svc.getGlobalCap();
      if (capMode(gcap) !== "resources") return true;
      // Frozen checks restart before any new card, a light one included.
      if (activeFrozenCount() > 0) return false;
      return budgetVerdict(gcap, undefined, undefined, projectId)?.verdict.admit ?? true;
    } catch { return false; }
  }
  function pressureBlock(): string | null {
    try {
      let gcap: GlobalDispatchCap;
      try { gcap = deps.svc.getGlobalCap(); } catch { return null; }
      if (capMode(gcap) !== "resources") { shared.lastPressureAxis = null; shared.budgetGate = "admitting"; return null; }
      const computed = budgetVerdict(gcap);
      if (!computed) return null;
      const { verdict, sample, share, mem } = computed;
      shared.budgetGate = verdict.state;
      // Frozen checks come back first: the room the freeze made is theirs, not a new agent's.
      const frozenHold = verdict.admit && activeFrozenCount() > 0;
      if (verdict.firstAgentExempt && !frozenHold) {
        // Not a block, but not a free machine either: the log says why the
        // first one went through, once, or the next "why did that start on a
        // loaded Mac" costs somebody a read of the shared contract.
        if (!shared.firstAgentExemptNoted) shared.budgetExemptPending = true; // said by the claim that uses it
        shared.firstAgentExemptNoted = true;
      } else {
        shared.firstAgentExemptNoted = false;
        shared.budgetExemptPending = false;
      }
      const axis = frozenHold ? "frozen" : verdict.blockedBy;
      const reason = frozenHold
        ? "prima ripartono i check congelati"
        : verdict.admit ? null : machineBudgetMessage(verdict, sample.cores, share, mem);
      if (axis && axis !== shared.lastPressureAxis && reason) log(`coda in attesa per budget: ${reason}`);
      else if (!axis && shared.lastPressureAxis) log("coda ripartita: l'uso di Topics è rientrato nel budget");
      shared.lastPressureAxis = reason ? axis : null;
      return reason;
    } catch { return null; }
  }

  // THE SPEND BRAKE lives in `task-dispatcher-spend-cap.ts`: it is born OFF
  // (zero = unlimited), it refuses the NEXT turn instead of cutting one in half,
  // and it fails OPEN on anything it cannot read. What stays here is the wiring
  // and the note in the card's thread, which needs `noteHold`.
  const spendBrake: ReturnType<typeof createSpendBrake> = createSpendBrake({
    getSpendCaps: () => deps.svc.getSpendCaps(),
    spent24hCents: () => deps.svc.agentSpend().cents24h,
    clearsAtMs: (capCents) => deps.svc.agentSpendClearsAt(capCents),
    log,
  });

  /**
   * "The next turn does not start, and here is how much and which cap". Once per
   * episode, like the other waits: the difference is that this one does not
   * dissolve on its own, so the sentence also says what dissolves it.
   */
  function noteSpendHold(task: Task, capCents: number): void {
    ctx.queue.noteHold(spendHeldNoted, task, taskSpendMessage(task.agentCostCents, capCents));
  }
  function localMemorySeatTaken(): boolean {
    return shared.memorySeatTaskId !== null || localTurns() > 0;
  }
  try { deps.attempts?.clearInactiveNoLocalChecksReservations?.(); }
  catch (err) { log("prenotazioni senza check non ripulite all'avvio", err); }
  const noCheckReservations = createNoCheckReservationManager({
    ledger: noCheckExemptions,
    attempts: deps.attempts,
    task: (taskId) => deps.svc.get(taskId)?.task,
    checks: (projectId) => deps.svc.getBoardSettings(projectId).reviewChecks,
    inFlight: (taskId) => inFlight.has(taskId),
    localMemorySeatTaken,
    heldMemory: () => deps.heldMemory?.() ?? null,
    isCliRuntime: () => deps.isCliRuntime?.() ?? false,
    comments: (taskId) => deps.svc.get(taskId)?.comments ?? [],
    addComment: (input) => { deps.svc.addComment(input); },
    log,
  });
  const clearNoCheckReservation: typeof noCheckReservations.clear = noCheckReservations.clear;
  const releaseInvalidNoCheckReservations = noCheckReservations.releaseInvalid;
  const releaseInactiveNoCheckReservations: typeof noCheckReservations.releaseInactive = noCheckReservations.releaseInactive;
  const noCheckReservationFor: typeof noCheckReservations.reservationFor = noCheckReservations.reservationFor;
  const restoreNoCheckReservation: typeof noCheckReservations.restore = noCheckReservations.restore;
  const noteNoCheckExemptionStart: typeof noCheckReservations.noteStart = noCheckReservations.noteStart;
  /** Seat and claim are one synchronous step: a holder outside `inFlight` and not `in_progress` is an orphan. */
  function releaseOrphanMemorySeat(): void {
    const taskId = shared.memorySeatTaskId;
    if (!taskId || inFlight.has(taskId)) return;
    try { if (deps.svc.get(taskId)?.task.status !== "in_progress") shared.memorySeatTaskId = null; }
    catch { /* A failed read must not release a live seat. */ }
  }
  return { admissionPreview, admissionVerdictNow, cardPrices, cardWeights, childAdmissionPreview, clearNoCheckReservation, currentCap, floorVerdict, inResourcesMode, lightMemoryPass, localMemorySeatTaken, localTurns, noCheckBudgetDecision, noCheckReservationFor, noteDerogationUsed, noteNoCheckExemptionStart, noteSpendHold, pressureBlock, rampHeld, releaseInactiveNoCheckReservations, releaseOrphanMemorySeat, restoreNoCheckReservation, spendBrake };
}
