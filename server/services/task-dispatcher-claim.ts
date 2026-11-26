/**
 * task-dispatcher-claim.ts: the second half of a dispatch pass.
 *
 * Walks the todo cards the first half prepared, one at a time: the gates a card
 * must clear (spend cap, memory, cap, weight, ramp), the atomic claim, and the
 * launch (single or fan-out).
 */
import { type Task } from "./tasks";
import { type ResourceFloorKind } from "./dispatch-capacity";
import { effectiveTopicsRouting } from "../../shared/task-coding-models";
import { overTaskSpendCap } from "./task-dispatcher-spend-cap";
import { overflowEligible } from "./dispatch-overflow";
import { effectiveDelegatedSettings } from "./task-dispatcher-delegated";
import { WAITING_MEMORY, HEAVY_HOLD_MAX_MS, HELD_RESUME_REFRESH_MS, RESUME_WAIT_OPENINGS, CHIP_QUEUED, describeIntruders } from "./task-dispatcher-support";
import type { DispatcherCtx } from "./task-dispatcher-context";
import type { TickPlan } from "./task-dispatcher-tick";
import { isNodeChildRun } from "./node-child-run";
import { reopenedByMainRed } from "./red-bounce";

export function createClaim(ctx: DispatcherCtx) {
  const { capHeldNoted, clock, delegatedPolicy, deps, fanOutBlockedNoted, floorBlockSent, floorHeldNoted, graceTimers, heavyHeldNoted, heavyHoldSince, inFlight, log, noCheckExemptions, spendHeldNoted, shared } = ctx.core;

  async function claimPass(projectId: string, pass: TickPlan): Promise<void> {
    const { aliveAgents, capScope, caps, daySpendBlock, effectiveCap, fanOut, fanOutBlocked, floorBlock, floorNote, floorNoteKey, floorNow, floorSent, gateRuns, heavyBusy, heavyCall, heldForLoad, heldForMs, intruders, loadGate, memoryFloorHolds, noCheckReservationAtRead, noteCapFull, overflowRound, overflowRoundNo, pressure, rampActive, remoteCard, remoteIds, resolved, resourceFloor, settings, todos, wantFanOut } = pass;
    let floorReadAfterStarts = 0;
    /** The floor re-read once this pass has started a card (see the claim). */
    let midPassFloor: string | null = null;
    let midPassFloorKind: ResourceFloorKind | null = null;
    let startedThisTick = 0;

    for (const [idx, t] of todos.entries()) {
      if (inFlight.has(t.id)) continue;
      const delegated = delegatedPolicy(t);
      if (delegated === null) {
        try { ctx.queue.emit(deps.svc.setDispatchState({ taskId: t.id, state: null, error: "delegated_capability_invalid" })); }
        catch { /* fail closed even if the explanatory chip cannot be written */ }
        continue;
      }
      // PER-CARD SPEND BRAKE, and only when a cap is set. Not a `break`: this
      // card does not start, the others have nothing to do with it (the per-card
      // cap is its own). The line in the thread is written once per episode and
      // says how much and which cap, because the wait does not dissolve by itself.
      if (caps.perTaskCents > 0 && overTaskSpendCap(t.agentCostCents, caps.perTaskCents)) {
        ctx.admission.noteSpendHold(t, caps.perTaskCents);
        continue;
      }
      // A card pinned to a forbidden machine (drained, or offline with no way to
      // wake it) is moved to an allowed one, or here. Moved to another remote
      // machine it runs this round; moved here it re-enters the local gates next tick.
      if (remoteCard(t) && ctx.overflow.reassignFromForbidden(t, settings)) {
        remoteIds.delete(t.id);
        continue;
      }
      if (remoteCard(t) && ctx.overflow.pinnedMachineDrained(t)) continue;
      if (remoteCard(t) && ctx.overflow.pinnedMachineFull(t)) {
        ctx.hold.queueChip(t);
        continue;
      }
      const manualMemoryStartSelected = ctx.queue.manualMemoryStart.selectedTask(projectId) === t.id;
      // COLD ORIGIN CACHE (2026-11-13): the very first tick that asks this
      // project's origin starts an async lookup and answers "unknown" for it,
      // which `overflowCardToFreeSeat` below reads as "no origin" and skips. Without
      // this check that one tick fell through to the Mac even with a free node
      // seat sitting there, because nothing distinguished "no origin" from
      // "origin not asked yet" - and once a card starts locally this round, it
      // runs out here. One round's wait for the lookup is cheap; starting on
      // the wrong machine is not undone.
      if (!remoteCard(t) && !manualMemoryStartSelected) {
        const delegated = delegatedPolicy(t) !== undefined;
        const localId = (() => { try { return deps.node?.localMachineId?.() ?? null; } catch { return null; } })();
        if (overflowEligible({ ...t, delegated, description: t.description ?? t.descriptionPreview }, settings, localId)
          && ctx.overflow.overflowOriginUnresolved(t.projectId) && ctx.overflow.anyOverflowSeatElsewhere(localId, t.overflowSkipMachines)) {
          try { ctx.queue.emit(deps.svc.setDispatchState({ taskId: t.id, state: CHIP_QUEUED })); } catch { /* best-effort: the chip still reads "to do" */ }
          continue;
        }
      }
      // THE OVERFLOW, one rule: an eligible card takes a free seat on a node or
      // on the cloud as soon as one exists, whatever this Mac's memory floor is
      // doing. There is no hold to wait out any more: the card does not answer
      // to the floor over there, so a free seat always beats a wait here.
      if (!remoteCard(t) && !manualMemoryStartSelected && ctx.overflow.overflowCardToFreeSeat(t, settings, overflowRound)) {
        remoteIds.add(t.id);
      }
      const remoteTask = remoteCard(t);
      const candidateReservationGB = manualMemoryStartSelected || remoteTask ? null : ctx.admission.noCheckReservationFor(t);
      const candidateBudget = candidateReservationGB == null
        ? { needed: false, allowed: false }
        : ctx.admission.noCheckBudgetDecision(candidateReservationGB);
      const exemptionDaySpend = candidateReservationGB != null
        ? ctx.admission.spendBrake.dayBlock()
        : null;
      const noCheckExemption = candidateReservationGB != null
        && floorNow.kind !== "disk"
        && !exemptionDaySpend
        && candidateBudget.allowed;
      const needsNoCheckExemption = (heavyBusy && !isNodeChildRun(t))
        || (!!resourceFloor && floorNow.kind === "memory")
        || candidateBudget.needed;
      const useNoCheckExemption = noCheckExemption && needsNoCheckExemption;
      const memoryHold = (resourceFloor != null && (floorNow.kind === "memory" || floorNow.kind === "memory_warmup"))
        || (!!pressure && shared.lastPressureAxis === "memory")
        || floorNow.memoryFirstCardExempt;
      if (!remoteTask && ((!manualMemoryStartSelected && floorNow.memoryFirstCardExempt && t.dispatchWeight === "heavy")
        || (shared.memorySeatTaskId && shared.memorySeatTaskId !== t.id && memoryHold))) {
        if (memoryFloorHolds) ctx.overflow.markMemoryHeld(t, overflowRoundNo);
        ctx.hold.queueChip(t, WAITING_MEMORY);
        continue;
      }
      if (heavyBusy && !useNoCheckExemption && !remoteTask && !isNodeChildRun(t)) {
        ctx.queue.noteHeavyHold(
          t,
          "In coda: c'è un task PESANTE al lavoro e si prende la macchina da solo. " +
            "Riparto appena ha finito. Non devi fare nulla.",
        );
        continue;
      }
      const bypassMemoryBlock = useNoCheckExemption
        && !exemptionDaySpend
        && ((resourceFloor && floorNow.kind === "memory")
          || (pressure && shared.lastPressureAxis === "memory"));
      const manualMemoryBypass = manualMemoryStartSelected
        && (floorNow.kind === "memory" || floorNow.kind === "memory_warmup");
      // A light card (in place, no local check) is not held by a line drawn for
      // a card that runs the repo gates: it waits only if it would still wait
      // at its own price. Asked only while a memory hold is in hand, so a quiet
      // queue pays no extra floor read per card; the answer itself already
      // refuses on disk, spend and CPU (`lightMemoryPass`). The seat above still applies.
      const lightPass = !remoteTask && !useNoCheckExemption && !manualMemoryStartSelected
        && ((resourceFloor != null && floorNow.kind === "memory") || (!!pressure && shared.lastPressureAxis === "memory"))
        && ctx.admission.lightMemoryPass(t);
      if (remoteTask) {
        // The memory floor and the budget measure THIS machine's RAM and CPU: a
        // remote card answers only to a full disk (its delivery is planted in
        // this checkout) and to the day spend brake, which the floor's reading
        // skips.
        const diskFull = resourceFloor != null && floorNow.kind === "disk";
        if (diskFull || (resourceFloor ? ctx.admission.spendBrake.dayBlock() : daySpendBlock)) {
          ctx.hold.queueChip(t);
          continue;
        }
      } else if (floorBlock && !bypassMemoryBlock && !manualMemoryBypass && !lightPass) {
        // THE REASON GOES ON THE CARD, not only into the server log. This
        // branch used to write the bare `queued` chip and leave the
        // explanation in a file nobody watching the board opens: the card fell
        // through to the queue branch and said "in coda, la prossima" while
        // nothing started, on any board, for hours.
        //
        // Two channels, two different things: the chip is fed by
        // `publishDispatchBlock` above (it lives exactly as long as the block), the
        // thread line says the wait in words. One per EPISODE, and one ROW per
        // card across episodes and boots: it is the state of the wait, the same
        // slot as the resume's note (see `RESUME_WAIT_OPENINGS`).
        //
        // THE CHIP ONCE, THE CARD WHEN ITS BLOCK CHANGES. The chip is written
        // only when the row lacks it: rewritten at every poll it moved
        // `updated_at` and sent a frame 360 times an hour per card. What does
        // change is the block the card reads (`currentDispatchBlock`, published
        // above), so the card is re-sent without a write when that becomes
        // another block, or the same one with figures a minute old, like a held
        // resume's chip (`HELD_RESUME_REFRESH_MS`). Re-read, not `t`: `t` was
        // mapped before this tick published its block.
        const block = floorSent!;
        const sent = floorBlockSent.get(t.id);
        const stale = !sent || sent.key !== block.key
          || (sent.reason !== block.reason && clock() - sent.at >= HELD_RESUME_REFRESH_MS);
        const memoryWait = resourceFloor != null && (floorNow.kind === "memory" || floorNow.kind === "memory_warmup");
        if (memoryFloorHolds) ctx.overflow.markMemoryHeld(t, overflowRoundNo);
        const wrote = ctx.hold.queueChip(t, memoryWait ? WAITING_MEMORY : undefined);
        // In attesa di memoria la card legge solo il codice: cifre nuove non cambiano niente.
        if (stale && !wrote && !memoryWait) {
          try { const fresh = deps.svc.get(t.id)?.task; if (fresh) ctx.queue.emit(fresh); } catch { /* the task may have moved */ }
        }
        if (stale || wrote) floorBlockSent.set(t.id, { ...block, at: clock() });
        if (!memoryWait && floorNote && floorNoteKey && floorHeldNoted.get(t.id) !== floorNoteKey) {
          floorHeldNoted.set(t.id, floorNoteKey);
          try {
            // THE SAME SLOT AS THE RESUME'S NOTE: same machine state, same
            // sentences. Written apart, it piled up across boots (268 rows on
            // 58 cards in prod, up to 29 on one), and the resume's slot later
            // erased it as if it were its own copy.
            deps.svc.addComment({ taskId: t.id, author: "system", kind: "service", content: floorNote, replaces: [...RESUME_WAIT_OPENINGS], once: true });
          } catch { /* il task può essersi mosso sotto i piedi */ }
        }
        continue;
      }
      // The ramp (see `rampActive`): the last start is too recent, here or on
      // another board or from a resume. The rest of the queue gets the `queued`
      // chip, like a full cap would give it, and its turn comes with a fresher
      // reading.
      if (!remoteTask && rampActive && ctx.admission.rampHeld()) {
        ctx.hold.queueChip(t);
        continue;
      }
      // Respect the grace debounce: a task still inside its window is claimed by
      // its OWN scheduled tick (which deletes the timer first), never by a poll
      // firing mid-grace — otherwise a quick drag-through could still spawn.
      if (graceTimers.has(t.id)) continue;
      // ── Il lavoro di questa card è GIÀ su main: si chiude, non riparte ────
      //
      // Una card che ha consegnato porta lo scatto della consegna
      // (`deliveryCommit`), e quello sopravvive alla potatura del ramo. Se è
      // dentro il ramo d'integrazione non c'è niente da rifare: rimandarci un
      // agente vuol dire pagare due volte lo stesso lavoro, e in più farglielo
      // riscrivere sopra a mano con i conflitti che ne seguono. Misurato l'11 e
      // il 12/08: 32 ridispacci in un giorno, e le sole `4ec47331` e `e54a9be6`
      // valgono 3,26M token e 91M di cache read.
      //
      // Il land ha già il suo cancello all'approvazione (`settleLanded`); questo
      // copre le strade da cui la card rientra in coda DOPO — trascinata a mano,
      // riaperta da `done→todo`, recuperata come orfana — dove nessuno guardava
      // il repo prima di far partire un agente.
      //
      // Prima del claim e dentro il ciclo, non nel filtro sopra: qui la domanda
      // si fa solo per le card che stanno per partire davvero, e solo per quelle
      // che hanno una consegna registrata. Su tutte le altre non c'è nessuna
      // chiamata a git.
      //
      // DUE cose che il cancello non tocca, e che senza guardia trasformano una
      // difesa contro il lavoro rifatto in un modo per buttare via lavoro vero:
      //
      //  1. Una card che un UMANO ha rimesso in coda. È lo specchio esatto
      //     dell'invariante che il repo si è già dato l'11/08 (tasks.ts, «una
      //     card chiusa da un UMANO non la riapre un agente»): se la decisione
      //     di una persona non la ribalta la macchina in un verso, non la
      //     ribalta nemmeno nell'altro. Chi riapre una card atterrata sta
      //     chiedendo un SEGUITO, e richiuderla gli risponde con una riga di
      //     storico che non leggerà. Costa un turno crederci; costa una
      //     richiesta buttata non crederci.
      // Il padre con sottotask aperti era la SECONDA, e adesso il cancello sta
      // dentro `settleLanded` — dove sta anche per l'approvazione e per il
      // trascinamento sulla board. Ripeterlo qui voleva dire due predicati per
      // la stessa regola, liberi di divergere: quello di là si legge dal DB,
      // questo dai contatori arrivati con la lista. Se `settleLanded` non chiude
      // (torna una card che non è `done`) questa card non è finita, e il ciclo
      // prosegue fino al claim invece di saltarla.
      const reopenedHumanBy = t.reopenedActor === "human";
      // Sent back by the red on main after its land: the work is on main and a fix on top is still owed.
      const reopenedByMainRedCi = t.reopenedActor === "system" && reopenedByMainRed(deps.svc.get(t.id)?.comments ?? []);
      if (t.deliveryCommit && deps.deliveryLanded && !reopenedHumanBy && !reopenedByMainRedCi) {
        let landed: boolean | null = null;
        try { landed = await deps.deliveryLanded(resolved.path, t.deliveryCommit); }
        catch (err) { log(`sonda del commit di consegna fallita per ${t.id}`, err); }
        // SOLO il `true` chiude: `null` è ignoranza (repo irraggiungibile, sha
        // potato) e chiudere una card sull'ignoranza butterebbe via il lavoro
        // che manca — l'errore opposto, e più caro, di quello che si ripara qui.
        if (landed === true) {
          let chiusa = false;
          try {
            const closed = deps.svc.settleLanded({
              taskId: t.id,
              by: "system",
              reason:
                `il lavoro consegnato (${t.deliveryCommit.slice(0, 8)}) è già dentro main: ` +
                "niente da rifare, la card si chiude invece di ripartire",
            });
            if (closed) { ctx.queue.emit(closed); chiusa = closed.status === "done"; }
          } catch (err) { log(`chiusura della card già atterrata fallita per ${t.id}`, err); }
          // Solo se si è CHIUSA davvero. `settleLanded` rifiuta di chiudere un
          // padre con step aperti: quella card non è finita, ha una checklist da
          // muovere, e saltarla la lascerebbe ferma per sempre.
          if (chiusa) {
            try { await deps.stopCardProcesses?.(t.id); }
            catch (err) { log(`chiusura dei processi della card atterrata fallita per ${t.id}`, err); }
            continue;
          }
        }
      }
      // The claim is the status CAS (todo → in_progress + chip 'starting');
      // the topic binding arrives in launch() via bindTopic() once the real
      // topic exists (assigned_topic_id has a FK to topics(id) — a placeholder
      // would violate it).
      // Un task che riusa il contesto del blocker vive nella chat DI QUELLO:
      // non si può fan-outtare una conversazione sola in N tentativi. Vince il
      // riuso (è una scelta esplicita dell'umano sul task), il fan-out cede.
      const taskFanOut = useNoCheckExemption || delegated || remoteTask
        ? 1
        : (t.reuseBlockerContext && t.blockedByTaskId ? 1 : fanOut);
      // N agenti = N slot. `claim` conta le RIGHE in_progress (una, per un
      // fan-out), quindi la prenotazione va fatta qui: il claim passa solo se
      // restano almeno N posti liberi.
      // I gate in volo si sottraggono anche qui: il claimCap deve riflettere i
      // posti DAVVERO liberi, non solo quelli non occupati da agenti.
      const claimCap = effectiveCap - shared.reservedSlots - gateRuns - (taskFanOut - 1);
      if (!remoteTask && claimCap < 1) {
        // Macchina piena: da qui in poi aspettano tutti, e lo si dice a
        // ciascuno prima di uscire. Il `break` senza una riga era il difetto:
        // la coda restava ferma e le card non lo raccontavano.
        const vivi = aliveAgents();
        const posti = Math.max(0, effectiveCap - shared.reservedSlots - gateRuns);
        for (const rest of todos.slice(idx)) {
          if (inFlight.has(rest.id) || graceTimers.has(rest.id)) continue;
          noteCapFull(rest, vivi, { serve: taskFanOut, posti });
        }
        break;
      }
      // Un pesante a macchina carica aspetta — e TIENE la testa della coda. Se
      // cedesse il posto ai task leggeri dietro di lui, quelli partirebbero,
      // alzerebbero il carico, e il momento in cui la macchina è scarica non
      // arriverebbe mai: la guardia si trasformerebbe in un divieto permanente
      // proprio per il task che deve girare da solo.
      //
      // Il `break` resta, ma adesso lo si DICE. Quel salto ferma la coda intera,
      // e la card diceva solo «in coda»: chi guardava la board vedeva quaranta
      // righe idonee e nessuna che partiva, senza un posto in cui leggere che
      // era quest'una a tenerle tutte. Il numero di chi sta dietro è la cosa che
      // trasforma «aspetto il mio turno» in «sono io il tappo».
      if (heldForLoad(t)) {
        const dietro = todos.slice(idx + 1).filter((o) => !inFlight.has(o.id) && !graceTimers.has(o.id)).length;
        const misura = loadGate!.own
          ? `i nostri agenti stanno usando ${loadGate!.load1.toFixed(1)} core su ${loadGate!.cores}`
          : `la macchina è carica (load ${loadGate!.load1.toFixed(1)} su ${loadGate!.cores} core)`;
        const tappo = dietro > 0
          ? ` Intanto tiene ferma la coda: ${dietro} task dietro di lui non partono finché non parte questo.`
          : "";
        ctx.queue.noteHeavyHold(
          t,
          `In coda: questo task è PESANTE e ${misura}. ` +
            `Parte da solo appena si libera, e comunque entro ${Math.round(HEAVY_HOLD_MAX_MS / 60_000)} min.` +
            tappo,
        );
        break;
      }
      // Attesa sfondata: parte lo stesso. `machineIdle: true` non è una bugia
      // sulla misura, è la decisione presa qui che passa al CAS del claim, che
      // altrimenti lo rifiuterebbe in silenzio (`tasks.ts`, regola 2 del peso) e
      // lascerebbe la card ferma esattamente come prima, ma senza più nemmeno
      // una nota che lo spieghi.
      //
      // THE LAST LOOK BEFORE THE CLAIM, with nothing awaited between it and the
      // claim. The ramp again, because the probe of the delivery commit above
      // awaits and another board's tick can start a card in that gap. The floor
      // again once this pass has started a card: it was read once at the top,
      // and a count-mode tick claims every free slot against that one reading.
      if (!remoteTask && rampActive && ctx.admission.rampHeld()) {
        ctx.hold.queueChip(t);
        continue;
      }
      if (!remoteTask && !midPassFloor && startedThisTick > floorReadAfterStarts) {
        floorReadAfterStarts = startedThisTick;
        const verdict = ctx.admission.admissionVerdictNow();
        midPassFloor = verdict.reason;
        midPassFloorKind = verdict.kind;
      }
      const midPassMemoryHold = midPassFloor != null && (midPassFloorKind === "memory" || midPassFloorKind === "memory_warmup");
      if (!remoteTask && midPassFloor && !useNoCheckExemption
        && !(manualMemoryStartSelected && midPassMemoryHold) && !lightPass) {
        ctx.hold.queueChip(t, midPassMemoryHold ? WAITING_MEMORY : undefined);
        continue;
      }
      // The light pass was granted before the awaits of this iteration (the
      // delivery probe). A disk filled, or a card another board started in that
      // gap, must hold this one like any other: ask again, with nothing awaited
      // between this look and the claim.
      if (lightPass && !ctx.admission.lightMemoryPass(t)) {
        ctx.hold.queueChip(t, WAITING_MEMORY);
        continue;
      }
      let claimNoCheckReservationGB = 0;
      if (useNoCheckExemption) {
        const latestReservationGB = ctx.admission.noCheckReservationFor(t);
        const latestFloor = ctx.admission.floorVerdict();
        const latestBudget = latestReservationGB == null
          ? { needed: false, allowed: false }
          : ctx.admission.noCheckBudgetDecision(latestReservationGB);
        const latestDaySpend = latestReservationGB != null
          ? ctx.admission.spendBrake.dayBlock()
          : null;
        const stillNeedsExemption = heavyBusy
          || (latestFloor.kind === "memory" && !!latestFloor.reason)
          || latestBudget.needed;
        if (latestReservationGB == null
          || !stillNeedsExemption
          || !latestBudget.allowed
          || latestFloor.kind === "disk"
          || latestDaySpend) {
          if (latestReservationGB == null && noCheckExemptions.hasAny() && !noCheckExemptions.has(t.id)) {
            const freshBlock = ctx.usage.currentMachineBlock();
            if (freshBlock) ctx.usage.noteCurrentMachineBlock(t, freshBlock);
            else ctx.hold.queueChip(t);
          } else if (floorBlock || midPassFloor) ctx.hold.queueChip(t);
          else if (heavyBusy) ctx.queue.noteHeavyHold(t, "In coda: c'è un task PESANTE al lavoro e si prende la macchina da solo. Riparto appena ha finito. Non devi fare nulla.");
          continue;
        }
        if (!noCheckExemptions.reserve(t.id, latestReservationGB)) {
          ctx.hold.queueChip(t);
          continue;
        }
        try { deps.attempts?.setNoLocalChecksReservation?.(t.id, latestReservationGB); }
        catch (err) {
          ctx.admission.clearNoCheckReservation(t.id);
          log(`prenotazione senza check non persistita per ${t.id}`, err);
          ctx.hold.queueChip(t);
          continue;
        }
        claimNoCheckReservationGB = latestReservationGB;
      }
      if (!remoteTask
        && !noCheckReservationAtRead
        && noCheckExemptions.hasAny()
        && !noCheckExemptions.has(t.id)) {
        const freshBlock = ctx.usage.currentMachineBlock();
        if (freshBlock) {
          ctx.usage.noteCurrentMachineBlock(t, freshBlock);
          continue;
        }
      }
      const reserveMemorySeat = !remoteTask
        && (manualMemoryStartSelected || (memoryHold && (floorNow.memoryFirstCardExempt || useNoCheckExemption)));
      if (reserveMemorySeat && ctx.admission.localMemorySeatTaken() && shared.memorySeatTaskId !== t.id) {
        if (claimNoCheckReservationGB > 0) ctx.admission.clearNoCheckReservation(t.id);
        ctx.hold.queueChip(t, WAITING_MEMORY);
        continue;
      }
      if (reserveMemorySeat) shared.memorySeatTaskId = t.id;
      const forced = heavyCall.get(t.id) === "forced";
      let claimed: Task | null;
      try {
        claimed = deps.svc.claim({
          taskId: t.id, cap: claimCap, maxAttempts: delegated ? 1 : settings.dispatchRetryCap,
          scope: capScope, machineIdle: forced ? true : loadGate?.ok, noCheckExemption: claimNoCheckReservationGB > 0,
          remote: remoteTask,
        });
      } catch (err) {
        // A claim that throws (row deleted during this pass) releases what was taken for it.
        if (shared.memorySeatTaskId === t.id) shared.memorySeatTaskId = null;
        if (claimNoCheckReservationGB > 0) ctx.admission.clearNoCheckReservation(t.id);
        throw err;
      }
      if (!claimed) {
        if (shared.memorySeatTaskId === t.id) shared.memorySeatTaskId = null;
        if (claimNoCheckReservationGB > 0) ctx.admission.clearNoCheckReservation(t.id);
        // Il CAS ha detto di no. Due ragioni possibili, e solo una va raccontata:
        // il tetto pieno (che dura, e la card deve dirlo) oppure una corsa persa
        // con un altro claim nello stesso istante (che si risolve da sé al tick
        // dopo, e commentarla sarebbe rumore). Si distinguono ri-contando gli
        // agenti vivi: se sono già almeno quanti il tetto ne ammette, è il tetto.
        if (remoteTask) continue;
        const vivi = aliveAgents();
        if (vivi == null || vivi >= claimCap) noteCapFull(t, vivi);
        continue;
      }
      ctx.queue.clearGrace(t.id);
      if (!remoteTask) ctx.admission.noteDerogationUsed(t.id);
      // Il claim è riuscito: l'episodio «tetto pieno» di questa card è chiuso, e
      // va dimenticato QUI. La ripulitura in cima al ciclo guarda solo chi è
      // ancora fra i `todos`, e un task appena partito non lo è più: senza
      // questa riga il suo id resterebbe nell'insieme per sempre, e la prossima
      // volta che quella card aspetta un posto tornerebbe a restare muta, che è
      // esattamente il difetto che si sta chiudendo.
      capHeldNoted.delete(t.id);
      // Same for the spend brake: this card started, so the episode is closed. If
      // it goes through the cap again tomorrow, it says so again.
      spendHeldNoted.delete(t.id);
      if (forced) {
        const atteso = Math.round(heldForMs(t) / 60_000);
        heavyHoldSince.delete(t.id);
        heavyHeldNoted.delete(t.id);
        try {
          deps.svc.addComment({
            taskId: t.id, author: "system", kind: "service",
            content:
              `Parte comunque dopo ${atteso} min di attesa: è un task PESANTE e la macchina non si è liberata, ` +
              "ma un'attesa senza fine tiene ferma tutta la coda dietro di lui. " +
              "Può quindi girare accanto ad altri agenti: se rallenta, è per questo.",
          });
        } catch { /* il task può essersi mosso */ }
      }
      ctx.queue.emit(claimed); // chip → starting
      if (manualMemoryStartSelected) {
        try {
          deps.svc.addComment({
            taskId: t.id, author: "system", kind: "service",
            content: "Partita per scelta dell'utente.", once: true,
          });
        } catch { /* The start remains valid if its note cannot be written. */ }
      }
      // A claim that went through IS a new dispatch, fan-out or single: the
      // ramp counts cards, because one card is one reading of the machine. A
      // remote start reads nothing here and leaves the ramp alone, but it still
      // makes the next LOCAL card re-read the floor: the probe above awaits.
      startedThisTick++;
      if (!remoteTask) shared.lastAdmissionAt = Date.now();
      // Worktree dispatch with a live external session: the agent's files are
      // isolated, but the BRANCH it will land on is contended. Say so in the
      // thread so the reviewer knows before approving a merge.
      if (intruders.length > 0) {
        try {
          deps.svc.addComment({
            taskId: t.id, author: "system", kind: "service",
            content: `Attenzione: ${describeIntruders(intruders)} mentre parte questo agent. ` +
              "L'agent lavora in un worktree isolato, ma il landing su main può incrociare quel lavoro. Controlla il diff prima di approvare.",
          });
        } catch { /* best-effort note */ }
      }
      let launchSettings = {
        timeoutMin: settings.dispatchTimeoutMin,
        idleMin: settings.dispatchIdleMin,
        effort: settings.dispatchEffort,
        mcp: settings.dispatchMcp,
        model: settings.dispatchModel && settings.dispatchModel !== "auto" ? settings.dispatchModel : undefined,
        // Task esplicito, poi default board, poi prefisso legacy — letto sul modello che il turno USERA' davvero: guardare solo `t.model` perdeva il legacy della board per ogni task senza modello proprio. allow-italian: nomina il difetto della prima versione
        topicsRouting: effectiveTopicsRouting(
          t.topicsRouting ?? settings.dispatchTopicsRouting,
          t.model ?? (settings.dispatchModel && settings.dispatchModel !== "auto" ? settings.dispatchModel : undefined),
          "task",
          t.createdAt,
        ),
        // MSEL-06: the stored value travels too, `null` included, until the
        // reuse gate has read it (a never-written preference adopts the session's).
        topicsRoutingStored: t.topicsRouting ?? settings.dispatchTopicsRouting ?? null,
      };
      if (delegated) launchSettings = effectiveDelegatedSettings(launchSettings, delegated);
      // Fire the launch; do NOT await (one board can fill multiple slots).
      if (taskFanOut > 1 && resolved.projectStoreId) {
        if (taskFanOut < wantFanOut) {
          // Detto ad alta voce: un fan-out tagliato in silenzio si legge come un
          // fan-out che "non funziona".
          try {
            deps.svc.addComment({
              taskId: t.id, author: "system", kind: "service",
              content: `Fan-out ${wantFanOut}→${taskFanOut}: tetto di concorrenza ${effectiveCap}.`,
            });
          } catch { /* best-effort */ }
        }
        void ctx.fanout.launchFanOut(t.id, taskFanOut, launchSettings, { path: resolved.path, projectStoreId: resolved.projectStoreId });
        continue;
      }
      if (fanOutBlocked && !fanOutBlockedNoted.has(projectId)) {
        fanOutBlockedNoted.add(projectId);
        try {
          deps.svc.addComment({
            taskId: t.id, author: "system", kind: "service",
            content: `Fan-out ${wantFanOut} ignorato: board IN-PLACE (worktree off), ${wantFanOut} agenti nella stessa cartella si pesterebbero. Parte un agente solo.`,
          });
        } catch { /* best-effort */ }
      }
      void ctx.launch.launch(t.id, { useWorktree: settings.dispatchUseWorktree, ...launchSettings }, resolved);
    }
    ctx.overflow.pruneOverflowClocks(projectId, overflowRoundNo);
  }

  return { claimPass };
}
