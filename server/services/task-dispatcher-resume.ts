/**
 * task-dispatcher-resume.ts: continuing a card after a human message or a stop.
 * 
 * The resume and continue-nudge prompts, the held-resume gate, the resume turn
 * itself and the reattach of a turn that survived a restart.
 */
import { LAND_ACTION_LABEL, type Task } from "./tasks";
import { PREVIEW_RULE, RECOMMENDED_OPTION_RULE, REVIEW_CARD_RULE } from "../../shared/board";
import { type ResourceFloorKind } from "./dispatch-capacity";
import { daySpendSentence, heldResumeBlock, setHeldResumeBlock, type DispatchBlockKind } from "./dispatch-block-signal";
import { classifyTurnError, type TurnEndInfo } from "../providers/stop-reason";
import { runWithDelegatedDeadline } from "./task-dispatcher-delegated";
import { isMirrorCard, WAITING_MEMORY, RESUME_SLOT_RETRY_MS, HELD_RESUME_REFRESH_MS, holdKey, RESUME_WAIT_OPENINGS, CHIP_QUEUED, CHIP_WORKING } from "./task-dispatcher-support";
import { warnIfBusy } from "../lib/sqlite-busy";
import { onProjectResumed, type TurnOrigin } from "./turn-gate";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createResume(ctx: DispatcherCtx) {
  const { attemptCap, beginDelegated, clock, delegatedPolicy, deps, heldWritten, inFlight, log, noCheckExemptions, recordDelegated, slotWaits, waitingForSlot, shared } = ctx.core;

  /** Cards whose pending resume carries a person's message: the pause never holds it. */
  const personWrote = new Set<string>();
  const PAUSED_SENTENCE = "In pausa: limite del progetto";

  // When a pause closes, the held resumes of that project retry NOW instead of
  // at the next slot timer, and the project's todo cards get a tick.
  const offResumed = onProjectResumed((projectId) => {
    for (const [taskId, w] of [...slotWaits]) {
      let owner: string | null | undefined;
      try { owner = deps.svc.get(taskId)?.task.projectId; } catch { continue; }
      if (owner !== projectId) continue;
      clearTimeout(w.timer);
      slotWaits.delete(taskId);
      void resumeInBackground(taskId, w.message, { commentIds: w.commentIds, continuation: !w.message.trim() });
    }
    void ctx.tick.tick(projectId).catch((err) => log(`tick after pause for ${projectId} failed`, err));
  });

  // allow-emdash-block: prompt di ripresa e di sollecito, stessa ragione.
  function buildResume(task: Task, humanMessage: string): string {
    return [
      `Human update on task \`${task.id}\`:`,
      humanMessage.trim() || "(no text, carry on with your own judgement)",
      "",
      `Before you resume, run get_task(task_id="${task.id}"): the human may have added steps, or comments on steps, while you were stopped. Open steps = your work (close them with status="done").`,
      // Same delivery contract as the kickoff — the resume envelope MUST repeat it,
      // or the agent (with only this message in front of it) forgets to summarise
      // and hands back a mute review. This is the "altro da fare?" → review-without-
      // comment gap. Even "niente di nuovo" is a valid summary.
      `Carry on with the work. On delivery, BEFORE moving to review, ALWAYS write a summary comment for THIS turn with comment_task (1-2 sentences: what you did now, where to look — or "nothing new" with the reason). THEN update_task(task_id="${task.id}", status="review"). Without a comment from this turn the server refuses the review.`,
      // Same string as the kickoff: the resume is the only message in front of
      // an agent that comes back, and it writes the review card from it.
      REVIEW_CARD_RULE,
      // Stessa costante del kickoff, non un riassunto: il resume è l'unico
      // messaggio davanti all'agente che riprende, e la versione «corta» che
      // stava qui aveva già perso per strada il ramo del diagramma.
      PREVIEW_RULE,
      // Same reason as the line above, and the same precedent: the resume is the
      // ONLY message in front of an agent that comes back, and a rule that lives
      // only in a tool schema is read when the tool is called, not while the
      // agent decides WHETHER the answer needs options at all. `PREVIEW_RULE`
      // has an MCP carrier too (the `preview_image` description of
      // `update_task`) and is repeated here anyway, with a gate that demands it
      // (`tests/unit/preview-rule-in-envelope.test.ts`). Rule 5-bis of
      // `docs/board-protocol.md` names the envelopes and the two `options`
      // descriptions as carriers of one string: the resume is an envelope.
      RECOMMENDED_OPTION_RULE,
      `If you committed landable code, offer ONLY options=["${LAND_ACTION_LABEL}"] → the system does the LOCAL merge onto main (no push). You never do a git merge/push. Publishing online is separate, the human does it from the board's "Pubblica" control: do NOT propose it. No option at all if there is no committed code.`,
    ].join("\n");
  }

  /** The auto-continuation message after a turn that ended without reaching
   *  review. Escalates toward DELIVERY as the retry budget runs down: a plan-first
   *  or investigative agent that keeps ending turns without a hand-off otherwise
   *  burns the whole budget and gets parked — so the last continuation forces a
   *  deliver-what-you-have, and even then onTurnEnd hands a worked task to review
   *  rather than failing it. */
  function buildContinueNudge(task: Task, cap: number): string {
    // The NEXT turn is the last one when this attempt already reached the cap.
    const lastChance = task.dispatchAttempts >= cap;
    if (lastChance) {
      return [
        `LAST TURN on \`${task.id}\`: do not start new work and do not keep investigating.`,
        `Deliver NOW what you have — get_task(task_id="${task.id}"), then ONE summary comment with comment_task (the plan if this is plan-first, or the partial state/result: what you did, what is missing), then update_task(task_id="${task.id}", status="review").`,
        "If you do not deliver, the task is handed to the human as it is anyway: better that you deliver it with a clear summary.",
      ].join("\n");
    }
    return [
      "Your previous turn on this task was interrupted — no fault of yours, the work done so far is valid.",
      `Resume where you were: get_task(task_id="${task.id}") to review your steps and the comments, mark done the steps you already completed, then continue ONLY the remaining work (do not start over).`,
      `As soon as you have a plan or a valid partial result, deliver it IMMEDIATELY (do not wait to finish everything): ONE summary comment with comment_task, then update_task(task_id="${task.id}", status="review").`,
    ].join("\n");
  }

  // end-allow-emdash

  /** Il sollecito filtrato dalla rivendicazione sul task, con la ripresa che
   *  vince sempre sul cancello: se il servizio non risponde, parte il testo
   *  intero (un sollecito di troppo è rumore, uno mancato è un turno cieco). */
  function claimNudge(taskId: string, text: string): string {
    try { return deps.svc.claimNudge({ taskId, text }) || text; }
    catch { return text; }
  }

  /**
   * What holds a resume, in the order its door asks, and WHICH machine block it
   * is. `kind` is null for a drain and for the holds that are this card's own (a
   * provider hold, the per-card spend cap): the machine sentences on the card
   * do not describe them.
   */
  function resumeHold(t: Task, personWrote: boolean): { reason: string; kind: DispatchBlockKind | null; floor?: ResourceFloorKind | null; slot?: string } | null {
    // PROJECT PAUSE, the one door for every automated resume (red bounce, land
    // retreat, end-of-turn retry, reconcile, the slot timer, a step added under
    // the card). A person's message is never held. The card stays in progress
    // with its binding and resumes by itself when the pause closes
    // (`onProjectResumed` below); nothing is lost or moved to backlog.
    // Fail open: `projectPaused` swallows a read error.
    if (!personWrote && deps.svc.projectPaused(t.projectId)) return { reason: PAUSED_SENTENCE, kind: "paused" };
    // The provider wall's own slot rides along (see `taskPlanWait`), so the
    // note of this resume and the one the tick writes for the same wall are
    // the same row.
    const plan = ctx.hold.taskPlanWait(t);
    if (plan) return { reason: plan.reason, kind: null, slot: plan.slot };
    const drain = ctx.runs.drainBlock();
    if (drain) return { reason: drain, kind: null };
    // The floor VERDICT, because the resume keys its wait on the resource and
    // decides on it whether the sentence is worth a line in the thread.
    const floor = ctx.admission.admissionVerdictNow();
    if (floor.reason && !(floor.kind === "memory" && ctx.admission.lightMemoryPass(t))) {
      return { reason: floor.reason, kind: "resources", floor: floor.kind };
    }
    const day = ctx.admission.spendBrake.dayBlock();
    if (day) return { reason: daySpendSentence(day), kind: "spend" };
    const card = ctx.admission.spendBrake.taskBlock(t.agentCostCents);
    if (card) return { reason: card, kind: null };
    const pressure = ctx.admission.pressureBlock();
    return pressure && !(shared.lastPressureAxis === "memory" && ctx.admission.lightMemoryPass(t))
      ? { reason: pressure, kind: "pressure" }
      : null;
  }

  /**
   * `resume` from a timer or a poll, where nobody awaits it. Its writes
   * (`setDispatchState` first) run inside a try/finally with no catch, so a
   * busy database became an unhandled rejection and the server exited. A busy
   * refusal now skips this pass with a warning: `finally` has freed the run,
   * so the card is in progress with no live turn, which is exactly what the
   * next reconcile poll resumes. Any other error stays the rejection it was.
   */
  type ResumeOpts = { continuation?: boolean; commentIds?: string[]; origin?: TurnOrigin };
  function resumeInBackground(taskId: string, humanMessage: string, opts?: ResumeOpts): Promise<void> {
    return resume(taskId, humanMessage, opts).catch(warnIfBusy(`resume of task ${taskId}`, (msg, err) => log(msg, err)));
  }

  async function resume(taskId: string, humanMessage: string, opts?: ResumeOpts): Promise<void> {
    // A person's message marks the card until a turn starts: the buffered or
    // slot-waiting delivery of it comes back through here without the origin.
    if (opts?.origin?.kind === "person") personWrote.add(taskId);
    const t = deps.svc.get(taskId)?.task;
    if (t && deps.isActive?.() === false && !isMirrorCard(t)) return;
    // The caller (reviewDecision reject) has already moved it to in_progress and
    // it must still be bound to its topic. Anything else = nothing to resume.
    // E se quel task stava aspettando uno slot, l'attesa muore qui insieme al
    // resume: una voce che resta nel registro senza timer è peggio del guasto
    // che il registro cura — quella card non verrebbe recuperata MAI più.
    if (!t || !t.assignedTopicId || t.status !== "in_progress") {
      ctx.runs.clearSlotWait(taskId, false);
      if (t) ctx.turnEnd.settleStrandedReviewChip(t);
      return;
    }
    const policy = delegatedPolicy(t);
    if (policy === null) {
      ctx.runs.clearSlotWait(taskId, false);
      await ctx.events.cancelDelegatedTask(t, "delegated_authority_invalid");
      return;
    }
    if (inFlight.has(taskId)) {
      // Turn still live (winding down): buffer, onTurnEnd delivers it.
      //
      // AND THE CARD SAYS IT, without a note. Writing to a working agent used to
      // produce nothing visible, so the dispatcher wrote a service line to say
      // the message was queued. That line was STATE, and state now comes from
      // the envelope: the comment carries a «queued» chip under its own bubble
      // until the turn ends, then the same chip says «delivered». One row, that
      // changes, instead of two rows that both stay.
      // A NUDGE IS NOT A MESSAGE. A continuation nudge (or an empty
      // resume) buffered against a LIVE turn is a contradiction: the nudge says
      // "your turn ended without delivering" and the turn is right there,
      // answering. It stayed in the buffer anyway and `onTurnEnd` handed it over
      // as if a person had written it: card d2a4a907, delivered at 04:50 and
      // reopened at 04:50 with nothing to read. Nothing is lost by dropping it.
      if (opts?.continuation || !humanMessage.trim()) return;
      ctx.queue.bufferResume(taskId, humanMessage, opts?.commentIds);
      return;
    }
    // Il tetto vale anche qui. Il messaggio NON si perde: si riprova quando un
    // posto si libera, invece di aprire un agente in più — che è come si finisce
    // con 12 turni vivi su un tetto di 6 solo perché qualcuno ha rifiutato in
    // fila cinque card.
    // Il pavimento prima del tetto: se la macchina non regge un altro agente,
    // il messaggio aspetta esattamente come aspetterebbe per uno slot pieno —
    // stessa coda, stesso chip, stessa promessa che niente si perde.
    // The spend brake comes through the SAME door as the resource floor, and for
    // the same reason: the message is not lost, it waits. A cap that refused only
    // new dispatches would let through the turn that starts from a review
    // rejection, which is exactly the extra turn on an already expensive card.
    // The pressure gate is last and only in "by resources" mode: there the
    // count is infinite, so this is the only door a resume has to pass. A
    // resumed turn is a full agent turn on the same machine: letting it through
    // over the threshold would be the count-mode leak (resumes outside the
    // cap) reborn under another name.
    // THE RAMP FIRST, in "by resources" mode: a resume is a start like a
    // dispatch, and it waits for the same clock (`lastAdmissionAt`). Read before
    // the probes, so sixteen queued resumes retrying every few seconds do not
    // each spawn a `vm_stat` to learn that it is not their turn yet. No note in
    // the thread: a wait of seconds is a chip, not an episode.
      const rampWait = ctx.admission.inResourcesMode() && ctx.admission.rampHeld();
      const hold = rampWait ? null : resumeHold(t, personWrote.has(taskId));
      const floorBlock = hold?.reason ?? null;
      const memoryWait = hold?.kind === "resources"
        && (hold.floor === "memory" || hold.floor === "memory_warmup");
      const rowReason = memoryWait ? WAITING_MEMORY : floorBlock;
    // Le corse dei gate occupano slot come gli agenti: un resume che trovasse
    // un posto «libero» ignorando i gate lancerebbe un agente in piu' proprio
    // mentre la macchina e' gia' al limite per i check.
    const resumeGateRuns = (() => { try { return deps.checksRunning?.() ?? 0; } catch { return 0; } })();
    if (rampWait || floorBlock || inFlight.size + resumeGateRuns >= ctx.admission.currentCap()) {
      // Il chip dice DOV'E': senza, la card resta `in_progress` con nessun turno
      // vivo — il tempo non scorre e sembra piantata, che è esattamente come si
      // vede dal di fuori una coda invisibile. `queued` è già lo stato «aspetta
      // il suo turno», lo stesso dei dispatch.
      // The REASON rides on the row with the chip (as `markPlanWait` does): a
      // resume held by the floor, a drain or the budget in the In-progress
      // column otherwise showed a bare queued chip whose tooltip said "no reason recorded", while
      // the reason sat in a service comment the card never shows.
      // The hold's KIND rides beside it, written before the chip so the emitted
      // card already reads it (`heldResumeBlock`): the card says the block that
      // holds THIS resume, never the one the tick published last.
      //
      // ONLY WHEN THE WAIT CHANGED, or its numbers are a minute old. "Changed" is
      // another kind, or for the same kind another `holdKey`: other words for
      // spend, pressure and the drain, another resource for the floor, whose
      // three sentences of one memory episode are one wait (see `holdKey`). The
      // row must still carry the very sentence we wrote last, so a chip written
      // by anyone else (a start, a park) is never mistaken for ours.
      // When the write is skipped the kind entry is left alone too, because
      // `heldResumeBlock` believes it only while it matches the sentence the row
      // still carries; refreshing it alone would blank the card's reason.
      //
      // AND THE VERY SENTENCE ALREADY ON THE ROW IS NEVER REWRITTEN, minute or
      // not: the refresh exists for the same wait with other numbers, and with
      // identical words there is nothing to refresh. It used to fire anyway,
      // so every held card moved `updated_at` and sent a frame to every client
      // once a minute with nothing changed (89919742, 24/09/2026: two readings
      // of the row 65 s apart differed in `updated_at` alone). The kind entry IS
      // written here, because it describes exactly the sentence the row
      // carries, and after a restart the map is empty: without it the card
      // would lose its machine reason until the words changed.
      const kind = hold?.kind ?? null;
      const key = holdKey(kind, floorBlock, hold?.floor ?? null);
      const last = heldWritten.get(taskId);
      const rowSays = t.dispatchState === CHIP_QUEUED && (t.dispatchError ?? null) === rowReason;
      const sameHold = rowSays || (last != null
        && clock() - last.at < HELD_RESUME_REFRESH_MS
        && t.dispatchState === CHIP_QUEUED
        && (t.dispatchError ?? null) === last.reason
        && last.key === key);
      if (rowSays) {
        // ONE FRAME WHEN THE MAP LEARNS IT AGAIN. After a restart the kind map
        // is empty, and a client that read the card in that gap (useBoardFeed
        // refetches on every socket 'open') holds `queueReason: null`. The row
        // is right, so it is not rewritten: the card is only re-sent, once per
        // card per boot, the first time this process can name the reason.
        const relearned = heldResumeBlock(taskId, rowReason) === null && kind != null;
        setHeldResumeBlock(taskId, kind ? { kind, reason: rowReason! } : null);
        if (relearned) { try { ctx.queue.emit(deps.svc.get(taskId)?.task ?? t); } catch { /* best-effort */ } }
        if (last?.reason !== rowReason || last.key !== key) heldWritten.set(taskId, { at: clock(), key, reason: rowReason });
      } else if (!sameHold) {
        setHeldResumeBlock(taskId, kind ? { kind, reason: rowReason! } : null);
        try { ctx.queue.emit(deps.svc.setDispatchState({ taskId, state: CHIP_QUEUED, error: rowReason })); } catch { /* best-effort */ }
        heldWritten.set(taskId, { at: clock(), key, reason: rowReason });
      }
      // THE WARM-UP NEVER GOES IN THE THREAD. It lasts 120 s, it is guaranteed
      // at every boot, and the chip already carries it: what a comment adds is
      // one permanent line saying the window was empty, on a card whose real
      // reason arrives a minute later. It is also what held the key.
      //
      // AND THE REGISTER DECAYS ON THE KEY, not only when the block lifts: a
      // card already noted under one wait got nothing when the wait BECAME
      // another one, which is how a card held at boot never read its floor.
      const noteKey = memoryWait ? null : key;
      if (!rampWait && noteKey && waitingForSlot.get(taskId) !== noteKey) {
        waitingForSlot.set(taskId, noteKey);
        try {
          // ONE SLOT, see `RESUME_WAIT_OPENINGS`: the register above is born
          // empty at every boot, so across boots only the slot keeps this to
          // one row. `once` keeps the row already there when the words have
          // not changed, so a restart does not even move it.
          deps.svc.addComment({
            taskId, author: "system", kind: "service",
            content: floorBlock
              ?? `In attesa di uno slot: il tetto di concorrenza (${ctx.admission.currentCap()}) è pieno. Riprendo appena si libera. Niente è andato perso.`,
            replaces: hold?.slot && !RESUME_WAIT_OPENINGS.includes(hold.slot) ? [hold.slot, ...RESUME_WAIT_OPENINGS] : [...RESUME_WAIT_OPENINGS],
            once: true,
          });
        } catch { /* best-effort */ }
      }
      // Un'attesa sola per task. Un secondo messaggio che arriva mentre la prima
      // è in corso NON apre un secondo timer (due attese per una card renderebbero
      // il registro un'approssimazione, e la seconda voce cancellerebbe la prima
      // scattando): si imbuca dove si imbucano già i messaggi arrivati a turno
      // vivo, e `onTurnEnd` lo consegna quando il turno dell'attesa ha finito.
      if (slotWaits.has(taskId)) {
        if (!opts?.continuation && humanMessage.trim()) ctx.queue.bufferResume(taskId, humanMessage, opts?.commentIds);
        return;
      }
      // Sfalsati, o venti resume in coda si sveglierebbero tutti insieme per
      // riscoprire insieme che il posto è uno solo.
      const delay = RESUME_SLOT_RETRY_MS + (shared.resumeStagger++ % 8) * 250;
      // Il registro dice a `reconcile` che qui c'è ancora qualcuno: la voce vive
      // esattamente quanto il timer, e sparisce appena scatta (il resume che ne
      // segue o parte, o ri-registra una nuova attesa). Fra il `delete` e la
      // ri-registrazione non c'è nessun `await`, quindi il poll non può mai
      // guardare in mezzo e vedere l'attesa sparita.
      const timer = setTimeout(() => {
        slotWaits.delete(taskId);
        void resumeInBackground(taskId, humanMessage, opts);
      }, delay);
      slotWaits.set(taskId, { timer, message: humanMessage, commentIds: opts?.commentIds });
      return;
    }
    // C'è posto: questo turno parte e si prende anche l'eredità di un'attesa
    // ancora pendente su questo task (il suo messaggio, non il suo timer).
    ctx.runs.clearSlotWait(taskId, true);
    personWrote.delete(taskId);
    const sessionKey = "topic:" + t.assignedTopicId.slice(0, 8);
    let delegatedDeadlineAt: number | undefined;
    if (policy) {
      try {
        delegatedDeadlineAt = beginDelegated(t, "resume", sessionKey);
      } catch (err) {
        log(`delegated resume begin failed for task ${taskId}`, err);
        await ctx.events.cancelDelegatedTask(t, "delegated_begin_not_persisted");
        return;
      }
    }
    const runId = ctx.runs.beginRun(taskId, sessionKey);
    shared.lastAdmissionAt = Date.now();
    try {
      ctx.queue.emit(deps.svc.setDispatchState({ taskId, state: CHIP_WORKING }));
      let timeoutMin = 20;
      try { timeoutMin = deps.svc.getBoardSettings(t.projectId).dispatchTimeoutMin; } catch { /* default */ }
      if (policy) timeoutMin = Math.min(timeoutMin, policy.maxDurationMinutes);
      let idleMin = 5;
      try { idleMin = deps.svc.getBoardSettings(t.projectId).dispatchIdleMin; } catch { /* default */ }
      const t0 = Date.now();
      const usage0 = ctx.usage.anchorUsage(taskId, sessionKey, t.model ?? null);
      ctx.usage.startLiveTurn(t, sessionKey, t0, usage0, t.model ?? null);
      // IL SOLLECITO PASSA DAL CANCELLO, LA RIPRESA NO.
      //
      // Il turno riparte comunque: quello che il cancello decide è il TESTO.
      // Primo sollecito della finestra = paragrafo intero; le riprese che
      // seguono = una riga corta e numerata. Senza, la stessa frase copriva la
      // chat quattro volte in novanta secondi (topic:7d043b7e, 19/08). Un
      // resume UMANO non passa di qui: quello lo ha scritto una persona, e non
      // si riassume la voce di chi guarda.
      const content = opts?.continuation
        ? claimNudge(t.id, buildContinueNudge(t, attemptCap(t)))
        : buildResume(t, humanMessage);
      // Resume (human answer) or continuation (post-timeout nudge): the session
      // already carries the full envelope from kickoff — re-injecting CLAUDE.md
      // & co. only compounds cache write/read. Lean = role prompt + cwd only.
      let turnEnd: TurnEndInfo | undefined;
      try {
        turnEnd = (await runWithDelegatedDeadline({
          resolvePolicy: () => delegatedPolicy(t),
          sessionKey,
          persistedDeadlineAt: delegatedDeadlineAt,
          clock,
          abortTurn: deps.abortTurn,
          run: () => deps.runTurn(sessionKey, content, {
            timeoutMs: Math.max(1, timeoutMin) * 60_000,
            idleMs: Math.max(1, idleMin) * 60_000,
            contextMode: "lean",
            ...(opts?.continuation ? {} : { dispatchedFor: opts?.commentIds ?? [] }),
          }),
        })) || undefined;
      }
      catch (err) { log(`resume turn failed for ${taskId}`, err); turnEnd = classifyTurnError(err); }
      ctx.usage.bookUsageFloor(taskId, sessionKey, t.model ?? null);   // prima della guardia: vedi launch
      if (!ctx.runs.ownsRun(taskId, runId)) return; // buried mid-turn (see launch)
      ctx.usage.endLiveTurn(taskId);
      ctx.usage.recordTurnMs(taskId, t0);
      ctx.turnEnd.onTurnEnd(taskId, Date.now() - t0, turnEnd);
      if (policy) {
        const after = deps.svc.get(taskId)?.task;
        if (after?.status === "review" || after?.status === "done") {
          recordDelegated(taskId, "completed", { outcome: after.status });
        } else if (after?.status === "backlog") {
          recordDelegated(taskId, "failed", { outcome: turnEnd?.cause ?? turnEnd?.end ?? "stopped" });
        }
      }
    } finally {
      ctx.runs.endRun(taskId, runId);
    }
  }

  // Non-lossy restart recovery: ADOPT the agent turn still running in the broker
  // and drive it to completion, instead of resume-from-scratch. Mirrors resume's
  // inFlight/live-turn/onTurnEnd scaffolding but injects NO message (reattach
  // continues the exact turn — the CLI context is untouched). Falls back to
  // resume if the reattach dep reports the session vanished (TOCTOU).
  async function reattachTask(taskId: string): Promise<void> {
    const t = deps.svc.get(taskId)?.task;
    if (!t || !t.assignedTopicId || t.status !== "in_progress") {
      ctx.admission.clearNoCheckReservation(taskId);
      return;
    }
    const wasReserved = noCheckExemptions.has(taskId);
    const restored = ctx.admission.restoreNoCheckReservation(t);
    if (restored && !wasReserved) {
      const attempt = deps.attempts?.list(taskId).find((entry) =>
        entry.state === "running" && entry.topicId === t.assignedTopicId,
      );
      if (attempt) ctx.admission.noteNoCheckExemptionStart(taskId, attempt.id, noCheckExemptions.get(taskId)!);
    }
    const policy = delegatedPolicy(t);
    if (policy === null) {
      await ctx.events.cancelDelegatedTask(t, "delegated_authority_invalid");
      return;
    }
    if (inFlight.has(taskId)) return;
    // Nessun tetto qui, di proposito: il reattach ADOTTA un turno che sta già
    // girando nel broker. Rifiutarlo non risparmierebbe niente — lo lascerebbe
    // orfano, a bruciare token senza nessuno che ne raccolga il risultato.
    const sessionKey = "topic:" + t.assignedTopicId.slice(0, 8);
    let delegatedDeadlineAt: number | undefined;
    if (policy) {
      try {
        delegatedDeadlineAt = beginDelegated(t, "resume", sessionKey);
      } catch (err) {
        log(`delegated reattach begin failed for task ${taskId}`, err);
        await ctx.events.cancelDelegatedTask(t, "delegated_begin_not_persisted");
        return;
      }
    }
    const runId = ctx.runs.beginRun(taskId, sessionKey);
    try {
      ctx.queue.emit(deps.svc.setDispatchState({ taskId, state: CHIP_WORKING }));
      let timeoutMin = 20;
      try { timeoutMin = deps.svc.getBoardSettings(t.projectId).dispatchTimeoutMin; } catch { /* default */ }
      if (policy) timeoutMin = Math.min(timeoutMin, policy.maxDurationMinutes);
      let idleMin = 5;
      try { idleMin = deps.svc.getBoardSettings(t.projectId).dispatchIdleMin; } catch { /* default */ }
      const t0 = Date.now();
      const usage0 = ctx.usage.anchorUsage(taskId, sessionKey, t.model ?? null);
      ctx.usage.startLiveTurn(t, sessionKey, t0, usage0, t.model ?? null);
      let turnEnd: TurnEndInfo | undefined;
      try {
        turnEnd = (await runWithDelegatedDeadline({
          resolvePolicy: () => delegatedPolicy(t),
          sessionKey,
          persistedDeadlineAt: delegatedDeadlineAt,
          clock,
          abortTurn: deps.abortTurn,
          run: () => deps.reattach!(sessionKey, {
            timeoutMs: Math.max(1, timeoutMin) * 60_000,
            idleMs: Math.max(1, idleMin) * 60_000,
          }),
        })) || undefined;
      }
      catch (err) { log(`reattach turn failed for ${taskId}`, err); turnEnd = classifyTurnError(err); }
      ctx.usage.bookUsageFloor(taskId, sessionKey, t.model ?? null);   // prima della guardia: vedi launch
      if (!ctx.runs.ownsRun(taskId, runId)) return; // buried mid-turn (see launch)
      ctx.usage.endLiveTurn(taskId);
      ctx.usage.recordTurnMs(taskId, t0);
      ctx.turnEnd.onTurnEnd(taskId, Date.now() - t0, turnEnd);
      // The adopted turn was opened by a launch that died with the old server,
      // so nobody else closes its attempt. Left `running`, it reads as a live
      // turn forever: the CI phase skipped such a card at every sweep without a
      // word (e8a0ce90, 14/11: 50 minutes in the CI column, never measured).
      const open = deps.attempts?.list(taskId).find((a) => a.state === "running" && a.topicId === t.assignedTopicId);
      if (open) {
        try {
          deps.attempts!.finish(open.id, {
            state: !turnEnd || turnEnd.end === "end_turn" ? "delivered" : "failed",
            agentMs: Date.now() - t0,
          });
        } catch (err) { log(`reattach: attempt ${open.id} not closed`, err); }
      }
    } finally {
      ctx.runs.endRun(taskId, runId);
    }
  }
  return { reattachTask, resume, resumeInBackground, dispose: () => { offResumed(); personWrote.clear(); } };
}
