/**
 * A LATE ANSWER IS KEPT, ON ITS TURN'S ROW, UNDER THE CUT (card 1046df0b, C3).
 *
 * Once the chat route has finalized a turn, the provider can still answer into
 * it (a send that waited in its queue, C2). That answer used to land on
 * whatever row was last, then was dropped; kept nowhere, the final answer was
 * lost and the sweep resent a message the CLI had already executed. Here it is
 * written on the turn's own row after the cut, the content column keeps the
 * text above it, and every frame names the row and says it is late, so a
 * client paints it on that bubble and never on the last one. Which callbacks
 * come here, which stay live and which are dropped: `finalized-turn-guard.ts`.
 *
 * Three rules, each from the review of PR #135:
 *   - it starts from the ROW, not from the route's copy of the timeline. The
 *     closer may have written on the row since (endStream turns running tools
 *     into errors, the sweeper adds its verdict), and writing the copy back put
 *     a closed tool back to running, on a turn nothing would close again;
 *   - it goes through the turn's write throttle, and its end writes the rest.
 *     Forced, every late event rewrote the whole timeline: a long late answer
 *     cost the square of its length in bytes. While it runs the row is also
 *     flushed on demand (`onOpen`), for a reader looking up its tools;
 *   - whatever ends it saves it. An error or an abort lost everything after
 *     the last periodic save, and a failure now leaves the notice a live turn
 *     leaves, the one the sweep resumes.
 *
 * And an END with nothing late before it is not a late answer: it is the turn
 * itself ending twice (claude-code reports a dead child on the session and
 * again on the send; Codex's abort arrives after the Stop already closed the
 * turn). Only something late opens the lane, so those are logged and left.
 */
import type { ContentBlock, StoredMessage } from "../types";
import type { ProviderDoneMessage, StreamHandler } from "../providers/types";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { classifyTurnError, type TurnEndInfo } from "../providers/stop-reason";
import { avvisoPerTurno, isResumableCause } from "./cancelled-notice";
import { isWantedStop } from "./abort-cause";

interface Slot { get: () => string; set: (value: string) => void }

const END_EVENTS: ReadonlySet<string> = new Set(["onDone", "onError", "onAborted"]);

export interface LateAnswerLaneOptions {
  sessionKey: string;
  topicId?: string;
  /** The turn's own row. A function because the row is born after the lane. */
  rowId: () => string;
  isClosed: () => boolean;
  /** The row as it is in the database now. */
  readRow: () => StoredMessage | null;
  /** The turn's timeline and text, which the lane takes from the row and then grows. */
  blocks: ContentBlock[];
  content: Slot;
  thinking: Slot;
  /** The route's appenders: they keep the timeline's size, which the throttle reads. */
  appendTextBlock: (text: string) => void;
  appendThinkingBlock: (text: string) => void;
  setBlocksBytes: (bytes: number) => void;
  /** The turn's throttled write of content, thinking and blocks; `force` writes now. */
  save: (force: boolean) => void;
  broadcast: (frame: OutboundMessage) => void;
  finalText: (message?: ProviderDoneMessage) => string | null;
  /** Deltas between two saves, as for the live text. */
  saveEvery: number;
  onOpen: () => void;
  onClose: () => void;
}

export interface LateAnswerLane {
  handlers: Partial<StreamHandler>;
  /** For `guardFinalizedTurn`: a callback reached the closed turn and is kept. */
  onHeard: (event: string) => void;
  /** For `guardFinalizedTurn`: a callback reached the closed turn and went nowhere. */
  onDropped: (event: string) => void;
  /** A late answer is running: its end will write the row. */
  isOpen: () => boolean;
}

