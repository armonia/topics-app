import { lazy, Suspense } from 'react';
import { X, Activity, Cpu, BarChart3, LayoutGrid, BookOpen } from 'lucide-react';

const ActivityFeedPanel = lazy(() => import('../Sidebar/ActivityFeedPanel').then(m => ({ default: m.ActivityFeedPanel })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const AllBoardsPane = lazy(() => import('../Board/AllBoardsPane').then(m => ({ default: m.AllBoardsPane })));

export type UtilityPanelType = 'activity' | 'agents' | 'dashboard' | 'all-boards' | 'journal';

export const UTILITY_PREFIX = '__';

export function isUtilityPanelId(id: string): boolean {
  return id.startsWith(UTILITY_PREFIX) && id.endsWith('__');
}

export function utilityPanelId(type: UtilityPanelType): string {
  return `${UTILITY_PREFIX}${type}__`;
}

export function parseUtilityPanelType(id: string): UtilityPanelType | null {
  if (!isUtilityPanelId(id)) return null;
  return id.slice(UTILITY_PREFIX.length, -2) as UtilityPanelType;
}

const CONFIG: Record<UtilityPanelType, { icon: typeof Activity; label: string; color: string }> = {
  activity:      { icon: Activity,   label: 'Activity',    color: '#06b6d4' },
  agents:        { icon: Cpu,        label: 'Agents',      color: '#8b5cf6' },
  dashboard:     { icon: BarChart3,  label: 'Statistics',   color: '#10b981' },
  'all-boards':  { icon: LayoutGrid, label: 'Board',       color: '#10b981' },
  journal:       { icon: BookOpen,   label: 'Journal',     color: '#f59e0b' },
};

const Spinner = <div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" /></div>;

interface UtilityPanelProps {
  type: UtilityPanelType;
  isFocused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onNavigateToTopic?: (topicId: string) => void;
  onMessage?: (handler: (msg: any) => void) => () => void;
}

export function UtilityPanel({ type, isFocused, onFocus, onClose, onNavigateToTopic, onMessage }: UtilityPanelProps) {
  const config = CONFIG[type];
  const Icon = config.icon;

  return (
    <div
      className={`flex flex-col h-full min-h-0 bg-surface rounded-lg overflow-hidden border ${
        isFocused ? 'border-primary/40' : 'border-app-border'
      }`}
      onClick={onFocus}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border flex-shrink-0 bg-elevated">
        <div className="flex items-center gap-2">
          <Icon size={14} style={{ color: config.color }} />
          <span className="text-[13px] font-medium text-app-text">{config.label}</span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text transition-colors"
          title="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={Spinner}>
          {type === 'activity' && <ActivityFeedPanel enabled />}
          {type === 'agents' && <AgentsPane onNavigateToTopic={onNavigateToTopic} onMessage={onMessage} />}
          {type === 'dashboard' && <DashboardPane />}
          {type === 'all-boards' && <AllBoardsPane onMessage={onMessage} />}
        </Suspense>
      </div>
    </div>
  );
}
