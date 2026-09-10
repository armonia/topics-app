/**
 * WHAT EACH PROJECT HAS CONSUMED: tokens, and the part of it that has a price.
 *
 * ── ONE READ PER GESTURE, NEVER A POLL ──────────────────────────────────────
 * `GET /api/usage/projects` is a `GROUP BY` over the whole `messages` table,
 * and that table is wide - content, blocks and tool_calls sit next to the usage
 * columns, so the scan drags overflow pages it has no use for. Measured on the
 * live database (23.025 messages, 3.812 tasks): 1,2 s on the first call of a
 * process, 91 ms once the pages are warm. The server caches it for 60 s per
 * range, which is what makes reopening the panel free - but it is not a number
 * to put on a timer, so this hook reads ONCE when it is switched on and once
 * more whenever the range changes. Nothing here ticks.
 *
 * ── AND THE MONEY IS A FLOOR, NOT A TOTAL ───────────────────────────────────
 * `cost.partial` says so in a field rather than in a comment, because roughly a
 * quarter of the consumption on this installation lives in `tasks.agent_tokens`
 * - real tokens, spent by dispatched board work, with no input/output split and
 * therefore no price. Anything that renders `costUsd` has to render that fact
 * beside it; a dollar figure presented alone reads as the bill.
 */
import { useCallback, useEffect, useState } from 'react';

/** The windows the route accepts. `all` is the default on the server too. */
export type UsageRange = '1d' | '7d' | '30d' | 'all';

export interface ProjectUsageRow {
  /** `projectIdForPath(projectPath)`, the key board rows carry. */
  projectId: string;
  /** Absolute path, when a topic named one. `null` = only board rows exist for
   *  this id, and the path is not recoverable from them. */
  projectPath: string | null;
  chatTokens: number;
  taskTokens: number;
  totalTokens: number;
  /** Dollars from PRICED message rows only. See `cost.excluded`. */
  costUsd: number;
  messageCount: number;
  taskCount: number;
  /** Message rows whose recorded cost was left out. `> 0` = this row's money is
   *  understated on its own, not just globally. */
  unpricedMessages: number;
}

export interface ProjectUsage {
  range: string;
  /** ISO instant of the server-side read this answer came from. */
  cachedAt: string;
  projects: ProjectUsageRow[];
  totals: { chatTokens: number; taskTokens: number; totalTokens: number; costUsd: number };
  cost: {
    currency: 'usd';
    partial: boolean;
    excluded: { taskTokens: number; messages: number; models: string[] };
  };
}

export function useProjectUsage(enabled: boolean, range: UsageRange): {
  usage: ProjectUsage | null;
  loading: boolean;
  error: boolean;
  refresh: () => void;
} {
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const read = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/usage/projects?range=${range}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as ProjectUsage;
      if (signal.aborted) return;
      setUsage(data);
      setError(false);
    } catch (e) {
      // An abort is this hook closing, not a failure: painting the error state
      // on the way out is how a panel flashes red as you close it.
      if ((e as Error)?.name === 'AbortError') return;
      setError(true);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [enabled, read]);

  const refresh = useCallback(() => {
    const controller = new AbortController();
    void read(controller.signal);
  }, [read]);

  return { usage, loading, error, refresh };
}
