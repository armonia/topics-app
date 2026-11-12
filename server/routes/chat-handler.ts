import type { StreamHandler } from "../providers";
import { onFirstModelEvent } from "../lib/answer-relay";
import { guardFinalizedTurn } from "../lib/finalized-turn-guard";
import { computeCleanBroadcastDelta } from "./stream-markers";
import { deriveToolDetail } from "../../shared/tool-detail";
import type { ToolCall } from "../types";
import { dispatchBrowserToolCall, providerRunsBrowserToolsItself, resolveContextIdForTopic } from "../browser-tool-dispatcher";
import { ControlToolError, dispatchControlToolCall, isControlTool } from "../control-tools";
import { isPassthroughProvider } from "../browser-tools-adapters";
import { rememberLiveToolTail } from "../lib/live-tool-tail";
import { callsCostUsd } from "../usage/pricing";
import { backfillPostTokens, insertCompactionMarkerIfNew } from "../db/compaction-markers";
import { getActiveGoal, replaceSteps } from "../services/goals";
import { accumulateTurnUsage, turnUsageWire } from "../usage/turn-usage";
import { buildContextUpdate } from "../usage/usage-update";
import { recordSessionContext } from "../db/session-context";
import { parseCodexUsageLimit } from "../providers/codex/usage-limit";
import { holdUntilLabel, setProviderHold } from "../lib/provider-hold";
import type { ChatTurnScope } from "./chat-turn-scope";

