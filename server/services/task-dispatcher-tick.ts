/**
 * task-dispatcher-tick.ts: the dispatch pass over one board.
 */
import { UNASSIGNED_PROJECT_ID, type Task } from "./tasks";
import { MAX_FANOUT, UNRESOLVED_PROJECT_PARK_REASON } from "../../shared/board";
import { publishDispatchBlock } from "./dispatch-block-signal";
import { isMirrorCard, HEAVY_HOLD_MAX_MS, holdKey, CHIP_QUEUED, CHIP_FAILED, CHIP_BLOCKED, describeIntruders } from "./task-dispatcher-support";
import { isNodeChildRun } from "./node-child-run";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createTick(ctx: DispatcherCtx) {
  const { capHeldNoted, clock, deps, evaluateNight, externallyHeldNoted, floorBlockSent, floorHeldNoted, graceTimers, heavyHeldNoted, heavyHoldSince, inFlight, log, memoryHeldCards, noCheckExemptions, planHeldNoted, shared } = ctx.core;

  async function tick(projectId: string): Promise<void> {
    // The one gate for a non-primary server: grace timers, blocker events and the
    // manual start all end up here, so no caller can claim a card around it.
    try { await dispatchTick(projectId); }
    finally { ctx.queue.notifyMemoryQueue(); }
  }

  async function dispatchTick(projectId: string): Promise<void> {
    const pass = await preparePass(projectId);
    if (!pass) return;
    await ctx.claim.claimPass(projectId, pass);
  }

  /**
   * The first half of a dispatch pass: everything read ONCE per tick (board
   * settings, the todo list, the machine verdicts, the caps) plus the cards that
   * are parked or released before any claim. Returns the plan the claim pass
   * consumes, or null when the pass has nothing to claim.
   */
  async function preparePass(projectId: string) {
    // First, before any return: a round that ends early is a round that did not
    // hold anything by memory, and the overflow's clock must see it.
    const overflowRoundNo = ctx.overflow.beginOverflowRound(projectId);
    ctx.admission.releaseInactiveNoCheckReservations();
    ctx.admission.releaseOrphanMemorySeat();
    // Project-less tasks are never dispatchable (no cwd): they WAIT quietly on
    // the global board — parking them with "progetto non risolvibile" would be
    // the todo→backlog bounce all over again.
    if (projectId === UNASSIGNED_PROJECT_ID) return null;
    let settings;
    try { settings = deps.svc.getBoardSettings(projectId); }
    catch (err) { log(`getBoardSettings failed for ${projectId}`, err); return null; }
    if (!settings.autoDispatch) return null;
    // A restart is waiting for the fleet to go quiet: picking a card now would
    // keep it waiting forever. The card is not lost, it is next after the boot.
    if (shared.draining) return null;
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
    if (settings.dispatchPaused) return null;

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
        return null;
      }
      if (decision.action === "wait") {
        log(`modalità notturna in attesa su ${projectId}: ${decision.reason}`);
        return null;
      }
    }

    const resolved = deps.resolveProject(projectId);

    let todos: Task[];
    // rootsOnly: a STEP dragged/created in todo must never be claimed as an
    // independent task (it's the checklist of a parent, worked by ITS agent).
    // A secondary server assigns nothing of its own board, but still runs the mirror cards its primary sends.
    const listTodos = () => {
      const all = deps.svc.list({ scope: "project", projectId, status: "todo", rootsOnly: true });
      return deps.isActive?.() === false ? all.filter(isMirrorCard) : all;
    };
    try { todos = listTodos(); }
    catch (err) { log(`list todo failed for ${projectId}`, err); return null; }
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
        try { todos = listTodos(); }
        catch (err) { log(`re-list after heal failed for ${projectId}`, err); return null; }
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
    // A card already parked here stays in Todo (visible) with the spent budget:
    // it is not parked a second time, or the thread would get the note every pass.
    const exhausted = todos.filter((t) =>
      pronto(t) && t.dispatchAttempts >= settings.dispatchRetryCap && t.dispatchState !== CHIP_FAILED);
    let toldExhausted = false;
    for (const t of exhausted) {
      if (inFlight.has(t.id) || graceTimers.has(t.id)) continue;
      try {
        ctx.queue.releaseAndEmit({
          taskId: t.id,
          requeue: false,
          parkState: CHIP_FAILED,
          // It stays in Todo, with its reason: a card parked in backlog after
          // repeated empty rounds disappeared from the column people read.
          keepInTodo: true,
          // «Guarda cosa lo fa fallire» diceva due cose sbagliate in una riga.
          // Presumeva un guasto da trovare, e ci finiva dentro anche chi aveva
          // solo ASPETTATO: fino al rimborso in `deferForWait`, due attese
          // dichiarate bastavano a esaurire il budget e la card veniva accusata
          // di un fallimento che non era successo. Ora le attese hanno il loro
          // contatore e questa riga può dire soltanto ciò che è vero qui: i
          // turni si sono chiusi senza arrivare in review, e la ragione di
          // ciascuno è già scritta nel thread.
          reason:
            `${t.dispatchAttempts} tentativi senza esito (budget ${t.dispatchAttempts}/${settings.dispatchRetryCap}): i turni si sono chiusi ` + // allow-italian: user-facing board comment
            "senza arrivare in review, quindi il task non riparte da solo e resta qui, fermo. Rimettilo in Todo per ridargli i tentativi. " +
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
            reason: UNRESOLVED_PROJECT_PARK_REASON,
          }, { announce: !announced });
          announced = true;
        } catch { /* task may have moved */ }
      }
      return null;
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
      if (todos.length === 0) return null;
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
    const childPasses = (t: Task) => remoteCard(t) || isNodeChildRun(t);
    const eligibleChildExists = heavyBusy && todos.some((task) => !inFlight.has(task.id) && isNodeChildRun(task));
    if (heavyBusy && !eligibleNoCheckTaskExists && !eligibleChildExists) {
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
        if (childPasses(t)) continue;
        ctx.queue.noteHeavyHold(
          t,
          "In coda: c'è un task PESANTE al lavoro e si prende la macchina da solo. " +
            "Riparto appena ha finito. Non devi fare nulla.",
        );
      }
      // A heavy turn takes THIS machine; a card running elsewhere does not
      // compete with it, so only the remote cards go on to the claim.
      todos = todos.filter(childPasses);
      if (todos.length === 0) return null;
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
      if (heavyBusy && !childPasses(t)) {
        // The ordinary heavyBusy path returns before touching load timers.
        heavyCall.set(t.id, t.dispatchWeight === "heavy" ? "hold" : "go");
        continue;
      }
      if (t.dispatchWeight !== "heavy" || loadGate?.ok !== false || childPasses(t)) {
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
    return { aliveAgents, capScope, caps, daySpendBlock, effectiveCap, fanOut, fanOutBlocked, floorBlock, floorNote, floorNoteKey, floorNow, floorSent, gateRuns, heavyBusy, heavyCall, heldForLoad, heldForMs, intruders, loadGate, memoryFloorHolds, noCheckReservationAtRead, noteCapFull, overflowRound, overflowRoundNo, pressure, rampActive, remoteCard, remoteIds, resolved, resourceFloor, settings, todos, wantFanOut };
  }

  return { tick, preparePass };
}

export type TickPlan = NonNullable<Awaited<ReturnType<ReturnType<typeof createTick>["preparePass"]>>>;
