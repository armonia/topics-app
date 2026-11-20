/**
 * task-dispatcher-turn-end.ts: what happens when a turn stops.
 * 
 * One reconciliation: requeue, park, hand to review or wait for a command, and
 * the review chip that goes with it.
 */
import { BOARD_HOLD_KEY, setProviderHold, holdFromDeclaredReset } from "../lib/provider-hold";
import { isAgentAuthor } from "../../shared/comment-author";
import { awaitsHuman } from "../../shared/workflow";
import { commentAsksHuman, type Task } from "./tasks";
import { PARKED_STOPPED, PARKED_WAITED_OUT, statusEventEnters } from "../../shared/board";
import { consumesAttempt, describeTurnEnd, needsHuman, shouldResume, type TurnEndInfo } from "../providers/stop-reason";
import { BACKGROUND_WORK_CAP_MS } from "../providers/claude/background-work";
import { isDeliverySheetPath } from "../../shared/media-kind";
import { FREE_PROVIDER_ERRORS, CHIP_NEEDS_INPUT, CHIP_DELIVERED, CHIP_FAILED, CHIP_WAITING, RECOVERABLE_DISPATCH_STATES, parkedEdgeEvent } from "./task-dispatcher-support";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createTurnEnd(ctx: DispatcherCtx) {
  const { attemptCap, backoffMs, deps, inFlight, log, pendingResume, providerErrors, recentlyEnded, retryWaits } = ctx.core;

  /**
   * Did the agent leave a summary comment for THIS turn — one made after the
   * newest `…→in_progress` status event (the turn's start)? A stale comment from
   * an earlier exchange does NOT count: the reviewer needs to know what the agent
   * did this time. On self-delivery the `review_needs_summary` service gate now
   * enforces exactly this, so the agent writes its OWN comment; this check is the
   * dispatcher's read of the same fact for the system-delivery fallback below.
   */
  function hasFreshAgentComment(task: Task): boolean {
    try {
      const comments = deps.svc.get(task.id)?.comments ?? [];
      let turnStart = 0;
      for (const c of comments) {
        // `endsWith` no: da quando una transizione porta la sua ragione
        // (`done→in_progress · il land…`) il contenuto non finisce con lo stato.
        // Lo stesso parser del servizio, o le due letture del "quando inizia il
        // turno" divergerebbero.
        if (c.kind === "status" && statusEventEnters(c.content, "in_progress")) {
          const ts = Date.parse(c.createdAt);
          if (ts > turnStart) turnStart = ts;
        }
      }
      return comments.some((c) =>
        isAgentAuthor(c.author) && c.kind === "comment" &&
        Date.parse(c.createdAt) >= turnStart);
    } catch { return false; }
  }

  /**
   * The agent's last session prose (trimmed), for the SYSTEM-delivery fallback:
   * when a worked turn died before ever reaching review, the agent's turn is over
   * and it can't comment — we surface its last words inside the system note
   * (honest attribution), NEVER as a faked agent comment. null when unavailable.
   */
  function recoverAgentWords(task: Task): { text: string; id: string } | null {
    const topicId = task.assignedTopicId;
    if (!topicId || !deps.getLastAgentText) return null;
    try {
      const last = deps.getLastAgentText("topic:" + topicId.slice(0, 8));
      const text = last?.text.trim();
      return text && last ? { text, id: last.id } : null;
    }
    catch { return null; }
  }

  /**
   * Which review chip this arrival in review deserves, read from the agent's
   * last word: a question = "serve te" (a human decision is required), anything
   * else = delivered. Also the test for "was this card waiting for an answer?",
   * which is what decides whether a late message may reopen it.
   */
  function reviewChipFor(taskId: string): string {
    try {
      const comments = deps.svc.get(taskId)?.comments ?? [];
      // kind='status' rows are transition events, not the agent speaking:
      // "the agent's last word" must be an actual comment.
      const lastAgent = [...comments].reverse().find((c) => isAgentAuthor(c.author) && c.kind === "comment");
      if (lastAgent && !commentAsksHuman(lastAgent.content)) return CHIP_DELIVERED;
    } catch { /* default to needs_input */ }
    return CHIP_NEEDS_INPUT;
  }

  /**
   * A card in REVIEW that still carries an active chip (`queued`, `starting`,
   * `working`) and has no live turn here: the turn that delivered it ended
   * without `onTurnEnd`, the only writer of the review chip. It gets the chip
   * `onTurnEnd` would have written, and the stale wait sentence goes with the
   * old chip. a551b940 (23/09/2026) read "in coda" from the Review column with
   * the floor sentence of 18:04 under it. A live turn is left alone: its own
   * `onTurnEnd` is about to settle it.
   */
  function settleStrandedReviewChip(t: Task): void {
    if (t.status !== "review" || !RECOVERABLE_DISPATCH_STATES.has(t.dispatchState ?? "")) return;
    if (inFlight.has(t.id)) return;
    try { ctx.queue.emit(deps.svc.setDispatchState({ taskId: t.id, state: reviewChipFor(t.id), error: null })); }
    catch { /* best-effort: the row may have moved */ }
  }

  /** `04:36`, local time: when the buffered message was actually written. */
  function hourMinute(at: number): string {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  /** The buffered messages as one quotable block, hours included, trimmed. */
  function quoteQueued(queued: { text: string; at: number }[]): string {
    return queued
      .map((q) => `${hourMinute(q.at)} «${q.text.trim().length > 220 ? q.text.trim().slice(0, 220) + "..." : q.text.trim()}»`)
      .join(" / ");
  }

  /** `afterCommandWait`: called by `pollCommandWaits`, whose wait is over and must not start again. */
  function onTurnEnd(taskId: string, turnMs?: number, turnEnd?: TurnEndInfo, afterCommandWait = false): void {
    recentlyEnded.set(taskId, Date.now());
    // Chi non la sa la dichiara `end_turn` — non è un default innocuo, è
    // l'ipotesi più benevola: "l'agent ha finito". Sbagliarla verso `error`
    // farebbe scattare backoff su turni sani.
    const end: TurnEndInfo = turnEnd ?? { end: "end_turn" };
    const cur = deps.svc.get(taskId)?.task;
    if (!cur) { pendingResume.delete(taskId); return; }
    // Human input buffered mid-turn → continue on the same tab instead of the
    // requeue path (which would discard the conversation). Deferred a tick:
    // the caller's finally still holds the inFlight slot at this point.
    //
    // A DELIVERY IS NOT REJECTED BY A MESSAGE THAT NEVER SAW IT.
    //
    // The message is buffered while the turn is alive, and the NORMAL way that
    // turn ends is by taking the card to review. Rejecting from there put the
    // card back to work twenty seconds after the delivery, signed "user", with
    // nothing in the thread saying why: three times on the night of 2026-09-04
    // (18bdf214, cdeb9868, d2a4a907), a wasted turn each, and the agent hunting
    // for a hole in a delivery nobody had complained about. The one case where
    // a late message really is an answer is the card that ASKED something
    // (chip "serve te"): there it reopens, and it says so out loud. Otherwise
    // the delivery stands and the message waits in the thread for the person
    // who is about to open it anyway.
    const queued = pendingResume.get(taskId) ?? [];
    pendingResume.delete(taskId);
    if (queued.length && cur.assignedTopicId) {
      if (cur.status === "review") {
        const answering = reviewChipFor(taskId) === CHIP_NEEDS_INPUT;
        let reopened: Task | null = null;
        if (answering) {
          try { reopened = deps.svc.reviewDecision({ taskId, by: "system", decision: "reject" }); }
          catch { reopened = null; }
        }
        try {
          deps.svc.addComment({
            taskId, author: "system", kind: "service",
            content: reopened
              ? `Riaperta per consegnare all'agent, che aspettava una risposta, il messaggio arrivato mentre chiudeva il turno (${quoteQueued(queued)}).`
              : `Feedback arrivato mentre l'agent stava consegnando, quindi non l'ha visto (${quoteQueued(queued)}). La consegna resta in review, decidi tu: se la rifiuti l'agent riprende e rilegge il thread, questo messaggio compreso.`,
          });
        } catch { /* best-effort */ }
        try { ctx.queue.emit(deps.svc.get(taskId)?.task ?? cur); } catch { /* best-effort */ }
        if (reopened) {
          // Deferred a tick: the caller's finally still holds the inFlight slot.
          setTimeout(() => { void ctx.resume.resumeInBackground(taskId, queued.map((q) => q.text).join("\n"), { commentIds: ctx.queue.queuedCommentIds(queued) }); }, 0);
          return;
        }
        // Delivery intact: fall through to the review handling below (chip,
        // preview). The card stays where the agent put it.
      } else if (cur.status === "in_progress") {
        setTimeout(() => { void ctx.resume.resumeInBackground(taskId, queued.map((q) => q.text).join("\n"), { commentIds: ctx.queue.queuedCommentIds(queued) }); }, 0);
        return;
      }
      // No turn to resume: the card went back to the queue (a declared wait, a
      // requeue) and restarts when its turn comes. Nothing is written here. The
      // note that used to say it was STATE ("your feedback arrived after the
      // turn"), and state is the chip the thread derives from the envelope: the
      // words are already a row of their own, and a service line under them said
      // the same thing a second time, in the past tense, forever.
    }
    // The agent declared a wait mid-turn (wait_for_condition → deferForWait moved
    // it back to todo + chip `waiting`). The slot is already freed by the finally;
    // leave the chip/deferral intact — the else-branch below would wipe it, and
    // the tick will re-dispatch once the window passes. NOT a delivery, NOT a fail.
    if (cur.status === "todo" && cur.dispatchState === CHIP_WAITING) return;
    if (cur.status === "review") {
      // It's the human's now — but distinguish WHY: a question as the agent's
      // last word = "serve te" (decision required); anything else = "delivered"
      // (the agent believes it's done, ready to approve). Binding stays for the
      // deep-link and the resume-on-answer path either way.
      // (The agent already summarised THIS turn: the review_needs_summary gate
      // rejects a self-delivery without a fresh comment, so the thread is never
      // mute here and the chip detection below reads real, current words.)
      //
      // The test is `commentAsksHuman`, not the presence of the fence: this very
      // envelope orders a landable delivery to attach `options=["Landa su main"]`,
      // so reading the fence chipped every finished delivery "serve te".
      const chip = reviewChipFor(taskId);
      try { ctx.queue.emit(deps.svc.setDispatchState({ taskId, state: chip })); } catch { /* best-effort */ }
      // Review-ready preview: boot a live server from the worktree, set output_url
      // to the local deep-link, attach a screenshot. Best-effort, fire-and-forget.
      //
      // Lo snellimento viene DOPO, incatenato: l'anteprima è un `bun run dev` che
      // gira dentro quel worktree, e togliergli `node_modules` sotto i piedi
      // mentre parte lo ucciderebbe. Aspettare che il tentativo si concluda toglie
      // la corsa; se un'anteprima è rimasta viva, `slimWorktree` se ne accorge e
      // non tocca niente (la passata del GC ci riproverà quando sarà spenta).
      try {
        void Promise.resolve(deps.preparePreview?.(taskId))
          .catch(() => { /* best-effort: un'anteprima fallita non blocca il resto */ })
          .then(() => deps.slimWorktree?.(taskId))
          .catch(() => { /* best-effort */ });
      } catch { /* best-effort */ }
      return;
    }
    if (cur.status === "in_progress") {
      // Turn ended without reaching review — typically the wall-clock timeout
      // cutting a busy agent mid-work. The conversation is still there: CONTINUE
      // it on the same topic (and worktree) instead of releasing and re-kicking
      // from scratch — a fresh restart re-plans, re-creates the step checklist
      // and burns the whole retry budget on any task bigger than one timeout.
      if (cur.assignedTopicId && shouldResume(end)) {
        // Ended on a command that will wake it: no nudge, no attempt, see `commandWaits`.
        if (!afterCommandWait && ctx.runs.awaitCommandWake(cur)) {
          const capHours = Math.round(BACKGROUND_WORK_CAP_MS / 3_600_000);
          const waker = ctx.runs.wakeOwedBy("topic:" + cur.assignedTopicId.slice(0, 8)) === "subagent"
            ? "un sotto-agente lanciato con spawn_agent"
            : "un comando lanciato con run_command";
          try {
            deps.svc.addComment({
              taskId, author: "system", kind: "service",
              content: `${describeTurnEnd(end)}: ${waker} sveglierà la sessione. La card aspetta quella sveglia (al massimo ${capHours} ore di silenzio), nessun tentativo consumato.`,
            });
          } catch { /* best-effort */ }
          return;
        }
        const cap = attemptCap(cur);
        const backoff = backoffMs(cur.projectId);
        let bumped: Task | null = null;
        // Uno stop premuto dall'UMANO non è un fallimento dell'agent e non gli
        // costa un tentativo (`consumesAttempt`): si riprende senza bruciare
        // budget. Il nostro tetto a orologio invece SÌ, o il freno contro un
        // task che gira in tondo non frenerebbe mai.
        // Un errore del provider non è un fallimento dell'agente: vedi
        // `providerErrors`. Il contatore vive qui, non in `consumesAttempt`,
        // perché quella è una funzione pura sul singolo turno e questa è una
        // domanda sulla STORIA del task.
        let free = !consumesAttempt(end);
        // A WALL THAT NAMES ITS END IS A WAIT, NOT A FAILED ATTEMPT. A turn that died on an
        // error declaring when the plan frees up (`resets_at`, see `readDeclaredReset`) costs
        // nothing: the hold goes up until then, and the wait below (`taskPlanWait`) parks the
        // card in Todo until that hour. Without it four such turns in a row sent the card to
        // backlog, where nobody takes it up again (19/11, card 8f2d0c9f, reserve stop).
        if (end.end === "error") {
          const wall = holdFromDeclaredReset(end.detail);
          // The wall belongs to the board, not to chats: the reserve stays with whoever can confirm it (BOARD_HOLD_KEY).
          if (wall) { setProviderHold({ ...wall, provider: BOARD_HOLD_KEY }); free = true; }
        }
        // `process-died` arriva come `error` ma NON si perdona: è la rete di
        // sicurezza sulla liveness, cioè l'unico freno contro una sessione
        // fantasma. Perdonare anche quella significherebbe pagare un problema
        // di costo con una guardia — e la guardia serve.
        if (end.end === "error" && end.cause !== "process-died") {
          const n = (providerErrors.get(taskId) ?? 0) + 1;
          providerErrors.set(taskId, n);
          if (n <= FREE_PROVIDER_ERRORS) free = true;
        } else {
          providerErrors.delete(taskId);
        }
        try {
          bumped = free
            ? (deps.svc.get(taskId)?.task ?? null)
            : deps.svc.bumpDispatchAttempt({ taskId, maxAttempts: cap });
        } catch { /* park below */ }
        if (bumped) {
          // Backoff prima di riprendere quando il turno è caduto per un guasto:
          // riprovare subito dentro un'interruzione del provider brucia i
          // tentativi mentre l'interruzione è ancora in corso. La durata resta
          // un indizio valido quando la ragione non è arrivata fin qui.
          // `turn-in-flight` ASPETTA SEMPRE, e non per euristica: la front-door
          // ci ha respinti perche' la sessione sta gia' rispondendo, quindi un
          // ritentativo immediato incassa lo stesso 409 per costruzione. Finora
          // ci finiva dentro solo di rimbalzo, via `turnMs < backoff` — vero in
          // produzione (il turno non parte, quindi dura zero) ma falso appena la
          // durata non arriva fin qui, e allora si riprovava SUBITO.
          const outage = end.end === "error"
            || end.cause === "turn-in-flight"
            || (turnMs !== undefined && turnMs < backoff);
          const attempt = free
            ? `tentativo ${bumped.dispatchAttempts}/${cap}, non conteggiato`
            : `tentativo ${bumped.dispatchAttempts}/${cap}`;
          try {
            deps.svc.addComment({
              taskId, author: "system", kind: "service",
              content: outage
                ? `${describeTurnEnd(end)}: riprovo tra ${Math.round(backoff / 1000)}s sulla stessa sessione (${attempt}).`
                : `${describeTurnEnd(end)}: l'agent continua sulla stessa sessione (${attempt}).`,
            });
          } catch { /* best-effort */ }
          ctx.queue.emit(bumped);
          // Deferred at least a tick: the caller's finally still holds the
          // inFlight slot; quick deaths wait out the backoff.
          // Il timer si REGISTRA: senza, il poll di `reconcile` (10s) vede una
          // card `in_progress` senza turno vivo e la sveglia comunque, contro
          // una sessione che sta ancora rispondendo. Vedi `retryWaits`.
          ctx.runs.clearRetryWait(taskId);
          // A spent usage window has a published end: the card waits for it
          // (plus its backoff), instead of resuming into the same 429. An API
          // outage names none: past the backoff, `resume` queues the card
          // behind it and starts it once the API answers.
          const holdMs = Math.max(0, (ctx.hold.taskPlanWait(bumped)?.untilMs ?? 0) - Date.now());
          const waitMs = outage ? Math.max(backoff, holdMs) : 0;
          const retryTimer = setTimeout(() => {
            retryWaits.delete(taskId);
            void ctx.resume.resumeInBackground(taskId, "", { continuation: true });
          }, waitMs);
          retryWaits.set(taskId, retryTimer);
          ctx.usage.broadcastRetryWait(bumped, { at: Date.now() + waitMs, attempt: bumped.dispatchAttempts, cap, free, end });
          return;
        }
      }
      // Retry budget exhausted, and the turn never reached review on its own.
      // Distinguish "did work but ran out of turns" from a genuine no-output
      // failure: a FRESH agent comment, or (failing that) the agent's last session
      // words, means it worked → hand it to the human in review with those words
      // RECOVERED into the system note (honest — the agent's turn is over, it can't
      // comment itself here; we never fake an agent comment). Only a task that
      // produced literally nothing (no fresh comment AND no session words) fails.
      // …oppure il turno è finito in un modo che nessun ritentativo può
      // sbloccare (`needsHuman`: il modello si è rifiutato). Riprovare identico
      // otterrebbe lo stesso rifiuto: si arriva subito all'umano, con la ragione
      // scritta invece che dopo aver bruciato tutto il budget.
      // PRIMA DI DIRE «non c'e' niente da guardare», GUARDA.
      //
      // Il testo qui sotto sceglie fra due frasi opposte leggendo
      // `deliveryBranch` e `deliveryFilesChanged`. Su questo percorso nessuno le
      // aveva mai scritte — la fotografia la prendeva solo la ROTTA, sull'edge
      // verso review — quindi la condizione era sempre vera e la card diceva
      // sempre «nessun ramo e nessun file toccato». Misurato il 18/08 su
      // `cf15dea6`: quel testo su una card il cui ramo portava il commit
      // `af248dcf9`, worktree pulito, cinque sottotask su cinque chiusi.
      // Il tail e' asincrono perche' la fotografia si legge da git: `onTurnEnd`
      // resta sincrono (i suoi chiamanti non lo aspettano) e il lavoro parte qui.
      void (async () => {
        if (deps.captureDelivery) {
          try { await deps.captureDelivery(taskId); } catch { /* mai bloccare la consegna su git */ }
        }
        // La riga RILETTA: la fotografia l'ha appena scritta.
        const t = deps.svc.get(taskId)?.task ?? cur;
        const fresh = hasFreshAgentComment(t);
        const recovered = fresh ? null : recoverAgentWords(t);
        if (t.assignedTopicId && (fresh || recovered || needsHuman(end))) {
          // ── «VALUTA COSA HA PRODOTTO» SU UNA CARD DOVE NON C'E' NIENTE ───────
          //
          // La frase era una sola per due situazioni opposte, e su quella
          // sbagliata mandava a cercare un lavoro che non esiste. Misurato il
          // 17/08 su `5cf58e29`: nessun ramo, zero file toccati, ogni turno morto
          // su un errore del provider — e la card chiedeva di valutare la
          // consegna. Segnalato: «non capisco che succede».
          //
          // La differenza la sanno le colonne, non il testo: un turno che ha
          // prodotto qualcosa lascia un ramo o dei file cambiati. Quando non c'e'
          // ne' l'uno ne' gli altri, la card lo DICE e nomina la sola mossa che
          // ha senso, invece di chiedere una valutazione impossibile.
          const nienteDaVedere = !t.deliveryBranch && !t.deliveryFilesChanged;
          // NIENTE NELLA STORIA NON VUOL DIRE NIENTE SUL DISCO. Si chiede solo
          // quando la storia e' vuota: e' l'unico caso in cui la risposta
          // cambia cosa deve fare chi legge, e su una card con un diff da
          // guardare sarebbe una domanda a git per niente.
          //
          // ASKED ALSO WHEN A BRANCH EXISTS BUT CARRIES NOTHING: the delivery
          // sheet draws zero files in both cases, and zero reads as "did
          // nothing". The question costs one `git status` and it separates the
          // two opposite decisions (one line asking for a commit against a
          // re-dispatch). On a card that really has a diff nothing is asked:
          // there the condition is false.
          const noCommits = !t.deliveryFilesChanged;
          const sporchi = noCommits && deps.uncommittedInWorktree
            ? await deps.uncommittedInWorktree(taskId).catch(() => null)
            : null;
          // THE NUMBER GOES TO THE CARD, THE SENTENCE STAYS AS IT WAS. The chip
          // already speaks about the git side and it now carries the count, so
          // the widened probe must not widen the NOTE too: saying it a second
          // time in the thread would be the same fact as noise. The wording
          // keeps the condition it always had.
          const lavoroNonCommittato = nienteDaVedere && sporchi && sporchi.length > 0 ? sporchi : null;
          // IL PERCHE' E' DI CHI CHIUDE IL TURNO, IL DOVE NO. Qui si sa perché il
          // turno è finito; NON si sa dove finirà la card, perché
          // `deliverToReviewBySystem` ha due guardie che possono mandarla in
          // `todo` (sottotask ancora aperti, figli parcheggiati da sbloccare).
          // Dichiarare «l'ho portato io in review» da qui era una previsione, e
          // su tre giorni ha sbagliato 6 volte su 35 — la riga resta nel thread
          // per sempre e il reviewer la trova quando la card arriva DAVVERO in
          // review, chiedendogli di valutare una consegna che allora non c'era.
          // Quindi: la mossa successiva viaggia a parte, e la scrive chi sa dove
          // la card è atterrata.
          const base = needsHuman(end)
            ? `${describeTurnEnd(end)}. Nessun ritentativo automatico può sbloccarlo.`
            : lavoroNonCommittato
              // IL LAVORO C'E', NON E' COMMITTATO. Non e' la stessa card di una
              // dove non c'e' niente, e la mossa non e' la stessa: qui c'e'
              // qualcosa da salvare, e va nominato prima che qualcuno decida
              // di ributtare via il worktree.
              ? `Il turno e' finito prima del commit: ${t.dispatchAttempts} turni, nessun commit, ` +
                `ma nel worktree ci sono ${lavoroNonCommittato.length} file modificati ` +
                `(${lavoroNonCommittato.slice(0, 6).join(", ")}${lavoroNonCommittato.length > 6 ? ", …" : ""}). ` +
                `L'ultimo turno e' finito cosi': ${describeTurnEnd(end).toLowerCase()}.`
              : nienteDaVedere
                ? `Nessun lavoro consegnato: ${t.dispatchAttempts} turni, nessun ramo e nessun file toccato. ` +
                  `L'ultimo e' finito cosi': ${describeTurnEnd(end).toLowerCase()}.`
                : `L'agent ha lavorato ${t.dispatchAttempts} turni ma non ha spostato il task in review da solo.`;
          // Cosa può fare l'umano, e ha senso SOLO se la card gli arriva davvero.
          const mossa = needsHuman(end)
            ? "L'ho portato in review perché lo guardi tu (rimandandolo indietro riparte sulla stessa sessione)."
            : lavoroNonCommittato
              ? "Quel lavoro non e' perduto: rimandalo indietro e riparte sulla stessa sessione, nello stesso worktree, e la prima cosa che deve fare e' committare."
              : nienteDaVedere
                ? "Non c'e' un diff da guardare: rimandalo avanti e riparte sulla stessa sessione, oppure prendilo in mano tu."
                : "L'ho portato io in review: valuta cosa ha prodotto, oppure rimandalo indietro (un rifiuto lo fa ripartire sulla stessa sessione).";
          const reason = recovered
            ? `${base}\n\nUltime parole dell'agent (recuperate dalla sessione): ${recovered.text}`
            : base;
          // "RICATTURA EVIDENZA" (RECAPTURE EVIDENCE) STARTS ON ITS OWN, BEFORE
          // THE GATE, not after. No agent opens a browser by hand for its own before/after
          // shot (kickoff rule), so on a `visibile` card the auto-capture is
          // this door's ONLY chance to give the gate below something real to
          // find — awaited here, not fired in the background after the
          // bounce already happened.
          if (t.labels.some((l) => l.label === "visibile")) {
            const preview = (t.previewImage ?? "").trim();
            if (!preview || isDeliverySheetPath(preview)) {
              try { await deps.preparePreview?.(taskId); } catch { /* best-effort */ }
            }
          }
          try {
            const delivered = deps.svc.deliverToReviewBySystem({
              taskId,
              reason,
              nextMove: mossa,
              // Due cause distinte, non una: "ha lavorato ma è finito il budget di
              // turni" si può rimandare indietro e riparte; "il modello si è
              // rifiutato" no — riproverebbe a rifiutarsi. Il reviewer decide
              // diversamente nei due casi, quindi la card deve dirglielo.
              cause: needsHuman(end) ? "model_refused" : "retries_exhausted",
              // The number the delivery sheet never had: `[]` measured clean
              // is zero, "not measurable" stays null, and the sheet says two
              // different sentences instead of passing one off as the other.
              uncommittedFiles: sporchi ? sporchi.length : null,
              // The note QUOTES an assistant row, so it is anchored to it: the
              // reader draws the recovered words under the step they were said
              // in instead of at the bottom, hours away from it.
              messageId: recovered?.id ?? null,
            });
            ctx.queue.emit(delivered);
            // System-delivery bypasses the route PATCH, so the review-edge
            // notification (OS banner + web-push) would never fire. Emit it here:
            // this is exactly the "task waiting for review after a timeout" case
            // that was previously silent.
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
            // Stessa catena della consegna volontaria: anteprima prima, snellimento
            // dopo. Una consegna forzata dal sistema è una consegna a tutti gli
            // effetti, e il suo worktree costa gli stessi ~260 MB.
            try {
              void Promise.resolve(deps.preparePreview?.(taskId))
                .catch(() => { /* best-effort */ })
                .then(() => deps.slimWorktree?.(taskId))
                .catch(() => { /* best-effort */ });
            } catch { /* best-effort */ }
          } catch (err) { log(`deliverToReviewBySystem failed for ${taskId}`, err); }
          return;
        }
        ctx.queue.releaseAndEmit({
          taskId,
          requeue: false,
          parkState: CHIP_FAILED,
          reason: `${describeTurnEnd(end)}. Nessun output dopo ${t.dispatchAttempts} tentativi: parcheggiato in backlog.`,
        });
      })();
      return;
    }
    // Lo stop umano passa PROPRIO di qui, ed è l'unico park che si annuncia da
    // solo: la route parcheggia PRIMA e taglia il turno DOPO, quindi questo
    // `onTurnEnd` è quello del turno appena abortito e trova la card già
    // `stopped`. Azzerarla riporterebbe la card muta — che è il difetto che
    // `stopped` esiste per togliere.
    if (cur.dispatchState === PARKED_STOPPED) return;
    // Stessa trappola, altro park che si annuncia da solo: la serie di attese ha
    // sfondato il tetto e `deferForWait` ha già parcheggiato la card in backlog
    // col chip `waited_out`. Il turno che ha dichiarato quell'attesa finisce
    // SUBITO DOPO e arriva qui: senza questa guardia la riga sotto azzererebbe
    // il chip, e la card tornerebbe muta — cioè indistinguibile da un park a
    // mano, che è esattamente il difetto che `waited_out` esiste per togliere.
    if (cur.dispatchState === PARKED_WAITED_OUT) return;
    // Human moved it elsewhere (backlog/todo/done) mid-turn.
    //
    // A turn the agent CLOSED by itself leaves nothing to say: the card is the
    // human's now, so we drop our chip and get out of the way. A turn that
    // FAILED is the opposite case, and it was going down the same road: the two
    // parks above are skipped because they announce themselves, and this branch
    // announced nothing at all. So the failure was erased in silence and the
    // card sat exactly as the human had left it, indistinguishable from one no
    // agent had ever touched: "I moved it to backlog, it failed, and nothing
    // happened". The chip and the reason are the only place that failure can
    // live once the card is no longer ours.
    //
    // `consumesAttempt` is the same test the retry budget uses, so what it
    // calls free (a stop by hand, a restart of the server, a session reset, a
    // saturated API) stays mute here too: those are not the agent's failures
    // and a chip on them would be noise on a card that is about to restart.
    const failedInHumanHands = cur.status !== "done"
      && end.end !== "end_turn"
      && consumesAttempt(end);
    if (failedInHumanHands) {
      const why = `${describeTurnEnd(end)}. La card era stata spostata a mano mentre il turno girava: il tentativo e' finito qui, non e' stato rimesso in coda.`;
      try { ctx.queue.emit(deps.svc.setDispatchState({ taskId, state: CHIP_FAILED, error: why })); } catch { /* best-effort */ }
      try {
        deps.svc.addComment({ taskId, author: "system", kind: "service", content: why });
      } catch { /* best-effort */ }
      const parked = parkedEdgeEvent(cur, { requeue: false, parkState: CHIP_FAILED, reason: why });
      if (parked) { try { deps.broadcast(parked); } catch { /* best-effort */ } }
      return;
    }
    try { ctx.queue.emit(deps.svc.setDispatchState({ taskId, state: null })); } catch { /* best-effort */ }
  }
  return { onTurnEnd, settleStrandedReviewChip };
}
