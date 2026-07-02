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
 * fixture string) and a thin path wrapper that reads the file.
 */
import { readFileSync } from "fs";

/** Max title length — keeps a pasted blob from breaking the tab strip. */
const MAX_TITLE_LEN = 80;

/** Pull the best available title out of already-read JSONL transcript text.
 *  Returns null when nothing usable is present. */
export function extractTitleFromTranscript(raw: string): string | null {
  let aiTitle: string | null = null;
  let lastPrompt: string | null = null;
  let firstUser: string | null = null;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }

    switch (ev?.type) {
      case "ai-title":
        // Keep the LAST one — Claude re-emits it as the topic evolves.
        if (typeof ev.aiTitle === "string" && ev.aiTitle.trim()) aiTitle = ev.aiTitle.trim();
        break;
      case "last-prompt":
        if (typeof ev.lastPrompt === "string" && ev.lastPrompt.trim()) lastPrompt = ev.lastPrompt.trim();
        break;
      case "user":
        if (!firstUser) {
          const c = ev?.message?.content;
          const text = typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join(" ")
              : "";
          if (text.trim()) firstUser = text.trim();
        }
        break;
    }
  }

  const chosen = aiTitle || lastPrompt || firstUser;
  if (!chosen) return null;
  return chosen.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LEN);
}

/** Read a transcript file and derive its title. Returns null if the file is
 *  missing/unreadable or carries nothing usable yet. */
export function deriveClaudeSessionTitle(transcriptPath: string): string | null {
  let raw: string;
  try { raw = readFileSync(transcriptPath, "utf-8"); } catch { return null; }
  return extractTitleFromTranscript(raw);
}
