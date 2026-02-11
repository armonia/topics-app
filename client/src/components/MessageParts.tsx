import { useState, memo } from 'react';
import { ChevronDown, ChevronRight, Brain, Wrench, Check, X, Loader2 } from 'lucide-react';
import type { ToolCall } from '../types';

// Thinking block - collapsible by default
interface ThinkingBlockProps {
  content: string;
  defaultCollapsed?: boolean;
}

export const ThinkingBlock = memo(function ThinkingBlock({ content, defaultCollapsed = true }: ThinkingBlockProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  if (!content) return null;

  return (
    <div className="mb-2 border border-[var(--border-light)] rounded-lg overflow-hidden bg-[var(--bg-elevated)]">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <Brain size={14} className="text-purple-500" />
        <span className="font-medium">Thinking</span>
        {collapsed && (
          <span className="text-[11px] text-[var(--text-muted)] ml-2 truncate max-w-[200px]">
            {content.slice(0, 50)}...
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="px-3 py-2 border-t border-[var(--border-light)] text-[12px] text-[var(--text-secondary)] whitespace-pre-wrap font-mono leading-relaxed">
          {content}
        </div>
      )}
    </div>
  );
});

// Tool call badge/card
interface ToolCallBadgeProps {
  toolCall: ToolCall;
  compact?: boolean;
}

export const ToolCallBadge = memo(function ToolCallBadge({ toolCall, compact = false }: ToolCallBadgeProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = () => {
    switch (toolCall.status) {
      case 'running':
      case 'pending':
        return <Loader2 size={12} className="animate-spin text-blue-500" />;
      case 'success':
        return <Check size={12} className="text-green-500" />;
      case 'error':
        return <X size={12} className="text-red-500" />;
      default:
        return <Loader2 size={12} className="animate-spin text-blue-500" />;
    }
  };

  const statusColor = () => {
    switch (toolCall.status) {
      case 'running':
      case 'pending':
        return 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20';
      case 'success':
        return 'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20';
      case 'error':
        return 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20';
      default:
        return 'border-[var(--border)] bg-[var(--bg-elevated)]';
    }
  };

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono border ${statusColor()}`}>
        {statusIcon()}
        <Wrench size={10} className="text-[var(--text-secondary)]" />
        {toolCall.name}
      </span>
    );
  }

  return (
    <div className={`my-2 border rounded-lg overflow-hidden ${statusColor()}`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {statusIcon()}
        <Wrench size={14} className="text-[var(--text-secondary)]" />
        <span className="font-mono font-medium">{toolCall.name}</span>
        {!expanded && Object.keys(toolCall.args).length > 0 && (
          <span className="text-[11px] text-[var(--text-muted)] ml-2">
            ({Object.keys(toolCall.args).length} args)
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-inherit">
          {/* Arguments */}
          {Object.keys(toolCall.args).length > 0 && (
            <div className="px-3 py-2 border-b border-inherit">
              <div className="text-[10px] uppercase text-[var(--text-muted)] mb-1 font-semibold">Arguments</div>
              <pre className="text-[11px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap overflow-auto max-h-32">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>
            </div>
          )}
          {/* Result */}
          {toolCall.result && (
            <div className="px-3 py-2">
              <div className="text-[10px] uppercase text-[var(--text-muted)] mb-1 font-semibold">Result</div>
              <pre className="text-[11px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap overflow-auto max-h-48">
                {toolCall.result}
              </pre>
            </div>
          )}
          {/* Error */}
          {toolCall.error && (
            <div className="px-3 py-2">
              <div className="text-[10px] uppercase text-red-500 mb-1 font-semibold">Error</div>
              <pre className="text-[11px] font-mono text-red-500 whitespace-pre-wrap overflow-auto max-h-32">
                {toolCall.error}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// Partial/streaming indicator
export function PartialIndicator() {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] mt-1">
      <Loader2 size={12} className="animate-spin" />
      <span>Streaming...</span>
    </div>
  );
}

// Tool calls list
interface ToolCallsListProps {
  toolCalls: ToolCall[];
  compact?: boolean;
}

export function ToolCallsList({ toolCalls, compact = false }: ToolCallsListProps) {
  if (!toolCalls || toolCalls.length === 0) return null;

  if (compact) {
    return (
      <div className="flex flex-wrap gap-1 mb-2">
        {toolCalls.map((tc, i) => (
          <ToolCallBadge key={tc.id || i} toolCall={tc} compact />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {toolCalls.map((tc, i) => (
        <ToolCallBadge key={tc.id || i} toolCall={tc} />
      ))}
    </div>
  );
}
