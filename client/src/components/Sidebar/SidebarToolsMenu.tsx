import { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { Wrench, Cpu, Activity, BookOpen, Clock, Radio, Server, Globe, ExternalLink, ChevronRight, ChevronDown } from 'lucide-react';
import type { SidebarTab } from '@/types';

const CronJobsPanel = lazy(() => import('./CronJobsPanel').then(m => ({ default: m.CronJobsPanel })));
const RemoteAccessPanel = lazy(() => import('./RemoteAccessPanel').then(m => ({ default: m.RemoteAccessPanel })));
const SystemStatusPanel = lazy(() => import('./SystemStatusPanel').then(m => ({ default: m.SystemStatusPanel })));
const BrowserSidebarControl = lazy(() => import('../Browser/BrowserSidebarControl').then(m => ({ default: m.BrowserSidebarControl })));

const PAGES = [
  { id: 'activity' as const, icon: Activity, label: 'Activity' },
  { id: 'journal' as const, icon: BookOpen, label: 'Journal' },
  { id: 'agents' as const, icon: Cpu, label: 'Agents' },
];

const TOOLS: { id: SidebarTab; icon: typeof Clock; label: string }[] = [
  { id: 'cron', icon: Clock, label: 'Cron Jobs' },
  { id: 'remote', icon: Radio, label: 'Remote Access' },
  { id: 'system', icon: Server, label: 'System Status' },
  { id: 'browser', icon: Globe, label: 'Browser' },
];

interface SidebarToolsMenuProps {
  onOpenAsPage: (type: 'activity' | 'journal' | 'agents') => void;
  agentsBadge?: number | boolean;
}

export function SidebarToolsMenu({ onOpenAsPage, agentsBadge }: SidebarToolsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedTool, setExpandedTool] = useState<SidebarTab | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setExpandedTool(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setExpandedTool(null);
        e.stopPropagation();
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [isOpen]);

  const hasBadge = agentsBadge !== undefined && agentsBadge !== false && agentsBadge !== 0;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen); }}
        className="w-11 h-11 md:w-7 md:h-7 flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer relative"
        style={{ pointerEvents: 'auto' }}
        title="Tools"
        aria-label="Tools"
      >
        <Wrench size={14} />
        {hasBadge && (
          <span className="absolute top-0.5 right-0.5 md:top-0 md:right-0 w-2 h-2 rounded-full bg-primary" />
        )}
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-1 bg-surface border border-app-border rounded-lg shadow-lg z-50 min-w-[200px] max-h-[70vh] overflow-y-auto">
          {/* Pages section */}
          <div className="px-2 pt-2 pb-1">
            <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wider">Pages</span>
          </div>
          {PAGES.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => {
                onOpenAsPage(id);
                setIsOpen(false);
                setExpandedTool(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
            >
              <Icon size={14} strokeWidth={1.5} />
              <span className="flex-1 text-left">{label}</span>
              {id === 'agents' && hasBadge && typeof agentsBadge === 'number' && (
                <span className="text-[9px] text-white bg-primary px-1 rounded-full min-w-[14px] text-center leading-[14px]">
                  {agentsBadge > 99 ? '99+' : agentsBadge}
                </span>
              )}
              <ExternalLink size={10} className="text-app-text-muted flex-shrink-0" />
            </button>
          ))}

          <div className="border-t border-app-border my-1" />

          {/* Tools section */}
          <div className="px-2 pt-1 pb-1">
            <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wider">Tools</span>
          </div>
          {TOOLS.map(({ id, icon: Icon, label }) => {
            const isExpanded = expandedTool === id;
            return (
              <div key={id}>
                <button
                  onClick={() => setExpandedTool(isExpanded ? null : id)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors ${isExpanded ? 'bg-app-hover' : ''}`}
                >
                  <Icon size={14} strokeWidth={1.5} />
                  <span className="flex-1 text-left">{label}</span>
                  {isExpanded ? <ChevronDown size={12} className="text-app-text-muted" /> : <ChevronRight size={12} className="text-app-text-muted" />}
                </button>
                {isExpanded && (
                  <div className="border-t border-app-border/50 bg-black/[0.02] dark:bg-white/[0.02]">
                    <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Loading...</div>}>
                      <div className="max-h-[300px] overflow-y-auto">
                        {id === 'cron' && <CronJobsPanel enabled />}
                        {id === 'remote' && <RemoteAccessPanel enabled />}
                        {id === 'system' && <SystemStatusPanel enabled />}
                        {id === 'browser' && <BrowserSidebarControl enabled />}
                      </div>
                    </Suspense>
                  </div>
                )}
              </div>
            );
          })}
          <div className="h-1" />
        </div>
      )}
    </div>
  );
}
