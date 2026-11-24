/**
 * Derive a Claude Code session's current topic title from its transcript.
 *
 * Claude Code writes `{ type: 'ai-title', aiTitle }` lines into the session's
 * JSONL and re-emits them as the conversation evolves, so the LAST one is the
 * up-to-date topic. Before Claude has produced a title (early in a session) we
 * fall back to the last user prompt, then the first user message, so a
 * brand-new tab still gets a meaningful label.
 *
 * Split into a pure `extractTitleFromTranscript(raw)` (unit-testable with a
 * fixture string) and a path wrapper that reads the file INCREMENTALLY: this
 * runs on every hook turn-boundary of every live session, and transcripts
 * grow to many MB — re-reading the whole file synchronously each turn stalls
 * the event loop (today-review finding). Per-path scan state caches the byte
 * offset already consumed plus the fields found so far; each call reads only
 * the appended delta. A shrunken file (rotation/truncation) resets the scan.
 */
import { createIncrementalJsonlScanner, type IncrementalScanBase } from "./incremental-jsonl-scan";

/** Max title length — keeps a pasted blob from breaking the tab strip. */
const MAX_TITLE_LEN = 80;

interface TitleScanState extends IncrementalScanBase {
  aiTitle: string | null;
  lastPrompt: string | null;
  firstUser: string | null;
}

function blankState(): TitleScanState {
  return { offset: 0, carry: Buffer.alloc(0), aiTitle: null, lastPrompt: null, firstUser: null };
}

/** Harness plumbing, not something the human typed: slash-command frames
 *  (`<command-name>/compact</command-name>…`), local-command stdout, task
 *  notifications, system reminders. Using one as a tab title yields literal
 *  "<command-name>…" labels. A prompt that BEGINS with markup is plumbing —
 *  skip the candidate and keep the previous meaningful one. */
function isHarnessMarkup(text: string): boolean {
  return text.startsWith("<");
}

/** Fold one batch of complete JSONL lines into the scan state. */
function scanLines(st: TitleScanState, lines: string[]): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }

    switch (ev?.type) {
      case "ai-title":
        // Keep the LAST one — Claude re-emits it as the topic evolves.
        if (typeof ev.aiTitle === "string" && ev.aiTitle.trim()) st.aiTitle = ev.aiTitle.trim();
        break;
      case "last-prompt": {
        const p = typeof ev.lastPrompt === "string" ? ev.lastPrompt.trim() : "";
        if (p && !isHarnessMarkup(p)) st.lastPrompt = p;
        break;
      }
      case "user":
        if (!st.firstUser) {
          const c = ev?.message?.content;
          const text = typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join(" ")
              : "";
          const t = text.trim();
          if (t && !isHarnessMarkup(t)) st.firstUser = t;
        }
        break;
    }
  }
}

function chooseTitle(st: TitleScanState): string | null {
  const chosen = st.aiTitle || st.lastPrompt || st.firstUser;
  if (!chosen) return null;
  return chosen.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LEN);
}

/** Reads a file (only the bytes appended since the last call) and derives its
 *  title. Returns null if the file is missing/unreadable or carries nothing
 *  usable yet. */
export const deriveClaudeSessionTitle = createIncrementalJsonlScanner({
  blank: blankState,
  scanLines,
  choose: chooseTitle,
  cacheMax: 200,
});
