/**
 * transcript-usage.ts — incremental, deduplicated usage accounting for Claude
 * Code transcripts (JSONL).
 *
 * Why this exists (vs the old inline sum in server.ts):
 * - Claude Code writes ONE usage line PER CONTENT BLOCK of the same API
 *   response, all sharing the same `message.id` and identical usage numbers.
 *   Summing every line overcounts ~2-2.5x. We count each message.id once
 *   (first occurrence wins — duplicate rows are verified identical).
 * - `cache_read_input_tokens` is the dominant share of real consumption
 *   (~60% measured) and was previously invisible. It is tracked separately:
 *   `billableTokens` keeps the historical semantics (input+output+cacheWrite)
 *   so the board chip stays comparable turn-over-turn, cacheRead rides along
 *   for the breakdown tooltip.
 * - The live board ticker polls every 4s; re-reading a multi-MB transcript
 *   each tick is O(file). This reader keeps a per-path byte offset and parses
 *   only appended bytes (transcripts are append-only).
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { Buffer } from "node:buffer";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** input + output + cacheWrite, deduplicated — the board-facing counter. */
  billableTokens: number;
}

export const ZERO_USAGE: SessionUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  billableTokens: 0,
});

interface PathState {
  byteOffset: number;
  /** Tail bytes of the last read that didn't end in \n (line mid-write).
   *  Kept as raw bytes: a chunk boundary can split a multi-byte UTF-8 char. */
  partial: Buffer;
  /** message.id values already counted (bounded FIFO). */
  seenIds: Set<string>;
  totals: { input: number; output: number; cacheWrite: number; cacheRead: number };
}

const MAX_SEEN_IDS = 8192;
const MAX_TRACKED_PATHS = 128;
const READ_CHUNK = 1 << 20; // 1MB

function freshState(): PathState {
  return { byteOffset: 0, partial: Buffer.alloc(0), seenIds: new Set(), totals: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
}

export function createTranscriptUsageReader(): { read(path: string): SessionUsage } {
  const states = new Map<string, PathState>();

  function accountLine(state: PathState, line: string): void {
    if (!line.includes('"usage"')) return;
    let j: any;
    try { j = JSON.parse(line); } catch { return; /* partial line already buffered; anything else is noise */ }
    const msg = j?.message;
    const u = msg?.usage;
    if (!u || typeof u !== "object") return;
    const id: string | undefined = msg.id ?? j.requestId;
    if (id) {
      if (state.seenIds.has(id)) return; // duplicate content-block row of a counted response
      state.seenIds.add(id);
      if (state.seenIds.size > MAX_SEEN_IDS) {
        // FIFO eviction: ids are chronological, old ones can't reappear.
        const first = state.seenIds.values().next().value;
        if (first !== undefined) state.seenIds.delete(first);
      }
    }
    state.totals.input += u.input_tokens ?? 0;
    state.totals.output += u.output_tokens ?? 0;
    state.totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
    state.totals.cacheRead += u.cache_read_input_tokens ?? 0;
  }

  function toUsage(state: PathState): SessionUsage {
    const { input, output, cacheWrite, cacheRead } = state.totals;
    return {
      inputTokens: input,
      outputTokens: output,
      cacheWriteTokens: cacheWrite,
      cacheReadTokens: cacheRead,
      billableTokens: input + output + cacheWrite,
    };
  }

  return {
    read(path: string): SessionUsage {
      if (!existsSync(path)) {
        // Vanished transcript: drop state so a recreated file re-reads from 0.
        states.delete(path);
        return ZERO_USAGE;
      }
      let state = states.get(path);
      if (!state) {
        state = freshState();
        states.set(path, state);
        if (states.size > MAX_TRACKED_PATHS) {
          const oldest = states.keys().next().value;
          if (oldest !== undefined && oldest !== path) states.delete(oldest);
        }
      }
      let size: number;
      try { size = statSync(path).size; } catch { return toUsage(state); }
      if (size < state.byteOffset) {
        // Transcript replaced/truncated (compaction): recount from scratch.
        Object.assign(state, freshState());
      }
      if (size === state.byteOffset) return toUsage(state);

      let fd: number;
      try { fd = openSync(path, "r"); } catch { return toUsage(state); }
      try {
        const buf = Buffer.alloc(Math.min(READ_CHUNK, size - state.byteOffset));
        while (state.byteOffset < size) {
          const want = Math.min(buf.length, size - state.byteOffset);
          const got = readSync(fd, buf, 0, want, state.byteOffset);
          if (got <= 0) break;
          state.byteOffset += got;
          const chunk = Buffer.concat([state.partial, buf.subarray(0, got)]);
          const lastNl = chunk.lastIndexOf(0x0a);
          if (lastNl < 0) { state.partial = chunk; continue; }
          state.partial = Buffer.from(chunk.subarray(lastNl + 1));
          for (const line of chunk.toString("utf8", 0, lastNl).split("\n")) accountLine(state, line);
        }
      } finally {
        closeSync(fd);
      }
      return toUsage(state);
    },
  };
}
