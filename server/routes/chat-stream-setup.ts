import { createHumanWaitLedger } from "../lib/human-wait";
import type { ContentBlock, ToolCall } from "../types";
import { cartelloRisveglio, commandWakeBanner } from "../providers/claude/woken-turn";
import { createTurnBodyPersist } from "../lib/turn-body-persist";
import { outageCutPickedUp } from "../lib/ripresa-boot";
import { createLateAnswerLane } from "../lib/late-answer-lane";
import { patchOpenTool, registerTurnBodyFlush } from "../lib/turn-body-flush";
import { isAwaitingHuman } from "../../shared/types";
import { emptyTurnUsage } from "../usage/turn-usage";
import type { PricedCall } from "../usage/pricing";
import type { RowSnapshot } from "./reattachMerge";
import { decodeCol } from "../../shared/message-blob";
import { restoreBlocksJson } from "../lib/tool-output-store";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { providerSurvivesRestart, turnSurvivesRestart } from "../lib/quiescence";
import { recordTurnStart } from "../providers/turn-end-registry";
import { isInternalRequest } from "../lib/abort-cause";
import { createSseNudge, startSsePing } from "../lib/sse-ping";
import { firstTimes, type ToolTimes, toolTimesOfRow } from "../lib/tool-call-times";
import type { TurnEndInfo } from "../providers/stop-reason";
import type { ChatTurnScope } from "./chat-turn-scope";

