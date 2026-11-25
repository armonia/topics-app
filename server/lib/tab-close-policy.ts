import type { Database } from "bun:sqlite";
import { getDatabase } from "../db";

/**
 * Whether closing a tab archives the chat in it: the `closeArchives` option of
 * the View menu, part of the server-synced `settings` ui-state value.
 *
 * Off by default since 24/11 (asked: every tab has three states, open, closed,
 * archived): a closed chat stays a closed row until it is archived. The client
 * already honours it when it closes; this is the same rule for the server-side
 * cascade, which otherwise archived the chat a moment later.
 */
export function tabCloseArchives(db?: Database): boolean {
  try {
    const database = db ?? getDatabase();
    const row = database.query("SELECT value FROM ui_state WHERE key = ?").get("settings") as
      | { value?: string | null }
      | null;
    if (!row?.value) return false;
    const settings: unknown = JSON.parse(row.value);
    if (settings && typeof settings === "object" && !Array.isArray(settings)) {
      return (settings as Record<string, unknown>).closeArchives === true;
    }
  } catch {
    // Tests and early boot can run before the UI-state database is available.
  }
  return false;
}
