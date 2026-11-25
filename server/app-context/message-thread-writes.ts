/** Message rows written to SQLite: appends, partial turns and tool-call updates. */
import type { Database } from "bun:sqlite";
import { toolCallsColumnForRow, toolCallsForDisk } from "../../shared/lean-tool-call";
import { redactDeep } from "../lib/secret-redaction";
import { decodeCol } from "../../shared/message-blob";
import { hasMachineMark } from "../../shared/prompt-number";
import { isReusableHeadstone } from "../lib/empty-turn-headstone";
import { keepFirstTimes } from "../lib/tool-call-times";
import type { ContentBlock, ReattachedPartial, StoredMessage, ToolCall } from "../types";
import type { AppStatements, DbRow } from "./app-statements";
import type { MessageThreadReads } from "./message-thread-reads";

export function createMessageThreadWrites({ db, stmts, parseBlocksCol, rowToMessage, metaParams, writeMessage, loadActiveThread }: { db: Database; stmts: AppStatements; parseBlocksCol: MessageThreadReads["parseBlocksCol"]; rowToMessage: MessageThreadReads["rowToMessage"]; metaParams: MessageThreadReads["metaParams"]; writeMessage: MessageThreadReads["writeMessage"]; loadActiveThread: MessageThreadReads["loadActiveThread"] }) {
  /** Sort order and parent id for a row appended at the end of the active thread. */
  function nextAppendSlot(sessionKey: string): { maxOrder: number; parentId: string | null } {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as { max_order: number }).max_order;
    // Only an id is needed, so read lean: without these two options the call
    // hydrated the whole active branch with parsed blocks and tool_calls, and
    // every written row paid for it.
    const activeThread = loadActiveThread(sessionKey, { withBlocks: false, withToolCalls: false });
    const lastMsg = activeThread.length > 0 ? activeThread[activeThread.length - 1] : null;
    return { maxOrder, parentId: lastMsg?.id || null };
  }

  /** Insert parameters of a fully formed message; `live` keeps its partial/streamed flags, otherwise it is stored closed. */
  function importedRowParams(sessionKey: string, msg: StoredMessage, sortOrder: number, live: boolean) {
    return {
      $id: msg.id,
      $session_key: sessionKey,
      $role: msg.role,
      $content: msg.content || '',
      $thinking: msg.thinking || null,
      $tool_calls: toolCallsColumnForRow(redactDeep(msg.toolCalls), msg.blocks),
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: live && msg.partial ? 1 : 0,
      $streamed_at: live ? msg.streamedAt || null : null,
      $plan_status: msg.planStatus || null,
      $timestamp: msg.timestamp,
      $sort_order: sortOrder,
      $parent_id: msg.parentId || null,
      $branch_index: msg.branchIndex || 0,
    };
  }

  /** The columns an update leaves as they are on the row, for the writers that own only content, thinking or tool_calls. */
  function carriedParams(msg: StoredMessage) {
    return {
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
    };
  }

  /**
   * RIMPIAZZA l'intera sessione con `msgs`: cancella ogni messaggio e ogni
   * scelta di ramo, poi reinserisce quello che gli si passa.
   *
   * Va bene per chi vuole davvero questo (svuotare una topic, importare una
   * conversazione da fuori). NON va usata per TAGLIARE: `loadLocalMessages`
   * restituisce solo il ramo attivo, quindi il giro
   * `saveLocalMessages(loadLocalMessages().slice(0, n))` butta via ogni
   * versione alternativa della sessione — comprese quelle nate molto prima del
   * punto di taglio. Per troncare c'è `truncateSessionAfter`
   * (server/db/message-tree.ts), che cancella solo il sottoalbero appeso
   * all'ultimo messaggio tenuto.
   */
  function saveLocalMessages(sessionKey: string, msgs: StoredMessage[]): void {
    db.transaction(() => {
      stmts.deleteMessagesBySession.run(sessionKey);
      stmts.deleteActiveBranchesBySession.run(sessionKey);
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        writeMessage(msg.id, msg.blocks, !msg.partial, (col) => stmts.insertMessage.run({ ...importedRowParams(sessionKey, msg, i, true), ...metaParams(msg, col) }));
      }
    })();
  }

  function appendLocalMessage(
    sessionKey: string,
    role: "user" | "assistant",
    content: string,
    /** Chi l'ha scritto (migration 095). Assente = non lo sappiamo, e resta NULL:
     *  è il caso dei turni importati da un transcript e di ogni risposta. */
    autore?: { authorPersonId?: string | null; authorDeviceId?: string | null },
    /**
     * Blocks to write ON the row, for the rare rows that are not just text.
     * Today one caller: the goal auto-continuation, whose `user` row carries a
     * `goal-nudge` block so the client draws a system line instead of a bubble
     * the human never typed (`services/goal-loop.ts`).
     */
    blocks?: ContentBlock[],
    /** The send's key (`clientMessageId`), on the person's row a send stored. Unique per session. */
    clientMessageId?: string,
  ): StoredMessage {
    const { maxOrder, parentId } = nextAppendSlot(sessionKey);
    const stored: StoredMessage = {
      id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString(), parentId, branchIndex: 0,
      authorPersonId: autore?.authorPersonId ?? null,
      authorDeviceId: autore?.authorDeviceId ?? null,
      ...(blocks && blocks.length ? { blocks } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      // Written whole, in one go: a sub-agent's report, a notice, an answer.
      ...(role === "assistant" ? { endReason: "done" as const } : {}),
    };
    writeMessage(stored.id, stored.blocks, true, (col) => stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: role,
      $content: content,
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 0,
      $streamed_at: null,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: 0,
      ...metaParams(stored, col),
    }));
    return stored;
  }

  /**
   * APPENDE un blocco di messaggi già formati (id/parentId/branchIndex/toolCalls
   * decisi dal chiamante) in coda alla sessione, senza toccare quelli esistenti.
   *
   * È il complemento di `saveLocalMessages` (che RIMPIAZZA tutto): serve
   * all'import incrementale di una sessione adottata, che a ogni sweep aggiunge i
   * turni nuovi letti dal transcript conservando i tool call e il thinking. I
   * `sort_order` proseguono dal massimo attuale; i `parentId` li ha già cablati
   * il parser delta (il primo punta all'ultima riga salvata). Transazionale: o
   * entrano tutti, o nessuno.
   */
  function appendImportedMessages(sessionKey: string, msgs: StoredMessage[]): void {
    if (msgs.length === 0) return;
    db.transaction(() => {
      const base = (stmts.getMaxSortOrder.get(sessionKey) as { max_order: number }).max_order as number;
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]!;
        writeMessage(msg.id, msg.blocks, true, (col) => stmts.insertMessage.run({ ...importedRowParams(sessionKey, msg, base + 1 + i, false), ...metaParams(msg, col) }));
      }
    })();
  }

  function createPartialMessage(sessionKey: string, role: "user" | "assistant"): StoredMessage {
    const { maxOrder, parentId } = nextAppendSlot(sessionKey);
    const stored: StoredMessage = {
      id: crypto.randomUUID(), role, content: "", timestamp: new Date().toISOString(),
      partial: true, streamedAt: new Date().toISOString(), parentId, branchIndex: 0,
    };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: role,
      $content: '',
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 1,
      $streamed_at: stored.streamedAt!,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: 0,
      ...metaParams({}),
    });
    return stored;
  }

  /** Reattach after a server restart: REUSE the surviving partial assistant row
   *  for this session (the exact bubble the client was watching before the
   *  restart) so the JSONL replay rebuilds it IN PLACE — no duplicate turn, no
   *  ghost spinner, and the client's `stream:catchup` targets the same
   *  messageId so the bubble updates seamlessly. Falls back to a fresh partial
   *  row when nothing survived. Only used on the reattach boot path.
   *
   *  IL CORPO NON SI TOCCA. Prima si svuotava qui (`content=''`, tool e blocchi
   *  a NULL) contando sul replay per riscriverlo, e la copia di quel che si
   *  cancellava viveva solo in RAM, dentro la richiesta di riadozione. Ma la
   *  riadozione ha tre uscite e due non ri-emettono niente, e la richiesta può
   *  morire prima di rimettere a posto: un secondo riavvio del watcher, il
   *  provider giù, un timeout. Quando succede la cancellazione è definitiva.
   *  Misurato su topic:dc2b90d0 il 10 agosto: riga nata alle 15:46:22.678,
   *  `streamed_at` 15:47:29.751 (l'ora del riattacco), corpo vuoto e
   *  `latency_ms` NULL — il finalize non è mai arrivato. A schermo restava il
   *  messaggio dell'utente e una bolla vuota, per sempre.
   *
   *  Adesso l'adozione è una scrittura sola: `streamed_at` riparte (la riga è
   *  di nuovo viva, e lo spazzino degli stream fermi la deve misurare da
   *  adesso). Chi ricostruisce ci scrive SOPRA — le scritture del turno sono
   *  assolute, e i tool si fondono per id — e chi muore non lascia il vuoto.
   *  Ad azzerarsi è la VISTA, non il record: `stream:start` porta
   *  `reattached`, e il client svuota la bolla prima di riempirla col replay.
   *
   *  A CLOSE FROM OUTSIDE IS NOT AN END. The StaleStream sweeper,
   *  `/api/chat/abort`, and the soft/hard timeouts in `routes/chat.ts` can all
   *  close this row (`partial=0`) while the turn's process is still alive —
   *  the `abort` they send it is an attempt, not a synchronous guarantee. If
   *  the process keeps going, the NEXT restart finds it still open
   *  (`reattachSurvivingChatTurns`, server.ts, asks the broker BEFORE calling
   *  in here: by the time this function runs, the caller already has proof
   *  the turn is alive). With `partial===1` as the only pass, that row was
   *  never reused again: a new one opened and the JSONL replay poured the
   *  turn into it FROM THE START — two consecutive rows, the second starting
   *  exactly like the first. Measured on the live DB on 2026-09-10: 65 pairs
   *  across 54 conversations.
   *
   *  The row says how it was closed (`end_reason`): `closed-outside` is this
   *  turn's own row, `done` is a whole answer and is left alone. For the rest,
   *  and for rows written before that column, the discriminant stays
   *  `latency_ms`: only the turn's legitimate completion writes it
   *  (`routes/chat.ts`, `Date.now() - turnStartMs`, never null), and none of
   *  the external closes pass it.
   *
   *  THE TURN'S ROW COMES FIRST, not the session's last one. With the child
   *  alive the boot sweep leaves the turn's row open, and a sub-agent's report
   *  written while the turn ran sits after it: adopting the LAST row poured
   *  the replay over the report, and the turn's own row was closed from
   *  outside once the leg ended, so a send waiting on it heard "a restart or a
   *  watchdog" for an answer that had completed (card a57e6d4d, test B). The
   *  same when the row was closed from outside before the reattach reached it:
   *  a window reloading after the restart runs the history cleanup first, and
   *  the stale sweeper may have given up on the turn. A turn that ended
   *  after such a row, finished, stopped or failed, is the last turn row, and
   *  with its latency it is not taken. */
  function reuseOrCreatePartialForReattach(sessionKey: string): ReattachedPartial {
    const row = (stmts.getTurnRow.get({ $sk: sessionKey }) ?? stmts.getLastMessage.get(sessionKey)) as DbRow;
    const isAssistant = row && row.role === "assistant";
    const stillPartial = isAssistant && (row.partial === 1 || row.partial === true);
    // A row the MACHINE wrote (a goal's stop line, the line under a turn the
    // machine stopped) is closed without `latency_ms` too, but it was never a
    // turn's own row: adopting it poured the replay over the line, and a replay
    // that then failed turned it into an error row offering Retry again.
    const closedFromOutsideWhileAlive = isAssistant && !stillPartial
      && (row.end_reason === "closed-outside" || (row.end_reason !== "done" && row.latency_ms == null))
      && !hasMachineMark(parseBlocksCol(row.blocks, String(row.id), "stub"));
    if (isAssistant && (stillPartial || closedFromOutsideWhileAlive)) {
      const now = new Date().toISOString();
      db.run("UPDATE messages SET streamed_at = ?, partial = 1, end_reason = NULL WHERE id = ?", [now, String(row.id)]);
      return {
        id: String(row.id), role: "assistant", content: String(row.content ?? ""), timestamp: String(row.timestamp),
        partial: true, streamedAt: now, parentId: row.parent_id ?? null, branchIndex: row.branch_index ?? 0,
        reusedBody: true,
      };
    }
    return { ...createPartialMessage(sessionKey, "assistant"), reusedBody: false };
  }

  /**
   * A SPONTANEOUS TURN PICKS UP THE HEADSTONE BEFORE IT, when there is one.
   *
   * A task notification delivered by the CLI opens a turn of its own, and its
   * empty `result` closes the row of a send that has just started, stamping it
   * with the «no answer» notice. The real prompt arrives right after and gets
   * adopted as a spontaneous turn: without this, the answer is born in a NEW
   * row and the notice stays above it saying it never came. When a row IS that
   * headstone — and the trace of the failure — lives in
   * `lib/empty-turn-headstone.ts`; only the write is here.
   *
   * The body really is emptied, unlike the post-restart reattach: there the
   * body is history to be rebuilt, here it is a notice we know to be false.
   * `streamed_at` restarts because the row is alive again.
   */
  function reuseHeadstoneOrCreate(sessionKey: string): StoredMessage {
    const row = stmts.getLastMessage.get(sessionKey) as DbRow;
    const riusabile = isReusableHeadstone(
      row
        ? {
            role: String(row.role ?? ""),
            content: String(row.content ?? ""),
            toolCallsJson: row.tool_calls == null ? null : String(row.tool_calls),
            // `decodeCol` and not `String`: since the writer compresses this
            // column, `String(blob)` would hand the headstone rule a comma
            // separated list of byte values instead of JSON.
            blocksJson: decodeCol(row.blocks),
            timestamp: String(row.timestamp ?? ""),
            partial: row.partial === 1 || row.partial === true,
          }
        : null,
      Date.now(),
    );
    if (!riusabile) return createPartialMessage(sessionKey, "assistant");
    const now = new Date().toISOString();
    db.run(
      "UPDATE messages SET content = '', blocks = NULL, tool_calls = NULL, streamed_at = ?, partial = 1, latency_ms = NULL, end_reason = NULL WHERE id = ?",
      [now, String(row.id)],
    );
    return {
      id: String(row.id), role: "assistant", content: "", timestamp: String(row.timestamp),
      partial: true, streamedAt: now, parentId: row.parent_id ?? null, branchIndex: row.branch_index ?? 0,
    } as StoredMessage;
  }

  /** `opts.rowId`: write THAT row of the session instead of the last one (see `getMessageForBodyUpdateById`). */
  function updateLastMessage(sessionKey: string, updates: Partial<StoredMessage>, opts?: { rowId?: string }): StoredMessage | null {
    // Lettura magra: `blocks` e `tool_calls` non arrivano nemmeno da SQLite.
    // Questa funzione non li legge — riscrive `tool_calls` solo se glielo passa
    // il chiamante, e `blocks` passa da `metaParams(updates)`, cioè sempre dal
    // chiamante — ma con `SELECT *` se li portava dietro comunque, a ogni
    // salvataggio periodico e a ogni finalizzazione. Sul DB vero sono decine di
    // KB per riga, e su un turno agentico lungo arrivano ai megabyte.
    //
    // Il valore di ritorno finisce in `discardIfEmptyTurn`, che senza quelle due
    // colonne prenderebbe per vuoto un turno fatto di SOLI tool o SOLI blocchi e
    // lo cancellerebbe. Le colonne non gli servono: gli serve sapere se ci sono,
    // e quello se lo chiede lui con `messageBodyPresence`.
    const row = (opts?.rowId
      ? stmts.getMessageForBodyUpdateById.get(opts.rowId, sessionKey)
      : stmts.getLastMessageForBodyUpdate.get(sessionKey)) as DbRow;
    if (!row) return null;
    const msg = rowToMessage(row, { withBlocks: false, withToolCalls: false });
    Object.assign(msg, updates);
    // Only overwrite the body fields the caller actually passed. Fields absent
    // from `updates` go in as null so the COALESCE in updateMessage keeps the
    // existing column — a partial update (e.g. flipping `partial` on timeout)
    // must never re-persist a stale content/thinking/tool snapshot over
    // concurrent writes, which is how turns were being blanked.
    // The turn's closing write (`partial` off, whole timeline) is where a new
    // row sheds its tool output: while the row is open the stream rewrites it.
    writeMessage(msg.id, updates.blocks, !msg.partial, (col) => stmts.updateMessage.run({
      $id: msg.id,
      $content: 'content' in updates ? (msg.content || '') : null,
      $thinking: 'thinking' in updates ? (msg.thinking || null) : null,
      $tool_calls: 'toolCalls' in updates ? toolCallsColumnForRow(redactDeep(msg.toolCalls), updates.blocks) : null,
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: msg.partial ? 1 : 0,
      $streamed_at: msg.streamedAt || null,
      $plan_status: msg.planStatus || null,
      // Only the partial-msg fields landing in `updates` should overwrite —
      // the SQL's COALESCE keeps existing values when these are null.
      ...metaParams(updates, col),
    }));
    return msg;
  }

  function appendToLastMessage(sessionKey: string, contentDelta: string, thinkingDelta?: string): StoredMessage | null {
    const row = stmts.getLastMessage.get(sessionKey) as DbRow;
    if (!row) return null;
    const msg = rowToMessage(row);
    if (contentDelta) msg.content += contentDelta;
    if (thinkingDelta) msg.thinking = (msg.thinking || "") + thinkingDelta;
    stmts.updateMessage.run({
      $id: msg.id,
      // Owns content/thinking. tool_calls is null so COALESCE keeps them — a
      // content delta must never overwrite tool state written concurrently.
      $content: msg.content,
      $thinking: msg.thinking || null,
      $tool_calls: null,
      ...carriedParams(msg),
    });
    return msg;
  }

  function finalizeLastMessage(sessionKey: string): StoredMessage | null {
    const row = stmts.getLastMessage.get(sessionKey) as DbRow;
    if (!row) return null;
    const msg = rowToMessage(row);
    delete msg.partial;
    delete msg.streamedAt;
    stmts.updateMessage.run({
      $id: msg.id,
      // Flips the partial/streamed_at control flags only. All body fields are
      // null so COALESCE preserves whatever streamed — finalizing a turn must
      // never blank its content, thinking, or tools.
      $content: null,
      $thinking: null,
      $tool_calls: null,
      $media: msg.media ? JSON.stringify(msg.media) : null,
      $partial: 0,
      $streamed_at: null,
      $plan_status: msg.planStatus || null,
      ...metaParams({}),
    });
    return msg;
  }

  /**
   * THE ROW HAS `blocks`: the tool call is already persisted there, so this
   * column has nothing to add and the UPDATE has nothing to do.
   *
   * Skipping it is not a micro optimisation. `updateMessage` rewrites the
   * ROW, and COALESCE keeping a column does not make it free: SQLite copies
   * the whole record, overflow pages included, so a write here re-copies the
   * `blocks` blob too. On the live database one message reached 3.65 MB of
   * blocks and 3.65 MB of tool_calls over 127 blocks: ~250 rewrites of ~1.8 MB
   * average, hundreds of MB of JSON and of WAL pages, for ONE message, on the
   * event loop, while the turn is alive and needs it for tokens, WS frames and
   * PTY.
   *
   * `has_tool_calls` is the one exception: a row that already carries the copy
   * (an older row, or the first tool of a turn announced before the first
   * block was persisted) gets ONE write to clear it, and then no more.
   *
   * `mirroredInBlocks` is DECLARED by the caller, not guessed from the row:
   * only whoever writes the block knows that the block carries this same tool
   * call (`routes/chat.ts` does, right after). The paths that write no
   * timeline at all (the gateway SSE consumer, an import) say nothing and keep
   * the column, which for them is the only source there is. Reading the blocks
   * here to check would cost the very parse this exists to avoid.
   */
  function toolColumnWriteMode(
    row: { has_blocks?: number; has_tool_calls?: number },
    mirroredInBlocks: boolean,
  ): 'skip' | 'clear' | 'write' {
    if (!mirroredInBlocks || row.has_blocks !== 1) return 'write';
    return row.has_tool_calls === 1 ? 'clear' : 'skip';
  }

  /** The row the two hot tool writers patch: the named one, or the session's last. */
  function toolUpdateRow(sessionKey: string, rowId: string | undefined): DbRow | null {
    return rowId
      ? stmts.getMessageForToolUpdateById.get(rowId, sessionKey) as DbRow | null
      : stmts.getLastMessageForToolUpdate.get(sessionKey) as DbRow | null;
  }

  function addToolCallToLastMessage(sessionKey: string, toolCall: ToolCall, opts?: { mirroredInBlocks?: boolean; rowId?: string }): StoredMessage | null {
    const row = toolUpdateRow(sessionKey, opts?.rowId);
    if (!row) return null;
    const msg = rowToMessage(row, { withBlocks: false });
    if (!msg.toolCalls) msg.toolCalls = [];
    // Defensive dedup: providers that emit cumulative tool snapshots (the
    // Claude CLI is one) call this multiple times for the same id. Without
    // this guard we'd accumulate duplicate entries; updateToolCallResult
    // only patches the FIRST match, so the duplicates would stay forever
    // in `running` and the spinner would never clear in the UI. The
    // upstream provider is meant to dedup too — this is belt-and-braces.
    const existingIdx = msg.toolCalls.findIndex(t => t.id === toolCall.id);
    if (existingIdx >= 0) {
      // In place, newer args win; the first times stay (lib/tool-call-times.ts).
      msg.toolCalls[existingIdx] = keepFirstTimes(msg.toolCalls[existingIdx], { ...msg.toolCalls[existingIdx], ...toolCall });
    } else {
      msg.toolCalls.push(toolCall);
    }
    const mode = toolColumnWriteMode(row, opts?.mirroredInBlocks === true);
    if (mode === 'skip') return msg;
    stmts.updateMessage.run({
      $id: msg.id,
      // Owns tool_calls only — see updateToolCallResult.
      $content: null,
      $thinking: null,
      $tool_calls: mode === 'clear' ? '[]' : toolCallsForDisk(redactDeep(msg.toolCalls)),
      ...carriedParams(msg),
    });
    return msg;
  }

  function updateToolCallResult(sessionKey: string, toolCallId: string, result: string, error?: string, extra?: Partial<ToolCall>, opts?: { mirroredInBlocks?: boolean; rowId?: string }): StoredMessage | null {
    const row = toolUpdateRow(sessionKey, opts?.rowId);
    if (!row) return null;
    const msg = rowToMessage(row, { withBlocks: false });
    const mode = toolColumnWriteMode(row, opts?.mirroredInBlocks === true);
    // Same rule as `addToolCallToLastMessage`: with blocks on the row the
    // result is written there (routes/chat.ts `updateBlockTool`), and this
    // column is either already empty or cleared once.
    if (mode === 'skip') return msg;
    if (mode === 'clear') {
      stmts.updateMessage.run({
        $id: msg.id,
        $content: null,
        $thinking: null,
        $tool_calls: '[]',
        ...carriedParams(msg),
      });
      return msg;
    }
    const tc = msg.toolCalls?.find(t => t.id === toolCallId);
    if (tc) {
      tc.result = result;
      tc.error = error;
      tc.status = error ? 'error' : 'success';
      // Terminal-time extras (endedAt timestamp, etc.) ride the same write
      // instead of paying a second parse→serialize cycle per tool.
      if (extra) Object.assign(tc, extra);
      stmts.updateMessage.run({
        $id: msg.id,
        // Owns tool_calls only. content/thinking are null so COALESCE keeps the
        // streamed body — a late tool_result (e.g. a killed process draining its
        // buffer) must never overwrite the assistant's text.
        $content: null,
        $thinking: null,
        $tool_calls: toolCallsForDisk(redactDeep(msg.toolCalls)),
        ...carriedParams(msg),
      });
    }
    return msg;
  }

  /**
   * Generic patch for a single ToolCall on the last assistant message.
   * Used for non-terminal mutations that `updateToolCallResult` doesn't
   * cover — currently `status: 'waiting_for_input'` + `userInputSchema`
   * on the way in, and `userResponse` on the way out when the user
   * answers a paused tool. `status` patching here goes through the same
   * SQLite row so a reload renders the pending form correctly.
   */
  function updateToolCallFields(sessionKey: string, toolCallId: string, patch: Partial<ToolCall>, opts?: { rowId?: string }): StoredMessage | null {
    // L'UNICA statement che porta `blocks`: qui servono davvero (vedi sotto), e
    // questa via si percorre quando un tool si ferma a chiedere qualcosa a una
    // persona, non a ogni evento di tool.
    const row = (opts?.rowId
      ? stmts.getMessageForToolFieldsById.get(opts.rowId, sessionKey)
      : stmts.getLastMessageForToolFields.get(sessionKey)) as DbRow;
    if (!row) return null;
    const msg = rowToMessage(row, { withBlocks: true });
    const tc = msg.toolCalls?.find(t => t.id === toolCallId);
    if (!tc) return msg;
    Object.assign(tc, patch);
    // ANCHE i blocchi, e non «anche» per scrupolo: quando un messaggio ha
    // `blocks`, chi disegna legge QUELLI e ignora `tool_calls`
    // (client/src/state/pendingAsk.ts, <MessageBubble>). Scrivere solo
    // `tool_calls` da fuori dallo stream produce una riga che nel DB dice
    // «aspetta una risposta» e a schermo continua a girare.
    //
    // Visto il 7 agosto sul primo permesso vero: tre chiamate a kiwi ferme da
    // tre minuti, il piede della chat che diceva «in attesa della tua
    // risposta», e NESSUN pannello — perché il pannello viveva in una colonna
    // che nessuno legge.
    //
    // Dentro lo stream i blocchi hanno un altro proprietario (l'array in
    // memoria di `routes/chat.ts`, che li riscrive con `persistBlocks`), quindi
    // questa scrittura può essere sovrascritta da un evento successivo. È
    // accettabile perché chi dipinge un pannello lo RIDIPINGE finché serve
    // (vedi la rotta `…/permission`): un colpo perso si recupera alla gamba
    // dopo, invece di restare perso per sempre.
    const nextBlocks = msg.blocks?.map(b =>
      b.kind === "tool" && b.toolCall.id === toolCallId
        ? { kind: "tool" as const, toolCall: { ...b.toolCall, ...patch } }
        : b,
    );
    // Same column as `metaParams`: this writer overrides `$blocks`, so without
    // the codec the pending-permission path would put the timeline back in
    // plaintext on a row the stream had just compressed. The row was read
    // whole (its stored tool output put back), so a closed one is split again.
    writeMessage(msg.id, nextBlocks, !msg.partial, (col) => stmts.updateMessage.run({
      $id: msg.id,
      $content: null,
      $thinking: null,
      $tool_calls: toolCallsColumnForRow(redactDeep(msg.toolCalls), nextBlocks ?? msg.blocks),
      ...carriedParams(msg),
      $blocks: col.value,
    }));
    return msg;
  }

  return { saveLocalMessages, appendLocalMessage, appendImportedMessages, createPartialMessage, reuseOrCreatePartialForReattach, reuseHeadstoneOrCreate, updateLastMessage, appendToLastMessage, finalizeLastMessage, addToolCallToLastMessage, updateToolCallResult, updateToolCallFields };
}

