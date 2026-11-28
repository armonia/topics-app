import type { Database } from "bun:sqlite";

/**
 * The readable-view fallback's switch and model. They live on the server so a
 * client never picks the model a request is sent to: the route reads them here.
 * Empty model = the default (`READABLE_VIEW_MODEL`).
 */
export interface ReadableViewSettings { fallbackEnabled: boolean; model: string }

export function readReadableViewSettings(db: Database): ReadableViewSettings {
  const row = db.prepare("SELECT fallback_enabled, model FROM readable_view_settings WHERE id = 1").get() as { fallback_enabled: number; model: string } | undefined;
  return { fallbackEnabled: row ? row.fallback_enabled !== 0 : true, model: row?.model ?? "" };
}

const MODEL_ID = /^[\w.:-]{0,80}$/;

/** Returns null when the patch is not valid (nothing is written). */
export function writeReadableViewSettings(db: Database, patch: unknown): ReadableViewSettings | null {
  if (!patch || typeof patch !== "object") return null;
  const p = patch as { fallbackEnabled?: unknown; model?: unknown };
  if (p.fallbackEnabled !== undefined && typeof p.fallbackEnabled !== "boolean") return null;
  if (p.model !== undefined && (typeof p.model !== "string" || !MODEL_ID.test(p.model))) return null;
  const cur = readReadableViewSettings(db);
  const next = { fallbackEnabled: p.fallbackEnabled ?? cur.fallbackEnabled, model: p.model ?? cur.model };
  db.prepare("INSERT INTO readable_view_settings (id, fallback_enabled, model) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET fallback_enabled = excluded.fallback_enabled, model = excluded.model")
    .run(next.fallbackEnabled ? 1 : 0, next.model);
  return next;
}
