import { lazy, Suspense } from 'react';
import { X, Activity, Cpu, BarChart3, BookOpen, Timer, Kanban } from 'lucide-react';
import type { WSMessage } from '../../types';
import type { UtilityPanelType } from '../../state/pane/adapters/utilityPanelId';

const ActivityFeedPanel = lazy(() => import('../Sidebar/ActivityFeedPanel').then(m => ({ default: m.ActivityFeedPanel })));
const AgentsPane = lazy(() => import('../Agents/AgentsPane').then(m => ({ default: m.AgentsPane })));
const DashboardPane = lazy(() => import('../Dashboard/DashboardPane').then(m => ({ default: m.DashboardPane })));
const CronJobsPanel = lazy(() => import('../Sidebar/CronJobsPanel').then(m => ({ default: m.CronJobsPanel })));
const KanbanBoardPane = lazy(() => import('../Board/KanbanBoardPane').then(m => ({ default: m.KanbanBoardPane })));

// Id helpers moved to their canonical PURE home (state/pane/adapters/
// utilityPanelId.ts) so non-component modules (buildSidebarItems) can parse
// utility ids without importing this component. Re-exported here so existing
// importers keep working unchanged.
// eslint-disable-next-line react-refresh/only-export-components -- pure re-export for back-compat with existing importers
export { UTILITY_PREFIX, isUtilityPanelId, utilityPanelId, parseUtilityPanelType } from '../../state/pane/adapters/utilityPanelId';
export type { UtilityPanelType } from '../../state/pane/adapters/utilityPanelId';

const CONFIG: Record<UtilityPanelType, { icon: typeof Activity; label: string; color: string }> = {
  activity:      { icon: Activity,   label: 'Activity',    color: '#06b6d4' },
  agents:        { icon: Cpu,        label: 'Agents',      color: '#8b5cf6' },
  dashboard:     { icon: BarChart3,  label: 'Statistics',   color: '#10b981' },
  journal:       { icon: BookOpen,   label: 'Journal',     color: '#f59e0b' },
  cron:          { icon: Timer,      label: 'Cron Jobs',   color: '#6366f1' },
  board:         { icon: Kanban,     label: 'Board generale', color: '#10b981' },
};

const Spinner = <div className="flex items-center justify-center h-full"><div className="w-4 h-4 border-2 border-app-border-light border-t-primary rounded-full animate-spin" /></div>;

interface UtilityPanelProps {
  type: UtilityPanelType;
  isFocused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onNavigateToTopic?: (topicId: string) => void;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
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
          {type === 'dashboard' && <DashboardPane onMessage={onMessage} />}
          {type === 'cron' && <CronJobsPanel />}
          {type === 'board' && <KanbanBoardPane global onMessage={onMessage} />}
        </Suspense>
      </div>
    </div>
  );
}
