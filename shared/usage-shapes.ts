/**
 * THE SHAPE OF "WHAT HAS THIS COST", written ONCE for both sides.
 *
 * The query lives on the server (`server/usage/project-usage.ts`) and the panel
 * that draws it lives in the client (`components/Sidebar/ProjectUsagePanel`).
 * Both need the same record, and copying it into the client is exactly what
 * `tests/unit/no-type-mirrors.test.ts` refuses: two copies of one contract are
 * two things that drift, and the drift shows up as a number rendered from a
 * field the server stopped sending.
 *
 * THE CAVEATS ARE PART OF THE TYPE, not of a README. Every field that can be
 * absent, partial or unpriceable says so here, because whoever renders it has
 * to render that fact too - see `partial`.
 */

/** One project's consumption inside the requested window. */
export interface ProjectUsageRow {
  /** `projectIdForPath(projectPath)` - the same key `tasks` rows carry, so the
   *  two halves of the union land on one row instead of two. */
  projectId: string;
  /**
   * Absolute path, when a `topics` row named one. `null` = only board rows
   * exist for this id and the path is not recoverable from `tasks`, which
   * stores the id.
   */
  projectPath: string | null;
  /** Cost-equivalent tokens from chats (`messages`). */
  chatTokens: number;
  /** Cost-equivalent tokens from dispatched board work (`tasks`). */
  taskTokens: number;
  /** `chatTokens + taskTokens`. */
  totalTokens: number;
  /** Dollars, from PRICED message rows only. See `ProjectUsageCost.excluded`. */
  costUsd: number;
  /** Message rows in the window for this project. */
  messageCount: number;
  /** Task rows in the window for this project. */
  taskCount: number;
  /**
   * Message rows carrying a cost that was NOT added to `costUsd` because it was
   * recorded before the cache split. `> 0` means THIS row's money is
   * understated, not just the total.
   */
  unpricedMessages: number;
}

/** What the money figure does not include, and why. */
export interface ProjectUsageCost {
  currency: 'usd';
  /**
   * TRUE whenever some consumption in this payload carries no price. True in
   * practice on any window holding board work, because task tokens are
   * structurally unpriceable. Do not present `costUsd` as "the bill" while this
   * is set.
   */
  partial: boolean;
  excluded: {
    /** Cost-equivalent tokens from `tasks`: real consumption, no price. */
    taskTokens: number;
    /** Message rows whose recorded cost is inflated and was left out. */
    messages: number;
    /** Models seen running that are absent from the price table; their turns
     *  were billed at zero. Same list as `status.server.unpricedModels`. */
    models: string[];
  };
}

/** What `projectUsage()` computes, before the route wraps it. */
export interface ProjectUsageResult {
  /** Sorted by `totalTokens`, descending. */
  projects: ProjectUsageRow[];
  totals: {
    chatTokens: number;
    taskTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  cost: ProjectUsageCost;
}

/**
 * What `GET /api/usage/projects` answers: the result plus the two facts only
 * the route knows - which window was asked for, and how old the reading is.
 *
 * `cachedAt` is not decoration: the route reuses a reading for a minute, so a
 * surface that shows the number has to be able to say when it was taken.
 */
export interface ProjectUsageResponse extends ProjectUsageResult {
  /** Echoed back exactly as it arrived. */
  range: string;
  /** ISO instant of the server-side read this answer came from. */
  cachedAt: string;
}

/** One session's token totals, from the native runtime's in-memory registry. */
export interface SessionUsageRow {
  /** `topic:<first 8 chars>` for a chat; the terminal session id otherwise. */
  sessionKey: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  /** A SUBSET of `cacheWriteTokens`, not another addend. */
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  /** input + output + cacheWrite. Cache reads are excluded. */
  billableTokens: number;
}

/**
 * What `GET /api/usage/sessions` answers.
 *
 * ABSENT IS NOT ZERO, and `absentMeansUnmeasured` is there to say so in the
 * payload. The registry is capped at 200 with oldest-out eviction and lives as
 * long as the process: a session evicted, or run before this boot, or never
 * routed through the native runtime, simply is not in the array. A row of zeros
 * would claim "measured, and it cost nothing", which is a different statement
 * and a false one.
 */
export interface SessionUsageResponse {
  sessions: SessionUsageRow[];
  source: 'native-runtime';
  absentMeansUnmeasured: true;
}
