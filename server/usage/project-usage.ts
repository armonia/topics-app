/**
 * WHAT A PROJECT HAS CONSUMED — one GROUP BY per table, no new tables.
 *
 * The dashboard already sums the same two sources by DATE
 * (`routes/dashboard.ts:tokensSeries`): chats live in `messages`, dispatched
 * board work lives in `tasks`, and looking at one of them alone makes the busy
 * day look idle. This asks the same question with a different grouping column,
 * and reuses the ONE definition of the cost formula that exists in SQL
 * (`usage/token-sql.ts`) rather than writing a second one.
 *
 * ── TRAP ONE: THE TWO KEYS ARE NOT THE SAME STRING ──────────────────────────
 * `topics.project_path` is an absolute path; `tasks.project_id` is
 * `projectIdForPath(path)` — the basename plus a djb2 hash, and a shape that a
 * Windows-born row only reached after the migration `20260907132557`. Summing
 * them side by side without converting produces TWO ROWS for one project, and
 * neither of them is wrong on its own, which is why it would survive review.
 *
 * The conversion runs in TypeScript and not in SQL because the hash cannot be
 * written in SQLite, and it uses `shared/board.ts:projectIdForPath` — the
 * function the rest of the repo already keys those rows by. A private
 * re-implementation here would be the fiftieth copy of the function whose
 * forty-nine copies that file's header is about.
 *
 * ── TRAP TWO: THE MONEY TOTAL IS PARTIAL BY CONSTRUCTION ────────────────────
 * Tokens are complete; DOLLARS are not, and never can be from this data:
 *
 *  · `tasks.agent_tokens` is a single total with no input/output split, so it
 *    cannot be priced at all (`routes/dashboard.ts` says the same and keeps the
 *    agents out of its cost series for it).
 *  · a `messages` row written before the cache split (`cache_read_tokens IS
 *    NULL`) carries a `cost_cents` that billed re-read tokens as fresh input —
 *    inflated by an unrecoverable factor. It is excluded, not silently added.
 *  · a model absent from the price table bills at zero, which reads exactly
 *    like "it was free".
 *
 * So the payload DECLARES it in fields (`cost.partial` and `cost.excluded`)
 * instead of in a comment nobody ships to the client.
 */
import type { Database } from "bun:sqlite";
import { projectIdForPath } from "../../shared/board";
import { costFromMessage, costFromTask } from "./token-sql";
import { CACHE_READ_WEIGHT } from "../../shared/token-cost";

// THE TWO RECORDS LIVE IN `shared/usage-shapes.ts`: the panel that draws them
// is in the client, and a second copy there is what `no-type-mirrors` refuses.
//
// Only `ProjectUsageResult` is re-exported, because only that one has a reader
// here (the route annotates its cache with it). Re-exporting the row as well
// was a door nobody walked through - the client imports it straight from
// `shared/` - and `check:deadcode` counts an export with no importer as debt,
// which is the whole point of the gate.
export type { ProjectUsageResult } from "../../shared/usage-shapes";
import type { ProjectUsageRow, ProjectUsageResult, SideCallUsage } from "../../shared/usage-shapes";

export interface ProjectUsageOptions {
  /**
   * Window in days back from now. Omitted/`null` = the whole history, which is
   * the only window that lines up with the lifetime totals on the cards.
   */
  days?: number | null;
  /** Injected so the caller decides the source; defaults to none known. */
  unpricedModels?: string[];
}

interface MessageGroup {
  project_path: string;
  cost_tokens: number;
  cost_usd: number;
  msgs: number;
  unpriced: number;
  estimated: number;
  estimated_usd: number;
}

interface TaskGroup {
  project_id: string;
  cost_tokens: number;
  tasks: number;
}

/**
 * `messages` grouped by the topic's project, `tasks` grouped by the board id,
 * merged on `projectIdForPath`.
 *
 * COST: two statements, each one indexed GROUP BY. `messages` is joined to
 * `topics` on `session_key`, which is the column `idx_messages_session` and the
 * `topics.session_key` UNIQUE index both cover.
 */
