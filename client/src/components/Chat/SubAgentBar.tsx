import { useState, useEffect, useMemo, memo } from 'react';
import { ChevronUp, ChevronDown, Loader2, Globe, Search, Terminal, Wrench, Brain, Check, AlertCircle, FileText, Code } from 'lucide-react';
import type { ChatMessage } from '../../types';

/** Map tool names to friendly labels and icons */
function toolInfo(name: string): { label: string; icon: typeof Globe } {
  const n = name.toLowerCase();
  if (n.includes('browser') || n.includes('navigate') || n.includes('screenshot')) return { label: 'Browser', icon: Globe };
  if (n.includes('search') || n.includes('web_search')) return { label: 'Searching', icon: Search };
  if (n.includes('exec') || n.includes('terminal') || n.includes('bash') || n.includes('shell')) return { label: 'Terminal', icon: Terminal };
  if (n.includes('think') || n.includes('reason')) return { label: 'Thinking', icon: Brain };
  if (n.includes('read') || n.includes('pdf') || n.includes('fetch')) return { label: 'Reading', icon: FileText };
  if (n.includes('edit') || n.includes('write') || n.includes('code')) return { label: 'Coding', icon: Code };
  return { label: name.length > 20 ? name.slice(0, 20) + '…' : name, icon: Wrench };
}

interface DisplayTool {
  id: string;
  name: string;
  label: string;
  icon: typeof Globe;
  status: 'running' | 'success' | 'error' | 'pending';
}

interface SubAgentBarProps {
  messages: ChatMessage[];
  isStreaming: boolean;
}

export const SubAgentBar = memo(function SubAgentBar({ messages, isStreaming }: SubAgentBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [, setTick] = useState(0);

  // Extract tool calls from the last assistant message
  const tools: DisplayTool[] = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        return msg.toolCalls.map(tc => {
          const info = toolInfo(tc.name || 'tool');
          return {
            id: tc.id || String(Math.random()),
            name: tc.name || 'tool',
            label: info.label,
            icon: info.icon,
            status: (tc.status || 'pending') as DisplayTool['status'],
          };
        });
      }
    }
    return [];
  }, [messages]);

  const hasRunningTools = tools.some(t => t.status === 'running' || t.status === 'pending');

  // Tick every 2s while tools are running
  useEffect(() => {
    if (!hasRunningTools) return;
    const t = setInterval(() => setTick(n => n + 1), 2000);
    return () => clearInterval(t);
  }, [hasRunningTools]);

  // Show bar when tools exist, auto-hide completed tools after 3s
  useEffect(() => {
    if (tools.length > 0) {
      setVisible(true);
      if (!isStreaming && !hasRunningTools) {
        const timer = setTimeout(() => setVisible(false), 3000);
        return () => clearTimeout(timer);
      }
    } else {
      setVisible(false);
    }
  }, [tools.length, isStreaming, hasRunningTools]);

  // Auto-collapse when streaming stops
  useEffect(() => {
    if (!isStreaming) setExpanded(false);
  }, [isStreaming]);

  if (!visible || tools.length === 0) return null;

  const runningCount = tools.filter(t => t.status === 'running' || t.status === 'pending').length;
  const totalCount = tools.length;
  const summaryText = hasRunningTools
    ? `${runningCount} tool${runningCount > 1 ? 's' : ''} active`
    : `${totalCount} tool${totalCount > 1 ? 's' : ''} completed`;

  return (
    <div className="border-t border-app-border bg-app-bg-secondary/50 flex-shrink-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text-muted hover:text-app-text transition-colors"
      >
        {hasRunningTools ? (
          <Loader2 size={12} className="animate-spin text-blue-500 flex-shrink-0" />
        ) : (
          <Check size={12} className="text-green-500 flex-shrink-0" />
        )}
        <span className="flex-1 text-left truncate">
          {summaryText}
          {' — '}
          {tools.map(t => t.label).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
        </span>
        {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </button>

      {expanded && (
        <div className="px-3 pb-2 space-y-1 max-h-32 overflow-y-auto">
          {tools.map(t => {
            const Icon = t.icon;
            const isRunning = t.status === 'running' || t.status === 'pending';
            const isError = t.status === 'error';
            return (
              <div
                key={t.id}
                className={`flex items-center gap-2 px-2 py-1 rounded text-[11px] ${
                  isError ? 'bg-red-900/20 border border-red-700/50' :
                  isRunning ? 'bg-blue-900/20 border border-blue-700/50' :
                  'bg-green-900/20 border border-green-700/50'
                }`}
              >
                {isRunning ? (
                  <Loader2 size={10} className="animate-spin text-blue-500 flex-shrink-0" />
                ) : isError ? (
                  <AlertCircle size={10} className="text-red-400 flex-shrink-0" />
                ) : (
                  <Check size={10} className="text-green-400 flex-shrink-0" />
                )}
                <Icon size={10} className={`flex-shrink-0 ${isError ? 'text-red-400' : isRunning ? 'text-blue-400' : 'text-green-400'}`} />
                <span className="truncate flex-1 min-w-0">{t.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
