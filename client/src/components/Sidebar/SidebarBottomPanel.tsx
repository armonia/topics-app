import { useState, useRef, useCallback, useEffect, lazy, Suspense } from 'react';
import { X, Maximize2, Minimize2, ExternalLink } from 'lucide-react';
import type { SidebarTab } from '@/types';

const AgentPanel = lazy(() => import('../Agents/AgentPanel').then(m => ({ default: m.AgentPanel })));
const ActivityFeedPanel = lazy(() => import('./ActivityFeedPanel').then(m => ({ default: m.ActivityFeedPanel })));
const JournalPanel = lazy(() => import('../Journal/JournalPanel').then(m => ({ default: m.JournalPanel })));
const CronJobsPanel = lazy(() => import('./CronJobsPanel').then(m => ({ default: m.CronJobsPanel })));
const RemoteAccessPanel = lazy(() => import('./RemoteAccessPanel').then(m => ({ default: m.RemoteAccessPanel })));
const SystemStatusPanel = lazy(() => import('./SystemStatusPanel').then(m => ({ default: m.SystemStatusPanel })));
const BrowserSidebarControl = lazy(() => import('../Browser/BrowserSidebarControl').then(m => ({ default: m.BrowserSidebarControl })));
const TAB_LABELS: Record<SidebarTab, string> = {
  agents: 'Agents',
  activity: 'Activity',
  journal: 'Journal',
  cron: 'Cron Jobs',
  remote: 'Remote Access',
  system: 'System Status',
  browser: 'Browser',
  terminal: 'Terminal',
  webhooks: 'Webhooks',
};

const PANEL_HEIGHT_KEY = 'topics-sidebar-panel-height';
const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 260;

const PANE_ELIGIBLE_TABS = new Set<SidebarTab>(['activity', 'journal', 'agents']);

interface SidebarBottomPanelProps {
  tab: SidebarTab;
  onClose: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onNavigateToTopic?: (topicId: string) => void;
  onMessage?: (handler: (msg: any) => void) => () => void;
  onOpenAsPane?: (type: 'activity' | 'journal' | 'agents') => void;
}

export function SidebarBottomPanel({ tab, onClose, expanded, onToggleExpand, onNavigateToTopic, onMessage, onOpenAsPane }: SidebarBottomPanelProps) {
  const [height, setHeight] = useState(() => {
    try {
      const saved = localStorage.getItem(PANEL_HEIGHT_KEY);
      return saved ? Math.max(MIN_HEIGHT, parseInt(saved, 10)) : DEFAULT_HEIGHT;
    } catch {
      return DEFAULT_HEIGHT;
    }
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  // Persist height
  useEffect(() => {
    try { localStorage.setItem(PANEL_HEIGHT_KEY, String(height)); } catch {}
  }, [height]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (expanded) return; // No drag in expanded mode
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startHeight.current = height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [height, expanded]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startY.current - e.clientY;
      const parentEl = containerRef.current?.parentElement;
      const maxHeight = parentEl ? parentEl.clientHeight * 0.5 : 400;
      setHeight(Math.max(MIN_HEIGHT, Math.min(maxHeight, startHeight.current + delta)));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className={`flex flex-col bg-surface overflow-hidden ${expanded ? 'flex-1 min-h-0' : 'flex-shrink-0 animate-slide-up'}`}
      style={expanded ? undefined : { height }}
    >
      {/* Drag handle - only in compact mode */}
      {!expanded && (
        <div
          className="h-[1px] flex-shrink-0 cursor-row-resize relative bg-app-border hover:bg-primary transition-colors z-10"
          onMouseDown={handleDragStart}
        >
          <div className="absolute inset-x-0 -top-[3px] -bottom-[3px]" />
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center justify-between px-3 py-1.5 flex-shrink-0">
        <span className="text-[11px] font-medium text-app-text-secondary">
          {TAB_LABELS[tab]}
        </span>
        <div className="flex items-center gap-0.5">
          {onOpenAsPane && PANE_ELIGIBLE_TABS.has(tab) && (
            <button
              onClick={() => onOpenAsPane(tab as 'activity' | 'journal' | 'agents')}
              className="w-5 h-5 flex items-center justify-center text-app-text-tertiary hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
              title="Open as pane"
            >
              <ExternalLink size={11} />
            </button>
          )}
          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              className="w-5 h-5 flex items-center justify-center text-app-text-tertiary hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
              title={expanded ? 'Minimize' : 'Expand'}
            >
              {expanded ? <Minimize2 size={11} /> : <Maximize2 size={11} />}
            </button>
          )}
          <button
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-app-text-tertiary hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
            title="Close panel"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className={`flex-1 min-h-0 ${tab === 'activity' ? 'overflow-hidden' : 'overflow-y-auto sidebar-scroll'}`}>
        <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Loading...</div>}>
          {tab === 'agents' && (
            <AgentPanel
              enabled
              onNavigateToTopic={onNavigateToTopic}
              onMessage={onMessage}
            />
          )}
          {tab === 'activity' && <ActivityFeedPanel enabled />}
          {tab === 'journal' && <JournalPanel enabled />}
          {tab === 'cron' && <CronJobsPanel enabled />}
          {tab === 'remote' && <RemoteAccessPanel enabled />}
          {tab === 'system' && <SystemStatusPanel enabled />}
          {tab === 'browser' && <BrowserSidebarControl enabled />}
        </Suspense>
      </div>
    </div>
  );
}
