/**
 * claude-transcript-import.ts — reconstruct a topic's chat history from a
 * Claude Code JSONL transcript.
 *
 * When Topics ADOPTS a session that was started elsewhere (a bare `claude` in a
 * terminal, a resume from another client), the conversation already exists on
 * disk as `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl`. To make that history
 * visible in the topic's chat we walk the transcript and rebuild the
 * `messages`-table rows: user/assistant turns, thinking, and tool calls with
 * their results matched back in.
 *
 * This is PURE (string in → StoredMessage[] out) so it's unit-testable without
 * touching disk. The phase state-machine in claude-session-state.ts parses the
 * SAME lines but only for liveness — it never extracts message text — so this
 * module does its own light parse rather than reuse it.
 *
 * Faithful, not lossless: sub-agent sidechains and CLI meta lines (command
 * echoes, interrupts, compaction markers) are dropped — they're noise in a
 * scrollback, not turns the human had.
 */
import type { StoredMessage } from "../types";
import type { ToolCall } from "../../shared/types";

/** One parsed transcript line, loosely typed — the CC format is a moving target. */
interface RawEntry {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  uuid?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/** Pull plain text out of a tool_result `content` (string, or array of blocks). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** A tool_result whose tool_use lives in an EARLIER chunk (already-saved
 *  message), so the caller must patch that stored row rather than a fresh
 *  message in this delta. See `parseTranscriptDelta`. */
export interface ToolResolution {
  toolUseId: string;
  result: string;
  isError: boolean;
}

export interface DeltaParseResult {
  /** New messages to APPEND, already chained (first from `opts.parentId`). */
  messages: StoredMessage[];
  /** tool_results for tool_use ids NOT in this chunk — patch the saved rows. */
  resolutions: ToolResolution[];
}

export interface DeltaParseOptions {
  /**
   * id of the last already-persisted message for this session. The first new
   * message's `parentId` points at it, so the imported branch stays linear
   * across sweeps. Omit (or null) for a full, from-scratch import.
   */
  parentId?: string | null;
}

/**
 * Parse a JSONL DELTA (the tail appended since the last import) into new chat
 * messages, chained from an already-saved parent.
 *
 * Two things make this more than a windowed `parseTranscriptToMessages`:
 *   1. `parentId` — the first new message links to the last row already in the
 *      DB, so appending the result keeps one linear branch across sweeps.
 *   2. cross-chunk tool_result — a tool_use can be consumed in sweep N and its
 *      result only in sweep N+1. Results whose tool_use is NOT in this chunk
 *      are returned as `resolutions` for the caller to patch onto the saved
 *      message. (Claude Code never emits a second assistant turn before a
 *      pending tool_result lands, so that saved message is always the LAST one
 *      — `updateToolCallResult` targets exactly it.)
 */
export function parseTranscriptDelta(text: string, opts?: DeltaParseOptions): DeltaParseResult {
  const startParentId = opts?.parentId ?? null;
  const out: StoredMessage[] = [];
  const resolutions: ToolResolution[] = [];
  // tool_use id → the toolCall object awaiting its result, so a later
  // tool_result line (which arrives as a `user` entry) can fill it in — but
  // only for tool_use blocks seen IN THIS chunk.
  const pendingTools = new Map<string, ToolCall>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let entry: RawEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    // Sidechains are a sub-agent's private transcript, meta lines are CLI
    // bookkeeping — neither is a turn the human sees in the main chat.
    if (entry.isSidechain === true || entry.isMeta === true || (entry as any).isCompactSummary === true) {
      // A tool_result can still live on a meta line in rare cases; but the
      // common meta lines carry no tool_result, so skipping is safe.
      continue;
    }
    const kind = entry.type;
    if (kind !== "user" && kind !== "assistant") continue;
    const msg = entry.message;
    if (!msg || typeof msg !== "object") continue;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString();

    if (kind === "assistant") {
      const content = msg.content;
      let textOut = "";
      let thinkingOut = "";
      const toolCalls: ToolCall[] = [];
      if (typeof content === "string") {
        textOut = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as any;
          if (b.type === "text" && typeof b.text === "string") {
            textOut += b.text;
          } else if (b.type === "thinking" && typeof b.thinking === "string") {
            thinkingOut += (thinkingOut ? "\n\n" : "") + b.thinking;
          } else if (b.type === "tool_use" && typeof b.id === "string") {
            const tc: ToolCall = {
              id: b.id,
              name: typeof b.name === "string" ? b.name : "tool",
              args: b.input && typeof b.input === "object" ? b.input : {},
              status: "success",
            };
            toolCalls.push(tc);
            pendingTools.set(b.id, tc);
          }
        }
      }
      if (!textOut && !thinkingOut && toolCalls.length === 0) continue;
      out.push({
        id: crypto.randomUUID(),
        role: "assistant",
        content: textOut,
        thinking: thinkingOut || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        timestamp: ts,
        parentId: out.length ? out[out.length - 1]!.id : startParentId,
        branchIndex: 0,
      });
      continue;
    }

    // kind === "user": either a real prompt, or a carrier of tool_result blocks
    // that belong to the preceding assistant's tool calls.
    const content = msg.content;
    let userText = "";
    if (typeof content === "string") {
      userText = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as any;
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          const resText = toolResultText(b.content);
          const tc = pendingTools.get(b.tool_use_id);
          if (tc) {
            // tool_use is in THIS chunk — resolve the fresh toolCall in place.
            if (b.is_error) tc.error = resText || "error";
            else tc.result = resText;
            tc.status = b.is_error ? "error" : "success";
            pendingTools.delete(b.tool_use_id);
          } else {
            // tool_use was in an earlier chunk — the caller patches the saved row.
            resolutions.push({
              toolUseId: b.tool_use_id,
              result: b.is_error ? (resText || "error") : resText,
              isError: !!b.is_error,
            });
          }
        } else if (b.type === "text" && typeof b.text === "string") {
          userText += b.text;
        }
      }
    }
    userText = userText.trim();
    if (!userText) continue; // pure tool_result carrier — no user turn to show
    // A local slash-command echo or an interrupt marker is CLI bookkeeping, not
    // a prompt the human typed — same exclusion list as the live-tail's
    // isMetaUserLine (claude-session-state.ts).
    if (
      userText.startsWith("<command-name>") ||
      userText.startsWith("<local-command") ||
      userText.startsWith("[Request interrupted")
    ) {
      continue;
    }
    out.push({
      id: crypto.randomUUID(),
      role: "user",
      content: userText,
      timestamp: ts,
      parentId: out.length ? out[out.length - 1]!.id : startParentId,
      branchIndex: 0,
    });
  }

  return { messages: out, resolutions };
}

/**
 * Parse a whole JSONL transcript into ordered chat messages — the full,
 * from-scratch import used at adoption time (and unit-tested directly).
 *
 * The result is a single linear branch: each message's `parentId` points at the
 * previous one (branchIndex 0), which is exactly what `loadActiveThread` walks —
 * so `saveLocalMessages(sessionKey, result)` renders them in order. Thin wrapper
 * over `parseTranscriptDelta` with no parent and (for a complete transcript) no
 * dangling cross-chunk resolutions.
 */
export function parseTranscriptToMessages(text: string): StoredMessage[] {
  return parseTranscriptDelta(text).messages;
}
