/**
 * What each agent handled in the last days, read from the channel bridge's own
 * database (read-only): one count per agent and channel from its `turns`.
 *
 * The turns carry no cost or timing, so none is reported here: a number the
 * source does not hold would be invented.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";

export interface AgentActivityRow {
  agent: string;
  channel: string;
  handled: number;
  failed: number;
  quota: number;
  merged: number;
  lastError: string | null;
}

const DAY_MS = 86_400_000;

/** A turn's field: the real column when the table has one, else the same key inside `meta`. */
function field(columns: Set<string>, name: string): string {
  return columns.has(name) ? name : `json_extract(meta, '$.${name}')`;
}

export function readAgentActivity(path: string, days = 7, now = Date.now()): AgentActivityRow[] {
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    const columns = new Set((db.query("PRAGMA table_info(turns)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("meta")) return [];
    const channel = field(columns, "channel");
    const status = field(columns, "status");
    const created = field(columns, "created");
    const error = field(columns, "error");
    const rows = db.query(
      `SELECT coalesce(json_extract(meta, '$.agent'), 'main') AS agent, coalesce(${channel}, '-') AS channel,
              ${status} AS status, ${error} AS error, ${created} AS created
       FROM turns WHERE ${created} >= ? ORDER BY ${created}`,
    ).all(now - days * DAY_MS) as { agent: string; channel: string; status: string | null; error: string | null }[];
    const out = new Map<string, AgentActivityRow>();
    for (const r of rows) {
      const key = `${r.agent}\u0000${r.channel}`;
      const row = out.get(key) ?? { agent: r.agent, channel: r.channel, handled: 0, failed: 0, quota: 0, merged: 0, lastError: null };
      row.handled++;
      if (r.status === "failed") row.failed++;
      else if (r.status === "quota") row.quota++;
      else if (r.status === "unito") row.merged++;
      if (r.error) row.lastError = String(r.error).slice(0, 300);
      out.set(key, row);
    }
    return [...out.values()].sort((a, b) => b.handled - a.handled);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export interface AgentTurn {
  agent: string;
  channel: string;
  chat: string | null;
  /** The chat's title as the bridge recorded it (`meta.chat_title`), or null. */
  title: string | null;
  /** `working` for a pending turn, `failed` for a failed one, else `done`. */
  state: "working" | "failed" | "done";
  created: number;
  error: string | null;
}

/** The newest turns of the last `days`, newest first: the list behind the Agents activity filters. */
export function readAgentTurns(path: string, days = 7, now = Date.now(), limit = 200): AgentTurn[] {
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    const columns = new Set((db.query("PRAGMA table_info(turns)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("meta")) return [];
    const channel = field(columns, "channel");
    const status = field(columns, "status");
    const created = field(columns, "created");
    const chat = field(columns, "chat");
    const rows = db.query(
      `SELECT coalesce(json_extract(meta, '$.agent'), 'main') AS agent, coalesce(${channel}, '-') AS channel, ${chat} AS chat,
              json_extract(meta, '$.chat_title') AS title, ${status} AS status, json_extract(meta, '$.error') AS error, ${created} AS created
       FROM turns WHERE ${created} >= ? ORDER BY ${created} DESC LIMIT ?`,
    ).all(now - days * DAY_MS, limit) as { agent: string; channel: string; chat: string | number | null; title: string | null; status: string | null; error: string | null; created: number }[];
    return rows.map((r) => ({
      agent: r.agent,
      channel: r.channel,
      chat: r.chat === null ? null : String(r.chat),
      title: r.title ? String(r.title) : null,
      state: r.status === "pending" ? "working" : r.status === "failed" ? "failed" : "done",
      created: Number(r.created),
      error: r.error ? String(r.error).slice(0, 300) : null,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}