export function projectUsage(db: Database, opts: ProjectUsageOptions = {}): ProjectUsageResult {
  const days = opts.days ?? null;
  // `messages.timestamp` is ISO-8601 UTC text, so the comparison against
  // `date('now', …)` is lexicographic and correct — the same reasoning the
  // dashboard's own windows rest on.
  const msgWindow = days === null ? "" : " AND m.timestamp >= date('now', ? || ' days')";
  const taskWindow = days === null
    ? ""
    : " AND COALESCE(t.completed_at, t.updated_at) >= date('now', ? || ' days')";
  const arg = days === null ? [] : [String(-Math.abs(days))];

  const messageRows = db
    .prepare(
      `SELECT tp.project_path AS project_path,
              SUM(${costFromMessage}) AS cost_tokens,
              SUM(CASE WHEN m.cache_read_tokens IS NOT NULL THEN COALESCE(m.cost_cents, 0) ELSE 0 END) / 100.0 AS cost_usd,
              COUNT(*) AS msgs,
              SUM(CASE WHEN m.cache_read_tokens IS NULL AND COALESCE(m.cost_cents, 0) > 0 THEN 1 ELSE 0 END) AS unpriced,
              SUM(CASE WHEN m.cost_estimated = 1 AND m.cache_read_tokens IS NOT NULL THEN 1 ELSE 0 END) AS estimated,
              SUM(CASE WHEN m.cost_estimated = 1 AND m.cache_read_tokens IS NOT NULL THEN COALESCE(m.cost_cents, 0) ELSE 0 END) / 100.0 AS estimated_usd
         FROM messages m
         JOIN topics tp ON tp.session_key = m.session_key
        WHERE tp.project_path IS NOT NULL AND tp.project_path <> ''${msgWindow}
        GROUP BY tp.project_path`,
    )
    .all(...arg) as MessageGroup[];

  const taskRows = db
    .prepare(
      `SELECT t.project_id AS project_id,
              SUM(${costFromTask}) AS cost_tokens,
              COUNT(*) AS tasks
         FROM tasks t
        WHERE t.project_id IS NOT NULL AND t.project_id <> ''${taskWindow}
        GROUP BY t.project_id`,
    )
    .all(...arg) as TaskGroup[];

  // Side calls that answered a chat (the fallback reply of a provider without
  // streaming) carry that chat's topic: they are the chat's cost, so they go
  // in its project. Their message row has no cost of its own, so nothing is
  // counted twice. The ledger's timestamp is epoch milliseconds.
  const ledgerWindow = days === null ? "" : " AND u.timestamp >= strftime('%s', date('now', ? || ' days')) * 1000";
  const ledgerRows = db
    .prepare(
      `SELECT tp.project_path AS project_path,
              SUM(MAX(0, COALESCE(u.input_tokens, 0) - COALESCE(u.cache_read_tokens, 0))
                  + COALESCE(u.output_tokens, 0)
                  + ${CACHE_READ_WEIGHT} * COALESCE(u.cache_read_tokens, 0)) AS cost_tokens,
              SUM(COALESCE(u.cost_usd, 0)) AS cost_usd,
              SUM(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) AS uncounted
         FROM usage_records u
         JOIN topics tp ON tp.id = u.topic_id
        WHERE tp.project_path IS NOT NULL AND tp.project_path <> ''${ledgerWindow}
        GROUP BY tp.project_path`,
    )
    .all(...arg) as { project_path: string; cost_tokens: number | null; cost_usd: number | null; uncounted: number | null }[];

  const byId = new Map<string, ProjectUsageRow>();
  const blank = (projectId: string, projectPath: string | null): ProjectUsageRow => ({
    projectId,
    projectPath,
    chatTokens: 0,
    taskTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    messageCount: 0,
    taskCount: 0,
    unpricedMessages: 0,
    estimatedMessages: 0,
  });
  let estimatedUsd = 0;

  for (const r of messageRows) {
    // THE NORMALISATION, and the only place it happens. Two chats on the same
    // folder already collapse here (they share the path); a board row for the
    // same folder collapses onto this id below, instead of standing next to it
    // as a second project with the same name.
    const id = projectIdForPath(r.project_path);
    const row = byId.get(id) ?? blank(id, r.project_path);
    row.chatTokens += Math.round(r.cost_tokens ?? 0);
    row.costUsd += r.cost_usd ?? 0;
    row.messageCount += r.msgs ?? 0;
    row.unpricedMessages += r.unpriced ?? 0;
    row.estimatedMessages += r.estimated ?? 0;
    estimatedUsd += r.estimated_usd ?? 0;
    if (!row.projectPath) row.projectPath = r.project_path;
    byId.set(id, row);
  }

  for (const r of ledgerRows) {
    const id = projectIdForPath(r.project_path);
    const row = byId.get(id) ?? blank(id, r.project_path);
    row.chatTokens += Math.round(r.cost_tokens ?? 0);
    row.costUsd += r.cost_usd ?? 0;
    // A reply nobody measured (ACP) or priced is said apart, like a message
    // without a price: never summed as a free one.
    row.unpricedMessages += r.uncounted ?? 0;
    if (!row.projectPath) row.projectPath = r.project_path;
    byId.set(id, row);
  }

  for (const r of taskRows) {
    // `tasks.project_id` is ALREADY the normalised id: it is what
    // `projectIdForPath` produced when the card was written, realigned for the
    // Windows-born rows by migration 20260907132557. Running the function over
    // it again would hash the id and invent a third key.
    const row = byId.get(r.project_id) ?? blank(r.project_id, null);
    row.taskTokens += Math.round(r.cost_tokens ?? 0);
    row.taskCount += r.tasks ?? 0;
    byId.set(r.project_id, row);
  }

  const projects = [...byId.values()];
  for (const p of projects) {
    p.totalTokens = p.chatTokens + p.taskTokens;
    p.costUsd = Math.round(p.costUsd * 100) / 100;
  }
  projects.sort((a, b) => b.totalTokens - a.totalTokens);

  const totals = projects.reduce(
    (a, p) => ({
      chatTokens: a.chatTokens + p.chatTokens,
      taskTokens: a.taskTokens + p.taskTokens,
      totalTokens: a.totalTokens + p.totalTokens,
      costUsd: a.costUsd + p.costUsd,
    }),
    { chatTokens: 0, taskTokens: 0, totalTokens: 0, costUsd: 0 },
  );
  totals.costUsd = Math.round(totals.costUsd * 100) / 100;

  const excludedMessages = projects.reduce((a, p) => a + p.unpricedMessages, 0);
  const models = opts.unpricedModels ?? [];

  return {
    projects,
    totals,
    sideCalls: sideCallUsage(db, days),
    cost: {
      currency: "usd",
      // Declared, not inferred by the reader: any of the three exclusions makes
      // the dollar figure a floor rather than a total.
      partial: totals.taskTokens > 0 || excludedMessages > 0 || models.length > 0,
      excluded: { taskTokens: totals.taskTokens, messages: excludedMessages, models },
      // Inside the total, not left out of it: said apart so nobody reads an
      // upper bound as a measured bill.
      estimated: {
        messages: projects.reduce((a, p) => a + p.estimatedMessages, 0),
        usd: Math.round(estimatedUsd * 100) / 100,
      },
    },
  };
}