/** Builds the provider stream handler of a turn. */
export function createStreamHandler(turn: ChatTurnScope): void {
  const { SAVE_INTERVAL, addToolCallToLastMessage, appendTextBlock, appendThinkingBlock, appendToolBlock, blocks, broadcastToAll, broadcastToTopicSubscribers, broadcastTurnFrame, browserNavigatedTopics, browserService, controlDispatchDeps, ctx, deps, detectLocalhostAutoNav, finalizeStream, findToolBlock, globalOrchestrator, humanWait, inheritsOpenCompaction, late, liveCalls, markToolExecuting, matchedTopic, overrideModel, ownMirrored, ownRow, ownStream, partialMsg, persistTurnBody, priorToolTimes, providerSignalsExecStart, resetStreamTimer, rowOfFrame, sessionKey, settleTrackedTool, spawnedModel, sseToolCallDelta, trackBackgroundShell, trackedToolCallIds, undoInlineMarkAfterFailedTurn, updateBlockTool, updateLastMessage, updateStreamActivity, updateStreamContent, updateToolCallFields, updateToolCallResult, watchSessionForSubagents, writeSSE, writeToolResultSSE } = turn;
  // The owed answers this turn carries reach the model with it: its
  // first event settles them (`lib/answer-relay.ts`).
  const heardCarry = turn.carry ? () => { if (turn.carry) deps.answerRelay?.heard(turn.carry); } : null;
  const handler: StreamHandler = onFirstModelEvent(guardFinalizedTurn({
    onTextDelta: (text: string, _fullText: string) => {
      resetStreamTimer();
      // Il primo argomento È il pezzo nuovo, sempre: lo dice il contratto
      // su `StreamHandler.onTextDelta` e lo rispettano tutti i provider.
      //
      // Qui prima si indovinava: prefisso tagliato se il testo cominciava
      // per quello di prima, evento SCARTATO se era identico. Su quattro
      // provider su cinque quella seconda regola perdeva un token ripetuto
      // — «the the», due `\n` di fila, un `= =` in una tabella — e la
      // perdita era muta, perché la riga salvata e lo schermo dicevano
      // esattamente la stessa cosa sbagliata.
      const newText = text;
      if (newText) {
        turn.fullContent += newText;
        appendTextBlock(newText);

        // Topic/project/browser are now driven by tools, not markers.
        // The only surviving heuristic is auto-opening the browser pane
        // when the model mentions a localhost:PORT dev server in prose.
        // Scan only the new delta plus a small carry-over tail (a URL can
        // straddle two chunks) — not the whole accumulated fullContent.
        const scanWindow = turn.localhostScanCarry + newText;
        if (!globalOrchestrator) detectLocalhostAutoNav(scanWindow, matchedTopic);
        // Keep enough trailing context for a `localhost:PORT` split across
        // the boundary (`http://localhost:65535` ≈ 22 chars).
        turn.localhostScanCarry = scanWindow.slice(-24);

        // Broadcast clean content as a true delta against the cumulative
        // marker-stripped state. See computeCleanBroadcastDelta() for
        // the three observable cases this handles (closed marker
        // spanning chunks, close+tail in same chunk, multiple markers
        // in one chunk). Unit-tested in
        // server/routes/topics-marker-strip.test.ts.
        const { cumulativeClean, delta: deltaToBroadcast } =
          computeCleanBroadcastDelta(turn.fullContent, turn.lastBroadcastClean);
        turn.lastBroadcastClean = cumulativeClean;
        if (deltaToBroadcast) {
          const chunk = { type: "stream:content_chunk" as const, sessionKey, topicId: matchedTopic?.id, content: deltaToBroadcast };
          if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, chunk);
          else broadcastToAll(chunk);
          writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { content: deltaToBroadcast } }] }));
        }
      }

      turn.chunkCount++;
      updateStreamContent(sessionKey, turn.fullContent, turn.fullThinking);
      if (turn.chunkCount - turn.lastSaveChunk >= SAVE_INTERVAL) {
        turn.lastSaveChunk = turn.chunkCount;
        // Persist blocks alongside content so a mid-stream
        // GET /api/history (e.g. another window attaching) sees
        // the chronological timeline up to this point, not just
        // the bucket fields. Without this the attaching window
        // has no blocks until finalize, and falls back to the
        // legacy bucket render for the duration of the stream.
        persistTurnBody(true);
      }
    },

    // THE REASONING TRAVELS ON THE SSE TOO (card 40ea050c). The window
    // that sent the message reads only its own SSE while the reply is
    // open and drops these WS frames (`senderAlsoSees.ts`), so it never
    // reserved the row nor saw its text: the row was born from the
    // history reload after the loader had gone. On the SSE they keep
    // their order with the answer's text, which a WS frame cannot.
    onThinkingStart: () => {
      resetStreamTimer();
      const start = { type: "stream:thinking_start" as const, sessionKey, topicId: matchedTopic?.id };
      if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, start);
      else broadcastToAll(start);
      writeSSE(JSON.stringify({ thinking: { open: true } }));
    },

    onThinkingEnd: () => {
      const end = { type: "stream:thinking_end" as const, sessionKey, topicId: matchedTopic?.id };
      if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, end);
      else broadcastToAll(end);
      writeSSE(JSON.stringify({ thinking: { open: false } }));
    },

    onThinkingDelta: (text: string) => {
      resetStreamTimer();
      turn.fullThinking += text;
      appendThinkingBlock(text);
      const thinkingChunk = { type: "stream:thinking_chunk" as const, sessionKey, topicId: matchedTopic?.id, content: text };
      if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, thinkingChunk);
      else broadcastToAll(thinkingChunk);
      if (text) writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { thinking: text } }] }));
      updateStreamContent(sessionKey, turn.fullContent, turn.fullThinking);
    },

    onToolStart: (toolCallId: string, name: string, args?: Record<string, unknown>) => {
      console.log(`[StreamWS] Tool start: ${name} (${toolCallId.slice(0,8)}) for ${sessionKey}`);
      // Build a typed `detail` at the boundary so the renderer doesn't
      // have to JSON-grovel `args`. Bash → shell, Read → read, Task →
      // sub_agent (empty actions, populated later by SidechainTracker
      // updates), `mcp__*` → mcp with namespace stripped, etc. See
      // `shared/tool-detail.ts`. Unknown names fall through
      // to `{ type: 'unknown' }` so the legacy generic row still works.
      const detail = deriveToolDetail(name, args);
      // A provider with `tool-phases` announces the call while the
      // model is still writing it and runs it later, after the calls
      // before it in the same round: until `onToolExecStart` it is
      // QUEUED, with no clock. Shown "running" from here, a call queued
      // behind a long shell looked stuck on a command that had not
      // started (04/10: 288 native calls queued over 1 s in three
      // days, the worst 1,135.6 s for 0.3 s of work), and its stored
      // duration was mostly the wait.
      const queued = providerSignalsExecStart;
      const toolCall: ToolCall = {
        id: toolCallId, name, args: args || {},
        status: queued ? 'pending' : 'running', contentOffset: turn.fullContent.length,
        detail,
        // Real-usage window opens NOW. With partial-message streaming
        // (claude-code) this is when the model starts WRITING the
        // input — the UI's duration covers generation + execution.
        // Unless this id was already announced: a replay after a
        // restart keeps the time the tool really started.
        ...(queued ? {} : { startedAt: priorToolTimes(toolCallId).startedAt ?? Date.now() }),
      };
      // IL TURNO È VIVO. `lastActivity` lo scriveva SOLO
      // `updateStreamContent`, cioè prosa e thinking: un turno che
      // macina tool senza dire una frase era indistinguibile da un
      // processo morto, e lo spazzino degli stream fermi lo uccideva a
      // tre minuti. È il guasto dell'8 agosto 2026 — 17 tool eseguiti,
      // zero caratteri di testo, e in chat «⚠️ Risposta interrotta:
      // nessuna attività per 3 minuti» mentre il figlio girava ancora.
      // Con gli schemi MCP deferiti (ToolSearch → mount → tool) quei
      // tratti muti si sono allungati, quindi il difetto è passato da
      // raro a quotidiano. Una tool call È attività: si dichiara qui.
      updateStreamActivity(sessionKey);
      trackedToolCallIds.push(toolCallId);
      turn.toolsStartedThisTurn += 1;
      // DOPO la push, mai prima: `armSoftTimer` si sospende sull'insieme
      // che vede in questo istante. Vedi l'invariante su `armSoftTimer`.
      resetStreamTimer();
      addToolCallToLastMessage(sessionKey, toolCall, ownMirrored);
      appendToolBlock(toolCall);
      broadcastTurnFrame({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall, ...rowOfFrame() }, matchedTopic?.id);

      // Also send as SSE for the HTTP client
      writeSSE(sseToolCallDelta(toolCall));

      // Track sessions_spawn
      if (name === 'sessions_spawn' && matchedTopic && !globalOrchestrator) {
        watchSessionForSubagents(matchedTopic.id, sessionKey);
        console.log(`[SubagentPoll] sessions_spawn detected via WS in topic ${matchedTopic.id.slice(0,8)}`);
      }

      // Phase 30 BROWSER-CHAT-04 — server-side dispatch for native browser_* tools.
      // When the LLM emits a tool call with name starting with "browser_", call
      // the canonical handler directly (no HTTP roundtrip). The handler wraps
      // its action in withLock so agent_active broadcasts on entry and exit
      // (try/finally guaranteed unlock even if it throws). Result is fed back
      // through the same onToolResult update path used by every other tool, so
      // the chat UI shows identical lifecycle (running -> success/error).
      //
      // ...AND ONLY FOR THE PROVIDERS THAT DO NOT RUN IT THEMSELVES.
      // The route dispatches what the ROUTE registered (the passthrough
      // tool list a few hundred lines below); a runtime that carries its
      // own browser surface already executed the call, so dispatching
      // here would run it TWICE -- and, on the native runtime, the copy
      // the route sees has EMPTY args, because the announcement comes
      // before the arguments are streamed. See
      // `providerRunsBrowserToolsItself` for the measure.
      if (name.startsWith('browser_') && matchedTopic && browserService && !globalOrchestrator
          && !providerRunsBrowserToolsItself(turn.topicProvider.name)) {
        // The route runs it itself: here announcing and starting ARE the
        // same instant, so the suspension is earned.
        markToolExecuting(toolCallId);
        dispatchBrowserToolCall(name, args || {}, matchedTopic, browserService)
          .then((result) => {
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            // Mirror the onToolResult flow inline so the UI / SSE / persisted
            // state updates happen consistently. Same surface as the existing
            // onToolResult callback below.
            const browserEndedAt = Date.now();
            // The start-time detail only knows the requested URL. The
            // result says where the page landed, under which context, and
            // whether it opened at all: a native pane RESOLVES `{error}`
            // instead of throwing, so this is the only place a failed
            // `browser_open` shows up (CHAT-BROWSER-01).
            const failed = !!result && typeof result === 'object' && 'error' in result;
            const browserDetail = deriveToolDetail(name, args, resultStr, { failed });
            updateToolCallResult(sessionKey, toolCallId, resultStr, undefined, { endedAt: browserEndedAt }, ownMirrored);
            updateBlockTool(toolCallId, { status: 'success', result: resultStr, endedAt: browserEndedAt, detail: browserDetail });
            broadcastTurnFrame({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result: resultStr, detail: browserDetail, endedAt: browserEndedAt }, matchedTopic?.id);
            writeToolResultSSE({ id: toolCallId, status: 'success', result: resultStr, detail: browserDetail, endedAt: browserEndedAt });
            settleTrackedTool(toolCallId);

            // Close the tool→UI loop: browser_open navigates Playwright server-side,
            // but until now nothing opened the user-visible pane. Broadcast the same
            // `browser:navigate` event the legacy `{{BROWSER:url}}` marker path emits
            // (see detectAndBroadcastBrowserMarker above) so usePaneOrdering's WS
            // listener (client/src/components/Layout/hooks/usePaneOrdering.ts) opens
            // or focuses the pane and navigates it. Also seed browserNavigatedTopics
            // so the localhost fallback at line 443+ doesn't fire a duplicate
            // navigate when the model later mentions the same URL in plain text.
            if (name === 'browser_open' && matchedTopic) {
              const urlArg = typeof (args as any)?.url === 'string' ? (args as any).url : undefined;
              // Prefer the resolved URL the handler returns (final URL after any
              // redirects). Fall back to the input URL if the result shape changes.
              const resolvedUrl = (result && typeof (result as any).url === 'string')
                ? (result as any).url as string
                : urlArg;
              if (resolvedUrl) {
                // contextId so the visible pane registers under the SAME id
                // the SDK browser_* tools resolve to (resolveContextIdForTopic),
                // not a random one → no invisible Playwright phantom.
                broadcastToAll({ type: "browser:navigate", topicId: matchedTopic.id, contextId: resolveContextIdForTopic(matchedTopic), url: resolvedUrl });
                browserNavigatedTopics.add(matchedTopic.id);
              }
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[browser-tool-dispatcher] ${name} failed: ${msg}`);
            const errResult = JSON.stringify({ error: msg });
            const browserErrEndedAt = Date.now();
            updateToolCallResult(sessionKey, toolCallId, errResult, undefined, { endedAt: browserErrEndedAt }, ownMirrored);
            updateBlockTool(toolCallId, { status: 'error', result: errResult, endedAt: browserErrEndedAt });
            broadcastTurnFrame({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'error', result: errResult, endedAt: browserErrEndedAt }, matchedTopic?.id);
            writeToolResultSSE({ id: toolCallId, status: 'error', result: errResult, endedAt: browserErrEndedAt });
            settleTrackedTool(toolCallId);
          });
      }

      // SDK-passthrough control tools (open/create-project, switch/new-topic
      // — the tool-shaped successors to the {{PROJECT_*}}/{{TOPIC_*}} markers).
      // Same in-turn flow as the browser dispatch above: run the side-effect
      // in-process (reuses the closure-local project helpers + AppContext
      // topic ops), then feed the confirmation (or error) back through the
      // shared onToolResult update path so the chat UI shows the normal
      // running→success/error lifecycle. Fire-and-forget: single-turn SDK
      // providers don't need the result back to continue.
      //
      // THE ROUTE EXECUTES ONLY WHAT THE ROUTE REGISTERED. These five
      // names are handed to the model by `sendOptions.tools` for the
      // passthrough providers alone (see `isPassthroughProvider` below);
      // every other runtime already owns them through the MCP table
      // (`TOOL_HANDLERS`) and runs them itself. Dispatching here for
      // those runtimes is a second execution of the same call: on the
      // native runtime the announcement carries no arguments
      // (`agent-loop.ts` emits `onToolStart(id, name, {})`), so the
      // route re-ran the tool with `{}` and painted a bogus "argument
      // required" error over a call that had in fact succeeded.
      if (isControlTool(name) && matchedTopic && !globalOrchestrator && isPassthroughProvider(turn.topicProvider.name)) {
        markToolExecuting(toolCallId);
        dispatchControlToolCall(name, args || {}, matchedTopic, controlDispatchDeps)
          .then((confirmation) => {
            const controlEndedAt = Date.now();
            updateToolCallResult(sessionKey, toolCallId, confirmation, undefined, { endedAt: controlEndedAt }, ownMirrored);
            updateBlockTool(toolCallId, { status: 'success', result: confirmation, endedAt: controlEndedAt });
            broadcastTurnFrame({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result: confirmation, endedAt: controlEndedAt }, matchedTopic?.id);
            writeToolResultSSE({ id: toolCallId, status: 'success', result: confirmation, endedAt: controlEndedAt });
            settleTrackedTool(toolCallId);
          })
          .catch((err: unknown) => {
            const msg = err instanceof ControlToolError ? err.message : (err instanceof Error ? err.message : String(err));
            console.warn(`[control-tool] ${name} failed: ${msg}`);
            const errResult = JSON.stringify({ error: msg });
            const controlErrEndedAt = Date.now();
            updateToolCallResult(sessionKey, toolCallId, errResult, undefined, { endedAt: controlErrEndedAt }, ownMirrored);
            updateBlockTool(toolCallId, { status: 'error', result: errResult, endedAt: controlErrEndedAt });
            broadcastTurnFrame({ type: 'stream:tool_result', sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'error', result: errResult, endedAt: controlErrEndedAt }, matchedTopic?.id);
            writeToolResultSSE({ id: toolCallId, status: 'error', result: errResult, endedAt: controlErrEndedAt });
            settleTrackedTool(toolCallId);
          });
      }

    },

    onToolExecStart: (toolCallId: string) => {
      // The provider (native runtime) is about to EXECUTE the call it
      // announced earlier. Only from here does the tool suspend the soft
      // timer: between the announcement and this instant the turn was
      // just a stream being listened to, and a stream can be dead.
      updateStreamActivity(sessionKey);
      markToolExecuting(toolCallId);
      // ...and only from here is it RUNNING on screen, with its clock:
      // the announcement left it `pending` (see `onToolStart`).
      const block = findToolBlock(toolCallId);
      if (!block) return;
      const startedAt = Date.now();
      const started: ToolCall = { ...block.toolCall, status: 'running', startedAt };
      updateToolCallFields(sessionKey, toolCallId, { status: 'running', startedAt }, ownRow);
      updateBlockTool(toolCallId, { status: 'running', startedAt });
      broadcastTurnFrame({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall: started, ...rowOfFrame() }, matchedTopic?.id);
      writeSSE(sseToolCallDelta(started));
    },

    onToolUpdate: (toolCallId: string, _partialResult: string) => {
      resetStreamTimer();
      // Kept for whoever opens a socket before the command ends: the
      // catch-up is built from the row, which never has this (CHAT-TOOL-11).
      rememberLiveToolTail(ownStream(), toolCallId, _partialResult);
      // Broadcast partial result to clients
      broadcastTurnFrame({ type: "stream:tool_update", sessionKey, topicId: matchedTopic?.id, toolCallId, partialResult: _partialResult }, matchedTopic?.id);
    },

    onToolActivity: (_toolCallId: string) => {
      // A tool's input is actively streaming (input_json_delta) — the
      // turn is alive even with no new field to show. Reset the stream
      // timer so a minutes-long Write/Edit input doesn't trip the false
      // "stream slow" annotation. No persistence, no broadcast.
      resetStreamTimer();
    },

    onRetry: (info) => {
      // The API failed transiently and the provider is waiting to try
      // the same call again. The turn is alive, so the wait must not
      // count as silence for the watchdog; and the person must see WHY
      // nothing moves, or a 30s backoff reads as a hung chat. Order
      // matters: reset first (it clears a previous announcement), then
      // announce this one.
      resetStreamTimer();
      turn.retryAnnounced = true;
      // A client attaching during the backoff gets this from the
      // catchup, not from the frame below (see `ActiveStream.retry`).
      const waiting = ctx.activeStreams.get(sessionKey);
      if (waiting) waiting.retry = { ...info, at: Date.now() };
      console.warn(`[StreamWS] ${sessionKey}: ${info.reason} on attempt ${info.attempt}/${info.maxAttempts}, next in ${info.delayMs}ms`);
      if (matchedTopic) {
        broadcastToAll({
          type: "stream:retry",
          sessionKey,
          topicId: matchedTopic.id,
          messageId: partialMsg.id,
          attempt: info.attempt,
          maxAttempts: info.maxAttempts,
          delayMs: info.delayMs,
          reason: info.reason,
        });
      }
    },

    onToolArgsUpdate: (toolCallId: string, args: Record<string, unknown>, update?: { partial?: boolean }) => {
      resetStreamTimer();
      // The tool was announced EARLY (input still streaming, args {})
      // and its input is now complete. Upsert the full args + a fresh
      // derived detail onto the same ToolCall — persisted row, blocks
      // timeline, and clients (stream:tool_call merges by id in
      // useChat's addToolCallToLastMessage).
      const block = findToolBlock(toolCallId);
      if (!block) return; // never announced (shouldn't happen)
      // A PARTIAL update (the native runtime, every PARTIAL_ARGS_EMIT_MS while the
      // model writes the call) marks the row as still being written,
      // and the complete one clears the mark. `false`, not a missing
      // key: a client merges by spread, and an absent key would leave
      // the old `true` in place.
      const writing = update?.partial
        ? { inputStreaming: true }
        : block.toolCall.inputStreaming ? { inputStreaming: false } : {};
      const fields = { args, detail: deriveToolDetail(block.toolCall.name, args), ...writing };
      const merged: ToolCall = { ...block.toolCall, ...fields };
      // A partial update is not written to the database: it is
      // superseded within half a second, and the timeline in memory
      // (persisted by the turn's own flush) already carries it.
      if (!update?.partial) updateToolCallFields(sessionKey, toolCallId, fields, ownRow);
      updateBlockTool(toolCallId, fields);
      broadcastTurnFrame({ type: "stream:tool_call", sessionKey, topicId: matchedTopic?.id, toolCall: merged, ...rowOfFrame() }, matchedTopic?.id);
      writeSSE(sseToolCallDelta(merged));
    },

    onUserInputRequired: (toolCallId, _toolName, schema) => {
      // A tool paused the stream to ask the user a question. The
      // detector in `server/providers/ask-user-detector.ts` already
      // validated the shape; here we just (1) mutate the on-disk
      // ToolCall row to flip status + persist the schema so a mid-
      // pause refresh re-renders the form, (2) update the chat
      // blocks timeline in-memory for the current stream, and
      // (3) broadcast a typed WS event so connected clients open
      // the form immediately. The soft inactivity timer stays
      // suspended naturally: the tool that is asking is RUNNING (it
      // started executing before it could ask), so it is in the set
      // that suspends — see the `running` invariant in
      // `stream-timer.test.ts` and `toolsSuspendSoftTimer`.
      // Da qui in poi il turno non lavora: aspetta noi. Il cronometro
      // dell'attesa parte, e quel pezzo non finirà nella durata del turno.
      humanWait.open(toolCallId, Date.now());
      updateToolCallFields(sessionKey, toolCallId, {
        status: 'waiting_for_input',
        userInputSchema: schema,
      }, ownRow);
      updateBlockTool(toolCallId, {
        status: 'waiting_for_input',
        userInputSchema: schema,
      });
      broadcastToAll({
        type: 'stream:tool_user_input_required',
        sessionKey,
        topicId: matchedTopic?.id,
        toolCallId,
        schema,
      });
      // THE SENDER GETS IT ON ITS SSE TOO, in order with the rest of the
      // row. The WS frame alone has no order with the SSE: WebKit can
      // hold an SSE burst until the next byte, so the frame may land
      // before the row it patches exists there (and is lost), or before
      // the `running` announcement written just above it. Measured on
      // 04/10: 4 runs out of 6 left the sender on a spinner.
      const asking = findToolBlock(toolCallId);
      if (asking) writeSSE(sseToolCallDelta(asking.toolCall));
    },

    onSubAgentUpdate: (parentToolCallId, snapshot) => {
      resetStreamTimer();
      // Patch the parent Task tool's `detail` with the latest sub-agent
      // snapshot. Each call replaces the full actions[] (snapshot, not
      // delta) so the renderer always shows the current truth. Same
      // callId used as the regular tool_call channel — the client
      // matches by id and merges. We also persist via updateBlockTool
      // so a mid-stream reload sees the in-progress sub-agent activity.
      const detail: import("../types").ToolCallDetail = {
        type: "sub_agent",
        ...(snapshot.subAgentType ? { subAgentType: snapshot.subAgentType } : {}),
        ...(snapshot.description ? { description: snapshot.description } : {}),
        actions: snapshot.actions,
        ...(snapshot.result ? { result: snapshot.result } : {}),
      };
      updateBlockTool(parentToolCallId, { detail });
      // Alla topic, non a tutti. Questo è lo snapshot INTERO del
      // sotto-agente — actions[] ricostruito a ogni colpo, i frame più
      // grossi del turno — ed era l'unico callback di tool rimasto su
      // `broadcastToAll` mentre i vicini passavano già da
      // `broadcastStreamToTopic`. Ogni finestra aperta su un'altra topic
      // li riceveva tutti per instradarli su `topicId` e buttarli.
      broadcastTurnFrame({
        type: "stream:tool_detail",
        sessionKey,
        topicId: matchedTopic?.id,
        toolCallId: parentToolCallId,
        detail,
        finished: snapshot.finished,
      }, matchedTopic?.id);
    },

    onToolResult: (toolCallId: string, result: string, isError?: boolean) => {
      // IL TURNO È VIVO, e lo si dichiara SUBITO — come in `onToolStart`,
      // e per la stessa ragione: lo spazzino degli stream fermi guarda
      // `lastActivity`, e un risultato di tool è attività. Il riarmo del
      // watchdog invece va in fondo, con `settleTrackedTool`: farlo qui
      // vorrebbe dire riarmarlo mentre questo tool risulta ancora in
      // corso, cioè non riarmarlo affatto (vedi `armSoftTimer`).
      updateStreamActivity(sessionKey);
      // Se questo tool stava aspettando una risposta, l'attesa finisce
      // qui: da adesso è di nuovo lavoro. Sui tool che non hanno mai
      // chiesto niente non fa nulla.
      humanWait.close(toolCallId, Date.now());
      const status = isError ? 'error' : 'success';
      console.log(`[StreamWS] Tool result: ${toolCallId.slice(0,8)} ${status} for ${sessionKey}`);

      // Re-derive detail with result so per-kind body fields (shell.output,
      // read.content, fetch.result) are populated for the renderer. We
      // need the original tool name + args to build it — read them off
      // the in-memory blocks (the running ToolCall is already there
      // courtesy of onToolStart).
      let detail: import("../types").ToolCallDetail | undefined;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.kind === "tool" && b.toolCall.id === toolCallId) {
          detail = deriveToolDetail(b.toolCall.name, b.toolCall.args, result, { failed: !!isError });
          break;
        }
      }

      const endedAt = priorToolTimes(toolCallId).endedAt ?? Date.now();
      if (isError) {
        // Pass result as the error so updateToolCallResult sets status='error'
        // and the row renders red ✗ + error body. The Claude SDK puts the
        // failure message inside `tool_result.content` so `result` IS the
        // error text — passing it as both result and error is intentional.
        updateToolCallResult(sessionKey, toolCallId, result, result, { endedAt }, ownMirrored);
        updateBlockTool(toolCallId, { status: 'error', result, error: result, endedAt, ...(detail ? { detail } : {}) });
        broadcastTurnFrame({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'error', result, error: result, detail, endedAt }, matchedTopic?.id);
        writeToolResultSSE({ id: toolCallId, status: 'error', result, error: result, detail, endedAt });
      } else {
        updateToolCallResult(sessionKey, toolCallId, result, undefined, { endedAt }, ownMirrored);
        updateBlockTool(toolCallId, { status: 'success', result, error: undefined, endedAt, ...(detail ? { detail } : {}) }); // a second answer's 404 may have left one
        broadcastTurnFrame({ type: "stream:tool_result", sessionKey, topicId: matchedTopic?.id, toolCallId, status: 'success', result, detail, endedAt }, matchedTopic?.id);
        writeToolResultSSE({ id: toolCallId, status: 'success', result, detail, endedAt });
      }
      // Le shell in background non finiscono col tool: restano.
      // Registrarle qui è l'unico punto in cui passano — dopo, esistono
      // solo nel transcript. Vedi `providers/claude/background-shell.ts`.
      trackBackgroundShell(detail, result, isError === true);

      // Fuori dall'insieme dei tool in corso, e solo ORA il watchdog
      // torna armato: era l'ultimo, e il silenzio che segue è silenzio.
      settleTrackedTool(toolCallId);
    },

    onToolUsage: (toolCallId, u) => {
      // Il costo di UNA azione, non del turno. Il provider ha già
      // spartito la quota della chiamata fra i suoi tool_use; qui si
      // traduce in prezzo con le STESSE tariffe del consuntivo, così la
      // somma delle azioni combacia col totale in fondo al messaggio.
      // Il client non fa aritmetica: riceve costo e token già pronti.
      const tokens = (u.inputTokens || 0) + (u.outputTokens || 0);
      let costCents: number | undefined;
      try {
        const usd = callsCostUsd([u], turn.liveModel || overrideModel || "unknown");
        if (usd > 0) costCents = Math.round(usd * 100);
      } catch { /* modello sconosciuto: si mostrano i token senza prezzo */ }
      const patch: Partial<ToolCall> = { tokens };
      if (costCents != null) patch.costCents = costCents;
      updateToolCallFields(sessionKey, toolCallId, patch, ownRow);
      updateBlockTool(toolCallId, patch);
      broadcastTurnFrame({
        type: "stream:tool_usage",
        sessionKey,
        topicId: matchedTopic?.id,
        toolCallId,
        tokens,
        ...(costCents != null ? { costCents } : {}),
      }, matchedTopic?.id);
    },

    onCompaction: (marker) => {
      // CHAT-COMPACT-01: surface + persist a context-compaction boundary
      // as a display-only divider. Render-only — no model resume, and
      // the marker never re-enters provider history (separate table).
      try {
        resetStreamTimer();
        turn.compactedThisTurn = true;
        const stored = insertCompactionMarkerIfNew(ctx.db, {
          sessionKey,
          topicId: matchedTopic?.id ?? null,
          afterMessageId: partialMsg?.parentId ?? null,
          marker,
        });
        const event = {
          type: "stream:compaction" as const,
          sessionKey,
          topicId: matchedTopic?.id,
          markerId: stored.id,
          afterMessageId: stored.afterMessageId,
          trigger: stored.trigger,
          ...(stored.preTokens != null ? { preTokens: stored.preTokens } : {}),
          createdAt: stored.createdAt,
        };
        if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, event);
        else broadcastToAll(event);
      } catch (err) {
        console.error("[compaction] persist/broadcast failed:", err);
      }
    },

    onCommandAnswer: (answer) => {
      // CMDUI-04: the answer of a command is the pane's card, never a
      // message. Not saved, not in the history sent to the engine.
      resetStreamTimer();
      turn.answeredAsCommand = true;
      const event = {
        type: "stream:command-answer" as const,
        sessionKey,
        topicId: matchedTopic?.id,
        command: answer.command,
        text: answer.text,
        ...(answer.outcome ? { outcome: answer.outcome } : {}),
      };
      if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, event);
      else broadcastToAll(event);
    },

    onPlan: (steps) => {
      // 3.4: il piano dell'agente diventa i PASSI del goal della topic,
      // non testo del trascritto — così sopravvive alla compattazione
      // (l'envelope lo re-inietta) invece di scorrere via con la chat.
      //
      // Senza un goal attivo NON se ne inventa uno: un obiettivo
      // dedotto da un elenco di passi è esattamente il tipo di
      // deduzione che poi l'umano si ritrova iniettata nel contesto
      // senza averla mai scritta. Il piano resta comunque visibile
      // nella chat come TodoCard; qui non ha dove attaccarsi.
      try {
        resetStreamTimer();
        const topicId = matchedTopic?.id;
        if (!topicId) return;
        const goal = getActiveGoal(ctx.db, topicId);
        if (!goal) return;
        replaceSteps(ctx.db, goal.id, steps);
        broadcastToAll({
          type: "goal:updated" as const,
          topicId,
          goal: getActiveGoal(ctx.db, topicId),
        });
      } catch (err) {
        console.error("[goal] plan persist failed:", err);
      }
    },

    onCallUsage: (u) => {
      // Si ACCUMULA: il provider manda l'usage di UNA chiamata, e il
      // `result` finale somma già tutto — sommare anche quello sarebbe
      // contare due volte. Il client non fa aritmetica: riceve i totali.
      turn.live = accumulateTurnUsage(turn.live, u);
      liveCalls.push(u);
      if (u.model) turn.liveModel = u.model;
      if (!matchedTopic) return;
      // The split into DISJOINT shares, once and outside the try.
      //
      // `live` carries the shares as the API sends them: nested, so
      // `cacheCreation` is the TOTAL and `cacheCreation1h` a part of it.
      // The `messages` columns and the wire fields want the opposite
      // (disjoint shares, migration 070): a single door for the saved row
      // and the wire, so the cache write is never counted twice.
      const wire = turnUsageWire(turn.live);
      // Running cost, at the same prices as the final one: each call
      // priced on its own, then summed.
      let liveCost: number | undefined;
      try {
        const usd = callsCostUsd(liveCalls, turn.liveModel || overrideModel || "unknown");
        if (usd > 0) liveCost = Math.round(usd * 100);
      } catch { /* modello sconosciuto: si mostrano i token senza prezzo */ }
      // Gli stessi numeri, anche SULLA RIGA e non solo sul filo.
      //
      // Il broadcast lo vede chi è collegato in quel momento; chi apre
      // la chat dopo, o ricarica, o guarda un turno fermo su una
      // domanda, leggeva una riga senza consumo — e la striscia di
      // chiusura restava con la sola durata, senza token né prezzo.
      // Scriverli qui li rende durevoli: la finalizzazione poi li
      // sovrascrive coi totali definitivi del provider.
      try {
        updateLastMessage(sessionKey, {
          usagePromptTokens: wire.promptTokens,
          usageCompletionTokens: wire.completionTokens,
          cacheReadTokens: wire.cacheReadTokens,
          cacheCreationTokens: wire.cacheCreationTokens,
          cacheCreation1hTokens: wire.cacheCreation1hTokens,
          ...(liveCost != null ? { costCents: liveCost } : {}),
          ...(turn.liveModel ? { model: turn.liveModel } : {}),
        }, ownRow);
      } catch (err) { console.warn(`[usage] consumo vivo non scritto su ${sessionKey}:`, err); }
      broadcastToAll({
        type: "stream:usage",
        sessionKey,
        topicId: matchedTopic.id,
        calls: turn.live.calls,
        ...wire,
        ...(liveCost != null ? { costCents: liveCost } : {}),
        ...(turn.liveModel ? { model: turn.liveModel } : {}),
      });
    },
    onContextSize: (tokens, model, windowTokens) => {
      // 1) Il ring del contesto reale (1b.5). Questo numero — il
      //    prompt di UNA chiamata — è l'unica misura onesta di "quanto
      //    ha in pancia il modello", e fino a ieri moriva qui dentro:
      //    serviva solo a riempire il marker di compaction. La barra
      //    che l'umano vedeva misura un'altra cosa (il preventivo
      //    dell'envelope che iniettiamo NOI), quindi di fatto il dato
      //    più guardato a ogni turno non era da nessuna parte.
      try {
        // Forma standard `usage_update` ACP (3.1): il payload lo
        // costruisce un posto solo, così l'evento vivo e
        // `GET /api/context/live` non possono divergere.
        const update = buildContextUpdate({ tokens, model, fallbackModel: spawnedModel, windowTokens });
        // Scrittura solo quando il numero cambia davvero: in un turno
        // lungo questo handler scatta a ogni chiamata al modello.
        if (update.usage.used !== turn.lastContextUsed) {
          turn.lastContextUsed = update.usage.used;
          recordSessionContext(ctx.db, {
            sessionKey,
            usedTokens: update.usage.used,
            windowTokens: update.usage.size,
            estimated: update.estimated,
            model: model ?? spawnedModel ?? null,
          });
          const usageEvent = {
            type: "stream:context" as const,
            sessionKey,
            topicId: matchedTopic?.id,
            ...update,
          };
          if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, usageEvent);
          else broadcastToAll(usageEvent);
        }
      } catch (err) { console.error("[context] ring update failed:", err); }

      // 2) Post-compaction context size. The FIRST model call after the
      // boundary is the only honest measurement: its prompt IS the
      // compacted context. Previously this was backfilled from the
      // final `result` usage, which AGGREGATES every call in the turn —
      // so a long turn reported a post-compaction size far bigger than
      // the pre one and the divider read "48.9k → 1.2M token", i.e. the
      // context appeared to EXPLODE during compaction.
      if (!(turn.compactedThisTurn || inheritsOpenCompaction) || turn.postCompactionFilled) return;
      turn.postCompactionFilled = true;
      try {
        const filled = backfillPostTokens(ctx.db, sessionKey, tokens);
        if (!filled) return;
        const commandEvent = {
          type: "stream:compaction" as const,
          sessionKey,
          topicId: matchedTopic?.id,
          markerId: filled.id,
          afterMessageId: filled.afterMessageId,
          trigger: filled.trigger,
          ...(filled.preTokens != null ? { preTokens: filled.preTokens } : {}),
          ...(filled.postTokens != null ? { postTokens: filled.postTokens } : {}),
          createdAt: filled.createdAt,
        };
        if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, commandEvent);
        else broadcastToAll(commandEvent);
      } catch (err) { console.error("[compaction] backfill failed:", err); }
    },

    onDone: (message?: any) => {
      // Extract final content from message if available
      if (message) {
        const finalText = turn.extractFinalText(message);
        if (finalText && finalText.length > turn.fullContent.length) {
          const extra = finalText.slice(turn.fullContent.length);
          if (extra) {
            turn.fullContent = finalText;
            if (extra) {
              const extraChunk = { type: "stream:content_chunk" as const, sessionKey, topicId: matchedTopic?.id, content: extra };
              if (matchedTopic?.id) broadcastToTopicSubscribers(matchedTopic.id, extraChunk);
              else broadcastToAll(extraChunk);
            }
          }
        }
        turn.captureProviderUsage(message);
      }
      finalizeStream("done", undefined, message?.turnEnd);
    },

    onError: (error: string) => {
      console.error(`[StreamWS] Error for ${sessionKey}: ${error}`);
      // The second writer to the shared provider-hold memo (see
      // server/lib/provider-hold.ts): Codex publishes no usage
      // endpoint, only this sentence in the error itself, so this is
      // where the wall becomes something the dispatcher can read
      // instead of retrying four times into it (card 31be77d3).
      if (turn.topicProvider.name === "codex") {
        const limit = parseCodexUsageLimit(error);
        if (limit) {
          setProviderHold({ ...limit, window: "usage_limit", provider: "codex" });
          console.warn(`[StreamWS] Codex usage limit recorded for ${sessionKey}: resumes at ${holdUntilLabel({ untilMs: limit.untilMs })}`);
        }
      }
      // Il turno e' fallito: il preambolo marcato come consegnato potrebbe
      // non esserlo mai stato (PROCESS_DEAD rigetta PRIMA di scrivere su
      // stdin). Nel dubbio si rimanda: due token in piu' contro un modello
      // che non sa in che progetto si trova.
      undoInlineMarkAfterFailedTurn();
      finalizeStream("error", error);
    },

    onAborted: (message?: any) => {
      // Extract content from aborted message
      if (message) {
        const abortedText = turn.extractFinalText(message);
        if (abortedText && abortedText.length > turn.fullContent.length) {
          turn.fullContent = abortedText;
        }
        // A CANCELLED TURN HAS STILL BEEN PAID FOR. It used to finalize
        // with tokens, cost and model empty, so a turn stopped after
        // twenty minutes of work looked free in the chat and in the
        // stats. A provider that reports nothing here still lands on
        // the guard inside, and the row stays as it was.
        turn.captureProviderUsage(message);
      }
      finalizeStream("aborted", undefined, message?.turnEnd);
    },
  }, () => turn.streamState === "finalized", late), heardCarry);
  turn.handler = handler;
}
