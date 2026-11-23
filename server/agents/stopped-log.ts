/**
 * The channel engine's own record of turns it stopped before replying.
 * `log.what` starts with `fermato:`, followed by the reason code the engine // allow-italian: literal engine values
 * writes (`fermato:da_un_nostro_bot`, `fermato:senza_menzione`, // allow-italian: literal engine values
 * `fermato:bot_senza_menzione`, `fermato:gruppo_spento`, among others). // allow-italian: literal engine values
 * The page is filterable by agent and reason.
 *
 * The engine's `log` table is `(t INTEGER NOT NULL, what TEXT NOT NULL, detail
 * TEXT)`: no `created`, `chat`, `agent` or `meta` column. `detail` carries
 * `<channel>:<account>:<chat> <sender>`, sometimes followed by a quoted
 * ` «message»` that is a person's own text and never surfaces here. The agent
 * is not stored at all: it is resolved from the account via
 * `accountToAgent` (the same resolver `readRegistry` uses), so this reader
 * and the one behind `/api/agent-config` never disagree on who owns a chat.
 *
 * Read-only, another repo's database: a missing file or a missing `log`
 * table both answer an empty page, never a throw — same contract as
 * `readAgentActivity` in `../services/agent-activity`.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { accountToAgent } from "./registry";
import type { StoppedPage } from "../../shared/stopped-log";

export type { StoppedPage };

function emptyPage(page: number, pageSize: number): StoppedPage {
  return { rows: [], total: 0, page, pageSize };
}

/** `<channel>:<account>:<chat> <sender>[ «message»]` — the message, when present, is never returned. */
const DETAIL_RE = /^([^:]+):([^:]+):(\S+)\s+(\S+)/;

function parseDetail(detail: string | null): { channel: string; account: string; chat: string } | null {
  const m = DETAIL_RE.exec(detail ?? "");
  if (!m) return null;
  return { channel: m[1], account: m[2], chat: m[3] };
}

export function readStoppedLog(
  path: string,
  home: string,
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
    if (!columns.has("what") || !columns.has("t")) return emptyPage(page, pageSize);
    const agentOf = accountToAgent(home);
    const where: string[] = ["what LIKE 'fermato:%'"];
    const params: string[] = [];
    if (opts.reason) {
      where.push("what = ?");
      params.push(`fermato:${opts.reason}`);
    }
    const all = db.query(
      `SELECT t, what, detail FROM log WHERE ${where.join(" AND ")} ORDER BY t DESC`,
    ).all(...params) as { t: number; what: string; detail: string | null }[];
    const rows = all
      .map((r) => {
        const parsed = parseDetail(r.detail);
        return {
          created: Number(r.t),
          chat: parsed?.chat ?? "",
          channel: parsed?.channel ?? null,
          agent: parsed ? agentOf(parsed.account) : "",
          reason: r.what.replace(/^fermato:/, ""),
        };
      })
      .filter((r) => !opts.agent || r.agent === opts.agent);
    const total = rows.length;
    const start = (page - 1) * pageSize;
    return { rows: rows.slice(start, start + pageSize), total, page, pageSize };
  } catch {
    return emptyPage(page, pageSize);
  } finally {
    db.close();
  }
}
