import { memo, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, X, Zap } from 'lucide-react';
import type { ToolCall } from '../../types';
import { ToolCallRow } from './ToolCallRow';
import {
  GROUP_MIN,
  formatCostCents,
  formatDurationMs,
  formatTokensCompact,
  formatToolCounts,
  isActiveTool,
  partitionToolGroup,
  summarizeToolGroup,
} from './toolGrouping';

/**
 * One collapsed summary row for a run of ≥GROUP_MIN consecutive tool calls
 * (CHAT-TOOL-02) — "N azioni · Read ×5 · Edit ×3 · 41s", click to expand
 * into the classic per-call <ToolCallRow> stack.
 *
 * While the run is still LIVE (some call pending/running) the container stays
 * mounted and shows the summary of settled work PLUS the active call(s) with
 * their auto-open body — one persistent "hot" panel that hands off from tool
 * to tool instead of N rows flashing open and closed. On settle it collapses
 * to the single summary row.
 */
function ToolGroupRow({ tools, sessionKey }: { tools: ToolCall[]; sessionKey?: string }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeToolGroup(tools), [tools]);
  const live = summary.running > 0;
  const settledCount = summary.total - summary.running;
  // Costo del gruppo: prezzo se noto, altrimenti i token sommati.
  const groupCost = typeof summary.costCents === 'number'
    ? formatCostCents(summary.costCents)
    : typeof summary.tokens === 'number' && summary.tokens > 0
      ? `${formatTokensCompact(summary.tokens)} tok`
      : '';

  return (
    <div data-testid="tool-group-row" className="text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full py-1 text-left text-app-text-secondary hover:text-app-text transition-colors"
        data-testid="tool-group-summary"
      >
        <span className="flex items-center gap-2">
          {open ? (
            <ChevronDown size={12} className="text-app-text-muted flex-shrink-0" />
          ) : (
            <ChevronRight size={12} className="text-app-text-muted flex-shrink-0" />
          )}
          <Zap size={13} className={`flex-shrink-0 ${live ? 'text-primary' : 'text-app-text-muted'}`} />
          <span className={`flex-shrink-0 font-medium ${live ? 'text-primary' : 'text-app-text'}`}>
            {live
              ? `${settledCount}/${summary.total} azioni`
              : `${summary.total} azioni`}
          </span>
          <span className="text-[11px] text-app-text-muted truncate">
            {formatToolCounts(summary.counts)}
          </span>
          {summary.errors > 0 && (
            <span
              data-testid="tool-group-errors"
              className="flex-shrink-0 inline-flex items-center gap-0.5 text-[11px] text-red-500"
            >
              <X size={11} /> {summary.errors}
            </span>
          )}
          <span className="ml-auto flex-shrink-0 inline-flex items-center gap-1.5">
            {summary.durationMs !== undefined && !live && (
              <span className="text-[10px] tabular-nums text-app-text-muted">
                {formatDurationMs(summary.durationMs)}
              </span>
            )}
            {/* Costo sommato delle azioni del gruppo — la sua parte del turno. */}
            {groupCost && (
              <span className="text-[10px] tabular-nums text-app-text-muted" data-testid="tool-group-cost" title="Costo sommato delle azioni del gruppo">
                {groupCost}
              </span>
            )}
            {live ? (
              <Loader2 size={11} className="animate-spin text-primary" />
            ) : summary.errors > 0 ? (
              <X size={11} className="text-red-500" />
            ) : (
              <Check size={11} className="text-green-500" />
            )}
          </span>
        </span>
      </button>
      {(open || live) && (
        <div className="space-y-px">
          {(open ? tools : tools.filter(isActiveTool)).map((tc) => (
            <ToolCallRow key={tc.id} toolCall={tc} sessionKey={sessionKey} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Renderer for one consecutive run of tool calls: partitions it into
 * aggregatable stretches and never-aggregated solos (waiting_for_input,
 * sub-agents), applies the GROUP_MIN threshold, and falls back to the plain
 * per-call rows below it. This is the single entry MessageContent (blocks
 * timeline + legacy bucket) uses for tool runs.
 */
export const GroupedToolRows = memo(function GroupedToolRows({ tools, sessionKey }: { tools: ToolCall[]; sessionKey?: string }) {
  const segments = useMemo(() => partitionToolGroup(tools), [tools]);
  return (
    <>
      {segments.map((seg) =>
        seg.kind === 'solo' ? (
          <ToolCallRow key={seg.tool.id} toolCall={seg.tool} sessionKey={sessionKey} />
        ) : seg.tools.length >= GROUP_MIN ? (
          <ToolGroupRow key={`grp-${seg.tools[0].id}`} tools={seg.tools} sessionKey={sessionKey} />
        ) : (
          seg.tools.map((tc) => <ToolCallRow key={tc.id} toolCall={tc} sessionKey={sessionKey} />)
        ),
      )}
    </>
  );
});
