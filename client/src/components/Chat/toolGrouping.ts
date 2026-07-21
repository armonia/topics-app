/**
 * Pure grouping logic for runs of consecutive tool calls (CHAT-TOOL-02).
 *
 * A run of settled calls collapses into ONE summary row with per-tool counts
 * ("Read ×5 · Edit ×3 · Bash ×4") — the drill-down re-uses the existing
 * per-call <ToolCallRow>. Kept free of React so it unit-tests under bun:test.
 */

import type { ToolCall } from '../../types';
import { resolveToolDetail, buildToolDisplayLabel } from './toolDetail';

/** Runs shorter than this render as plain per-call rows (no group chrome). */
export const GROUP_MIN = 3;

export type ToolGroupSegment =
  | { kind: 'aggregate'; tools: ToolCall[] }
  | { kind: 'solo'; tool: ToolCall };

/**
 * Calls that must NEVER fold into an aggregate:
 *  - `waiting_for_input` — the inline form is the row's whole reason to exist;
 *  - sub-agents (Task) — the live action log is the primary signal.
 * Errors stay IN the aggregate; the summary surfaces their count instead.
 */
export function isSoloTool(tc: ToolCall): boolean {
  if (tc.status === 'waiting_for_input') return true;
  return resolveToolDetail(tc).type === 'sub_agent';
}

/** A call the agent is still on (spinner territory). */
export function isActiveTool(tc: ToolCall): boolean {
  const status = tc.status ?? 'pending';
  return status === 'pending' || status === 'running';
}

/** Split a consecutive run into aggregatable stretches and solo rows, in order. */
export function partitionToolGroup(tools: ToolCall[]): ToolGroupSegment[] {
  const segments: ToolGroupSegment[] = [];
  for (const tc of tools) {
    if (isSoloTool(tc)) {
      segments.push({ kind: 'solo', tool: tc });
      continue;
    }
    const last = segments[segments.length - 1];
    if (last && last.kind === 'aggregate') last.tools.push(tc);
    else segments.push({ kind: 'aggregate', tools: [tc] });
  }
  return segments;
}

export interface ToolGroupSummary {
  total: number;
  /** Canonical display names (Read/Edit/Shell/…) with occurrence counts,
   *  sorted by count desc then name. */
  counts: Array<{ name: string; count: number }>;
  errors: number;
  /** pending + running */
  running: number;
  /** Wall-clock span of the run — first startedAt → last endedAt — when both
   *  bounds exist. Absent for legacy rows without timestamps. */
  durationMs?: number;
  /** WHAT was touched, not just how often: per-call digests (commands run,
   *  file basenames, search patterns, fetch hosts) deduped in run order.
   *  Rendered as the collapsed group's second line. */
  highlights: string[];
}

function truncateMiddleless(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * The one thing you'd want to know about this call without expanding it:
 * the shell COMMAND, the file BASENAME, the grep PATTERN, the fetch HOST.
 * Powers the group's highlights line — "counts tell how much, digests tell
 * what". Undefined for calls with nothing scannable (todo, plan, unknown).
 */
export function toolCallDigest(tc: ToolCall): string | undefined {
  const detail = resolveToolDetail(tc);
  switch (detail.type) {
    case 'shell': {
      const cmd = (detail.command ?? '').replace(/\s+/g, ' ').trim();
      return cmd ? truncateMiddleless(cmd, 36) : undefined;
    }
    case 'read':
    case 'edit':
    case 'write': {
      const base = detail.filePath?.split('/').pop();
      return base || undefined;
    }
    case 'search':
      return detail.query ? truncateMiddleless(detail.query, 24) : undefined;
    case 'fetch':
      try {
        return detail.url ? new URL(detail.url).hostname : undefined;
      } catch {
        return undefined;
      }
    case 'mcp':
      return detail.tool;
    default:
      return undefined;
  }
}

/** Highlights beyond this stay unrendered — the line truncates anyway. */
const MAX_HIGHLIGHTS = 8;

export function summarizeToolGroup(tools: ToolCall[]): ToolGroupSummary {
  const byName = new Map<string, number>();
  const highlights: string[] = [];
  let errors = 0;
  let running = 0;
  let firstStart: number | undefined;
  let lastEnd: number | undefined;
  for (const tc of tools) {
    const name = buildToolDisplayLabel(resolveToolDetail(tc), tc.name).name;
    byName.set(name, (byName.get(name) ?? 0) + 1);
    if (tc.status === 'error') errors++;
    else if (isActiveTool(tc)) running++;
    if (highlights.length < MAX_HIGHLIGHTS) {
      const digest = toolCallDigest(tc);
      if (digest && !highlights.includes(digest)) highlights.push(digest);
    }
    if (typeof tc.startedAt === 'number') {
      firstStart = firstStart === undefined ? tc.startedAt : Math.min(firstStart, tc.startedAt);
    }
    if (typeof tc.endedAt === 'number') {
      lastEnd = lastEnd === undefined ? tc.endedAt : Math.max(lastEnd, tc.endedAt);
    }
  }
  const counts = [...byName.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const durationMs =
    firstStart !== undefined && lastEnd !== undefined && lastEnd >= firstStart
      ? lastEnd - firstStart
      : undefined;
  return {
    total: tools.length,
    counts,
    errors,
    running,
    highlights,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** "Read ×5 · Edit ×3" — the counts joined for the summary header. */
export function formatToolCounts(counts: ToolGroupSummary['counts']): string {
  return counts.map((c) => (c.count > 1 ? `${c.name} ×${c.count}` : c.name)).join(' · ');
}

/** Human duration: "0.8s" under 10s, "41s" under a minute, "1m 05s" above. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}
