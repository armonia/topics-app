/**
 * The profile statistics: how much work really went through here.
 *
 * ── THE RULE THAT DECIDES EVERY QUERY IN THIS FILE ──────────────────────────
 * We read ONLY from tables that somebody writes. It sounds obvious, and instead
 * it is the fault the dashboard already had once: half its numbers came from
 * `usage_records` (a single INSERT in `server/db/seed.ts`, which nobody calls),
 * `agent_sessions` (zero INSERTs in the whole server) and `heartbeats`
 * (unreachable route). They were structural zeros, and a zero is the worst lie
 * a panel can tell - "0 sessions" reads as "you have not worked", not "I do not
 * know". The story in full is at the top of `server/routes/dashboard.ts`.
 *
 * The live sources, measured on the development DB (11/08: 14,697 messages,
 * 1,272 tasks, 737 topics, 8 projects):
 *   • `topics`   - the sessions: how many there are, how many still open;
 *   • `messages` - the chat turns, their tokens and their cost;
 *   • `tasks`    - the board's work: agent tokens, cache re-reads, execution
 *                  milliseconds, outcome;
 *   • `projects` - how many houses you have worked on.
 *
 * ── THE COST IS DECLARED IN TWO PIECES, NOT SUMMED ──────────────────────────
 * Same discipline as the dashboard: a row written before the cache was broken
 * out has a `cost_cents` inflated by up to ~10x by a factor that cannot be
 * reconstructed, because the re-read tokens were billed as fresh input. Those
 * rows are not summed and not hidden: they are COUNTED separately
 * (`uncertainRows`), and the profile carries that number next to the total. A
 * declared missing datum is information; secretly summed it is a lie.
 *
 * ── THE TOKENS ARE SUMMED, AND THE CACHE IS ALREADY IN ──────────────────────
 * The real consumption of an agentic turn is for the most part context re-read
 * (~60% measured). A total that excludes it describes a different app. But for
 * MESSAGES it must not be added: `usage_prompt_tokens` already CONTAINS it -
 * `readResultUsage` and `readAssistantCallUsage` (`providers/claude/events.ts`)
 * build the input as `input_tokens + cache_creation + cache_read`, and it is
 * the contract written down in `lib/cacheBreakdown.ts` too (`prompt = fresh +
 * read + creation`). Adding it again counts it twice: measured on the
 * production DB, 18.03 billion shown against 9.89 real, that is 1.82x.
 * Verified that the contract holds on every row: `usage_prompt_tokens >=
 * cache_read_tokens` on 1,061 rows out of 1,061.
 *
 * For TASKS, on the other hand, the sum is needed, and it is not an oversight:
 * `tasks.agent_tokens` comes from `billableTokens`, which is
 * "input+output+cacheWrite" and EXCLUDES the re-read by construction
 * (`services/dispatch-usage.ts`). Two tables, two conventions, and the
 * difference is in the module that fills them.
 */

import type { Database } from "bun:sqlite";
// The SHAPE lives in `shared/types.ts` because it crosses the wire: the profile
// panel reads it from the same declaration, instead of keeping a copy of it
// doomed to diverge (`tests/unit/no-type-mirrors.test.ts`). Here it is
// re-exported, so every historical import of this module stays valid.
import type { ProfileStats } from "../../shared/types";
import { projectIdForPath } from "../../shared/board";
export type { ProfileStats };

