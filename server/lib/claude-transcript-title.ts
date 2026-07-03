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
import { openSync, readSync, fstatSync, closeSync } from "fs";

/** Max title length — keeps a pasted blob from breaking the tab strip. */
const MAX_TITLE_LEN = 80;

interface TitleScanState {
  /** Bytes of the file already consumed (including the carried tail). */
  offset: number;
  /** Trailing partial line carried to the next scan, as RAW BYTES — the
   *  delta boundary can fall mid-multibyte-char, so decoding happens only on
   *  complete lines ('\n' = 0x0A never occurs inside a UTF-8 sequence). */
  carry: Buffer;
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

/** Pull the best available title out of already-read JSONL transcript text.
 *  Returns null when nothing usable is present. */
export function extractTitleFromTranscript(raw: string): string | null {
  const st = blankState();
  scanLines(st, raw.split("\n"));
  return chooseTitle(st);
}

/** Per-transcript incremental scan state. Bounded by the number of live
 *  sessions (a few dozen entries of a few strings each). Keyed by path; a
 *  same-size in-place rewrite would go unnoticed, but JSONL transcripts are
 *  append-only in practice. */
const scanCache = new Map<string, TitleScanState>();

/** Read a transcript file (only the bytes appended since the last call) and
 *  derive its title. Returns null if the file is missing/unreadable or
 *  carries nothing usable yet. */
export function deriveClaudeSessionTitle(transcriptPath: string): string | null {
  let fd: number;
  try { fd = openSync(transcriptPath, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    let st = scanCache.get(transcriptPath);
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
      // Consume complete lines only: split on the LAST '\n' byte and carry
      // the raw remainder — the writer may be mid-append, and the boundary
      // may even land mid-multibyte-char; both resolve on the next call.
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
      scanCache.set(transcriptPath, st);
    }
    // A final unterminated line is parsed opportunistically (it may be the
    // freshest ai-title; a complete line missing only its newline flush is
    // common at turn end) WITHOUT consuming it from the carry. If it's a
    // genuinely partial write, JSON.parse fails and the committed state wins.
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
