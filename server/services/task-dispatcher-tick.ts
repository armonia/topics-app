/**
 * task-dispatcher-tick.ts: the dispatch pass over one board.
 */
import { UNASSIGNED_PROJECT_ID, type Task } from "./tasks";
import { MAX_FANOUT } from "../../shared/board";
import { type ResourceFloorKind } from "./dispatch-capacity";
import { publishDispatchBlock } from "./dispatch-block-signal";
import { effectiveTopicsRouting } from "../../shared/task-coding-models";
import { overTaskSpendCap } from "./task-dispatcher-spend-cap";
import { overflowEligible } from "./dispatch-overflow";
import { effectiveDelegatedSettings } from "./task-dispatcher-delegated";
import { WAITING_MEMORY, HEAVY_HOLD_MAX_MS, HELD_RESUME_REFRESH_MS, holdKey, RESUME_WAIT_OPENINGS, CHIP_QUEUED, CHIP_FAILED, CHIP_BLOCKED, describeIntruders } from "./task-dispatcher-support";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createTick(ctx: DispatcherCtx) {
  const { capHeldNoted, clock, delegatedPolicy, deps, evaluateNight, externallyHeldNoted, fanOutBlockedNoted, floorBlockSent, floorHeldNoted, graceTimers, heavyHeldNoted, heavyHoldSince, inFlight, log, memoryHeldCards, noCheckExemptions, planHeldNoted, spendHeldNoted, shared } = ctx.core;

  async function tick(projectId: string): Promise<void> {
    try { await dispatchTick(projectId); }
    finally { ctx.queue.notifyMemoryQueue(); }
  }

  async function dispatchTick(projectId: string): Promise<void> {
    // First, before any return: a round that ends early is a round that did not
    // hold anything by memory, and the overflow's clock must see it.
    const overflowRoundNo = ctx.overflow.beginOverflowRound(projectId);
    ctx.admission.releaseInactiveNoCheckReservations();
    ctx.admission.releaseOrphanMemorySeat();
    // Project-less tasks are never dispatchable (no cwd): they WAIT quietly on
    // the global board — parking them with "progetto non risolvibile" would be
    // the todo→backlog bounce all over again.
    if (projectId === UNASSIGNED_PROJECT_ID) return;
    let settings;
    try { settings = deps.svc.getBoardSettings(projectId); }
    catch (err) { log(`getBoardSettings failed for ${projectId}`, err); return; }
    if (!settings.autoDispatch) return;
    // A restart is waiting for the fleet to go quiet: picking a card now would
    // keep it waiting forever. The card is not lost, it is next after the boot.
    if (shared.draining) return;
    // IL FRENO DI QUESTA BOARD, e viene dopo il globale di proposito: puo' solo
    // FERMARE. Il dispatch parte se il globale e' acceso E questa board non e'
    // in pausa; una board non in pausa con il globale spento non parte lo
    // stesso. Due interruttori che possono entrambi accendere si contraddicono,
    // e chi guarda non sa quale dei due sta leggendo.
    //
    // Senza questo, l'unica leva su una board che fa danni era spegnere TUTTO —
    // e con tutto spento si fermano anche le board che stavano lavorando bene.
    // A differenza di `nightMode` qui non c'e' niente di condizionale e niente
    // che si spenga da solo: e' una scelta secca, e resta finche' qualcuno non
    // la toglie.
    if (settings.dispatchPaused) return;

    // Modalità notturna: la coda si dispaccia solo mentre la macchina è libera,
    // e il turno si SPEGNE da solo all'orario di fine.
    //
    // Lo spegnimento non è cosmetico. Se la scadenza si limitasse a bloccare il
    // dispatch, l'interruttore resterebbe acceso all'infinito e la mattina dopo
    // la board sembrerebbe rotta («ho task in coda e non parte niente») invece
    // che semplicemente tornata normale. Un turno che non sa finire è peggio di
    // uno che non parte.
    if (settings.nightMode) {
      const { decision } = evaluateNight(settings);
      if (decision.action === "expire") {
        log(`modalità notturna spenta su ${projectId}: ${decision.reason}`);
        try { deps.svc.updateBoardSettings(projectId, { nightMode: false }); }
        catch (err) { log(`spegnimento della modalità notturna fallito su ${projectId}`, err); }
        return;
      }
      if (decision.action === "wait") {
        log(`modalità notturna in attesa su ${projectId}: ${decision.reason}`);
        return;
      }
    }

    const resolved = deps.resolveProject(projectId);

    let todos: Task[];
    // rootsOnly: a STEP dragged/created in todo must never be claimed as an
    // independent task (it's the checklist of a parent, worked by ITS agent).
    try { todos = deps.svc.list({ scope: "project", projectId, status: "todo", rootsOnly: true }); }
    catch (err) { log(`list todo failed for ${projectId}`, err); return; }
    // Self-heal DEAD bindings: a todo task still linked to a topic that no longer
    // exists (its agent tab was reaped after a prior run — done→todo re-queue is
    // the common trigger) is otherwise skipped forever by the `!assignedTopicId`
    // filter below, stranded in todo with no chip. Clear the dead link (release →
    // requeue) so it becomes claimable again, then re-read the list.
    if (deps.topicExists) {
      let healed = false;
      for (const t of todos) {
        if (!t.assignedTopicId) continue;
        let exists = true;
        try { exists = deps.topicExists(t.assignedTopicId); } catch { exists = true; /* trust binding on probe failure */ }
        if (exists) continue;
        try {
          ctx.queue.releaseAndEmit({
            taskId: t.id,
            requeue: true,
            reason: "Il topic dell'agent precedente non esiste più (ripulito): binding morto azzerato, il task riparte.",
          });
          healed = true;
        } catch (err) { log(`heal dead binding failed for ${t.id}`, err); }
      }
      if (healed) {
        try { todos = deps.svc.list({ scope: "project", projectId, status: "todo", rootsOnly: true }); }
        catch (err) { log(`re-list after heal failed for ${projectId}`, err); return; }
      }
    }
    const manualTaskId = ctx.queue.manualMemoryStart.selectedTask(projectId);
    if (manualTaskId) todos = todos.filter((task) => task.id === manualTaskId);
    // A card a scheduled run outside Topics works is not part of this queue at
    // all: no claim, no queue chip, no parking. The run does the work.
    todos = todos.filter((task) => !task.scheduled);
    const nowIso = new Date().toISOString();
    // Budget dei tentativi finito = NON riproverà MAI più, e finché lo si scarta
    // in silenzio la card resta in colonna «coda» fingendosi lavorabile: nessun
    // chip, nessuna riga, e il board conta come lavoro ciò che è fermo per
    // sempre. Misurate 19 card così l'11/08, a interruttore acceso e macchina
    // libera. Si parcheggiano con la ragione scritta — la coda deve dire il
    // vero, e un umano decide se rimetterle in coda (la PATCH a `todo` azzera
    // il contatore) o lasciarle stare.
    //
    // Ma «non riproverà mai più» vale solo per chi sarebbe pronto ADESSO. Un
    // task dentro la sua finestra d'attesa non ha finito niente: sta aspettando
    // una condizione esterna che l'agente ha dichiarato, e il tentativo lo
    // consumerà semmai la riclamata dopo. L'11/08 questo controllo, messo prima
    // del cancello dell'attesa, ha ucciso una card che aspettava 14 minuti di
    // UAT su CI — il bound sugli aspettatori eterni resta, ma scatta quando la
    // finestra è passata, non mentre scorre. Stessa ragione per il bloccante:
    // chi aspetta un altro task non sta fallendo.
    const pronto = (t: Task) =>
      !t.assignedTopicId &&
      !t.scheduled &&
      (!t.dispatchDeferredUntil || t.dispatchDeferredUntil <= nowIso) &&
      (() => { try { return !deps.svc.isDispatchBlocked(t.id); } catch { return true; } })();
    const exhausted = todos.filter((t) => pronto(t) && t.dispatchAttempts >= settings.dispatchRetryCap);
    let toldExhausted = false;
    for (const t of exhausted) {
      if (inFlight.has(t.id) || graceTimers.has(t.id)) continue;
      try {
        ctx.queue.releaseAndEmit({
          taskId: t.id,
          requeue: false,
          parkState: CHIP_FAILED,
          // «Guarda cosa lo fa fallire» diceva due cose sbagliate in una riga.
          // Presumeva un guasto da trovare, e ci finiva dentro anche chi aveva
          // solo ASPETTATO: fino al rimborso in `deferForWait`, due attese
          // dichiarate bastavano a esaurire il budget e la card veniva accusata
          // di un fallimento che non era successo. Ora le attese hanno il loro
          // contatore e questa riga può dire soltanto ciò che è vero qui: i
          // turni si sono chiusi senza arrivare in review, e la ragione di
          // ciascuno è già scritta nel thread.
          reason:
            `Budget dei tentativi finito (${t.dispatchAttempts}/${settings.dispatchRetryCap}): i turni si sono chiusi ` +
            "senza arrivare in review, quindi il task non riparte da solo. Rimettilo in Todo per ridargli i tentativi. " +
            "Il motivo di ogni tentativo è nel thread, in fondo.",
        }, { announce: !toldExhausted });
        toldExhausted = true;
      } catch { /* il task può essersi mosso */ }
    }
    todos = todos
      .filter((t) => !t.assignedTopicId && t.dispatchAttempts < settings.dispatchRetryCap)
      // Deferral gate: a task the agent parked with an external-condition wait
      // (chip `waiting`) stays out of the claim until its window elapses — the
      // same guard is in the claim CAS, so a poll firing early can't sneak it in.
      .filter((t) => !t.dispatchDeferredUntil || t.dispatchDeferredUntil <= nowIso)
      // Dependency gate: a todo whose blocker is still open WAITS (no claim
      // attempt, no chip). Same predicate as the claim CAS, so no divergence.
      .filter((t) => { try { return !deps.svc.isDispatchBlocked(t.id); } catch { return true; } })
      .filter((t) => {
        const wait = ctx.hold.taskPlanWait(t, t.model ?? (settings.dispatchModel !== "auto" ? settings.dispatchModel : undefined), true);
        if (!wait) { planHeldNoted.delete(t.id); return true; }
        // THE CHIP IS NOT A QUESTION. A wall of days needs a person, and the
        // chip is read by whoever already has the board open on that card: the
        // line goes in the thread once per episode, like the spend cap's -
        // the other wait here that no amount of patience ends.
        //
        // BEFORE the chip, not after: `noteHold` writes the `queued` state with
        // no reason, so the other order left the card with an empty
        // `dispatch_error` - the queue's own chip blanked by the line that was
        // meant to explain it.
        if (wait.asksAPerson) ctx.queue.noteHold(planHeldNoted, t, wait.reason, wait.slot);
        ctx.hold.markPlanWait(t, wait.reason);
        return false;
      })
      // Priority is the queue discipline (4=urgente first), age breaks ties —
      // an urgent task never waits behind an older low-priority one.
      .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));

    if (!resolved) {
      // Auto-dispatch is ON but the board id can't be mapped back to a
      // directory. Park the eligible todos with a visible reason instead of
      // stranding them (chip "queued" forever) with only a server log.
      log(`cannot resolve project path for board ${projectId}`);
      // La causa è UNA (la board non mappa a una directory) e vale per tutti i
      // todo idonei: li parcheggia tutti — il chip è la verità, task per task —
      // ma annuncia solo il primo. Le push si deduplicano per `task-park-<id>`,
      // quindi senza questo una board scollegata sparava N notifiche identiche
      // in fila, una per task in coda.
      let announced = false;
      for (const t of todos) {
        if (inFlight.has(t.id) || graceTimers.has(t.id)) continue;
        try {
          ctx.queue.releaseAndEmit({
            taskId: t.id,
            requeue: false,
            parkState: CHIP_BLOCKED,
            reason:
              "Auto-dispatch fermato: non riesco a risalire alla directory del progetto per questa board. " +
              "Apri il progetto in una tab (o registralo) e riporta il task in Todo.",
          }, { announce: !announced });
          announced = true;
        } catch { /* task may have moved */ }
      }
      return;
    }

    // Which todos run on another machine, read once per tick: the local id
    // comes from a store call, and the answer cannot change inside the pass.
    const remoteIds = new Set(todos.filter(ctx.overflow.isRemoteTask).map((t) => t.id));
    const remoteCard = (t: Task) => remoteIds.has(t.id);
    // GUARD — somebody else is already working this repo. `externalSessionsAt`
    // reports the live Claude sessions Topics didn't start (a bare `claude` in
    // a terminal). Read ONCE per tick: the census is TTL-cached upstream, and
    // every task in this tick shares the same answer.
    let intruders: Array<{ cwd: string; branch: string | null }> = [];
    if (deps.externalSessionsAt) {
      try { intruders = deps.externalSessionsAt(resolved.path) ?? []; }
      catch (err) { log(`external-session probe failed for ${resolved.path}`, err); }
    }
    if (intruders.length > 0 && !settings.dispatchUseWorktree) {
      // In-place dispatch means the agent edits the SAME directory the human's
      // session is in — a guaranteed fight over the working tree. HOLD instead
      // of claiming: the todos STAY in `todo` with the 'queued' chip, so the
      // 10s reconcile keeps re-ticking this board and dispatch resumes BY ITSELF
      // once the external session goes quiet — no human intervention, no
      // re-queue. One system note per hold episode, not per poll.
      for (const t of todos) {
        if (remoteCard(t)) continue;
        if (inFlight.has(t.id) || graceTimers.has(t.id)) continue;
        if (externallyHeldNoted.has(t.id)) continue;
        externallyHeldNoted.add(t.id);
        try {
          ctx.queue.emit(deps.svc.setDispatchState({ taskId: t.id, state: CHIP_QUEUED }));
          deps.svc.addComment({
            taskId: t.id, author: "system", kind: "service",
            content: `Dispatch in attesa: ${describeIntruders(intruders)} e questa board lavora IN-PLACE (isolamento worktree off). ` +
              "Il task riparte da solo appena il repo torna libero. Non devi fare nulla.",
          });
        } catch { /* task may have moved */ }
      }
      // The fight is over THIS working tree; a card that runs elsewhere has no
      // part in it.
      todos = todos.filter(remoteCard);
      if (todos.length === 0) return;
    }
    // Not holding this tick (repo free, or worktree mode isolates us): forget
    // the episode so a FUTURE hold notes again instead of staying silent.
    for (const t of todos) externallyHeldNoted.delete(t.id);

    // PESO — gli STESSI due predicati che il CAS di `claim` applica, letti qui
    // una volta per tick. Il claim li fa valere in silenzio (torna `null`), e un
    // silenzio lascerebbe le card ferme su `queued` senza che nessuno sappia
    // perché: la regola sta nel claim perché lì è atomica, la spiegazione sta
    // qui perché qui c'è il thread.
    const heavyBusy = (() => {
      try { return deps.svc.hasHeavyInFlight(); }
      catch (err) { log("lettura dei task pesanti in volo fallita", err); return false; }
    })();
    const loadGate = ctx.queue.heavyLoadGate();
    const eligibleNoCheckTaskExists = heavyBusy && todos.some((task) =>
      !inFlight.has(task.id) && !remoteCard(task) && ctx.admission.noCheckReservationFor(task) !== null,
    );
    if (heavyBusy && !eligibleNoCheckTaskExists) {
      // Un pesante in volo blocca OGNI claim, non solo gli altri pesanti: è il
      // senso stesso del peso — quel task si prende la macchina da solo. Niente
      // di questa board parte finché non ha finito, e la coda riparte da sé al
      // reconcile successivo.
      //
      // Si esce PRIMA di far partire l'orologio del freno, e non è un dettaglio
      // di ordine: questa attesa non è quella del carico. Aspettare che un
      // pesante finisca è una regola senza tetto (il turno dura quanto dura), e
      // contarla nel tetto del CARICO significherebbe che il pesante successivo
      // esce dal blocco già «scaduto», cioè parte senza aver mai guardato se la
      // macchina si è liberata. Il tetto esiste per l'attesa che potrebbe non
      // finire mai, non per quella che finisce quando finisce un turno.
      for (const t of todos) {
        if (remoteCard(t)) continue;
        ctx.queue.noteHeavyHold(
          t,
          "In coda: c'è un task PESANTE al lavoro e si prende la macchina da solo. " +
            "Riparto appena ha finito. Non devi fare nulla.",
        );
      }
      // A heavy turn takes THIS machine; a card running elsewhere does not
      // compete with it, so only the remote cards go on to the claim.
      todos = todos.filter(remoteCard);
      if (todos.length === 0) return;
    }
    const nowMs = clock();
    // La chiamata del freno, decisa UNA volta per tick e per task.
    //
    // Prima era un predicato puro (`t.dispatchWeight === "heavy" && !ok`) e lo
    // si poteva rileggere a piacere. Adesso l'attesa ha una DURATA, quindi la
    // decisione ha un effetto (segna l'istante in cui l'attesa comincia) e
    // dipende dall'orologio: valutarla due volte nello stesso giro darebbe due
    // risposte diverse e farebbe scadere il tetto un tick prima o dopo a caso.
    //
    //  'go'     → non trattenuto (leggero, o margine c'è).
    //  'hold'   → pesante, niente margine: aspetta e TIENE la testa della coda.
    //  'forced' → pesante, niente margine, ma l'attesa ha sfondato il tetto:
    //             parte comunque, e nel thread c'è scritto perché.
    // Remote cards first: the local gates below stop the whole pass (heavy
    // hold, full cap), and a card that runs elsewhere must not wait behind them.
    todos = [...todos.filter(remoteCard), ...todos.filter((t) => !remoteCard(t))];
    const heavyCall = new Map<string, "go" | "hold" | "forced">();
    for (const t of todos) {
      if (heavyBusy && !remoteCard(t)) {
        // The ordinary heavyBusy path returns before touching load timers.
        heavyCall.set(t.id, t.dispatchWeight === "heavy" ? "hold" : "go");
        continue;
      }
      if (t.dispatchWeight !== "heavy" || loadGate?.ok !== false || remoteCard(t)) {
        // Non trattenuto: l'attesa (se c'era) è finita, e il prossimo hold
        // ricomincia a contare da capo invece di ereditare quella vecchia.
        heavyHoldSince.delete(t.id);
        heavyCall.set(t.id, "go");
        continue;
      }
      const since = heavyHoldSince.get(t.id);
      if (since == null) { heavyHoldSince.set(t.id, nowMs); heavyCall.set(t.id, "hold"); continue; }
      heavyCall.set(t.id, nowMs - since >= HEAVY_HOLD_MAX_MS ? "forced" : "hold");
    }
    const heldForLoad = (t: Task) => heavyCall.get(t.id) === "hold";
    /** Da quanti ms questo task aspetta il freno (0 = non aspetta). */
    const heldForMs = (t: Task) => { const s = heavyHoldSince.get(t.id); return s == null ? 0 : Math.max(0, nowMs - s); };
    // Chi NON è più trattenuto dal peso dimentica l'episodio, così una prossima
    // attesa lo dice di nuovo invece di restare muta.
    if (!heavyBusy) for (const t of todos) { if (!heldForLoad(t)) heavyHeldNoted.delete(t.id); }

    // Effective concurrency cap for this tick: ONE machine-wide budget counted
    // across EVERY board (scope 'global'), so N boards can't multiply into N×cap
    // agents. 'auto' sizes it from live capacity (CPU/load); otherwise the fixed
    // number set in the global settings dropdown. Computed once so every claim in
    // this tick shares the same budget.
    const capScope: "board" | "global" = "global";
    // Una porta sola per entrambe le strade (dispatch e resume): `currentCap()`
    // legge il tetto globale e lo passa alla stessa funzione che usa la quota di
    // core dello spawn (`agent-job-quota.ts`).
    //
    // Attenzione a riusarlo altrove: questo numero risponde a «quanti agenti
    // NUOVI ammetto ADESSO», ed è apposta reattivo al carico. La quota di core
    // chiede un'altra cosa — «quanti stanno compilando accanto a me» — e la
    // prende dal ROSTER vivo. Usare questo come divisore lo invertiva: macchina
    // carica → raccomandazione 1 → «sono solo» → fetta intera.
    const effectiveCap = ctx.admission.currentCap();
    /**
     * THE RAMP of the "by resources" mode: ONE start per spacing, whatever the
     * door (`rampHeld`).
     *
     * Not out of caution: out of how the measure works. The probe describes the
     * machine of a few seconds ago, and an agent's gates land minutes after its
     * start. With N cards ready on a quiet machine, N verdicts in the same round
     * would all read the same quiet reading, and N agents would start together
     * with no count left to stop them. It happened for real with the cap at
     * zero: fourteen cards in one tick. One every ten seconds is a ramp of six a
     * minute, which gives the measure time to move between two admissions.
     *
     * The clock is the dispatcher's, not this tick's: every board has its own
     * tick, and a resume starts a turn as much as a dispatch does.
     */
    const rampActive = ctx.admission.inResourcesMode();
    let startedThisTick = 0;
    /** The floor re-read once this pass has started a card (see the claim). */
    let midPassFloor: string | null = null;
    let midPassFloorKind: ResourceFloorKind | null = null;
    let floorReadAfterStarts = 0;

    // Le corse dei check pre-review valgono slot: ogni barra in volo satura
    // core nella stessa macchina degli agenti. Si contano UNA volta per tick
    // (non per card: la sonda e' la stessa per tutti i todo di questo giro).
    // `null` = dep assente, comportamento storico (non si contano).
    const gateRuns: number = (() => { try { return deps.checksRunning?.() ?? 0; } catch { return 0; } })();

    // Fan-out richiesto dalla board, e cosa ne resta dopo la realtà. Due
    // condizioni non negoziabili, entrambe silenziose sarebbero una trappola:
    //  - serve l'isolamento worktree (N agenti nella STESSA cartella si
    //    pesterebbero i piedi: sarebbe un fan-out solo sulla carta);
    //  - serve che il host sappia fare worktree e tenere il registro dei
    //    tentativi (test/host degradato ⇒ fan-out spento, lancio singolo).
    const fanOutOff = !deps.attempts || !deps.createWorktree;
    const wantFanOut = fanOutOff ? 1 : Math.max(1, Math.min(settings.dispatchFanOut, MAX_FANOUT));
    const fanOutBlocked = wantFanOut > 1 && !settings.dispatchUseWorktree;
    // Il tetto di concorrenza è il tetto VERO: se non c'è posto per N agenti il
    // fan-out scende a quanti ce ne stanno, e lo si dice nel thread invece di
    // lanciarne meno in silenzio.
    // I gate in volo occupano slot come gli agenti: si sottraggono dal budget
    // prima di calcolare quanti posti restano per nuovi dispatch.
    const freeSlots = Math.max(1, effectiveCap - shared.reservedSlots - gateRuns);
    const fanOut = fanOutBlocked ? 1 : Math.min(wantFanOut, freeSlots);
    // Il pavimento vale anche — soprattutto — per i dispatch NUOVI: è un agente
    // nuovo ad aprire una worktree, cioè a consumare esattamente la risorsa che
    // sta finendo. Letto una volta per tick: la domanda è sulla macchina, non
    // sulla card, e chiederlo per ogni todo sarebbe una statfs per riga.
    const floorNow = ctx.admission.admissionVerdictNow();
    const resourceFloor = floorNow.reason;
    const daySpendBlock = resourceFloor ? null : ctx.admission.spendBrake.dayBlock();
    // The cap "by resources", ONCE per tick like the floor and after it: when
    // the floor or the bill already holds the queue there is nothing left for
    // the pressure to decide, and its probe (a `vm_stat` spawn) is not free.
    // Read once because the question is about the machine, not the card, and
    // because one reading per tick is what makes "nothing starts this round"
    // a single verdict instead of N cards racing the same load average.
    const pressure = resourceFloor || daySpendBlock ? null : ctx.admission.pressureBlock();
    const floorBlock = resourceFloor ?? daySpendBlock ?? pressure;
    // WHAT HOLDS THE WHOLE QUEUE, published where the card mapper can read it
    // (no row records these three: they are about the machine) and turned into
    // the line for the thread. Called every tick, `null` included, so the
    // signal never outlives the block it describes.
    const floorNote = publishDispatchBlock(resourceFloor, daySpendBlock, pressure);
    // WHICH wait the thread line describes, and whether it deserves a line at
    // all. The 120 s warm-up of the memory window gets none: it is guaranteed at
    // every boot, the chip already says it, and a permanent comment saying "the
    // window is empty" on a card whose real reason lands a minute later is the
    // wrong half of the story. Everything else is keyed so the note is rewritten
    // when the wait CHANGES, not only when the block finally lifts.
    const floorNoteKey = resourceFloor
      ? (floorNow.kind === "memory_warmup" ? null : `resources:${floorNow.kind}`)
      : daySpendBlock ? "spend" : pressure ? "pressure" : null;
    // And which block the held cards are SENT with: the warm-up included, since
    // the card reads it, and keyed like a held resume's chip (`holdKey`).
    const floorSent = floorBlock
      ? {
        key: holdKey(resourceFloor ? "resources" : daySpendBlock ? "spend" : "pressure", floorNote, resourceFloor ? floorNow.kind : null),
        reason: floorNote ?? floorBlock,
      }
      : null;
    // The spend caps, read ONCE per tick from the same '*' row that carries the
    // concurrency cap. With the caps off (zero = unlimited, the state of a fresh
    // install) this is the only extra read of the loop: no sum over the spend
    // ledger, and the per-card check below leaves immediately.
    const caps = ctx.admission.spendBrake.caps();
    const noCheckReservationAtRead = noCheckExemptions.hasAny();

    // Chi NON è più trattenuto dal tetto dimentica l'episodio, così una prossima
    // attesa lo dice di nuovo invece di restare muta. Si guarda chi è PARTITO
    // (in volo o dentro la grazia): un task ancora in coda sta ancora aspettando
    // lo stesso tetto, e ripetergli la stessa riga a ogni poll sarebbe rumore.
    for (const t of todos) { if (inFlight.has(t.id) || graceTimers.has(t.id)) capHeldNoted.delete(t.id); }
    // The block has lifted: forget the episode, so the next full disk says it
    // again instead of staying mute forever. It looks at the block and not at
    // the single card, because the block is one per machine.
    // The record of held cards follows the MEMORY floor only: a disk or a bill
    // holding the queue is not a memory hold. Nor is the warm-up
    // (`memory_warmup`): the floor has no two minutes of readings yet, so
    // nothing says this Mac is full.
    const memoryFloorHolds = resourceFloor != null && floorNow.kind === "memory";
    if (!memoryFloorHolds) memoryHeldCards.clear();
    // This round's number, and how many cards the overflow moved in it.
    const overflowRound = { no: overflowRoundNo, moved: 0 };
    if (!floorBlock) {
      floorHeldNoted.clear();
      // The cards sent with the block learn it lifted, once. No write says it
      // (their chip stays `queued`), and the poll that sees the lift may be
      // another board's: without this frame a card that goes on waiting (cap
      // full, already noted) keeps showing a block that is gone.
      for (const id of floorBlockSent.keys()) {
        try { const fresh = deps.svc.get(id)?.task; if (fresh) ctx.queue.emit(fresh); } catch { /* the task may have moved */ }
      }
      floorBlockSent.clear();
    }
    // Agenti vivi ADESSO, e SOLO per spiegare: la decisione resta del CAS dentro
    // `claim`, che è l'unico punto atomico. Non si memoizza per tick — dentro il
    // ciclo i claim che riescono cambiano il numero, e una nota che cita un
    // conteggio di dieci righe fa è peggio di una che non lo cita affatto.
    // `null` = non si sa, e la riga lo dice senza numeri invece di inventarne.
    const aliveAgents = (): number | null => {
      try { return deps.svc.liveAgents({ projectId: capScope === "global" ? null : projectId }); }
      catch { return null; }
    };
    // Da dove esce il tetto (core, RAM, quanta CPU tiene la flotta): una volta
    // per tick, perché la stessa riga va su tutte le card trattenute.
    let reasonCap: string | null | undefined;
    const whyFull = (): string | null => {
      if (reasonCap === undefined) {
        try { reasonCap = deps.capacity?.().reason ?? null; } catch { reasonCap = null; }
      }
      return reasonCap;
    };
    /**
     * «Non c'è posto», scritto sulla card con i numeri che lo producono.
     *
     * Il tetto pieno era l'unica delle tre attese a restare muta: cinque card
     * ferme senza una riga sembrano un sistema rotto, non un sistema che sta
     * aspettando (misurato il 12/08).
     */
    const noteCapFull = (t: Task, vivi: number | null, fanOutServe?: { serve: number; posti: number }): void => {
      const conto = vivi != null
        ? `ci sono ${vivi} agent al lavoro su un tetto di ${effectiveCap}`
        : `il tetto di ${effectiveCap} agent insieme è pieno`;
      const perche = whyFull();
      // QUANTE aspettano dietro. È il terzo numero, e l'unico che dice quanto
      // dura l'attesa invece di perché è cominciata: «il tetto è pieno» con una
      // card in fila e con dodici è la stessa frase per due situazioni diverse.
      // Si contano i todo di questo giro che non sono partiti, questo compreso.
      const fermi = todos.filter((x) => !inFlight.has(x.id) && !graceTimers.has(x.id)).length;
      const fila = fermi > 1 ? ` ${fermi} card sono ferme su questo tetto.` : "";
      // Il caso del fan-out: la card non aspetta UN posto, ne aspetta N insieme,
      // e senza dirlo la riga sembra sbagliata («ci sono 2 posti liberi, perché
      // non parte?»). Il numero di posti liberi e quanti gliene servono sono le
      // due meta' della stessa risposta.
      const perFanOut = fanOutServe && fanOutServe.serve > 1
        ? ` Questa ne vuole ${fanOutServe.serve} insieme e ${fanOutServe.posti === 1 ? "c'è 1 posto libero" : `ci sono ${fanOutServe.posti} posti liberi`}.`
        : "";
      ctx.queue.noteCapHold(
        t,
        `In coda: ${conto}${perche ? ` (${perche})` : ""}.${perFanOut}${fila} ` +
          "Parte da sé appena si libera un posto. Non devi fare nulla.",
      );
    };

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
          && ctx.overflow.overflowOriginUnresolved(t.projectId) && ctx.overflow.anyOverflowSeatElsewhere(localId, t.overflowSkipMachine)) {
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
      const needsNoCheckExemption = heavyBusy
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
      if (heavyBusy && !useNoCheckExemption && !remoteTask) {
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
      if (t.deliveryCommit && deps.deliveryLanded && !reopenedHumanBy) {
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
  return { tick };
}