export function createLateAnswerLane(opts: LateAnswerLaneOptions): LateAnswerLane {
  const { sessionKey } = opts;
  let adopted = false;
  let open = false;
  let ended = false;
  let lateText = "";
  let deltas = 0;
  let dropped = 0;

  // Only from `onHeard`, i.e. from the provider's callbacks after the close:
  // the route's own finalize runs with the turn already marked closed and
  // must keep its live body, not the throttle's last write.
  const adopt = () => {
    if (adopted || !opts.isClosed()) return;
    adopted = true;
    try {
      const row = opts.readRow();
      if (!row) return;
      opts.blocks.splice(0, opts.blocks.length, ...(row.blocks ?? []));
      opts.setBlocksBytes(JSON.stringify(opts.blocks).length);
      opts.content.set(row.content ?? "");
      opts.thinking.set(row.thinking ?? "");
    } catch (err) {
      console.warn(`[StreamWS] ${sessionKey}: closed row ${opts.rowId()} not re-read, the late answer starts from memory:`, err);
    }
  };

  // The first late text opens a paragraph and a block of its own: glued to
  // the text above the cut, two answers read as one. Its frame says so
  // (`lateStart`), and the client opens the same paragraph.
  const appendText = (text: string) => {
    const first = !lateText;
    if (first) {
      const above = opts.content.get();
      opts.content.set(above.trim() ? `${above}\n\n` : "");
      opts.blocks.push({ kind: "text", text: "" });
    }
    lateText += text;
    opts.content.set(opts.content.get() + text);
    opts.appendTextBlock(text);
    broadcastChunk("stream:content_chunk", text, first);
  };
  const broadcastChunk = (type: "stream:content_chunk" | "stream:thinking_chunk", content: string, lateStart = false) =>
    opts.broadcast({ type, sessionKey, topicId: opts.topicId, content, messageId: opts.rowId(), late: true, ...(lateStart ? { lateStart: true } : {}) });
  // The end carries the whole final text; what the deltas did not bring is its
  // tail, and the tail is what was lost before.
  const takeTail = (message?: ProviderDoneMessage) => {
    const finalText = message ? opts.finalText(message) : null;
    if (finalText && finalText.length > lateText.length && finalText.startsWith(lateText)) {
      appendText(finalText.slice(lateText.length));
    }
  };
  const trailing = (how: string): boolean => {
    if (open) return false;
    console.warn(`[StreamWS] ${sessionKey}: ${how} after the close of ${opts.rowId()} with nothing late before it, the turn's own end: left alone`);
    return true;
  };
  const end = (how: string, notice: string | null) => {
    if (notice) opts.blocks.push({ kind: "error", text: notice.replace(/^⚠️\s*/, "") });
    ended = true;
    try { opts.save(true); }
    catch (err) { console.warn(`[StreamWS] ${sessionKey}: late answer not saved on ${opts.rowId()}:`, err); }
    if (open) { open = false; opts.onClose(); }
    console.warn(`[StreamWS] ${sessionKey}: late answer of the closed turn ${opts.rowId()} ${how}, saved on its own row (${lateText.length} chars)`);
  };

  const handlers: Partial<StreamHandler> = {
    onTextDelta: (text: string) => {
      if (!text) return;
      appendText(text);
      deltas += 1;
      if (deltas % opts.saveEvery === 0) opts.save(false);
    },
    onThinkingDelta: (text: string) => {
      if (!text) return;
      opts.thinking.set(opts.thinking.get() + text);
      opts.appendThinkingBlock(text);
      broadcastChunk("stream:thinking_chunk", text);
    },
    onDone: (message?: ProviderDoneMessage) => {
      if (trailing("onDone")) return;
      takeTail(message);
      end("ended", null);
    },
    // The same notice a live turn failing this way gets. Not the live
    // `onError`: that one also rolls back the inline preamble mark, and after
    // the close the mark may belong to the next turn.
    onError: (error: string) => {
      if (trailing(`onError (${error})`)) return;
      const notice = avvisoPerTurno(classifyTurnError(error, "provider-error"), { haProdotto: true, riprendeDaSolo: true });
      end(`failed (${error})`, notice ?? error);
    },
    // A notice only for a cause the provider named, and not for the echo of a
    // stop somebody asked for (the person, or the machine on purpose): ACP and
    // the native loop can still speak between the stop and that echo, and the
    // stop explains itself (lib/abort-cause.ts).
    onAborted: (message?: ProviderDoneMessage) => {
      if (trailing("onAborted")) return;
      takeTail(message);
      const info: TurnEndInfo | undefined = message?.turnEnd;
      const explained = !info || isWantedStop(info.cause);
      end("aborted", explained ? null : avvisoPerTurno(info, { haProdotto: true, riprendeDaSolo: isResumableCause(info.cause) }));
    },
  };

  return {
    handlers,
    onHeard: (event: string) => {
      if (END_EVENTS.has(event)) return;
      adopt();
      if (!open && !ended) { open = true; opts.onOpen(); }
    },
    onDropped: (event: string) => {
      dropped += 1;
      if (dropped === 1) {
        console.warn(`[StreamWS] ${sessionKey}: ${event} reached the closed turn ${opts.rowId()} and was dropped (only its text, tools and end are kept)`);
      }
    },
    isOpen: () => open,
  };
}
