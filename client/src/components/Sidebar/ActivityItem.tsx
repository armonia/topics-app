import { useState } from 'react';
import {
  Terminal, Globe, FileText, Pencil, Wrench, Search,
  MessageSquare, Brain, Radio, Clock, Heart, Link,
  AlertCircle, Settings, ChevronDown, ChevronRight,
} from 'lucide-react';
import type { ActivityEvent, ActivityCategory } from '../../hooks/useActivity';

const CATEGORY_CONFIG: Record<ActivityCategory, { icon: typeof Terminal; color: string; label: string }> = {
  'tool:exec':    { icon: Terminal,      color: 'text-blue-500',    label: 'exec' },
  'tool:browser': { icon: Globe,         color: 'text-purple-500',  label: 'browser' },
  'tool:read':    { icon: FileText,      color: 'text-gray-500 dark:text-gray-400', label: 'read' },
  'tool:write':   { icon: Pencil,        color: 'text-green-500',   label: 'write' },
  'tool:edit':    { icon: Wrench,        color: 'text-orange-500',  label: 'edit' },
  'tool:search':  { icon: Search,        color: 'text-cyan-500',    label: 'search' },
  'tool:message': { icon: MessageSquare, color: 'text-yellow-500',  label: 'message' },
  'memory':       { icon: Brain,         color: 'text-pink-500',    label: 'memory' },
  'channel':      { icon: Radio,         color: 'text-teal-500',    label: 'channel' },
  'cron':         { icon: Clock,         color: 'text-amber-500',   label: 'cron' },
  'heartbeat':    { icon: Heart,         color: 'text-red-400',     label: 'heartbeat' },
  'session':      { icon: Link,          color: 'text-indigo-500',  label: 'session' },
  'error':        { icon: AlertCircle,   color: 'text-red-500',     label: 'error' },
  'system':       { icon: Settings,      color: 'text-slate-400',   label: 'system' },
};

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'now';
  if (diffMs < 1000) return 'now';
  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s`;
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`;
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface ActivityItemProps {
  event: ActivityEvent;
}

export function ActivityItem({ event }: ActivityItemProps) {
  const [expanded, setExpanded] = useState(false);
  const config = CATEGORY_CONFIG[event.category] || CATEGORY_CONFIG.system;
  const Icon = config.icon;
  const isError = event.level === 'error' || event.category === 'error';
  const hasDetail = !!(event.detail || event.raw);

  return (
    <div
      className={`group px-2 py-1 rounded cursor-default transition-colors ${
        isError
          ? 'bg-red-500/5 hover:bg-red-500/10'
          : 'hover:bg-app-hover'
      }`}
      onClick={() => hasDetail && setExpanded(!expanded)}
    >
      <div className="flex items-start gap-1.5">
        {/* Time */}
        <span
          className="text-[10px] font-mono text-app-text-muted flex-shrink-0 w-[28px] text-right mt-[1px]"
          title={new Date(event.timestamp).toISOString()}
        >
          {formatRelativeTime(event.timestamp)}
        </span>

        {/* Icon */}
        <Icon size={11} className={`${config.color} flex-shrink-0 mt-[2px]`} />

        {/* Title */}
        <span className={`text-[11px] leading-[16px] flex-1 min-w-0 break-words ${
          isError ? 'text-red-600 dark:text-red-400' : 'text-app-text-secondary'
        }`}>
          {event.title}
        </span>

        {/* Expand indicator */}
        {hasDetail && (
          <span className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-[1px]">
            {expanded ? <ChevronDown size={10} className="text-app-text-muted" /> : <ChevronRight size={10} className="text-app-text-muted" />}
          </span>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && hasDetail && (
        <div className="mt-1 ml-[40px] text-[10px] font-mono text-app-text-muted bg-elevated rounded px-2 py-1 break-all max-h-[120px] overflow-y-auto">
          {event.detail || event.raw}
        </div>
      )}
    </div>
  );
}

export { CATEGORY_CONFIG };
