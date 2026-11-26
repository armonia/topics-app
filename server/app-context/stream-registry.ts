/** The in-memory registry of active streams and how a turn ends. */
import type { Database } from "bun:sqlite";
import { blocksForDisk, toolCallsForDisk } from "../../shared/lean-tool-call";
import { decodeCol, encodeCol } from "../../shared/message-blob";
import { isAwaitingHuman } from "../../shared/types";
import { releaseHumanHold } from "../lib/human-hold";
import { closeWatchesOfSession } from "../lib/process-wait";
import { announceTurnEnded } from "../lib/turn-ended";
import type { TurnLedger } from "../lib/turn-ledger";
import type { ActiveStream, ToolCall } from "../types";
import type { DbRow } from "./app-statements";
import { redactDeep } from "../lib/secret-redaction";

export function createStreamRegistry({ db, activeStreams, turnLedger }: { db: Database; activeStreams: Map<string, ActiveStream>; turnLedger: TurnLedger }) {
  // --- Streams (in-memory, unchanged) ---
  function startStream(sessionKey: string, messageId: string, abortController?: AbortController, survivesRestart = false, brokerKeeps = false) {
    // A turn of another row still registered (a send parked behind the CLI's own
    // turn, whose adoption registers now) is shadowed, not dropped: its entry
    // comes back when this one ends (`endStream`).
    const live = activeStreams.get(sessionKey);
    const shadowed = live && live.messageId !== messageId ? live : undefined;
    activeStreams.set(sessionKey, { sessionKey, startedAt: new Date().toISOString(), isThinking: false, lastActivity: new Date().toISOString(), content: "", thinking: "", messageId, abortController, survivesRestart, brokerKeeps, ...(shadowed ? { shadowed } : {}) });
    turnLedger.set(sessionKey, "route", true);
  }

  function updateStreamActivity(sessionKey: string, isThinking?: boolean) {
    const stream = activeStreams.get(sessionKey);
    if (stream) {
      stream.lastActivity = new Date().toISOString();
      if (isThinking !== undefined) stream.isThinking = isThinking;
    }
  }

  function updateStreamContent(sessionKey: string, content: string, thinking: string) {
    const stream = activeStreams.get(sessionKey);
    if (stream) {
      stream.content = content;
      stream.thinking = thinking;
      stream.lastActivity = new Date().toISOString();
    }
  }

  function getStreamContent(sessionKey: string): { content: string; thinking: string; messageId: string } | null {
    const stream = activeStreams.get(sessionKey);
    if (!stream) return null;
    return { content: stream.content, thinking: stream.thinking, messageId: stream.messageId };
  }

  /**
   * Ends a stream. Marks any tool call left `running` as interrupted so the
   * client stops showing a spinner that ticks forever (observed: a tool
   * "running" for 2h+ after the turn already died). Stamps `endedAt` so the
   * duration freezes, and RETURNS the interrupted calls so the caller can
   * broadcast `stream:tool_result` to live clients (the DB write alone only
   * fixes a later reload). Parse → map → serialize (never a substring REPLACE,
   * which would clobber a literal `"status":"running"` inside args/result).
   *
   * A PERMISSION left `awaiting_permission` counts as interrupted: its
   * decision could only unblock this turn, and the turn is over.
   *
   * A QUESTION left `waiting_for_input` does NOT (29/09). It used to be closed
   * here too ("Interrotto: il turno è finito mentre la domanda era ancora a
   * schermo"), which let every machine ending - a sweep, a dead child, a server
   * going down under a native turn - end a question nobody had cancelled. The
   * question now outlives the process that asked: it stays `waiting_for_input`
   * with `askerGone`, the panel stays clickable, and the answer reaches the
   * model as the next user message (`lib/question-outlives-asker.ts`). The in-memory ask is
   * still released, so whoever is blocked on it fails instead of hanging.
   *
   * `cancelQuestions` is the person's own Stop: THEN the question ends, marked
   * `askEnded: 'cancelled'` so the panel says so in plain words.
   *
   * `keepAwaiting` is the ONE exception, and it exists because one ask is not
   * a leftover: the plan approval is posted BY the end of the turn, and its
   * answer starts a new turn instead of unblocking this one. Cancelling it
   * here would kill the panel a few lines after installing it. Anything not
   * named in this list keeps the rule above.
   *
   * `closedBecause` replaces the interrupted-prefix sentence when the turn was
   * stopped on purpose (lib/abort-cause.ts): the boot's repair pass reads that
   * prefix as a turn to resume.
   */
  function endStream(sessionKey: string, opts?: { keepAwaiting?: readonly string[]; closedBecause?: string; rowId?: string; cancelQuestions?: boolean }): ToolCall[] {
    const keepAwaiting = new Set(opts?.keepAwaiting ?? []);
    const top = activeStreams.get(sessionKey);
    // Ending a turn by its row touches that turn only: the entry on top may be
    // another turn's, and deleting it blind left the gate open for the rest of it.
    if (opts?.rowId && top && top.messageId !== opts.rowId) {
      if (top.shadowed?.messageId === opts.rowId) top.shadowed = undefined;
      return [];
    }
    const stream = top;
    const interrupted: ToolCall[] = [];
    if (stream?.messageId) {
      try {
        const row = db.prepare(`SELECT tool_calls, blocks FROM messages WHERE id = ?`).get(stream.messageId) as DbRow;
        const endedAt = Date.now();
        const fix = (tc: ToolCall | null | undefined): boolean | 'detached' => {
          if (tc && (tc.status === 'running' || tc.status === 'pending')) {
            tc.status = 'error';
            if (tc.endedAt == null) tc.endedAt = endedAt;
            if (!tc.error) tc.error = opts?.closedBecause ?? 'Interrotto: il turno è terminato senza risultato';
            return true;
          }
          // A panel on screen over a finished turn: a permission is closed (its
          // decision could only unblock this turn), a question survives (see
          // the docstring). One predicate for both, so they cannot drift apart
          // about what "awaiting a human" means.
          if (tc && isAwaitingHuman(tc.status)) {
            // An ask that outlives the turn on purpose: leave it exactly as it
            // is, panel included.
            if (keepAwaiting.has(tc.id)) return false;
            const eraPermesso = tc.status === 'awaiting_permission';
            // A question survives its turn unless the person stopped it.
            if (!eraPermesso && !opts?.cancelQuestions) {
              releaseHumanHold(sessionKey, 'the turn that asked has ended; the question stays open');
              if (tc.askerGone === true) return false;
              tc.askerGone = true;
              return 'detached';
            }
            if (!eraPermesso) tc.askEnded = 'cancelled';
            tc.status = 'error';
            if (tc.endedAt == null) tc.endedAt = endedAt;
            if (!tc.error) {
              tc.error = opts?.closedBecause ?? (eraPermesso
                ? 'Interrotto: il turno è finito mentre il permesso era ancora a schermo. La decisione non avrebbe più raggiunto nessuno.'
                : 'Interrotto: il turno è finito mentre la domanda era ancora a schermo. La risposta non avrebbe più raggiunto nessuno.');
            }
            releaseHumanHold(sessionKey, 'il turno è terminato mentre il pannello era a schermo');
            return true;
          }
          return false;
        };
        let tcStr: string | Uint8Array | null = row?.tool_calls ?? null;
        let blStr: string | Uint8Array | null = row?.blocks ?? null;
        let changed = false;
        if (row?.tool_calls) {
          const toolCallsDecoded = decodeCol(row.tool_calls);
          const toolCalls = JSON.parse(toolCallsDecoded ?? "null") as ToolCall[];
          let c = false;
          for (const tc of toolCalls) {
            const r = fix(tc);
            if (!r) continue;
            c = true;
            // A detached question is rewritten but not announced as ended: its
            // panel stays exactly as it is on every screen.
            if (r === true) interrupted.push(tc);
          }
          // `toolCallsForDisk` anche qui: questa riga la scrive di nuovo
          // INTERA, quindi e' una scrittura come le altre. Le tool call che
          // arrivano fin qui sono gia' magre (le ha scritte questo stesso
          // percorso), ma una riga vecchia riaperta da un riavvio no.
          if (c) { tcStr = encodeCol(toolCallsForDisk(redactDeep(toolCalls)) ?? "null") ?? null; changed = true; }
        }
        // The client renders tool state from `blocks` (the timeline) when
        // present, so finalize the block copy too or the spinner keeps ticking.
        if (row?.blocks) {
          const blocksDecoded = decodeCol(row.blocks);
          const bl = JSON.parse(blocksDecoded ?? "null") as { kind?: string; toolCall?: ToolCall }[];
          let c = false;
          // A tool repaired HERE has to be announced too, not just written.
          // `interrupted` is what the caller broadcasts `stream:tool_result`
          // off, and it used to be filled from the `tool_calls` column alone:
          // on a row whose tools live only in the timeline - which is every row
          // this same function then collapses to `[]` - the block was fixed on
          // disk and the screens were told nothing, so the panel already drawn
          // kept its spinner until a reload. Same id from both copies counts
          // once: the two are the same tool call.
          const announced = new Set(interrupted.map((tc) => tc.id));
          for (const b of bl) {
            if (b?.kind !== 'tool') continue;
            const r = fix(b.toolCall);
            if (!r) continue;
            c = true;
            if (r === true && b.toolCall && !announced.has(b.toolCall.id)) {
              announced.add(b.toolCall.id);
              interrupted.push(b.toolCall as ToolCall);
            }
          }
          if (c) { blStr = encodeCol(blocksForDisk(redactDeep(bl)) ?? "null") ?? null; changed = true; }
        }
        // The row carries both copies: this write is the last one of the turn,
        // so it is also where the duplicate goes. What the column held is
        // inside `blocks`, and `rowToMessage` reads it back from there.
        if (row?.blocks && row?.tool_calls) { tcStr = '[]'; changed = true; }
        if (changed) {
          db.prepare(`UPDATE messages SET tool_calls = ?, blocks = ? WHERE id = ?`).run(tcStr, blStr, stream.messageId);
        }
      } catch (e) {
        console.warn(`[Turn] closing the interrupted tool calls of ${sessionKey} failed, the box may stay in progress on disk:`, e);
      }
    }
    // A tool kept awaiting a person (the plan approval) is said with the close:
    // every window holds its queue on it, whatever its transcript shows yet.
    if (stream && keepAwaiting.size > 0) turnLedger.noteEnd(sessionKey, { awaitsHuman: true });
    if (stream?.shadowed) activeStreams.set(sessionKey, stream.shadowed);
    else activeStreams.delete(sessionKey);
    turnLedger.set(sessionKey, "route", activeStreams.has(sessionKey));
    // A `wait_for_process` of this turn waits for nobody from here on, even if
    // its request is still open: the command's wake is owed again.
    closeWatchesOfSession(sessionKey);
    // Whoever waits for the session to be free acts now (`lib/turn-ended.ts`).
    announceTurnEnded(sessionKey);
    return interrupted;
  }

  /**
   * The turn in flight on this session, for as long as its entry exists.
   *
   * No clock here. Three minutes without a provider event used to answer
   * "not streaming" while the entry stayed, and a tool that prints nothing
   * (a long Bash, a wait on a Monitor) is exactly that silence: the registry
   * poll dropped a live turn, every client took its Stop away, and the 409
   * gate let a second turn in (topic:3019832f, 2026-09-25). Silence says
   * nothing about death. The sweeper in server.ts asks the child, and it is
   * the one that removes the entry, finalizing the row and saying so.
   */
  function isStreaming(sessionKey: string): ActiveStream | undefined {
    return activeStreams.get(sessionKey);
  }

  // NOTE: the periodic stale-active-stream sweeper lives in server.ts
  // (`staleStreamTimer`, 30s). It is the authoritative one — it finalizes the
  // partial DB row and broadcasts stream:end with topicId+reason, and it is
  // cleared in gracefulShutdown. A second sweeper used to run here too, but it
  // duplicated/raced the server.ts logic with weaker side effects AND its
  // interval handle was never stored, so it leaked one live 60s timer per
  // `bun --watch` hot reload. Removed — don't reintroduce a sweeper here.

  return { startStream, updateStreamActivity, updateStreamContent, getStreamContent, endStream, isStreaming };
}

