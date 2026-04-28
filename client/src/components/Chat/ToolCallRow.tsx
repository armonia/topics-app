import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import type { ToolCall } from '../../types';
import { iconForToolName } from './toolIcon';

interface Props {
  toolCall: ToolCall;
  /**
   * Optional override for the row label. Defaults to the tool name.
   * Provider-specific renderers can pass a richer label (e.g. `Bash → ls`).
   */
  label?: string;
}

/**
 * One inline tool-call row. Borderless, single-line, with an icon, name, and
 * status indicator. Click to reveal the args/result drawer underneath. The
 * design matches the reference screenshot — no surrounding card, no padding
 * box; the parent message provides the visual envelope.
 */
export function ToolCallRow({ toolCall, label }: Props) {
  const [open, setOpen] = useState(false);
  const Icon = iconForToolName(toolCall.name);
  const argCount = Object.keys(toolCall.args ?? {}).length;
  const status = toolCall.status ?? 'pending';
  const isRunning = status === 'pending' || status === 'running';

  return (
    <div data-testid={`tool-call-row-${toolCall.id}`} className="text-[12px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 py-1 text-left text-app-text-secondary hover:text-app-text transition-colors"
      >
        {open ? <ChevronDown size={12} className="text-app-text-muted flex-shrink-0" /> : <ChevronRight size={12} className="text-app-text-muted flex-shrink-0" />}
        <Icon size={13} className="text-app-text-muted flex-shrink-0" />
        <span className="font-mono text-app-text truncate">{label ?? toolCall.name}</span>
        {argCount > 0 && (
          <span className="text-[10px] text-app-text-muted">({argCount} {argCount === 1 ? 'arg' : 'args'})</span>
        )}
        <span className="ml-auto flex-shrink-0" data-testid={`tool-call-status-${toolCall.id}`} data-status={status}>
          {isRunning && <Loader2 size={11} className="animate-spin text-app-text-muted" />}
          {status === 'success' && <Check size={11} className="text-green-500" />}
          {status === 'error' && <X size={11} className="text-red-500" />}
        </span>
      </button>
      {open && (
        <div className="ml-5 pb-1.5 space-y-1.5">
          {argCount > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-app-text-muted mb-0.5">Arguments</div>
              <pre className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-40 bg-app-hover/40 rounded px-2 py-1.5">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>
            </div>
          )}
          {toolCall.result && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-app-text-muted mb-0.5">Result</div>
              <pre className="text-[11px] font-mono text-app-text-secondary whitespace-pre-wrap overflow-auto max-h-56 bg-app-hover/40 rounded px-2 py-1.5">
                {toolCall.result}
              </pre>
            </div>
          )}
          {toolCall.error && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-red-500 mb-0.5">Error</div>
              <pre className="text-[11px] font-mono text-red-500 whitespace-pre-wrap overflow-auto max-h-40 bg-red-500/5 rounded px-2 py-1.5">
                {toolCall.error}
              </pre>
            </div>
          )}
          {!toolCall.result && !toolCall.error && status === 'success' && (
            <div className="text-[11px] text-app-text-muted italic">No output</div>
          )}
        </div>
      )}
    </div>
  );
}
