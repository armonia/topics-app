import type { ToolCall } from "../types";
import { toolsSuspendSoftTimer } from "../lib/soft-timer-suspension";
import { logStreamHardTimeout, logStreamRecovered, logStreamSoftTimeout } from "../db/activity-log";
import { readTurnEnd, recordTurnEnd } from "../providers/turn-end-registry";
import { cancelled } from "../providers/stop-reason";
import { stripSlowAnnotation } from "./stream-markers";
import { appendInterruptedVerdict } from "../lib/interrupted-turn-block";
import { forgetLiveToolTail } from "../lib/live-tool-tail";
import { classifyShellToolResult } from "../providers/claude/background-shell";
import { closeBackgroundShell, noteBackgroundShellOutput, registerBackgroundShell } from "./processes";
import { getSessionCliPid } from "../providers/session-pids";
import type { ChatTurnScope } from "./chat-turn-scope";

/** The soft, grace and hard timers of a streamed turn, and the tool bookkeeping they read. */
export function armTurnTimers(turn: ChatTurnScope): void {
  const { blocks, boardAgentTurn, broadcastToAll, broadcastTurnFrame, closeClient, ctx, dispatched, endStream, endTurnAttention, executingToolCallIds, externalAbort, finalizeTurnActivity, matchedTopic, ownRow, ownStream, partialMsg, persistBlocks, providerSignalsExecStart, releaseTurnBodyFlush, requestStartMs, sessionKey, trackedToolCallIds, turnBody, turnId, updateLastMessage, updateStreamContent, writeSSE, writeTurnEnd } = turn;
  // ── Stream timeout state machine (resilience layer) ────────────
  //
  // We split the old single-timer design into three layered timers
  // because the previous "any 2 min of silence → kill the stream"
  // rule was too aggressive for multi-agent flows where the parent
  // legitimately waits on Task() sub-agents that may not emit events
  // for minutes at a time (e.g. a Bash inside a sub-agent).
  //
  //   SOFT (STREAM_TIMEOUT_MS, 2 min)
  //     The provider has gone quiet. Annotate the partial message
  //     with a "stream slow" marker, log a warn to activity_log,
  //     keep the handler registered, and start the GRACE timer.
  //     CRUCIAL: while ≥1 tool call is in `running` state, this
  //     timer is suspended (we are not in a true silence — we are
  //     waiting on a tool by design).
  //
  //   GRACE (STREAM_GRACE_MS, 60 s)
  //     Final window after a soft timeout to receive ANY provider
  //     event. If one arrives, we strip the annotation and resume
  //     normal streaming. Otherwise the stream is finalized as
  //     timed-out (the old behavior).
  //
  //   HARD (STREAM_HARD_TIMEOUT_MS, 30 min)
  //     Absolute upper bound, armed once at stream start and never
  //     reset. Protects against a provider that keeps emitting
  //     dust events forever; logs `error` to activity_log.
  //
  // The state variable below tracks where we are; resetStreamTimer
  // is the single entry point called by every onTextDelta /
  // onToolStart / onSubAgentUpdate / etc. handler.
  // 1 min soft: surface the "sta rallentando" cue after a minute of PURE
  // silence (the timer already suspends while tool calls run, so this
  // only counts genuine no-output gaps), instead of a 2-min apparent
  // freeze. Harmless if a healthy-but-slow turn trips it — the slow
  // annotation is stripped the moment output resumes (resetStreamTimer
  // recovery). Grace (recovery window) and the hard cap are unchanged.
  // The knobs shrink both windows for a test that drives the real route.
  const STREAM_TIMEOUT_MS = Number(process.env.TOPICS_STREAM_SOFT_MS) || 60_000; // 1 min soft
  const STREAM_GRACE_MS = Number(process.env.TOPICS_STREAM_GRACE_MS) || 60_000;  // 1 min grace
  const STREAM_HARD_TIMEOUT_MS = 30 * 60_000; // 30 min hard upper-bound
  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  turn.softTimedOutAtMs = null;

  const clearAllTimers = () => {
    // The deferred block write goes too: every path here rewrites the row whole.
    turnBody.dispose();
    releaseTurnBodyFlush();
    if (softTimer) { clearTimeout(softTimer); softTimer = null; }
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
  };
  turn.clearAllTimers = clearAllTimers;

  /**
   * Close the turn in the database AND tell the screens about it.
   * `endStream` returns the tool calls it cancelled, and that list is
   * the only event able to switch off a panel already drawn: dropped by
   * the two watchdogs below, it left the spinner spinning and a
   * question clickable on a turn that was over.
   */
  const endStreamAndAnnounce = (opts?: Parameters<typeof endStream>[1]): ToolCall[] => {
    const interruptedTools = endStream(sessionKey, { rowId: partialMsg.id, ...opts });
    for (const tc of interruptedTools) {
      broadcastTurnFrame({
        type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id,
        toolCallId: tc.id, status: "error",
        result: tc.result, error: tc.error, endedAt: tc.endedAt,
      }, matchedTopic?.id);
    }
    return interruptedTools;
  };
  turn.endStreamAndAnnounce = endStreamAndAnnounce;

  /**
   * Suspend while ≥1 tool call is `running`. The next resetStreamTimer
   * (fired on onToolResult / new event) will re-arm if needed.
   *
   * INVARIANT — this reads `trackedToolCallIds` as it is AT CALL TIME, so
   * every caller must have already applied the event it is reacting to.
   * Push before reset in `onToolStart`, splice before reset in every
   * completion path. Getting it backwards broke both ends of a turn:
   *
   *   - last tool result: the splice ran AFTER the reset, so the reset
   *     still saw one tool running, set `softTimer = null`, and nothing
   *     re-armed it. The watchdog stayed off for the rest of the turn —
   *     no soft timeout, no grace, no `stream:slow`.
   *   - first tool start: the push ran AFTER the reset, so the reset saw
   *     an empty set and armed a 60 s timer against a turn that was, by
   *     design, waiting on a tool. One minute later the user got a
   *     spurious "slowing down" banner on a perfectly healthy turn.
   */
  const armSoftTimer = () => {
    if (turn.streamState !== "streaming") return;
    if (softTimer) clearTimeout(softTimer);
    // ANNOUNCED IS NOT RUNNING. The rule and the reason live in
    // `lib/soft-timer-suspension.ts`; here it is only read.
    if (toolsSuspendSoftTimer({
      announced: trackedToolCallIds.length,
      executing: executingToolCallIds.length,
      providerSignalsExecStart,
    })) { softTimer = null; return; }
    softTimer = setTimeout(handleSoftTimeout, STREAM_TIMEOUT_MS);
  };

  const handleSoftTimeout = () => {
    if (turn.streamState !== "streaming") return;
    console.warn(`[StreamWS] Soft timeout: no data for ${STREAM_TIMEOUT_MS / 1000}s on ${sessionKey} (grace ${STREAM_GRACE_MS / 1000}s)`);
    turn.streamState = "soft-timed-out";
    turn.softTimedOutAtMs = Date.now();
    // Kept on the registry entry too: the `stream:slow` frame below
    // reaches only the clients connected NOW, and whoever attaches
    // later is served from `activeStreams` (see `ActiveStream.slow`).
    const slowStream = ctx.activeStreams.get(sessionKey);
    if (slowStream) slowStream.slow = true;
    // La lentezza si DICE, non si scrive nel messaggio.
    //
    // Prima qui si appendeva `STREAM_SLOW_ANNOTATION` a `fullContent` e si
    // riscriveva il messaggio. Funzionava come segnale visivo, ma il
    // segnale finiva nella STORIA: se il turno si chiudeva mentre era
    // lento, l'annotazione restava nel contenuto per sempre, e da quel
    // momento tornava al modello a OGNI turno successivo come se
    // l'assistente avesse detto «stream lento — il provider è ancora
    // connesso». Misurati 64 messaggi cosi' nel DB reale (bonificati
    // dalla migration 069).
    //
    // L'evento `stream:slow` qui sotto porta la stessa informazione, e
    // ora il client la rende: `TurnActivityIndicator` diventa ambra e
    // cambia frase finche' non arriva `stream:resumed` o la fine del
    // turno. Transitorio, come la cosa che descrive. Il messaggio resta
    // partial e lo stream resta aperto: non si chiude niente qui.
    if (matchedTopic) {
      broadcastToAll({
        type: "stream:slow",
        sessionKey,
        topicId: matchedTopic.id,
        messageId: partialMsg.id,
        graceMs: STREAM_GRACE_MS,
      });
    }
    logStreamSoftTimeout({
      sessionKey,
      topicId: matchedTopic?.id,
      durationMs: Date.now() - requestStartMs,
      toolCallCount: trackedToolCallIds.length,
    });
    // Start grace window. If the provider emits ANYTHING in this
    // window, resetStreamTimer's recovery branch fires and we
    // return to "streaming". Otherwise we finalize as timeout.
    graceTimer = setTimeout(handleGraceExpiry, STREAM_GRACE_MS);
  };

  const handleGraceExpiry = () => {
    if (turn.streamState !== "soft-timed-out") return;
    // Auto-compact resilience: the CLI emits NOTHING while it compacts
    // a full context (observed 3+ min of total silence), which is
    // indistinguishable from a dead provider on the stream alone.
    // While the child process is still ALIVE this is not a timeout —
    // extend the grace window instead of aborting a healthy turn (the
    // 30-min hard cap still bounds a truly wedged process). Bumping the
    // stream activity keeps the StaleStream sweeper (3-min inactivity)
    // from finalizing the vouched-for stream underneath us.
    if (turn.topicProvider.isTurnProcessAlive?.(sessionKey)) {
      console.warn(`[StreamWS] Grace expired but provider process is alive on ${sessionKey} (compaction/long silence) — extending grace ${STREAM_GRACE_MS / 1000}s`);
      // "Alive but silent" has TWO causes that look identical here: the
      // child really is quiet (compaction, a long tool), or we stopped
      // hearing a child that never stopped talking (a broker attachment
      // lost to a reconnect / a spawn that acked without attaching).
      // Extending alone turns the second one into a turn that never
      // ends — the freeze this watchdog is supposed to catch. So ask
      // the provider to re-attach from the last byte we consumed first:
      // a no-op when we are attached, a full recovery when we are not
      // (the missed output arrives and resetStreamTimer strips the slow
      // annotation on its own).
      (turn.topicProvider as { resyncStream?: (sk: string) => Promise<boolean> }).resyncStream?.(sessionKey)
        .then((did) => { if (did) console.warn(`[StreamWS] Resync issued for ${sessionKey} — recovering the stream if it was detached`); })
        .catch((err) => console.warn(`[StreamWS] Resync on grace-expiry failed for ${sessionKey}:`, err));
      updateStreamContent(sessionKey, turn.fullContent, turn.fullThinking);
      graceTimer = setTimeout(handleGraceExpiry, STREAM_GRACE_MS);
      return;
    }
    console.warn(`[StreamWS] Grace expired without recovery on ${sessionKey} → finalize as timeout`);
    turn.streamState = "finalized";
    // Il figlio è morto e nessuno ha parlato: è il watchdog a fermare il
    // turno. Senza questo, chi guida un turno headless leggerebbe la fine
    // di default (`end_turn`) e crederebbe a una consegna riuscita.
    recordTurnEnd(sessionKey, { ...cancelled("watchdog", "grace expired"), turnId });
    const timeoutMsg = "⚠️ Response timed out. The AI service took too long to respond. Please try again.";
    // Replace the soft annotation with the hard timeout marker.
    turn.fullContent = stripSlowAnnotation(turn.fullContent);
    if (!turn.fullContent.trim()) turn.fullContent = timeoutMsg;
    else turn.fullContent += "\n\n---\n*[Response timed out]*";
    // The marker above is the fallback for old clients, and it is a
    // footnote. The EVENT is the block: the cause in code, which is
    // what the client draws the banner off (`interrupted-turn-block`).
    const graceBlocks = appendInterruptedVerdict(blocks, { text: timeoutMsg, cause: "watchdog" });
    updateLastMessage(sessionKey, { content: turn.fullContent, blocks: graceBlocks, partial: undefined, streamedAt: undefined, endReason: "closed-outside" }, ownRow);
    endStreamAndAnnounce();
    turn.topicProvider.unregisterStreamHandler?.(sessionKey);
    // Abort the underlying provider turn too. `unregisterStreamHandler` is
    // a no-op for providers that don't implement it (e.g. ClaudeCodeProvider),
    // so without this the spawned process keeps running and later fires
    // `onDone` → a second finalizeStream (now guarded) and, worse, a frozen
    // per-session turn queue. Mirrors `/api/chat/abort` in topics.ts.
    // reason "watchdog": the liveness check above means we only get here
    // with a DEAD child, but the abort must still never read "user stop".
    turn.topicProvider.abort?.(sessionKey, undefined, "watchdog")?.catch((err: any) => console.warn(`[StreamWS] Provider abort on grace-expiry failed:`, err));
    if (matchedTopic) {
      broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: timeoutMsg });
      // `reason: "error"` + the notice: this end bypasses finalizeStream,
      // so the failure push (push-triggers) must be told here.
      broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id, stopReason: "cancelled", stopCause: "watchdog", reason: "error", error: timeoutMsg, ...(dispatched ? { dispatched: true } : {}) });
      endTurnAttention(matchedTopic, { messageId: partialMsg.id, stopCause: "watchdog", reason: "error", error: timeoutMsg, dispatched: boardAgentTurn });
      finalizeTurnActivity(matchedTopic);
    }
    // No separate "grace expired" log line — the soft-timeout entry
    // already exists; recovery would have logged on the way out.
    // Failing to recover IS the absence of a recovery log entry.
    writeTurnEnd(cancelled("watchdog")).then(() => writeSSE("[DONE]")).then(() => closeClient())
      .catch((err) => console.warn(`[StreamWS] DONE/close on grace-expiry failed:`, err));
    clearAllTimers();
  };

  const handleHardTimeout = () => {
    if (turn.streamState === "finalized") return;
    // Match the interactive CLI: NEVER kill a turn whose child process is
    // still alive. A 40-minute refactor, a big test run, a slow-but-live
    // tool is doing real work — not wedged. The terminal `claude` has no
    // wall-clock session cap at all; a turn runs until the model finishes,
    // the process dies, or the human hits Ctrl+C. So here the hard cap is
    // symmetric with the grace window: while the process is ALIVE we
    // extend (never SIGKILL a live, working turn — that was the sole
    // reason a headless chat could "crash"); only a DEAD child is
    // finalized, non-destructively (accumulated content is kept). The
    // Stop button is the user's Ctrl+C for a genuinely stuck-but-alive
    // turn.
    if (turn.topicProvider.isTurnProcessAlive?.(sessionKey)) {
      console.warn(`[StreamWS] Hard cap (${STREAM_HARD_TIMEOUT_MS / 60_000} min) reached but provider process is alive on ${sessionKey} — extending (a live turn is never killed)`);
      updateStreamContent(sessionKey, turn.fullContent, turn.fullThinking);
      hardTimer = setTimeout(handleHardTimeout, STREAM_HARD_TIMEOUT_MS);
      return;
    }
    console.error(`[StreamWS] Hard cap (${STREAM_HARD_TIMEOUT_MS / 60_000} min) reached and provider process is DEAD on ${sessionKey} → finalize`);
    turn.streamState = "finalized";
    recordTurnEnd(sessionKey, { ...cancelled("watchdog", "hard cap reached"), turnId });
    const msg = `⚠️ Hard timeout (${STREAM_HARD_TIMEOUT_MS / 60_000} min) reached. The provider stopped responding.`;
    turn.fullContent = stripSlowAnnotation(turn.fullContent);
    if (!turn.fullContent.trim()) turn.fullContent = msg;
    else turn.fullContent += `\n\n---\n*[Hard timeout (${STREAM_HARD_TIMEOUT_MS / 60_000} min) reached]*`;
    // `watchdog` and not `wall-clock`: the cause written on the row is
    // the one this path broadcasts on `stream:end` below, and two
    // witnesses of the same turn must not disagree.
    const hardBlocks = appendInterruptedVerdict(blocks, { text: msg, cause: "watchdog" });
    updateLastMessage(sessionKey, { content: turn.fullContent, blocks: hardBlocks, partial: undefined, streamedAt: undefined, endReason: "closed-outside" }, ownRow);
    endStreamAndAnnounce();
    turn.topicProvider.unregisterStreamHandler?.(sessionKey);
    // See handleGraceExpiry: abort the orphaned provider turn (no-op
    // unregister otherwise leaves the process running).
    turn.topicProvider.abort?.(sessionKey, undefined, "watchdog")?.catch((err: any) => console.warn(`[StreamWS] Provider abort on hard-timeout failed:`, err));
    if (matchedTopic) {
      broadcastToAll({ type: "stream:error", sessionKey, topicId: matchedTopic.id, error: msg });
      // Same as the grace path: told here because finalizeStream never runs.
      broadcastToAll({ type: "stream:end", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id, stopReason: "cancelled", stopCause: "watchdog", reason: "error", error: msg, ...(dispatched ? { dispatched: true } : {}) });
      endTurnAttention(matchedTopic, { messageId: partialMsg.id, stopCause: "watchdog", reason: "error", error: msg, dispatched: boardAgentTurn });
      finalizeTurnActivity(matchedTopic);
    }
    logStreamHardTimeout({
      sessionKey,
      topicId: matchedTopic?.id,
      durationMs: Date.now() - requestStartMs,
      toolCallCount: trackedToolCallIds.length,
    });
    writeTurnEnd(cancelled("watchdog")).then(() => writeSSE("[DONE]")).then(() => closeClient())
      .catch((err) => console.warn(`[StreamWS] DONE/close on hard-timeout failed:`, err));
    clearAllTimers();
  };

  const recoverFromSoftTimeout = () => {
    // A provider event arrived during the grace window. Strip the
    // annotation and return to "streaming". Future events resume
    // normal handling.
    if (turn.streamState !== "soft-timed-out") return;
    console.log(`[StreamWS] Recovered from soft timeout on ${sessionKey} after ${Date.now() - (turn.softTimedOutAtMs ?? Date.now())}ms`);
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    turn.streamState = "streaming";
    turn.fullContent = stripSlowAnnotation(turn.fullContent);
    updateLastMessage(sessionKey, { content: turn.fullContent }, ownRow);
    const recovered = ctx.activeStreams.get(sessionKey);
    if (recovered) delete recovered.slow;
    if (matchedTopic) {
      broadcastToAll({
        type: "stream:resumed",
        sessionKey,
        topicId: matchedTopic.id,
        messageId: partialMsg.id,
      });
    }
    logStreamRecovered({
      sessionKey,
      topicId: matchedTopic?.id,
      durationMs: turn.softTimedOutAtMs ? Date.now() - turn.softTimedOutAtMs : undefined,
    });
    turn.softTimedOutAtMs = null;
  };

  /** Single entry point called by every provider event handler. */
  // A retry was announced to the client and not yet cleared: the next
  // provider event clears it, the way `stream:resumed` clears "slow".
  turn.retryAnnounced = false;
  const resetStreamTimer = () => {
    if (turn.streamState === "finalized") return;
    // Any provider event proves the stream is alive — bump the
    // in-memory registry so the StaleStream sweeper (3-min
    // lastActivity cutoff) doesn't finalize a healthy tool-heavy
    // turn: lastActivity was only ever bumped by TEXT deltas, so a
    // turn grinding through tools for minutes with no prose got its
    // partial flag force-cleared and the UI spinner killed mid-run.
    updateStreamContent(sessionKey, turn.fullContent, turn.fullThinking);
    if (turn.streamState === "soft-timed-out") recoverFromSoftTimeout();
    if (turn.retryAnnounced) {
      // The API came back after a retry: the amber notice goes away,
      // on the registry entry as well as on the wire.
      turn.retryAnnounced = false;
      const retryStream = ctx.activeStreams.get(sessionKey);
      if (retryStream) delete retryStream.retry;
      if (matchedTopic) {
        broadcastToAll({ type: "stream:resumed", sessionKey, topicId: matchedTopic.id, messageId: partialMsg.id });
      }
    }
    armSoftTimer();
  };
  turn.resetStreamTimer = resetStreamTimer;

  /**
   * Un tool ha finito: PRIMA esce dall'insieme, POI si riarma il timer.
   *
   * L'ordine è la regola scritta su `armSoftTimer`, e questo è l'unico
   * posto in cui si toglie un id: i cinque siti che facevano
   * `indexOf`+`splice` a mano (risultato del tool, i due esiti della
   * dispatch dei tool `browser_*`, i due dei control tool) erano cinque
   * occasioni di dimenticarsene — e tre di loro se n'erano già
   * dimenticate, lasciando il watchdog spento dopo l'ultimo tool.
   */
  const settleTrackedTool = (toolCallId: string) => {
    forgetLiveToolTail(ownStream(), toolCallId);
    const idx = trackedToolCallIds.indexOf(toolCallId);
    if (idx >= 0) trackedToolCallIds.splice(idx, 1);
    const running = executingToolCallIds.indexOf(toolCallId);
    if (running >= 0) executingToolCallIds.splice(running, 1);
    resetStreamTimer();
  };
  turn.settleTrackedTool = settleTrackedTool;

  /**
   * The tool is running from now on. Both sets carry the id: the
   * announcement stays what it is (the row is already on screen), and
   * this is what suspends the soft timer.
   *
   * Called by `onToolExecStart` for providers that declare `tool-phases`
   * and, for the tools the ROUTE executes itself (`browser_*`, control
   * tools), at the moment the route dispatches them - there, announcing
   * and starting really are the same instant.
   */
  const markToolExecuting = (toolCallId: string) => {
    if (!executingToolCallIds.includes(toolCallId)) executingToolCallIds.push(toolCallId);
    resetStreamTimer();
  };
  turn.markToolExecuting = markToolExecuting;

  /**
   * Tiene vive nel pannello Processi le shell che l'agente lascia in
   * background (3.5). Il transcript le mostra una volta e le dimentica;
   * qui diventano stato: si contano, si leggono, si fermano.
   *
   * Non butta mai il turno: un registro che non si aggiorna è una riga
   * mancante nel pannello, non un motivo per far fallire una chat.
   */
  const trackBackgroundShell = (
    detail: import("../types").ToolCallDetail | undefined,
    result: string,
    isError: boolean,
  ) => {
    try {
      const action = classifyShellToolResult(detail, result, isError);
      if (!action) return;
      if (action.kind === "start") {
        // La cwd della topic viene PRIMA di quella del tool: il pannello
        // raggruppa per progetto, e una shell lanciata in `client/`
        // appartiene comunque al progetto che l'utente sta guardando —
        // con la cwd del tool finirebbe in un gruppo che non esiste.
        const cwd = (matchedTopic ? ctx.resolveTopicCwd(matchedTopic) : null)
          || action.cwd
          || process.cwd();
        registerBackgroundShell({
          sessionKey,
          topicId: matchedTopic?.id ?? null,
          shellId: action.shellId, outputPath: action.outputPath,
          command: action.command,
          cwd,
          ownerPid: getSessionCliPid(sessionKey),
        });
      } else if (action.kind === "output") {
        noteBackgroundShellOutput(sessionKey, action.shellId, {
          ...(action.output ? { output: action.output } : {}),
          ...(action.status ? { status: action.status } : {}),
          ...(action.exitCode != null ? { exitCode: action.exitCode } : {}),
        });
      } else {
        closeBackgroundShell(sessionKey, action.shellId, "killed");
      }
    } catch (err) {
      console.warn("[shell] registro non aggiornato:", err);
    }
  };
  turn.trackBackgroundShell = trackBackgroundShell;

  // Hard timer is armed once at stream start and is the only timer
  // never reset by events.
  hardTimer = setTimeout(handleHardTimeout, STREAM_HARD_TIMEOUT_MS);
  // Il soft timer parte SUBITO, non al primo evento del provider. Prima
  // lo armava solo `resetStreamTimer`, quindi un turno che non emetteva
  // NULLA (CLI wedged, MCP che non risponde all'init, `--resume` che non
  // parte) non produceva né `stream:slow` né soft-timeout: nei log di
  // prod zero occorrenze di entrambi a fronte di turni finalizzati dallo
  // sweeper. Il silenzio iniziale è esattamente il caso da sorvegliare.
  armSoftTimer();

  // Finalizzazione decisa da FUORI (sweeper StaleStream): il turno è già
  // chiuso in DB e annunciato via WS, qui resta solo da liberare il
  // client SSE, che altrimenti aspetta `[DONE]` all'infinito.
  externalAbort.signal.addEventListener("abort", () => {
    if (turn.streamState === "finalized") return;
    console.warn(`[StreamWS] finalizzazione esterna su ${sessionKey} — chiudo l'SSE`);
    // I BLOCCHI si salvano PRIMA di dichiarare finito il turno, ed è
    // l'ultimo momento in cui si può: da qui in poi `streamState` è
    // `finalized`, quindi `finalizeStream` esce subito e chi finalizza da
    // fuori scrive `content` ma non li tocca — `/api/chat/abort` passa a
    // `updateLastMessage` solo content/thinking, e il COALESCE tiene la
    // colonna vecchia (server/utils.ts).
    //
    // `content` lo tiene lo stream in memoria a ogni delta, i blocchi si
    // persistono ogni SAVE_INTERVAL=10: fermare un turno al quindicesimo
    // delta lasciava la riga con quindici delta in `content` e dieci in
    // `blocks` — e chi disegna legge `blocks`. Il finale della risposta
    // c'era, in una colonna che nessuno guarda.
    //
    // Solo i blocchi, non il testo: sulla via dello sweeper StaleStream la
    // riga porta già il cartello «Risposta interrotta» scritto in
    // `content`, e riscriverci sopra cancellerebbe la spiegazione. E i
    // flag di controllo non si toccano — `persistTurnBody` non passa
    // `partial`, quindi resta quello della riga.
    try { persistBlocks(true); }
    catch (err) { console.warn(`[StreamWS] salvataggio dei blocchi su abort esterno fallito:`, err); }
    turn.streamState = "finalized";
    clearAllTimers();
    turn.topicProvider.unregisterStreamHandler?.(sessionKey);
    // Deposited by whoever aborted (abort route, sweeper); an older one is another turn's.
    const deposited = readTurnEnd(sessionKey);
    writeTurnEnd(deposited && deposited.atMs >= requestStartMs ? deposited.info : { end: "cancelled" })
      .then(() => writeSSE("[DONE]")).then(() => closeClient())
      .catch((err) => console.warn(`[StreamWS] DONE/close su abort esterno fallito:`, err));
  }, { once: true });
}
