/**
 * task-dispatcher-reconcile.ts: the periodic pass that brings reality and the board back together.
 * 
 * Dead-turn sweeps and the reconcile pass (boot and poll).
 */
import { type Task } from "./tasks";
import { logActivity } from "../db/activity-log";
import { shouldAnnounceResume, DEAD_SESSION_NOTE } from "../lib/dead-run-note";
import { isMirrorCard, BOOT_QUEUED_NOTE, rotateFrom, CHIP_QUEUED, CHIP_WORKING, LIVENESS_DEAD_SWEEPS, RECOVERABLE_DISPATCH_STATES } from "./task-dispatcher-support";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createReconcile(ctx: DispatcherCtx) {
  const { RECONCILE_GRACE_MS, commandWaits, deps, graceTimers, heldOffNoted, inFlight, liveTurns, livenessGraceMs, log, memoryHeldCards, recentlyEnded, retryWaits, slotWaits, shared } = ctx.core;

  /**
   * Close a run whose agent process is gone, and hand the task back to the normal
   * end-of-turn policy.
   *
   * The slot is released FIRST: a dead run must stop being counted as live the
   * moment we know it's dead (the board's concurrency cap counts `in_progress`
   * rows, so this frees the double-launch guard, not the cap — the cap frees when
   * the recovery below decides the task's fate). Then the accounting the turn
   * never got to do
   * (usage booked, live ticker stopped), then `onTurnEnd` — the SAME road every
   * other turn ending takes, which decides between continuing on the session,
   * backing off, delivering what was produced, or parking. No fifth guard with
   * its own opinion.
   */
  function buryDeadRun(taskId: string, runId: number): void {
    if (!ctx.runs.ownsRun(taskId, runId)) return;
    const slot = inFlight.get(taskId)!;
    inFlight.delete(taskId);
    // A REMOTE run has no process, no session and no live turn to account for:
    // the accounting below would book a transcript that does not exist and end
    // a turn that never started here.
    if (slot.node) { ctx.runs.remote.buryRun(taskId, slot.node); return; }
    ctx.admission.cardWeights.finish(taskId);
    if (shared.memorySeatTaskId === taskId) shared.memorySeatTaskId = null;
    ctx.admission.clearNoCheckReservation(taskId);
    ctx.queue.notifyMemoryQueue();
    const lt = liveTurns.get(taskId);
    ctx.usage.endLiveTurn(taskId);
    // I token si scrivono SEMPRE, anche senza un turno vivo in mano: quel ramo
    // `else` era il terzo posto in cui un turno spariva. Il tempo no — senza
    // `turnStartedAt` non c'è un inizio da cui misurarlo, e un'attesa inventata
    // è peggio di un'attesa mancante.
    ctx.usage.bookUsageFloor(taskId, slot.sessionKey, lt?.model ?? null);
    if (lt) ctx.usage.recordTurnMs(taskId, lt.turnStartedAt);
    log(`liveness: sessione ${slot.sessionKey} morta con il turno ancora aperto → recupero il task ${taskId}`);
    // The rule lives in `lib/dead-run-note.ts`, pure and tested: applied here.
    // A late-dying process wrote "I am resuming the task" onto a card that had
    // already reached review, a prediction that is wrong exactly while a human
    // is reading it. The rest of the burial is not conditioned on this.
    if (shouldAnnounceResume(deps.svc.get(taskId)?.task.status)) {
      try {
        deps.svc.addComment({
          taskId, author: "system", kind: "service",
          replaces: DEAD_SESSION_NOTE,
          content:
            DEAD_SESSION_NOTE +
            " mentre il turno era ancora aperto (il processo non c'è più): " +
            "riprendo il task invece di lasciarlo fermo su 'lavora'.",
        });
      } catch { /* dedupe/best-effort */ }
    }
    // Qui la ragione la sappiamo per costruzione: il processo dell'agent non
    // c'è più. Non è un `cancelled` — nessuno l'ha fermato, è morto.
    // Senza turno vivo non c'è un inizio: la durata è 0, che è «non misurata».
    ctx.turnEnd.onTurnEnd(taskId, lt ? Date.now() - lt.turnStartedAt : 0, { end: "error", cause: "process-died" });
  }

  /**
   * Rete di sicurezza sulla liveness (il buco: `inFlight` è solo memoria).
   *
   * `reconcile` salta ogni task in `inFlight`, e quel set si svuota SOLO quando la
   * promise del turno settla. Un figlio che muore senza mai chiudere il suo stream
   * lascia la promise appesa: card ferma su `working`, slot occupato, nessuno sweep
   * che la guardi. Qui si incrocia la memoria con la realtà del processo.
   *
   * Due cautele, entrambe pagate a caro prezzo in passato:
   *  - ISTERESI a due sweep consecutivi (~20s) più una grazia dalla nascita del
   *    run: il probe dice "morto" anche nella finestra in cui il turno esiste ma
   *    il figlio non è ancora nato (assemblaggio del contesto).
   *  - il segnale è la LIVENESS DEL PROCESSO, mai l'inattività: un agente che
   *    pensa a lungo, o che sta compattando, è muto ma vivissimo — un reaper a
   *    idle aveva già ucciso turni vivi (fix 1790f859).
   *
   * Restituisce i task appena sepolti: il ciclo orfani di `reconcile` deve
   * saltarli, o li "recupererebbe" una seconda volta con la nota sbagliata.
   */
  function sweepDeadTurns(): Set<string> {
    const buried = new Set<string>();
    const probe = deps.isTurnAlive;
    const now = Date.now();
    const doomed: Array<{ taskId: string; runId: number }> = [];
    for (const [taskId, slot] of inFlight) {
      // A REMOTE slot is judged by its own lane (consecutive failed polls),
      // never by the local probe nor by the clock: see that module.
      const verdict = ctx.runs.remote.sweepVerdict(slot);
      if (verdict !== "local") {
        if (verdict === "bury") doomed.push({ taskId, runId: slot.runId });
        continue;
      }
      if (!probe) continue;                                 // no local probe: the historical behaviour
      if (!slot.sessionKey) continue;                       // setup: nessuna sessione da sondare
      if (now - slot.sessionAt < livenessGraceMs) continue; // troppo giovane per giudicarla
      let alive: boolean | null;
      try { alive = probe(slot.sessionKey); } catch { alive = null; }
      if (alive !== false) { slot.deadSweeps = 0; continue; } // vivo, o "non so": mai seppellire
      slot.deadSweeps++;
      if (slot.deadSweeps >= LIVENESS_DEAD_SWEEPS) doomed.push({ taskId, runId: slot.runId });
    }
    for (const d of doomed) {
      buryDeadRun(d.taskId, d.runId);
      buried.add(d.taskId);
    }
    return buried;
  }
  function reconcile(opts?: { reason?: "boot" | "poll" }): Promise<void> {
    if (shared.reconciling) return shared.reconciling;
    shared.reconciling = reconcilePass(opts).finally(() => { shared.reconciling = null; });
    return shared.reconciling;
  }

  async function reconcilePass(opts?: { reason?: "boot" | "poll" }): Promise<void> {
    ctx.admission.releaseInactiveNoCheckReservations();
    const reason = opts?.reason ?? "boot";
    // The notes below used to assume a restart: on the 10 s poll that is a
    // lie, and it was read as one (a restart that never happened).
    const perche = reason === "boot"
      ? "Il server e' ripartito mentre questa card lavorava"
      : "Questa card risulta al lavoro ma non ha nessun turno vivo (turno riciclato o finito senza consegna)";
    // 0) Turns whose agent process died without ever settling their promise —
    //    the one case the orphan pass below can't see (it skips `inFlight`).
    // 0-bis) THE REMOTE RUNS, polled BEFORE the sweep: a failure counted now is
    //    what the sweep below judges, and a success is what resets the count.
    await ctx.runs.remote.poll();
    const justBuried = sweepDeadTurns();
    ctx.runs.pollCommandWaits();
    // 1) Recover orphaned in-progress tasks (server restarted mid-turn): they are
    //    in_progress + mid-dispatch chip, but we have no live launch for them.
    let running: Task[] = [];
    try { running = deps.svc.list({ scope: "all", status: "in_progress" }); }
    catch (err) { log("reconcile list failed", err); }
    if (deps.isActive?.() === false) running = running.filter(isMirrorCard);
    // IL RECUPERO ARRIVA NEL LOG. Il 18/08 il server ha ripreso 303 card e
    // `grep 'Server ripartito' topics-server.log` ne trovava ZERO: le note
    // andavano solo in `task_comments`, quindi per sapere quante card aveva
    // ripreso un riavvio bisognava interrogare il database. I contatori qui
    // sotto diventano UNA riga sola in fondo al passo, non una riga per card:
    // con 303 riprese il per-card e' un allagamento, non una misura.
    let directIn = 0, daCapo = 0, inCoda = 0, nonRecuperabili = 0, fanOut = 0, heldOff = 0, parked = 0;
    for (const t of running) {
      if (inFlight.has(t.id)) continue; // we own it, leave it
      if (reason !== "boot") {
        const endedAt = recentlyEnded.get(t.id);
        if (endedAt !== undefined) {
          if (Date.now() - endedAt < RECONCILE_GRACE_MS) continue;
          recentlyEnded.delete(t.id);
        }
      }
      // Un'attesa di slot VIVA (il resume rinviato a tetto pieno) non ha un turno,
      // quindi non lascia traccia in `inFlight`: da qui è indistinguibile da un
      // fantasma del riavvio — stessa riga `in_progress`, stesso chip `queued`.
      // Requeuarla sarebbe il guasto di prima al contrario: il messaggio
      // dell'umano muore col timer e la card riparte su un topic nuovo. Il
      // registro è la differenza, e vive in memoria come il timer: se il processo
      // è ripartito è vuoto, e allora la card è orfana per davvero.
      if (slotWaits.has(t.id)) continue;
      // Un RITENTATIVO gia' programmato: stessa forma dell'attesa di slot qui
      // sopra — nessun turno vivo, quindi nessuna traccia in `inFlight` — e
      // stessa conseguenza se lo si ignora, moltiplicata per il poll: la card
      // viene svegliata ogni 10 secondi contro una sessione occupata. Vedi
      // `retryWaits` per la misura.
      if (retryWaits.has(t.id)) continue;
      // Waiting for its command's wake: the wake starts it again, see `commandWaits`.
      if (commandWaits.has(t.id)) continue;
      // Just buried above: its recovery is already scheduled (onTurnEnd). Without
      // this it would ALSO look like a restart orphan and get a second, wrong
      // recovery ("il server è ripartito", which never happened).
      if (justBuried.has(t.id)) continue;
      // A card that names a NODE is never resumed HERE: its lane puts it back
      // in the queue instead (`task-dispatcher-remote-node.ts`).
      const remoteQueued = await ctx.runs.remote.queueAfterRestart(t);
      if (remoteQueued !== null) { if (remoteQueued) inCoda++; continue; }
      // Only touch tasks the DISPATCHER had in hand when the process died:
      // mid-turn (working), mid-claim (starting — the claim precedes bindTopic,
      // so an early crash leaves the binding NULL), or waiting for a slot
      // (queued — an attesa that lived only in memory). A human who drags a
      // review/done card (chip null or needs_input) into In Progress is NOT an
      // orphan — leave it be.
      if (!RECOVERABLE_DISPATCH_STATES.has(t.dispatchState ?? "")) {
        ctx.admission.clearNoCheckReservation(t.id);
        // ...ma se e' stato IL SERVER a tagliarla (solo allora la card porta
        // `interrupted_at`, scritto dallo spegnimento), il salto va detto: qui
        // non passera' mai piu' nessun recupero, e finora era un `continue`
        // muto. `noteStranded` tace da sola per le card mosse a mano e per
        // l'interruzione gia' raccontata, quindi il conteggio si incrementa
        // solo quando la nota e' uscita davvero.
        try {
          const chip = t.dispatchState ? `«${t.dispatchState}»` : "nessun chip";
          const detta = deps.svc.noteStranded({
            taskId: t.id,
            note:
              `${perche}, ma il suo stato (${chip}) non e' fra quelli che il recupero riprende: ` +
              "nessun turno ripartira' da solo. Per rimetterla in moto riportala in Todo, oppure chiudila.",
          });
          if (detta) nonRecuperabili++;
        } catch { /* best-effort: il reconcile non si ferma per una nota */ }
        continue;
      }
      // Un FAN-OUT orfano non si "riprende sulla stessa sessione": di sessioni
      // ne aveva N, e `assigned_topic_id` ne punta una sola (il tentativo 1).
      // Riprendere quella abbandonerebbe le altre in silenzio. Si chiude il giro
      // con ciò che i worktree hanno conservato e decide l'umano.
      // A single launch writes its own attempt row as HISTORY (see `launch`),
      // so a card mid-turn at boot always has one still "running", on the very
      // topic the card is bound to. A fan-out round is recognisable by its
      // SIBLINGS: running rows on OTHER topics (attempt 1 is bound to the task
      // from the moment its topic exists, see `runAttempt`). Read every running
      // row as a fan-out, the reconcile closed bound cards "without a commit"
      // at every restart and reaped their worktrees: three cards on 2026-09-04.
      let orphanAttempts = 0;
      let siblings = 0;
      try {
        const running = (deps.attempts?.list(t.id) ?? []).filter((a) => a.state === "running");
        orphanAttempts = running.length;
        siblings = running.filter((a) => !t.assignedTopicId || a.topicId !== t.assignedTopicId).length;
      } catch { orphanAttempts = 0; siblings = 0; }
      if (siblings > 0) {
        try {
          deps.svc.claimInterruption({
            taskId: t.id,
            note:
              `Il server è ripartito mentre ${orphanAttempts} ${orphanAttempts === 1 ? "tentativo del fan-out lavorava" : "tentativi del fan-out lavoravano"}: ` +
              "i turni sono morti col processo, ma i worktree no. Chiudo il giro con quello che avevano committato.",
          });
        } catch { /* best-effort */ }
        fanOut++;
        void ctx.fanout.recoverOrphanedFanOut(t.id);
        continue;
      }
      // Everything a `working` orphan needs to CONTINUE survived the restart in
      // SQLite: the topic (systemPrompt/worktree/model), the task binding, and
      // the CLI conversation (claude_code_sessions + --resume). Only the
      // in-memory turn driver died. So resume IN PLACE — same topic, same
      // worktree, lean continuation nudge — instead of release+re-claim, which
      // would spawn a fresh topic+worktree and restart the agent from zero on
      // every deploy/hot-reload (KANBAN-10; same principle as the post-timeout
      // continuation). No attempt is consumed: a restart is never the agent's
      // fault. The resume gate: chip `working` (a `starting` orphan may have
      // died before the kickoff ever reached the CLI — re-claim is cleaner),
      // a LIVE topic (absent probe ⇒ trust the binding, like the tick heal),
      // and the global dispatch switch still ON.
      let autoOn = false;
      try { autoOn = deps.svc.getBoardSettings(t.projectId).autoDispatch; } catch { /* treat as off */ }
      // A card that was WAITING for a slot has a session as much as one that
      // was mid-turn: the wait lived in memory, the conversation and the
      // worktree did not. Requeueing it handed the next agent an EMPTY
      // worktree (2026-09-04: twelve cards at one boot, eight of them with
      // uncommitted work) for the sole reason that the cap was full, or the
      // switch off, when the process died.
      const topicId = t.assignedTopicId;
      if ((t.dispatchState === CHIP_WORKING || t.dispatchState === CHIP_QUEUED) && topicId) {
        let alive = true;
        try { alive = deps.topicExists ? deps.topicExists(topicId) : true; } catch { alive = true; }
        if (alive && !autoOn) {
          // The switch is off: nothing may start, but nothing is lost either.
          // The binding stays, the chip says "in coda", and the poll resumes
          // this very session the moment the switch is back on. Said ONCE per
          // hold: the poll passes here every 10 s for as long as the switch
          // stays off.
          if (!heldOffNoted.has(t.id)) {
            heldOffNoted.add(t.id);
            try {
              deps.svc.claimInterruption({
                taskId: t.id,
                note: "Dispatch spento: tengo la sessione e il worktree di questa card, riparte da sola (stessa sessione) quando riaccendi il dispatch.",
              });
            } catch { /* dedupe/best-effort */ }
            if (t.dispatchState !== CHIP_QUEUED) {
              try { ctx.queue.emit(deps.svc.setDispatchState({ taskId: t.id, state: CHIP_QUEUED })); } catch { /* best-effort */ }
            }
            heldOff++;
          }
          continue;
        }
        if (alive) {
          // Broker survived the restart with the turn STILL RUNNING → reattach
          // in place (seamless, no re-run). Only when there's no live session do
          // we fall back to resume-from-scratch (the pre-broker behaviour).
          //
          // DAL 16/08 QUESTA SONDA RISPONDE SEMPRE FALSE, E DICE LA VERITA'.
          // Le card girano sul runtime nativo, il cui turno vive DENTRO il
          // processo del server: quando il server muore, il turno muore, e non
          // c'e' nessun figlio da adottare. L'unica cosa adottabile e' un
          // figlio del broker ai-bridge, ed e' per quello che la sonda
          // interroga solo `claude-code`. Il salto nella misura (365 riadozioni
          // il 13/08, 0 il 18/08) e' quel cambio di runtime, non una
          // regressione: il ramo `resume(continuation)` qui sotto non e' un
          // ripiego difettoso, per il nativo e' l'unica strada. Farla
          // rispondere vero sarebbe il guasto peggiore, ed e' gia' successo
          // una volta (vedi il commento a server.ts:812-826).
          let live = false;
          if (deps.hasLiveSession && deps.reattach) {
            const sessionKey = "topic:" + topicId.slice(0, 8);
            try { live = await deps.hasLiveSession(sessionKey); } catch { live = false; }
          }
          // The probe awaited: a human's comment or a retry timer may have
          // resumed or parked this card in the meantime, and resuming it again
          // would only count it twice.
          if (inFlight.has(t.id) || slotWaits.has(t.id)) continue;
          if (live) {
            try {
              deps.svc.claimInterruption({
                taskId: t.id,
                note: "Riavvio del server: ripreso in diretta, nessun tentativo consumato.",
              });
            } catch { /* dedupe/best-effort */ }
            directIn++;
            void ctx.resume.reattachTask(t.id);
            continue;
          }
          // Owed a command's wake after a restart: the wait lived in memory, the
          // command did not (`routes/processes.ts` re-adopts it), and its wake
          // starts the card again as it would have without the restart. A card
          // cut mid-turn with such a command running waits too: the wake's turn
          // is where it goes on, instead of a nudge that meets the command
          // running. After the switch and the broker on purpose: a held card
          // stays held, and a surviving turn is read to its end, which waits
          // on its own (`onTurnEnd`).
          if (ctx.runs.awaitCommandWake(t, true)) continue;
          // UNA BOCCIATURA UMANA NON E' UN TURNO INTERROTTO.
          //
          // `buildContinueNudge` says "your previous turn was interrupted, no
          // fault of yours, carry on ONLY with the work that is left" — which
          // is the exact opposite of what happened when a person rejected the
          // delivery with three objections. The rejection text lived in
          // `slotWaits`, a Map in memory, because the floor was holding the
          // resume: the first restart lost it and every restart after that
          // handed the agent the interrupted-turn nudge instead. Measured
          // 2026-09-17: 3 cards rejected on the 15th, stopped 45 hours, 44
          // restarts each, and the words still sitting unread in the thread.
          //
          // The words themselves come from the service (`pendingHumanReopen`),
          // which owns both the row that says who reopened and the record of
          // which comments a resume envelope has already carried.
          let rejection: { text: string; commentIds: string[] } | null = null;
          try { rejection = deps.svc.pendingHumanReopen({ taskId: t.id }); }
          catch { rejection = null; }
          // A card cut on a question its person has not answered is waiting, not
          // interrupted: the nudge would tell the agent to carry on without the
          // answer. The answer reaches the session through the chat route. A human
          // rejection above still resumes: it is news the agent has not read.
          let onQuestion = false;
          try { onQuestion = !rejection && !!deps.hasOpenQuestion?.("topic:" + topicId.slice(0, 8)); }
          catch { onQuestion = false; }
          if (onQuestion) {
            try {
              deps.svc.claimInterruption({
                taskId: t.id,
                note: "Server ripartito mentre la card aspettava una tua risposta: non la riprendo da sola, riparte quando rispondi.",
              });
            } catch { /* dedupe/best-effort */ }
            continue;
          }
          try {
            deps.svc.claimInterruption({
              taskId: t.id,
              note: rejection
                ? "Riprendo la stessa sessione con la tua bocciatura, che il turno precedente non aveva ancora ricevuto: nessun tentativo consumato."
                : reason === "boot"
                  ? (t.dispatchState === CHIP_QUEUED
                    ? `${BOOT_QUEUED_NOTE}: riprendo la stessa sessione appena c'è posto, nessun tentativo consumato.`
                    : "Server ripartito a metà turno: riprendo la stessa sessione, nessun tentativo consumato.")
                  : "Nessun turno vivo su questa card (riciclato o finito senza consegna): riprendo la stessa sessione, nessun tentativo consumato.",
              // One row per card for the queued boot note, see `BOOT_QUEUED_NOTE`.
              slot: !rejection && reason === "boot" && t.dispatchState === CHIP_QUEUED ? BOOT_QUEUED_NOTE : undefined,
            });
          } catch { /* dedupe/best-effort */ }
          // A brokerless restart starts a new turn, so its old exemption slot
          // must not remain attached to a dead run.
          ctx.admission.clearNoCheckReservation(t.id);
          // Sets inFlight synchronously → the 10s poll can never double-fire.
          if (rejection) void ctx.resume.resumeInBackground(t.id, rejection.text, { commentIds: rejection.commentIds });
          else void ctx.resume.resumeInBackground(t.id, "", { continuation: true });
          // COUNTED BY WHAT HAPPENED, not by the call. `resume` is synchronous up
          // to its start (`beginRun`) or its wait (`slotWaits`), so the two maps
          // already say which one it was. Counting the call wrote «riprese» for
          // cards the floor had parked, which read as a stampede that never
          // happened.
          if (inFlight.has(t.id)) daCapo++;
          else if (slotWaits.has(t.id)) parked++;
          continue;
        }
      }
      // No session to resume (binding never made, topic reaped, kickoff never
      // launched, or dispatch turned off): requeue and roll back the interrupted
      // attempt so a few deploys/kickstarts can't exhaust the retry budget and
      // park a healthy task in backlog "per errore". Genuine failures still
      // park via onTurnEnd.
      try {
        // Un fantasma `queued` non stava lavorando: stava aspettando un posto,
        // e l'attesa è morta col processo. Dirgli "mentre l'agent lavorava"
        // manderebbe l'umano a cercare un lavoro che non c'è mai stato.
        const nota = t.dispatchState === CHIP_QUEUED
          ? "Il server è ripartito mentre il task aspettava uno slot libero e la sua sessione non c'è più: lo rimetto in coda (il riavvio non consuma un tentativo)."
          : "Il server è ripartito mentre l'agent lavorava: task rimesso in coda (il riavvio non consuma un tentativo).";
        // La nota passa dal cancello, la release no: il task torna in coda
        // comunque, ma se questa interruzione è già stata raccontata (un
        // riavvio prima, un altro scrittore) qui non si aggiunge una quarta
        // versione della stessa cosa. Il `reason` non serve altrove: con
        // `requeue: true` non c'è evento di park che lo porti.
        deps.svc.claimInterruption({ taskId: t.id, note: nota });
        ctx.queue.releaseAndEmit({
          taskId: t.id,
          requeue: true,
          rollbackAttempt: true,
        });
        // On a board that never dispatches the requeue's `queued` chip would
        // strand forever (tick no-ops with the switch off) — clear it.
        if (!autoOn) ctx.queue.emit(deps.svc.setDispatchState({ taskId: t.id, state: null }));
        inCoda++;
      } catch (err) { log(`reconcile release failed for ${t.id}`, err); }
    }
    if (directIn + daCapo + parked + inCoda + nonRecuperabili + fanOut + heldOff > 0) {
      log(
        `riavvio: ${directIn + daCapo} riprese (${directIn} in diretta, ${daCapo} da capo), ${parked} in attesa di un posto, ` +
        `${inCoda} rimesse in coda, ${heldOff} trattenute a dispatch spento, ${fanOut} fan-out chiusi, ${nonRecuperabili} non recuperabili`,
      );
    }
    // 1-ter) IL CHIP «IN CODA» RIMASTO ACCESO IN BACKLOG.
    //    Il `claim` reclama `status = 'todo'` e basta: in Backlog quel chip non
    //    e' «un agente che sta per nascere», e' una riga che promette una
    //    partenza che non arrivera' mai. Da li' nasceva il giro muto della card
    //    05ae83f7 — la card offriva «Ferma» per un agente mai nato.
    //
    //    `onLeaveTodo` adesso lo spegne nel gesto, ma le righe gia' ferme non
    //    vedranno mai piu' quel gesto: questa passata le raccoglie, una volta,
    //    senza bisogno di una migration. Sta PRIMA del cancello globale perche'
    //    un chip che mente va spento anche a dispatch spento.
    try {
      for (const t of deps.svc.list({ scope: "all", status: "backlog" })) {
        if (t.dispatchState !== CHIP_QUEUED) continue;
        if (inFlight.has(t.id) || graceTimers.has(t.id)) continue;
        try { ctx.queue.emit(deps.svc.setDispatchState({ taskId: t.id, state: null })); }
        catch { /* best-effort: la riga puo' essersi mossa */ }
      }
    } catch (err) { log("sweep del chip in coda in backlog fallito", err); }
    // 1-ter-bis) THE ACTIVE CHIP LEFT ON A REVIEW CARD. A turn that took its
    //    card to review and ended without `onTurnEnd` (an adoption that dropped
    //    the turn, a crash between the two) leaves `queued` on a card in the
    //    Review column: a551b940 read "in coda" from review for a day on
    //    23/09/2026. No resume will ever look at it again, so the boot does.
    //    Once per boot, cheap: review is a short column.
    if (reason === "boot") {
      try {
        for (const t of deps.svc.list({ scope: "all", status: "review" })) ctx.turnEnd.settleStrandedReviewChip(t);
      } catch (err) { log("sweep of the active chip on review cards failed", err); }
    }
    // 1-quinquies) A CARD NOBODY OWNS, in backlog past ten minutes. This is the
    //    coordinator's event, not a banner: `task:unowned` on the socket for a
    //    connected one, and an activity_log row for one that is not (Jarvis
    //    reads `GET /api/activity/log?category=board`). `sweepUnownedBacklog`
    //    stamps each card before returning it, so a card is reported once per
    //    round and the 10 s poll does not repeat itself. Its own `try`: the
    //    event is information and must never take the sweeps above or the
    //    tick below down with it. It sits BEFORE the global auto-dispatch gate:
    //    a card nobody owns is just as unowned with the switch off (maybe more).
    try {
      for (const t of deps.svc.sweepUnownedBacklog()) {
        const waitedMinutes = Math.floor(Math.max(0, Date.now() - Date.parse(t.updatedAt)) / 60_000);
        log(`card senza padrone in backlog da ${waitedMinutes} min: ${t.id}`);
        deps.broadcast({
          type: "task:unowned", projectId: t.projectId, taskId: t.id, taskTitle: t.text || "Task",
          createdBy: t.createdBy ?? null, waitedMinutes,
        });
        (deps.recordActivity ?? logActivity)({
          category: "board", level: "warn", title: "card senza padrone in backlog",
          detail: `${t.text || "Task"} (${waitedMinutes} min)`,
          entityType: "task", entityId: t.id, actor: t.createdBy ?? undefined,
          metadata: { projectId: t.projectId, createdBy: t.createdBy ?? null, waitedMinutes },
        });
      }
    } catch (err) { log("avviso card senza padrone fallito", err); }
    // 1-bis) LE CHECKLIST FERME CHE NESSUNO STA GUARDANDO. La domanda sui figli
    //    fermi si arma su due EVENTI (un figlio che si ferma, il turno del padre
    //    che finisce), e una card che si era fermata prima non ne vedrà mai un
    //    altro: nessun turno tornerà lì a scoprirlo. Il 13/08 erano sette padri
    //    e ventuno card, ferme sotto la soglia mentre le colonne si disegnavano
    //    vuote — la board fetcha `rootsOnly`, e gli step non ci stanno dentro.
    //
    //    Sta QUI, prima del giro delle board, per due ragioni: il posto dove si
    //    guarda l'intera macchina è questo (il `tick` è per board, e un padre
    //    fermo non è un problema di una board), e i padri che passano in review
    //    escono dalla lista dei todo che il passo 2 sta per leggere.
    //
    //    Solo sulle board ACCESE, come il `tick`. Su una board spenta nessuna
    //    coda scorre: le due risposte («rimetti in coda» / «archivia») non
    //    farebbero partire niente, e una card mossa da sola dove qualcuno ha
    //    spento la macchina è la sorpresa che spegne la fiducia nel chip.
    //
    //    L'INTERRUTTORE SI LEGGE UNA VOLTA SOLA, e prima di tutto. È la riga
    //    globale `*` (`getGlobalAutoDispatch`): con quella spenta ogni `tick`
    //    esce alla seconda riga e `acceso` risponde `false` a ogni board, quindi
    //    tutto ciò che segue è lavoro che finisce nel cestino. Chiederla per
    //    board dentro `sweepParkedChildren` e poi rifare il giro dei todo
    //    significava pagare quel cestino ogni 10 secondi.
    if (!(() => { try { return deps.svc.getGlobalAutoDispatch(); } catch { return false; } })()) {
      // The switch is global (a board's `autoDispatch` reads and writes it).
      // Nothing ticks with it off, so no round can clear a stale hold record:
      // they go here, along with the carried-branch answers they keep alive.
      for (const id of [...memoryHeldCards.keys()]) ctx.overflow.forgetOverflowClock(id);
      return;
    }
    const acceso = (projectId: string): boolean => {
      try { return deps.svc.getBoardSettings(projectId).autoDispatch; } catch { return false; }
    };
    try {
      for (const t of deps.svc.sweepParkedChildren({ by: "dispatcher", eligible: acceso })) {
        log(`checklist ferma: alzata la domanda su ${t.id}`);
        ctx.queue.emit(t);
      }
    } catch (err) { log("sweep delle checklist ferme fallito", err); }
    // 1-quater) LA SERIE DI ATTESE CHE NESSUNO CRONOMETRAVA.
    //    `WAIT_SERIES_MAX_MS` had one reader, inside `deferForWait`: the cap
    //    fired only if another turn started and re-declared the same wait. With
    //    admissions held the series just grew — 2 cards past the 4-hour cap by
    //    45 and 31 hours on 2026-09-17, zero `waited_out` parks in the whole
    //    history, and `waited_out` is the only state that reaches a push
    //    notification. This pass already walks card by card, so the clock is
    //    read here.
    //
    //    Its own `try`, and not the one above: a sweep that throws must not take
    //    the other one down with it — that is how a backstop stays a backstop.
    //
    //    `busy` is the whole difference between a park and a turn cut in half: a
    //    card with a live turn, a queued resume, a scheduled retry or an open
    //    grace window is OURS, whatever the row says.
    //
    //    BEFORE THE `tick`, ON PURPOSE. The two only ever fire in the same pass
    //    when a card's requested wake-up lands on the very instant its series
    //    tops the cap, and after `waitedOutIfCapped` learned to read
    //    `dispatch_deferred_until` that can only happen to a real SERIES —
    //    streak two or more, so at least two turns have already come back to
    //    look at this condition and asked for more time. The cap exists to stop
    //    the next one. A single wait never meets the two conditions together:
    //    its clock starts at the wake-up, so the retry is always four hours
    //    ahead of the park.
    //
    //    AND IT DOES NOT RUN WITH GLOBAL DISPATCH OFF: the `return` above stops
    //    the pass, exactly as it does for `sweepParkedChildren`. That is the
    //    state in which a card can sit past the cap indefinitely, and it is
    //    still the right call — `waited_out` is a push notification asking a
    //    person to decide about a card, and with the queue deliberately off the
    //    honest answer is that NOTHING is moving, not that this one card needs
    //    attention. Nothing is lost while it is off: the clock lives on the row
    //    (`wait_since`), not in this process, so the first pass after the
    //    switch comes back on parks whatever went past the cap meanwhile.
    try {
      const ours = (taskId: string): boolean =>
        inFlight.has(taskId) || slotWaits.has(taskId) || retryWaits.has(taskId) || graceTimers.has(taskId);
      for (const t of deps.svc.sweepWaitedOut({ eligible: acceso, busy: ours })) {
        log(`serie di attese oltre il tetto: ${t.id} parcheggiata`);
        ctx.queue.emit(t);
      }
    } catch (err) { log("sweep delle serie di attese fallito", err); }
    // 1-quater-bis) A CARD PARKED BY THE MACHINE GOES BACK BY ITSELF (see
    //    `sweepMachineWaitedOut`). After the pass above: a card parked just now
    //    has a fresh `updated_at` and does not come back in the same pass.
    try {
      for (const t of deps.svc.sweepMachineWaitedOut({ eligible: acceso })) {
        log(`card fermata dalla macchina rimessa in coda: ${t.id}`);
        ctx.queue.emit(t);
      }
    } catch (err) { log("rientro delle card fermate dalla macchina fallito", err); }
    // 1-quater-ter) A card parked because its board mapped to no project
    //    directory returns once the directory is found again.
    try {
      for (const t of deps.svc.sweepUnresolvedProjectParked({
        resolvable: (projectId) => acceso(projectId) && !!deps.resolveProject(projectId),
      })) {
        log(`cartella del progetto di nuovo trovata: ${t.id} rimessa in coda`);
        ctx.queue.emit(t);
      }
    } catch (err) { log("rientro delle card senza cartella fallito", err); }
    // 2) Opportunistically fill free slots on every board that has queued todos.
    //
    //    UNA PROIEZIONE, NON I TASK. Qui serve un insieme di id di board, e si
    //    otteneva idratando OGNI todo di OGNI board — payload completo per
    //    riga: etichette, bloccante, ragione di coda, commenti — per poi
    //    leggerne solo `projectId` e buttare il resto. Ogni 10 secondi. Era il
    //    pavimento di CPU che il freno del dispatch misurava, cioè un freno che
    //    frenava sé stesso.
    const boards = new Set<string>();
    try { for (const projectId of deps.svc.boardsWithQueuedTodos()) boards.add(projectId); }
    catch (err) { log("reconcile todo list failed", err); }
    // A card that left Todo by a path that calls neither hook (a direct write,
    // a sweep) on a board with nothing else queued: its clock goes here.
    ctx.overflow.pruneOverflowClocksOutside(boards);
    // A TURNO, non sempre nello stesso ordine. Il tetto è globale: la board che
    // tocca per prima riempie i posti, e chi viene dopo non ne trova mai. Con
    // l'ordine fisso della lista, l'11/08 una board ha preso 26 claim su 31 in
    // un'ora mentre un'altra, con tre card in coda, ne prendeva ZERO — non per
    // priorità, per posizione. Il cursore fa scorrere chi comincia, così ogni
    // board arriva prima a giro suo e nessuna resta indietro per sempre.
    const ordinate = rotateFrom([...boards], shared.boardCursor);
    if (ordinate.length > 1) shared.boardCursor = (shared.boardCursor + 1) % ordinate.length;
    for (const projectId of ordinate) {
      await ctx.tick.tick(projectId).catch((err) => log(`reconcile tick failed for ${projectId}`, err));
    }
  }
  return { reconcile };
}