/** Sets up the per-turn state of a streamed turn: the row, the blocks, the usage counters and the SSE writers. */
export function setupTurnStream(turn: ChatTurnScope): void {
  const { MIRRORED, boardAgentTurn, body, broadcastStreamToTopic, broadcastToAll, createPartialMessage, ctx, db, dispatched, idempotencyKey, isReattach, isWoken, matchedTopic, req, resumeAttempt, reuseHeadstoneOrCreate, reuseOrCreatePartialForReattach, sentByPerson, sessionKey, ssePingMs, startStream, startTurnAttention, updateLastMessage } = turn;
  const requestStartMs = Date.now();
  turn.requestStartMs = requestStartMs;
  // L'inizio del TURNO — di norma è questo istante, ma su una
  // riadozione diventa l'ora di nascita della riga che stiamo
  // riprendendo (vedi sotto). `requestStartMs` resta l'inizio di
  // QUESTA gamba HTTP, che serve ad altro (i media nuovi, le durate
  // degli eventi).
  turn.turnStartMs = requestStartMs;
  turn.fullContent = "";
  turn.fullThinking = "";
  // Carry-over tail for the localhost auto-nav scan: instead of
  // re-scanning the whole accumulated fullContent every delta (O(n²) over
  // a stream), we scan only `carry + newDelta` where `carry` holds the
  // last few chars of what we already scanned — enough to catch a
  // `localhost:PORT` URL split across two chunks (max ~22 chars).
  turn.localhostScanCarry = "";
  // Cumulative marker-stripped content that has already been broadcast
  // to clients. Delta to broadcast on each chunk =
  //   currentMarkerStrippedFullContent - lastBroadcastClean
  // This closes the chunk-split + post-marker-tail leak (delta carrying
  // `…}} now check it out` after the close arrives) that pure regex
  // strip on `newText` cannot. See CLOSED_MARKER_REGEX comment above.
  turn.lastBroadcastClean = "";
  turn.chunkCount = 0;
  turn.lastSaveChunk = 0;
  const SAVE_INTERVAL = 10;
  turn.SAVE_INTERVAL = SAVE_INTERVAL;
  const trackedToolCallIds: string[] = [];
  turn.trackedToolCallIds = trackedToolCallIds;
  /**
   * How many tools this turn STARTED, finished or not. Not the same as
   * `trackedToolCallIds.length`: that list holds the tools still in
   * flight and every finished tool leaves it, so at the end of a turn it
   * is empty by construction. The goal loop read it as "did this turn
   * run a tool?" and stopped a working chase as «2 turns with no tool
   * run» (topic:33966f4e, 23/09, after Bash, Read and browser calls).
   */
  turn.toolsStartedThisTurn = 0;
  /**
   * The ids of the tools that are actually RUNNING, not merely announced.
   *
   * `trackedToolCallIds` is filled in `onToolStart`, which fires at
   * `content_block_start`: the model has begun WRITING the call, and on
   * the native runtime execution only happens once the round has closed.
   * Suspending the soft timer on that set switches the fastest guard off
   * for the whole writing window, two minutes in the case measured on
   * 2026-08-28. Only tools somebody saw START enter here. See
   * `toolsSuspendSoftTimer`.
   */
  const executingToolCallIds: string[] = [];
  turn.executingToolCallIds = executingToolCallIds;
  /**
   * Can this provider tell "announced" from "running"? One that does not
   * declare it will never emit `onToolExecStart`, so for it the
   * announcement keeps counting as execution: demanding a signal it
   * cannot send would turn every long CLI tool into a false "the stream
   * is slowing down".
   */
  const providerSignalsExecStart = turn.topicProvider.capabilities.has("tool-phases");
  turn.providerSignalsExecStart = providerSignalsExecStart;
  // Il tempo passato fermi su una domanda: si apre in `onUserInputRequired`,
  // si chiude quando quel tool consegna il risultato, e alla fine si
  // sottrae da `latencyMs`. Senza, la durata scritta sotto il messaggio è
  // il tempo che ci ha messo una persona a rispondere. Vedi lib/human-wait.ts.
  const humanWait = createHumanWaitLedger();
  turn.humanWait = humanWait;
  // Chronological content timeline. Each event from the provider is
  // appended in arrival order; consecutive same-kind text/thinking
  // deltas grow the trailing block, while tool calls always start a
  // new block. Persisted on finalize so reload preserves ordering.
  // See `server/types.ts:ContentBlock` — same shape lives on
  // `StoredMessage.blocks` and (mirror-typed) on the client.
  // A `run_command` wake names its command, how it ended and its last line (BGVIS-07).
  const blocks: ContentBlock[] = isWoken ? cartelloRisveglio(true, body.wokenSource ?? body.wokenLabel) : commandWakeBanner(body.processExit);
  turn.blocks = blocks;
  // Il cartello della RIPRESA (`lib/ripresa-boot.ts`): senza, sembrerebbe
  // che l'agente abbia risposto due volte alla stessa domanda.
  // It carries the resend number in the chain: if this turn too dies
  // under a restart, the next boot knows how many it has already spent.
  // Counting on the single row let the same message resume at every boot.
  if (resumeAttempt > 0) blocks.push({ kind: "ripreso", attempt: resumeAttempt });
  // What the timeline is worth in bytes, near enough: it decides WHEN
  // the row is rewritten, never what goes into it (see
  // `createBlockPersistThrottle`). Each event adds only what IT brings.
  let blocksBytes = 0;
  const appendTextBlock = (delta: string) => {
    if (!delta) return;
    blocksBytes += delta.length;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "text") last.text += delta;
    else blocks.push({ kind: "text", text: delta });
  };
  turn.appendTextBlock = appendTextBlock;
  const appendThinkingBlock = (delta: string) => {
    if (!delta) return;
    blocksBytes += delta.length;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "thinking") last.text += delta;
    else blocks.push({ kind: "thinking", text: delta });
  };
  turn.appendThinkingBlock = appendThinkingBlock;
  // The body of the turn reaches its row from here and nowhere else:
  // WHAT gets written and HOW OFTEN both live in lib/turn-body-persist.ts.
  const turnBody = createTurnBodyPersist({
    sessionKey,
    updateLastMessage,
    rowId: () => partialMsg.id,
    blocks,
    content: () => turn.fullContent,
    thinking: () => turn.fullThinking,
    trackedTools: () => trackedToolCallIds.length,
    reattachSnapshot: () => reattachSnapshot,
  });
  turn.turnBody = turnBody;
  const persistTurnBody = (withText: boolean, force = false) => turnBody.request(withText, blocksBytes, force);
  turn.persistTurnBody = persistTurnBody;
  // A late answer is kept on this turn's row, under the cut, starting
  // from the row as its closer left it: lib/late-answer-lane.ts. Which
  // callbacks go there, which stay live and which are dropped:
  // lib/finalized-turn-guard.ts.
  let releaseLateFlush: (() => void) | null = null;
  // An outage's cut on this row is resumed without the person only as
  // the direct answer to their message, which the sweep resends, or on
  // a card in progress, which the dispatcher resumes: read off the
  // database when the cut is written.
  const directAnswer = () => outageCutPickedUp(db, sessionKey, partialMsg.id, matchedTopic?.id);
  turn.directAnswer = directAnswer;
  const late = createLateAnswerLane({
    sessionKey, topicId: matchedTopic?.id, rowId: () => partialMsg.id, blocks, saveEvery: SAVE_INTERVAL, directAnswer,
    isClosed: () => turn.streamState === "finalized",
    readRow: () => ctx.getMessageById(partialMsg.id),
    content: { get: () => turn.fullContent, set: (value) => { turn.fullContent = value; } },
    thinking: { get: () => turn.fullThinking, set: (value) => { turn.fullThinking = value; } },
    appendTextBlock, appendThinkingBlock, setBlocksBytes: (bytes) => { blocksBytes = bytes; },
    save: (force) => persistTurnBody(true, force),
    broadcast: (frame) => broadcastStreamToTopic(frame, matchedTopic?.id),
    finalText: (message) => turn.extractFinalText(message),
    onOpen: () => { releaseLateFlush = registerTurnBodyFlush(sessionKey, () => turnBody.flush(), { patchTool: patchOpenTool(blocks, updateBlockTool) }); },
    onClose: () => { releaseLateFlush?.(); },
  });
  turn.late = late;
  // THE ROW, FOR WHOEVER READS IT INSTEAD OF THE STREAM: the outbound
  // gate reads the waiting tool from a row the throttle can owe for
  // fifteen seconds. And THE TIMELINE, for a route that writes a tool
  // (the person's answer): the turn's next write is made from it.
  // Published here, taken down with the turn: lib/turn-body-flush.ts.
  const releaseTurnBodyFlush = registerTurnBodyFlush(sessionKey, () => turnBody.flush(), { rowId: () => partialMsg.id, stop: () => turnBody.stop(), patchTool: patchOpenTool(blocks, (id, patch) => updateBlockTool(id, patch)) });
  turn.releaseTurnBodyFlush = releaseTurnBodyFlush;
  // A turn already finalized has no write budget left to save: whatever
  // still arrives (a tool result that came back after the end) is
  // written NOW. Deferring it would leave the row without it until an
  // event that will never come, and would put the write on a timer
  // outliving the turn that owns it. A tool the ROUTE runs itself
  // (`browser_*`, control tools) settling after the end is that case.
  // A late answer's tools are not: its end writes the row, and forced
  // they rewrote the whole timeline at every event.
  const persistBlocks = (force = false) =>
    persistTurnBody(false, force || (turn.streamState === "finalized" && !late.isOpen()));
  turn.persistBlocks = persistBlocks;
  const appendToolBlock = (tc: ToolCall) => {
    blocks.push({ kind: "tool", toolCall: tc });
    blocksBytes += JSON.stringify(tc).length;
    persistBlocks();
  };
  turn.appendToolBlock = appendToolBlock;
  const updateBlockTool = (id: string, patch: Partial<ToolCall>) => {
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.kind === "tool" && b.toolCall.id === id) {
        // Replace the tool block with a fresh object holding a fresh
        // toolCall ref. Mutating in place looks tempting but breaks
        // any client-side React.memo that uses shallow prop equality
        // when we serialize the array — the toolCall ref is what
        // ToolCallRow keys off of in the legacy bucket too.
        blocks[i] = {
          kind: "tool",
          toolCall: { ...b.toolCall, ...patch },
        };
        blocksBytes += JSON.stringify(patch).length;
        // A tool that stops to ask is written NOW: a panel that lives
        // only in memory is a question a reload throws away.
        persistBlocks(isAwaitingHuman(patch.status));
        return;
      }
    }
  };
  turn.updateBlockTool = updateBlockTool;
  /** The timeline block of an announced call, newest first. */
  const findToolBlock = (id: string): Extract<ContentBlock, { kind: "tool" }> | undefined => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === "tool" && b.toolCall.id === id) return b;
    }
    return undefined;
  };
  turn.findToolBlock = findToolBlock;
  /**
   * The SSE twin of a `stream:tool_call` frame, for the window that sent
   * the message (it drops the WS copy). It carries the lifecycle fields
   * too: a row rebuilt from a bare name and args would read `running`
   * without a clock, whatever the call is really doing.
   */
  const sseToolCallDelta = (tc: ToolCall): string => JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
    id: tc.id,
    function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    contentOffset: tc.contentOffset,
    ...(tc.status ? { status: tc.status } : {}),
    ...(typeof tc.startedAt === "number" ? { startedAt: tc.startedAt } : {}),
    ...(tc.detail ? { detail: tc.detail } : {}),
    ...(typeof tc.inputStreaming === "boolean" ? { inputStreaming: tc.inputStreaming } : {}),
    ...(tc.status === "waiting_for_input" && tc.userInputSchema ? { userInputSchema: tc.userInputSchema } : {}),
  }] } }] });
  turn.sseToolCallDelta = sseToolCallDelta;
  // Captured at stream-end if the provider's final message includes
  // usage (claude-code SDK does; codex turn.completed will too).
  // finalizeStream() reads these and persists them on the message so
  // the UI footer can render `<duration>s · <tokens> · $<cost>`.
  
  
  
  // Il MODELLO del turno, salvato accanto al costo che ha determinato.
  // Qui e' l'unico punto in cui e' noto: piu' avanti resta solo il numero,
  // e un numero senza la tariffa che lo ha prodotto non e' correggibile
  // (vedi la bonifica 077, che ha dovuto dedurre il prezzo a ritroso).
  
  // Lo SCORPORO della cache, che finora esisteva solo dentro il calcolo del
  // prezzo e veniva buttato. In un turno agentico lungo la cache riletta è
  // la voce schiacciante — lo stesso prompt riletto a ogni chiamata al
  // modello arriva a milioni di token — quindi il totale da solo non
  // insegna niente: dice quanto è costato, non cosa l'ha reso costoso.
  //
  // Quote DISGIUNTE, come in usage/pricing.ts: `cacheCreationTokens` NON
  // include `cacheCreation1hTokens`. Sommarle sarebbe contarle due volte.
  
  
  
  // Il consumo del turno MENTRE cresce, chiamata per chiamata. Distinto
  // dai tre di sopra, che sono il consuntivo che arriva col `result`:
  // questo serve a far vedere qualcosa muoversi durante un turno agentico
  // lungo, dove prima non si vedeva niente fino alla fine.
  turn.live = emptyTurnUsage();
  
  // The same calls one by one: the message's cost is the sum of their
  // prices, because Haiku 5.5 picks its rate card per request.
  const liveCalls: PricedCall[] = [];
  turn.liveCalls = liveCalls;
  // Set when a compaction boundary lands mid-turn, so onDone knows this
  // turn's `prompt_tokens` (the compacted context that was sent) is the
  // post-compaction size to backfill onto the just-created marker.
  turn.compactedThisTurn = false;
  // The turn answered a command (CMDUI-04): its text went to the
  // command card, and the row it leaves is empty on purpose.
  turn.answeredAsCommand = false;
  // A MANUAL /compact ENDS AT THE BOUNDARY: the turn that made it has no
  // model call after it, so nothing ever measured the compacted context
  // and the divider kept «~445k token before» for good (10 manual
  // markers of 10 on the prod DB, 24/09, none with a post count). The
  // first call of the NEXT turn is that measurement, so a turn that
  // starts with the session's latest marker still open takes it.
  // `backfillPostTokens` targets exactly that marker and refuses a
  // number that is not smaller than the pre count.
  const openCompaction = (ctx.db.prepare(
    `SELECT post_tokens FROM compaction_markers WHERE session_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(sessionKey) as { post_tokens: number | null } | undefined);
  const inheritsOpenCompaction = !!openCompaction && openCompaction.post_tokens == null;
  turn.inheritsOpenCompaction = inheritsOpenCompaction;
  // First per-call context size seen AFTER a compaction boundary — that
  // single measurement IS the post-compaction context. Latched so later
  // calls in the same turn (which grow again as work resumes) can't
  // overwrite it. See onContextSize below.
  turn.postCompactionFilled = false;
  // Last context size broadcast for the ring. `onContextSize` fires once
  // per model call, so a turn with thirty tool calls would otherwise
  // write the same row and push the same event thirty times.
  turn.lastContextUsed = -1;
  // Disfa la marcatura ottimistica del preambolo inline.
  //
  // Dichiarato QUI, prima dello stream handler, perché è `onError` a dover
  // chiamarlo: `sendChat` di claude-code non rigetta su nessun fallimento di
  // turno — TIMEOUT, RATE_LIMIT, PROCESS_DEAD e il doppio SESSION_RESET
  // chiamano tutti `handler.onError` e poi fanno `return { runId }`. Il
  // rollback che stava solo nel `.catch` di `drive` era quindi codice morto
  // per l'intera classe di errori per cui era stato scritto.
  //
  // Idempotente: `onError` e il `.catch` possono scattare entrambi.
  turn.rollbackInlineSent = null;
  const undoInlineMark = () => { turn.rollbackInlineSent?.(); turn.rollbackInlineSent = null; };
  turn.undoInlineMark = undoInlineMark;
  // The context epoch the turn was composed for: set only by a provider
  // that keeps the conversation itself (native, see `AIProvider.contextEpoch`).
  
  // A failed turn on such a provider stays in its conversation: the
  // message is the history's unanswered tail and the next turn merges
  // into it (native `sendChat`). The context it carried is in that
  // copy, and undoing the mark would send it a second time, kept for
  // the rest of the session (measured: 70k characters per call became
  // 140k). If the copy is rebuilt later, its epoch moves and the next
  // turn's scope changes by itself.
  const undoInlineMarkAfterFailedTurn = () => {
    if (turn.sentEpoch !== undefined) { turn.rollbackInlineSent = null; return; }
    undoInlineMark();
  };
  turn.undoInlineMarkAfterFailedTurn = undoInlineMarkAfterFailedTurn;
  // Reattach after a server restart continues the SAME bubble the client
  // was watching (reuse + in-place JSONL replay) instead of spawning a
  // duplicate turn / leaving a ghost spinner. Normal sends always get a
  // fresh row.
  // A SPONTANEOUS turn picks up the headstone before it, when there is
  // one. A task notification delivered by the CLI opens a turn of its
  // own, and its empty `result` stamps the «no answer» notice on the
  // row of a send that has just started; the real prompt arrives right
  // after and ends up here, adopted. Without this the answer was born
  // in a NEW row and the notice stayed above it saying it never came.
  // When the previous row is NOT that headstone nothing is touched:
  // the rule, and the trace, in `lib/empty-turn-headstone.ts`.
  const partialMsg = isReattach
    ? reuseOrCreatePartialForReattach(sessionKey)
    : isWoken
    ? reuseHeadstoneOrCreate(sessionKey)
    : createPartialMessage(sessionKey, "assistant");
  turn.partialMsg = partialMsg;
  // A reattach took the turn's row back, or found none and opened this one (`reuseOrCreatePartialForReattach`).
  const reusedRow = isReattach && "reusedBody" in partialMsg && partialMsg.reusedBody;
  turn.reusedRow = reusedRow;
  // The ADOPTED row as the reattach found it (the reuse leaves its body
  // in place), for the one rule that counts here: a re-adoption may add,
  // never take away (reattachMerge.ts). By id, not the session's last
  // row: a sub-agent's report written after the turn's row was merged
  // INTO it (card a57e6d4d). A row born just now has nothing to keep.
  const reattachSnapshot: RowSnapshot | null = reusedRow
    ? (() => {
        try {
          const r = db.prepare("SELECT content, thinking, tool_calls, blocks FROM messages WHERE id = ?")
            .get(partialMsg.id) as { content?: string; thinking?: string | null; tool_calls?: string | null; blocks?: string | null } | undefined;
          // Whole, for the same reason as `readRowForNotice`: the
          // replay merges into it and the merge is what screens get.
          return r ? { content: r.content ?? "", thinking: r.thinking ?? null, toolCallsJson: decodeCol(r.tool_calls), blocksJson: restoreBlocksJson(db, partialMsg.id, decodeCol(r.blocks)) } : null;
        } catch { return null; }
      })()
    : null;
  turn.reattachSnapshot = reattachSnapshot;
  // L'AbortController registrato insieme allo stream è l'unica maniglia
  // che chi finalizza da FUORI questa route ha sul client SSE. Lo
  // sweeper `[StaleStream]` (server.ts) chiudeva il turno in DB e
  // broadcastava `stream:end`, ma la risposta HTTP restava aperta per
  // sempre: il browser continuava ad aspettare `[DONE]` su un turno già
  // morto — la chat "appesa a caricare" che si sbloccava solo con un
  // reload. Il listener sotto trasforma quell'abort nella chiusura che
  // mancava.
  // EVERY WRITE OF THIS TURN GOES TO ITS OWN ROW, by id. The writers
  // default to the session's LAST row, which is this one only until
  // something is written after it: the resume sweep's notices, a
  // boot's, a woken turn's row. On 24/09 (chat 3019832f, card
  // 1046df0b) a closed turn's late answer rewrote six notices that way.
  const ownRow = { rowId: partialMsg.id } as const;
  turn.ownRow = ownRow;
  const ownMirrored = { ...MIRRORED, rowId: partialMsg.id } as const;
  turn.ownMirrored = ownMirrored;
  // The same row, named on the frames that CREATE something on screen
  // (a tool call), so the client puts it on this bubble; `late` once
  // the turn is closed, which tells the client not to fall back on its
  // last bubble when this one is not in view.
  const rowOfFrame = () => ({
    messageId: partialMsg.id,
    ...(turn.streamState === "finalized" ? { late: true as const } : {}),
  });
  turn.rowOfFrame = rowOfFrame;
  // And every other stream frame once the turn is closed: the window
  // that sent the NEXT turn drops the session's frames it expects on
  // its own SSE, and a late frame of this turn is not among them.
  const broadcastTurnFrame = (message: OutboundMessage, topicId: string | undefined) =>
    broadcastStreamToTopic(turn.streamState === "finalized" ? { ...message, ...rowOfFrame() } : message, topicId);
  turn.broadcastTurnFrame = broadcastTurnFrame;
  turn.crashedPartialId = partialMsg.id;
  // Su una RIADOZIONE il turno non comincia adesso: è cominciato quando
  // l'ha aperto il turno vero, e noi ci stiamo solo riattaccando. Con
  // l'orologio che parte da qui la durata scritta sotto il messaggio
  // era quella del replay muto — 71ms, 100ms, 131ms su turni da minuti
  // — cioè un numero che non misura niente. La riga porta la sua ora di
  // nascita: quella è l'inizio.
  if (isReattach) {
    const born = Date.parse(partialMsg.timestamp);
    if (Number.isFinite(born) && born > 0 && born <= Date.now()) turn.turnStartMs = born;
  }
  const externalAbort = new AbortController();
  turn.externalAbort = externalAbort;
  // Regge un riavvio chi gira in un processo FIGLIO che si riadotta, e
  // una chat che il boot riprende da sola (`turnSurvivesRestart`). Si
  // chiede UNA volta, qui: non cambia mentre il turno gira.
  startStream(sessionKey, partialMsg.id, externalAbort, turnSurvivesRestart({ providerReattaches: providerSurvivesRestart(turn.topicProvider), boardCard: !!dispatched }), providerSurvivesRestart(turn.topicProvider));
  // The turn's name: the user row it answers. It rides on every end this
  // route records, so a late end is never taken for the next turn's.
  const turnId = partialMsg.parentId ?? undefined;
  turn.turnId = turnId;
  if (turnId) recordTurnStart(sessionKey, turnId, { byPerson: sentByPerson && !isInternalRequest(req), key: idempotencyKey });
  // From here the turn's end decides for the answers it carries, not the route's exit.
  if (turn.carry) turn.carry.turnStarted = true;
  // `reattached` dice al client: questa bolla la stai già vedendo piena,
  // e sto per ricostruirla da capo — svuotala PRIMA che arrivino le
  // delta, o il replay si somma a quello che c'è già e il testo esce
  // doppio. È l'azzeramento che prima si faceva cancellando la riga in
  // DB: la vista si può rifare, il record no.
  startTurnAttention(matchedTopic, boardAgentTurn);
  broadcastToAll({
    type: "stream:start", sessionKey, topicId: matchedTopic?.id, messageId: partialMsg.id,
    ...(reusedRow ? { reattached: true as const } : {}),
    ...(resumeAttempt > 0 ? { resumedBy: "server" as const } : {}),
    // A wake's banner rides the start: no live frame carries it, and a
    // woken turn often ends before any history read brings it (BGVIS-06).
    ...(isWoken || body.processExit ? { banners: blocks.filter((b) => b.kind === "woken") } : {}),
  });

  // Create SSE response for the HTTP client
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  turn.readable = readable;
  const writer = writable.getWriter();
  let clientDisconnected = false;
  const encoder = new TextEncoder();

  // Declared before `writeSSE` uses it; wired to the writer just below the ping.
  let nudge: ReturnType<typeof createSseNudge> | null = null;
  const writeSSE = async (data: string) => {
    if (clientDisconnected) return;
    try { await writer.write(encoder.encode(`data: ${data}\n\n`)); } catch { clientDisconnected = true; }
    // The last frame of a burst must not wait for the next write (see createSseNudge).
    nudge?.touch();
  };
  turn.writeSSE = writeSSE;
  // THE SSE CARRIES THE SAME TOOL CALL AS THE WS FRAME (CHAT-TOOL-10):
  // `sseToolCallDelta` for the announcement, this for the result. The
  // window that sent the message reads only this stream while its
  // reply is open (useChat.ts, senderAlsoSees.ts): without `endedAt`
  // its row had no duration, and without `error` a red X that said
  // nothing, while a second window on the same turn had both.
  const writeToolResultSSE = (r: { id: string; status: 'success' | 'error'; result?: string; error?: string; detail?: import("../types").ToolCallDetail; endedAt: number }) =>
    writeSSE(JSON.stringify({ choices: [{ index: 0, delta: { tool_result: r } }] }));
  turn.writeToolResultSSE = writeToolResultSSE;
  // This turn's own registry entry: another row's turn may have taken
  // the session's slot and shadowed it (`startStream`).
  const ownStream = () => {
    let s = ctx.activeStreams.get(sessionKey);
    while (s && s.messageId !== partialMsg.id) s = s.shadowed;
    return s;
  };
  turn.ownStream = ownStream;
  // The times a tool was FIRST given win (CHAT-TOOL-12): the ones on
  // this turn's timeline, then the ones the adopted row already had.
  // A re-adoption starts from an empty timeline and replays every tool.
  let adoptedTimes: Map<string, ToolTimes> | null = null;
  const priorToolTimes = (toolCallId: string): ToolTimes => {
    let onTimeline: ToolTimes | undefined;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === "tool" && b.toolCall.id === toolCallId) { onTimeline = b.toolCall; break; }
    }
    adoptedTimes ??= reattachSnapshot ? toolTimesOfRow(reattachSnapshot.blocksJson, reattachSnapshot.toolCallsJson) : new Map();
    return firstTimes(onTimeline, adoptedTimes.get(toolCallId));
  };
  turn.priorToolTimes = priorToolTimes;
  // A byte every 20 s while the turn lives: Bun's 255 s idle timeout cut this response mid-tool.
  const writeRaw = (chunk: Uint8Array) => { if (!clientDisconnected) writer.write(chunk).catch(() => { clientDisconnected = true; }); };
  const stopPingTimer = startSsePing({ intervalMs: ssePingMs, alive: () => !clientDisconnected && turn.streamState !== "finalized", write: writeRaw });
  nudge = createSseNudge({ alive: () => !clientDisconnected && turn.streamState !== "finalized", write: writeRaw });
  turn.stopPing = () => { stopPingTimer(); nudge?.stop(); };
  const closeClient = async () => {
    turn.stopPing();
    if (clientDisconnected) return;
    try { await writer.close(); } catch { clientDisconnected = true; }
  };
  turn.closeClient = closeClient;
  // `turn` frames for send_chat_message: the first names the row a cut stream waits on, the
  // last an end that is not a finished answer. Other readers look only at `choices`.
  writeSSE(JSON.stringify({ turn: { messageId: partialMsg.id } }));
  const writeTurnEnd = (info?: TurnEndInfo) => !info || info.end === "end_turn" ? Promise.resolve()
    : writeSSE(JSON.stringify({ turn: { end: info.end, ...(info.cause ? { cause: info.cause } : {}) } }));
  turn.writeTurnEnd = writeTurnEnd;
}