/**
 * The side-call ledger (`usage/side-calls.ts`) over the same window, cut at the
 * same midnight as the chat rows: every call not counted in a project. A reply
 * to a chat with a project is in that project; one to a chat WITHOUT a project
 * is here, or it would be in neither total. Its `timestamp` is epoch
 * milliseconds, not ISO text like `messages`.
 *
 * A call the provider did not measure has NULL tokens and cost: it is counted
 * as a call and said apart, never summed as a zero. Same for a measured call on
 * a model without a price, and for a call that failed.
 */
function sideCallUsage(db: Database, days: number | null): SideCallUsage {
  const window = days === null ? "" : " AND u.timestamp >= strftime('%s', date('now', ? || ' days')) * 1000";
  const arg = days === null ? [] : [String(-Math.abs(days))];
  const rows = db
    .prepare(
      `SELECT COALESCE(u.purpose, 'other') AS purpose, COUNT(*) AS calls,
              SUM(CASE WHEN u.measured = 0 THEN 1 ELSE 0 END) AS unmeasured,
              SUM(CASE WHEN u.measured = 1 AND u.cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
              SUM(CASE WHEN u.error IS NOT NULL THEN 1 ELSE 0 END) AS failed,
              SUM(u.cost_usd) AS cost_usd, SUM(u.total_tokens) AS tokens
         FROM usage_records u
         LEFT JOIN topics tp ON tp.id = u.topic_id
        WHERE (tp.project_path IS NULL OR tp.project_path = '')${window}
        GROUP BY COALESCE(u.purpose, 'other')
        ORDER BY SUM(COALESCE(u.cost_usd, 0)) DESC, COUNT(*) DESC, COALESCE(u.purpose, 'other')`,
    )
    .all(...arg) as { purpose: string; calls: number; unmeasured: number; unpriced: number; failed: number; cost_usd: number | null; tokens: number | null }[];
  const byPurpose = rows.map((r) => ({
    purpose: r.purpose,
    calls: r.calls,
    unmeasured: r.unmeasured,
    costUsd: Math.round((r.cost_usd ?? 0) * 100) / 100,
    tokens: r.tokens ?? 0,
  }));
  const total = (key: "calls" | "unmeasured" | "unpriced" | "failed") => rows.reduce((a, r) => a + (r[key] ?? 0), 0);
  return {
    calls: total("calls"),
    unmeasured: total("unmeasured"),
    unpriced: total("unpriced"),
    failed: total("failed"),
    costUsd: Math.round(rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0) * 100) / 100,
    byPurpose,
  };
}
