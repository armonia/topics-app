import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import type { ToolCall } from '../../types';
import { resolveToolDetail, buildToolDisplayLabel } from './toolDetail';
import { ToolCardBody, iconForDetail } from './ToolCards';

interface Props {
  toolCall: ToolCall;
  /**
   * Optional override for the row label. Defaults to the canonical
   * display name from `buildToolDisplayLabel(detail)` (e.g. "Read",
   * "Shell"). Provider-specific renderers can pass a richer label.
   */
  label?: string;
}

/**
 * One inline tool-call row. Borderless, single-line header (chevron, icon,
 * name + summary, status); click to reveal a typed body card matching the
 * tool kind (shell terminal, read content, edit diff, sub-agent log, etc.).
 *
 * The detail comes from `tc.detail` when the server's normalizer set it; the
 * client falls back to `deriveToolDetail` for legacy messages persisted
 * before the normalization layer existed. Both paths land in the same
 * `<ToolCardBody>` dispatcher so a Bash tool from 6 months ago and one
 * streaming right now render identically.
 */
export function ToolCallRow({ toolCall, label }: Props) {
  const [open, setOpen] = useState(false);

  // Resolve the detail (server-provided or fallback derivation) and the
  // user-facing display name + summary. Sub-agent rows are auto-expanded
  // because their action log IS the primary signal — collapsed they'd hide
  // the entire reason for showing the row.
  const detail = resolveToolDetail(toolCall);
  const display = buildToolDisplayLabel(detail);
  const Icon = iconForDetail(detail);
  const status = toolCall.status ?? 'pending';
  const isRunning = status === 'pending' || status === 'running';
  const isError = status === 'error';

  // Auto-open sub-agent rows so the action log is visible by default
  // (otherwise the entire benefit of the SidechainTracker is hidden behind
  // a chevron). Honor user toggles afterwards.
  const [userToggled, setUserToggled] = useState(false);
  const effectiveOpen = userToggled ? open : (open || detail.type === 'sub_agent');

  const onToggle = () => {
    setUserToggled(true);
    setOpen((v) => !v);
  };

  return (
    <div data-testid={`tool-call-row-${toolCall.id}`} className="text-[12px]">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 py-1 text-left text-app-text-secondary hover:text-app-text transition-colors"
      >
        {effectiveOpen ? <ChevronDown size={12} className="text-app-text-muted flex-shrink-0" /> : <ChevronRight size={12} className="text-app-text-muted flex-shrink-0" />}
        <Icon size={13} className="text-app-text-muted flex-shrink-0" />
        <span className="font-mono text-app-text flex-shrink-0">{label ?? display.name}</span>
        {display.summary && (
          <span className="text-[11px] text-app-text-muted truncate font-mono">
            {display.summary}
          </span>
        )}
        <span className="ml-auto flex-shrink-0" data-testid={`tool-call-status-${toolCall.id}`} data-status={status}>
          {isRunning && <Loader2 size={11} className="animate-spin text-app-text-muted" />}
          {status === 'success' && <Check size={11} className="text-green-500" />}
          {status === 'error' && <X size={11} className="text-red-500" />}
        </span>
      </button>
      {effectiveOpen && (
        <div className="ml-5 pb-1.5">
          <ToolCardBody detail={detail} isError={isError} />
          {toolCall.error && status === 'error' && detail.type !== 'shell' && (
            <div className="mt-1.5">
              <div className="text-[10px] uppercase tracking-wide text-red-500 mb-0.5">Error</div>
              <pre className="text-[11px] font-mono text-red-500 whitespace-pre-wrap overflow-auto max-h-40 bg-red-500/5 rounded px-2 py-1.5">
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
