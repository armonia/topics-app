/**
 * The channel engine's own record of turns it stopped before replying
 * (`log.what` starting `fermato:` — `fermato:da_un_nostro_bot`,
 * `fermato:senza_menzione`, `fermato:bot_senza_menzione`,
 * `fermato:gruppo_spento`…), paged and filterable by agent and reason.
 *
 * Read-only, another repo's database: a missing file or a missing `log`
 * table both answer an empty page, never a throw — same contract as
 * `readAgentActivity` in `../services/agent-activity`.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import type { StoppedPage } from "../../shared/stopped-log";

export type { StoppedPage };

function emptyPage(page: number, pageSize: number): StoppedPage {
  return { rows: [], total: 0, page, pageSize };
}

/** A column that may live directly on the row, or inside its `meta` JSON. */
function field(columns: Set<string>, name: string): string {
  return columns.has(name) ? name : `json_extract(meta, '$.${name}')`;
}

export function readStoppedLog(
  path: string,
  opts: { agent?: string; reason?: string; page?: number; pageSize?: number } = {},
): StoppedPage {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  if (!existsSync(path)) return emptyPage(page, pageSize);
  const db = new Database(path, { readonly: true });
  try {
    const hasLog = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'log'").get();
    if (!hasLog) return emptyPage(page, pageSize);
    const columns = new Set((db.query("PRAGMA table_info(log)").all() as { name: string }[]).map((c) => c.name));
    if (!columns.has("what")) return emptyPage(page, pageSize);
    const created = field(columns, "created");
    const chat = field(columns, "chat");
    const agentCol = field(columns, "agent");
    const what = field(columns, "what");
    // Only fall back to `meta` when the table actually has one: a `log` with neither a
    // `channel` nor a `meta` column (today's schema) must not turn into a broken query.
    const channelCol = columns.has("channel") || columns.has("meta") ? field(columns, "channel") : "NULL";
    const where: string[] = [`${what} LIKE 'fermato:%'`];
    const params: (string | number)[] = [];
    if (opts.agent) {
      where.push(`${agentCol} = ?`);
      params.push(opts.agent);
    }
    if (opts.reason) {
      where.push(`${what} = ?`);
      params.push(`fermato:${opts.reason}`);
    }
    const clause = where.join(" AND ");
    const total = (db.query(`SELECT count(*) AS n FROM log WHERE ${clause}`).get(...params) as { n: number }).n;
    const rows = db.query(
      `SELECT ${created} AS created, ${chat} AS chat, ${agentCol} AS agent, ${what} AS what, ${channelCol} AS channel
       FROM log WHERE ${clause} ORDER BY ${created} DESC LIMIT ? OFFSET ?`,
    ).all(...params, pageSize, (page - 1) * pageSize) as { created: number; chat: string | null; agent: string | null; what: string; channel: string | null }[];
    return {
      rows: rows.map((r) => ({
        created: Number(r.created), chat: String(r.chat ?? ""), agent: String(r.agent ?? ""),
        reason: String(r.what ?? "").replace(/^fermato:/, ""), channel: r.channel ? String(r.channel) : null,
      })),
      total, page, pageSize,
    };
  } catch {
    return emptyPage(page, pageSize);
  } finally {
    db.close();
  }
}
