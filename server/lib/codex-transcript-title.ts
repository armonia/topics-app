/**
 * Derive a Codex CLI session's title from its rollout JSONL — the codex analogue
 * of claude-transcript-title.ts. Unlike Claude (which writes `ai-title` records
 * Codex re-emits as the topic evolves), Codex emits NO title event, so the best
 * available label is the user's own prompt text:
 *
 *   {"type":"event_msg","payload":{"type":"user_message","message":"…"}}
 *
 * We prefer the LAST clean `user_message` (tracks the current turn, ≈ Claude's
 * `last-prompt`) and fall back to the FIRST (≈ `firstUser`) so a brand-new tab
 * still gets a meaningful label before a second prompt exists. Harness plumbing
 * (the `<environment_context>` preamble, `#`-prefixed guidance, the guardian
 * "The following is the Codex agent history" frame) is skipped so it never
 * becomes a tab title.
 *
 * Split into a pure `extractCodexTitleFromRollout(raw)` (unit-testable with a
 * fixture string) and a path wrapper that reads the file INCREMENTALLY: this
 * runs on every idle/turn boundary of every live codex session, and rollouts
 * grow large and append-only — re-reading the whole file each turn stalls the
 * event loop. Per-path scan state caches the byte offset already consumed plus
 * the fields found so far; each call reads only the appended delta. A shrunken
 * file (rotation/truncation) resets the scan. (Same incremental scanner as
 * claude-transcript-title.ts — kept separate because the line shapes differ.)
 */
import { openSync, readSync, fstatSync, closeSync } from "fs";

/** Max title length — keeps a pasted blob from breaking the tab strip. */
const MAX_TITLE_LEN = 80;

interface TitleScanState {
  /** Bytes of the file already consumed (including the carried tail). */
  offset: number;
  /** Trailing partial line carried to the next scan, as RAW BYTES — the delta
   *  boundary can fall mid-multibyte-char, so decoding happens only on complete
   *  lines ('\n' = 0x0A never occurs inside a UTF-8 sequence). */
  carry: Buffer;
  /** Last clean (non-plumbing) user_message — tracks the current turn. */
  lastClean: string | null;
  /** First clean user_message — the fallback for a one-prompt session. */
  firstUser: string | null;
}

function blankState(): TitleScanState {
  return { offset: 0, carry: Buffer.alloc(0), lastClean: null, firstUser: null };
}

/** Plumbing, not something the human typed: the `<environment_context>` preamble
 *  and other markup frames (`<…>`), `#`-prefixed guidance, and the guardian
 *  history preamble Codex injects into internal subagent rollouts. Using one as
 *  a tab title yields a useless label, so skip the candidate and keep the
 *  previous meaningful one. */
function isHarnessMarkup(text: string): boolean {
  return (
    text.startsWith("<") ||
    text.startsWith("#") ||
    text.startsWith("The following is the Codex agent history")
  );
}

/** Fold one batch of complete JSONL lines into the scan state. */
function scanLines(st: TitleScanState, lines: string[]): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    // The clean, human-typed prompt (excludes the environment_context preamble
    // that the `response_item` representation carries as its first user message).
    if (ev?.type === "event_msg" && ev?.payload?.type === "user_message") {
      const msg = typeof ev.payload.message === "string" ? ev.payload.message.trim() : "";
      if (msg && !isHarnessMarkup(msg)) {
        if (!st.firstUser) st.firstUser = msg;
        st.lastClean = msg;
      }
    }
  }
}

function chooseTitle(st: TitleScanState): string | null {
  const chosen = st.lastClean || st.firstUser;
  if (!chosen) return null;
  return chosen.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LEN);
}

/** Pull the best available title out of already-read rollout JSONL text.
 *  Returns null when nothing usable is present. */
export function extractCodexTitleFromRollout(raw: string): string | null {
  const st = blankState();
  scanLines(st, raw.split("\n"));
  return chooseTitle(st);
}

/** Per-rollout incremental scan state, keyed by path. Rollout paths are unique
 *  per session, so without a cap this grows with every session the process has
 *  EVER seen — LRU-capped like claude-transcript-title's twin cache. */
const scanCache = new Map<string, TitleScanState>();
const SCAN_CACHE_MAX = 200;

function cacheTouch(path: string, st: TitleScanState): void {
  // Map iteration order is insertion order — delete+set moves this key to the
  // tail, so the head is always the least-recently-used entry.
  scanCache.delete(path);
  scanCache.set(path, st);
  while (scanCache.size > SCAN_CACHE_MAX) {
    const oldest = scanCache.keys().next().value;
    if (oldest === undefined) break;
    scanCache.delete(oldest);
  }
}

/** Read a rollout file (only the bytes appended since the last call) and derive
 *  its title. Returns null if the file is missing/unreadable or carries nothing
 *  usable yet. */
export function deriveCodexSessionTitle(rolloutPath: string): string | null {
  let fd: number;
  try { fd = openSync(rolloutPath, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    let st = scanCache.get(rolloutPath);
    // First sight, or the file shrank (rotation/truncation) → full rescan.
    if (!st || size < st.offset) st = blankState();
    if (size > st.offset) {
      const delta = Buffer.alloc(size - st.offset);
      let read = 0;
      while (read < delta.length) {
        const n = readSync(fd, delta, read, delta.length - read, st.offset + read);
        if (n <= 0) break;
        read += n;
      }
      // Consume complete lines only: split on the LAST '\n' byte and carry the
      // raw remainder — the writer may be mid-append, and the boundary may even
      // land mid-multibyte-char; both resolve on the next call.
      const combined = st.carry.length
        ? Buffer.concat([st.carry, delta.subarray(0, read)])
        : delta.subarray(0, read);
      const lastNl = combined.lastIndexOf(0x0a);
      if (lastNl >= 0) {
        scanLines(st, combined.toString("utf-8", 0, lastNl).split("\n"));
      }
      // Copy — a subarray view would pin the whole delta buffer in memory.
      st.carry = Buffer.from(combined.subarray(lastNl + 1));
      st.offset += read;
      cacheTouch(rolloutPath, st);
    }
    // A final unterminated line is parsed opportunistically (a complete line
    // missing only its newline flush is common at turn end) WITHOUT consuming it
    // from the carry. If it's a genuinely partial write, JSON.parse fails and
    // the committed state wins.
    if (st.carry.length) {
      const peek: TitleScanState = { ...st };
      scanLines(peek, [st.carry.toString("utf-8")]);
      return chooseTitle(peek);
    }
    return chooseTitle(st);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
