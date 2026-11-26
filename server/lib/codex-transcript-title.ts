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
 * claude-transcript-title.ts, via incremental-jsonl-scan.ts; only the line shapes differ.)
 */
import { createIncrementalJsonlScanner, type IncrementalScanBase } from "./incremental-jsonl-scan";

/** Max title length — keeps a pasted blob from breaking the tab strip. */
const MAX_TITLE_LEN = 80;

interface TitleScanState extends IncrementalScanBase {
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

/** Reads a file (only the bytes appended since the last call) and derives its
 *  title. Returns null if the file is missing/unreadable or carries nothing
 *  usable yet. */
export const deriveCodexSessionTitle = createIncrementalJsonlScanner({
  blank: blankState,
  scanLines,
  choose: chooseTitle,
  cacheMax: 200,
});
