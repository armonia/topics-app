/**
 * What a sub-agent weighs and how long its kind takes: the two numbers the
 * rows of the live-work strip carry next to their name.
 *
 * Nothing here is invented. The weight is the provider's own report: a native
 * child's registry and last measured context, a CLI child's transcript (the
 * tokens of its last call are its context). With no report the fields are
 * absent and the UI draws nothing. The estimate is read from the children of
 * the same runtime that already finished, and exists only past the sample
 * floor of `estimateBasis`.
 */
import type { Database } from "bun:sqlite";
import { HISTORY_CAP, estimateBasis, type EstimateBasis } from "../../shared/task-countdown";
import type { WorkWeight } from "../../shared/live-work";
import { getSessionContext } from "../db/session-context";
import { readNativeUsage } from "../providers/native-usage-registry";
import { classifyContext, contextWindowFor, windowForMeasure } from "../usage/context-window";
import { createTranscriptUsageReader, type SessionUsage } from "../services/transcript-usage";
import { findClaudeTranscript } from "./claude-transcript-path";
import type { SubagentRow } from "./subagent-store";

const transcripts = createTranscriptUsageReader();

const centsOf = (u: SessionUsage): number => (typeof u.costUsd === "number" ? Math.round(u.costUsd * 100) : 0);

/** The weight of a session out of its usage totals and, when there is one, its context measure. */
export function weightOf(u: SessionUsage, context: { used: number; size: number; estimated: boolean } | null): WorkWeight | null {
  if (u.billableTokens <= 0 && u.cacheReadTokens <= 0 && !context) return null;
  return {
    usedTokens: context ? context.used : null,
    windowTokens: context ? context.size : null,
    estimated: context?.estimated ?? false,
    billableTokens: u.billableTokens,
    cacheReadTokens: u.cacheReadTokens,
    costCents: centsOf(u),
  };
}

/** A native child: its engine's usage registry and the context measure persisted for its chat. */
export function nativeChildWeight(db: Database, row: Pick<SubagentRow, "sessionKey" | "model">): WorkWeight | null {
  if (!row.sessionKey) return null;
  const usage = readNativeUsage(row.sessionKey);
  const measured = getSessionContext(db, row.sessionKey);
  const context = measured ? classifyContext(measured.usedTokens, windowForMeasure(measured, row.model)) : null;
  if (!usage && !context) return null;
  return weightOf(usage ?? emptyUsage(), context);
}

/** A CLI child: its transcript. The tokens of its last call are the context it carries now. */
export function cliChildWeight(row: Pick<SubagentRow, "cwd" | "claudeSessionId">): WorkWeight | null {
  if (!row.claudeSessionId) return null;
  const path = findClaudeTranscript(row.cwd, row.claudeSessionId);
  if (!path) return null;
  const usage = transcripts.read(path);
  const last = usage.lastCall;
  const context = last ? classifyContext(last.contextTokens, contextWindowFor(last.model)) : null;
  return weightOf(usage, context);
}

function emptyUsage(): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, billableTokens: 0 };
}

/**
 * The estimate of a child of a runtime, from the children of that runtime that
 * finished, by the rows of the `subagents` table (created to ended), the most
 * recent first. `undefined` below the sample floor: no history, no estimate.
 */
export function childEstimate(db: Database, runtime: SubagentRow["runtime"]): EstimateBasis | undefined {
  const rows = db
    .query(
      `SELECT created_at AS c, ended_at AS e FROM subagents
        WHERE COALESCE(runtime, 'claude-code') = ? AND ended_at IS NOT NULL AND state IN ('retired', 'stopped')
        ORDER BY ended_at DESC LIMIT ?`,
    )
    .all(runtime, HISTORY_CAP) as Array<{ c: string; e: string }>;
  const durations = rows.map((r) => ({ agentMs: Date.parse(r.e) - Date.parse(r.c) }));
  return estimateBasis(durations) ?? undefined;
}