const EMPTY: ProfileStats = {
  sessions: { total: 0, open: 0 },
  messages: { total: 0, assistant: 0 },
  tokens: { total: 0, chat: 0, agents: 0 },
  cost: { measuredUsd: 0, uncertainRows: 0 },
  tasks: { total: 0, done: 0, inProgress: 0 },
  projects: 0,
  agentHours: 0,
  activity: { firstSeen: null, activeDays: 0, streakDays: 0, last30: [] },
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** A single row, with `?? 0` on every column: a table that does not exist yet
 *  (a DB older than the migration that brings it) must not tear down the whole
 *  profile card. */
function scalar(db: Database, sql: string, ...args: unknown[]): number {
  try {
    const row = db.query(sql).get(...(args as never[])) as { v?: unknown } | null;
    return num(row?.v);
  } catch {
    return 0;
  }
}

/** `YYYY-MM-DD` in UTC, the same unit SQLite writes `date(...)` in. */
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The consecutive run of active days that reaches up to yesterday or today.
 *
 * Pure, and taking the set of days as input: computing a streak has exactly one
 * interesting case - the boundary - and it is the only one people get wrong.
 * The DB is not needed to prove it.
 */
export function streak(activeDays: Set<string>, todayMs: number): number {
  const DAY_MS = 86_400_000;
  // If there is nothing today yet we start from yesterday: the day in progress
  // is not a missed day until it is over.
  let cursor = activeDays.has(day(todayMs)) ? todayMs : todayMs - DAY_MS;
  let n = 0;
  while (activeDays.has(day(cursor))) {
    n++;
    cursor -= DAY_MS;
  }
  return n;
}

/**
 * The statistics, right now.
 *
 * No cache: they are nine queries on indexed tables, the panel asks for them
 * when you open it, and a wrong cache on a number that has to say "this is you
 * today" is an elaborate way of showing yesterday.
 */
export function computeProfileStats(db: Database, now: number = Date.now()): ProfileStats {
  try {
    const sessionsTotal = scalar(db, "SELECT COUNT(*) AS v FROM topics");
    const sessionsOpen = scalar(db, "SELECT COUNT(*) AS v FROM topics WHERE archived = 0");
    const messagesTotal = scalar(db, "SELECT COUNT(*) AS v FROM messages");
    const messagesAssistant = scalar(db, "SELECT COUNT(*) AS v FROM messages WHERE role = 'assistant'");

    const tokensChat = scalar(
      db,
      `SELECT COALESCE(SUM(
           COALESCE(usage_prompt_tokens, 0) + COALESCE(usage_completion_tokens, 0)
       ), 0) AS v FROM messages`,
    );
    const tokensAgents = scalar(
      db,
      "SELECT COALESCE(SUM(agent_tokens + agent_cache_read_tokens), 0) AS v FROM tasks",
    );

    // The RELIABILITY gate is `cache_read_tokens IS NOT NULL`, not a technical
    // detail: see the header.
    const measuredCents = scalar(
      db,
      "SELECT COALESCE(SUM(cost_cents), 0) AS v FROM messages WHERE cache_read_tokens IS NOT NULL",
    );
    const uncertainRows = scalar(
      db,
      "SELECT COUNT(*) AS v FROM messages WHERE cost_cents > 0 AND cache_read_tokens IS NULL",
    );

    const tasksTotal = scalar(db, "SELECT COUNT(*) AS v FROM tasks");
    const tasksDone = scalar(db, "SELECT COUNT(*) AS v FROM tasks WHERE status = 'done'");
    const tasksInProgress = scalar(db, "SELECT COUNT(*) AS v FROM tasks WHERE status = 'in_progress'");
    const projects = scalar(db, "SELECT COUNT(*) AS v FROM projects WHERE archived = 0");
    const agentMs = scalar(db, "SELECT COALESCE(SUM(agent_ms), 0) AS v FROM tasks");

    let firstSeen: string | null = null;
    try {
      const r = db.query("SELECT MIN(timestamp) AS v FROM messages").get() as { v?: string | null } | null;
      firstSeen = r?.v ?? null;
    } catch { /* older schema: no start date */ }

    // The active days, and the streak: a single read for both.
    let days: Array<{ date: string; tokens: number }> = [];
    try {
      days = db.query(
        `SELECT date(timestamp) AS date,
                SUM(COALESCE(usage_prompt_tokens, 0) + COALESCE(usage_completion_tokens, 0)) AS tokens
           FROM messages
          WHERE timestamp IS NOT NULL
          GROUP BY date(timestamp)`,
      ).all() as Array<{ date: string; tokens: number }>;
    } catch { /* no messages: no series */ }

    const perDay = new Map(days.map((g) => [g.date, num(g.tokens)]));
    // The board's days count as activity even if you did not write a message
    // that day: an agent that worked all night is work.
    try {
      const t = db.query(
        `SELECT date(completed_at) AS date,
                SUM(agent_tokens + agent_cache_read_tokens) AS tokens
           FROM tasks WHERE completed_at IS NOT NULL GROUP BY date(completed_at)`,
      ).all() as Array<{ date: string; tokens: number }>;
      for (const r of t) {
        if (!r.date) continue;
        perDay.set(r.date, (perDay.get(r.date) ?? 0) + num(r.tokens));
      }
    } catch { /* schema without the 040/048 columns */ }

    const DAY_MS = 86_400_000;
    const last30: ProfileStats["activity"]["last30"] = [];
    for (let i = 29; i >= 0; i--) {
      const d = day(now - i * DAY_MS);
      last30.push({ date: d, tokens: perDay.get(d) ?? 0 });
    }

    return {
      sessions: { total: sessionsTotal, open: sessionsOpen },
      messages: { total: messagesTotal, assistant: messagesAssistant },
      tokens: { total: tokensChat + tokensAgents, chat: tokensChat, agents: tokensAgents },
      cost: { measuredUsd: Math.round(measuredCents) / 100, uncertainRows },
      tasks: { total: tasksTotal, done: tasksDone, inProgress: tasksInProgress },
      projects,
      agentHours: Math.round((agentMs / 3_600_000) * 10) / 10,
      activity: {
        firstSeen,
        activeDays: perDay.size,
        streakDays: streak(new Set(perDay.keys()), now),
        last30,
      },
    };
  } catch {
    // The DB is not ready (very early tests, a half-done boot): the profile is
    // drawn at zero instead of answering 500. It is not a made-up number - it is
    // the empty shape, and the card shows it as "nothing yet".
    return { ...EMPTY, activity: { ...EMPTY.activity, last30: [] } };
  }
}

// ── The state RIGHT NOW, for the presence ──────────────────────────────────

/**
 * How many sessions are open and how many are working at this moment.
 *
 * It is the number the daemon this replaced tried to guess with `ps` and a CPU
 * sampling. Here nothing is guessed: `liveTurns` is the count of the sessions
 * producing right now - the turns the server is STREAMING
 * (`ctx.activeStreams`, one entry per session) plus the agents grinding in a
 * terminal tab (`countBusyAgentTerminals`, which the caller adds in) - and the
 * tasks at work are the ones the board dispatched and has not closed yet.
 */
export function computePresenceCounts(
  db: Database,
  liveTurns: number,
  externalSessions = 0,
  externalWorking = 0,
): {
  openSessions: number;
  workingSessions: number;
  activeTasks: number;
  focusProject: string | null;
  externalSessions: number;
  externalWorking: number;
} {
  const openSessions = scalar(db, "SELECT COUNT(*) AS v FROM topics WHERE archived = 0");
  const activeTasks = scalar(db, "SELECT COUNT(*) AS v FROM tasks WHERE dispatch_state = 'working'");

  // The project in the foreground: the one of the task the board has been
  // running for the longest. If the board is idle, the one of the most recently
  // updated topic - "where are you right now" is a question that has an answer
  // even without agents.
  //
  // `tasks.project_id` IS THE BOARD SLUG, NOT `projects.id`. It is
  // `projectIdForPath(path)` - `<folder>-<hash>` - while `projects.id` is a
  // UUID, so the obvious join `p.id = t.project_id` matched 0 rows out of 3024
  // on the production DB and this query was always empty. The presence then
  // fell through to the topic branch and NAMED ANOTHER PROJECT with total
  // confidence, in the status bar and in the Discord Rich Presence other people
  // read. The slug is derived, not stored, so the match is done here on the few
  // project rows rather than in SQL.
  let focusProject: string | null = null;
  try {
    const r = db.query(
      `SELECT t.project_id AS v
         FROM tasks t
        WHERE t.dispatch_state = 'working' AND t.project_id IS NOT NULL
        ORDER BY t.in_progress_at ASC LIMIT 1`,
    ).get() as { v?: string } | null;
    const boardId = r?.v ?? null;
    if (boardId) {
      const projects = db.query(
        `SELECT id, name, path FROM projects WHERE path IS NOT NULL`,
      ).all() as Array<{ id: string; name: string; path: string }>;
      focusProject = projects.find(
        // `p.id` too: rows written before the board switched to the slug still
        // carry the UUID (`scripts/migrate-uuid-board-ids.ts`).
        (p) => projectIdForPath(p.path) === boardId || p.id === boardId,
      )?.name ?? null;
    }
    if (!focusProject) {
      const s = db.query(
        `SELECT p.name AS v
           FROM topics tp JOIN projects p ON p.path = tp.project_path
          WHERE tp.archived = 0 AND tp.project_path IS NOT NULL
          ORDER BY tp.updated_at DESC LIMIT 1`,
      ).get() as { v?: string } | null;
      focusProject = s?.v ?? null;
    }
  } catch { /* reduced schema: no foreground project */ }

  return {
    openSessions,
    // The Claude sessions open OUTSIDE Topics (a terminal, another harness):
    // the census already knows them and keeps them cached, but until now
    // neither of the two surfaces named them. They stay a SEPARATE number and
    // are not added to `openSessions`: that one counts topics, that is,
    // containers, and this one counts processes. Summing them would give a
    // total that is neither one nor the other.
    externalSessions,
    // Of those, how many are grinding right now: without this number an
    // external session at work looks as idle as an idle one.
    externalWorking,
    // A live turn IS a session at work; the board's tasks have their turn
    // inside `activeStreams`, so they are NOT summed again here - that would be
    // counting them twice, which is how a counter turns into bragging.
    workingSessions: Math.max(0, liveTurns),
    activeTasks,
    focusProject,
  };
}
