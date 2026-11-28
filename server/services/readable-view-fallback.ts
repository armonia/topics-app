/**
 * The model fallback for a tool result whose shape `deterministicReadableView`
 * does not recognize: a cheap model (Haiku by default) picks a component from
 * the closed catalog and names PATHS into the real JSON, never values — so it
 * cannot invent a number (`shared/readable-view.ts`). Cached by structural
 * signature (keys + types, never values), so the same shape on different data
 * calls the model once; an answer that is not a valid spec is cached too, so
 * it is not retried on every render. A provider error is not cached.
 */
import type { Database } from "bun:sqlite";
import type { AIProvider } from "../providers";
import { leafPaths, resolveDeclSpec, shapeSignature, validateDeclSpec, type ReadableView } from "../../shared/readable-view";

export const READABLE_VIEW_MODEL = "claude-haiku-5-5";

const CATALOG = `Catalogo chiuso di componenti. Rispondi SOLO con JSON, una di queste forme:
{"kind":"kv","fields":[{"label":"...","path":"..."}]}
{"kind":"table","columns":[{"label":"...","path":"..."}],"rowsPath":"..."}
{"kind":"list","itemsPath":"...","textPath":"..."}
{"kind":"chip","path":"...","tone":"neutral|success|danger|warning"}
{"kind":"counter","label":"...","path":"..."}
{"kind":"error","path":"..."}
Regole: ogni percorso punta dentro il JSON sottostante, in notazione a punti ("data.items[].name": [] scorre un array). Non scrivere mai un valore, solo percorsi che esistono qui sotto.
"rowsPath" e "itemsPath" sono ASSOLUTI (partono dalla radice, es. "data.items[]"); i percorsi di "columns" e "textPath" sono RELATIVI alla riga (es. "name", non "data.items[].name").
Scegli la forma piu' leggibile per questi campi (percorso: tipo):
`;

/** The prompt names only paths and their types — never a value from the result. */
export function fallbackPrompt(toolName: string, value: unknown): string {
  const paths = leafPaths(value).map((p) => `${p.path}: ${p.type}`).join("\n");
  return `${CATALOG}\nTool: ${toolName}\n${paths}`;
}

export interface ReadableViewCacheRow { signature: string; tool_name: string; spec_json: string | null }

function cachedRow(db: Database, signature: string): ReadableViewCacheRow | undefined {
  return db.prepare("SELECT signature, tool_name, spec_json FROM readable_view_cache WHERE signature = ?").get(signature) as ReadableViewCacheRow | undefined;
}

function writeCache(db: Database, signature: string, toolName: string, specJson: string | null): void {
  db.prepare(
    "INSERT INTO readable_view_cache (signature, tool_name, spec_json, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(signature) DO UPDATE SET spec_json = excluded.spec_json",
  ).run(signature, toolName, specJson, new Date().toISOString());
}

export interface FallbackDeps {
  db: Database;
  /** Injected so a test can count calls / stub an answer without a real provider. */
  complete: (prompt: string) => Promise<string>;
}

/**
 * Resolves a readable view for a value the pure matcher could not place,
 * through the cache first and the model on a miss. Null when no view is
 * possible (the model failed, or the cached spec no longer fits this value) —
 * the caller falls back to the generic (coloured JSON) view.
 */
export async function readableViewFallback(deps: FallbackDeps, toolName: string, value: unknown): Promise<ReadableView | null> {
  const signature = `${toolName}::${shapeSignature(value)}`;
  const row = cachedRow(deps.db, signature);
  if (row) {
    if (row.spec_json === null) return null;
    const spec = validateDeclSpec(JSON.parse(row.spec_json));
    return spec ? resolveDeclSpec(spec, value) : null;
  }
  let raw: unknown;
  let text: string;
  try {
    text = await deps.complete(fallbackPrompt(toolName, value));
  } catch {
    // The provider failed (down, quota): nothing was answered, so nothing is
    // cached; a later result of this shape asks again.
    return null;
  }
  try {
    raw = JSON.parse(text.trim().replace(/^```(?:json)?\n?/, "").replace(/```$/, ""));
  } catch {
    writeCache(deps.db, signature, toolName, null);
    return null;
  }
  const spec = validateDeclSpec(raw);
  if (!spec) {
    writeCache(deps.db, signature, toolName, null);
    return null;
  }
  writeCache(deps.db, signature, toolName, JSON.stringify(spec));
  return resolveDeclSpec(spec, value);
}

/** The `complete` dependency the route wires: a real provider, Haiku by default. */
export function completeWith(provider: AIProvider, model: string = READABLE_VIEW_MODEL): FallbackDeps["complete"] {
  return async (prompt: string) => {
    const out = await provider.complete([{ role: "user", content: prompt }], { purpose: "readable-view", model });
    return out.content ?? "";
  };
}
