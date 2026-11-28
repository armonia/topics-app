/**
 * The model fallback for a tool NAME `shared/tool-phrase.ts` does not know: a
 * cheap model writes one short phrase and picks the category. One model call
 * per never-seen tool name, cached by name in `tool_phrase_cache`; a provider
 * error is not cached. The prompt carries the tool name and its argument KEYS
 * only, never an argument value.
 */
import type { Database } from "bun:sqlite";
import type { Phrase, ToolCategory } from "../../shared/tool-phrase";

const CATEGORIES: ToolCategory[] = ["read", "write", "search", "network", "browser", "shell", "other"];

export function phrasePrompt(toolName: string, argKeys: string[]): string {
  return `Dai un nome leggibile a una chiamata di tool. Rispondi SOLO con JSON: {"text":"<frase breve all'indicativo, es. Legge la card>","category":"${CATEGORIES.join("|")}"}.\nTool: ${toolName}\nArgomenti: ${argKeys.join(", ") || "(nessuno)"}`;
}

function parsePhrase(raw: unknown): Phrase | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { text?: unknown; category?: unknown };
  if (typeof r.text !== "string" || !r.text.trim() || r.text.length > 80) return null;
  if (typeof r.category !== "string" || !CATEGORIES.includes(r.category as ToolCategory)) return null;
  return { text: r.text.trim(), category: r.category as ToolCategory };
}

export interface PhraseDeps { db: Database; complete: (prompt: string) => Promise<string> }

export async function toolPhraseFallback(deps: PhraseDeps, toolName: string, argKeys: string[]): Promise<Phrase | null> {
  const row = deps.db.prepare("SELECT phrase, category FROM tool_phrase_cache WHERE tool_name = ?").get(toolName) as { phrase: string | null; category: string | null } | undefined;
  if (row) return row.phrase && row.category ? { text: row.phrase, category: row.category as ToolCategory } : null;
  let text: string;
  try {
    text = await deps.complete(phrasePrompt(toolName, argKeys));
  } catch {
    return null;
  }
  let phrase: Phrase | null = null;
  try {
    phrase = parsePhrase(JSON.parse(text.trim().replace(/^```(?:json)?\n?/, "").replace(/```$/, "")));
  } catch { /* an answer that is not JSON is cached as "no phrase" below */ }
  deps.db.prepare("INSERT OR IGNORE INTO tool_phrase_cache (tool_name, phrase, category, created_at) VALUES (?, ?, ?, ?)")
    .run(toolName, phrase?.text ?? null, phrase?.category ?? null, new Date().toISOString());
  return phrase;
}
