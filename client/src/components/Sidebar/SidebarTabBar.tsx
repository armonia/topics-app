import { Cpu, Activity, BookOpen, Clock, Radio, Server, Globe, type LucideIcon } from 'lucide-react';
import type { SidebarTab } from '@/types';

interface TabDef {
  id: SidebarTab;
  icon: LucideIcon;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'agents', icon: Cpu, label: 'Agents' },
  { id: 'activity', icon: Activity, label: 'Activity' },
  { id: 'journal', icon: BookOpen, label: 'Journal' },
  { id: 'cron', icon: Clock, label: 'Cron Jobs' },
  { id: 'remote', icon: Radio, label: 'Remote Access' },
  { id: 'system', icon: Server, label: 'System Status' },
  { id: 'browser', icon: Globe, label: 'Browser' },
];

interface SidebarTabBarProps {
  activeTab: SidebarTab | null;
  onTabChange: (tab: SidebarTab | null) => void;
  badges?: Partial<Record<SidebarTab, number | boolean>>;
}

export function SidebarTabBar({ activeTab, onTabChange, badges = {} }: SidebarTabBarProps) {
  return (
    <div className="flex items-center h-9 border-t border-app-border flex-shrink-0 bg-surface">
      {TABS.map(({ id, icon: Icon, label }) => {
        const isActive = activeTab === id;
        const badge = badges[id];

        return (
          <button
            key={id}
            onClick={() => onTabChange(isActive ? null : id)}
            className={`flex-1 flex items-center justify-center gap-1 h-full relative transition-colors ${
              isActive
                ? 'text-primary bg-primary/10'
                : 'text-app-text-tertiary hover:text-app-text-secondary hover:bg-app-hover'
            }`}
            title={label}
            aria-label={label}
            aria-pressed={isActive}
          >
            <Icon size={14} strokeWidth={1.5} />
            {/* Badge */}
            {badge !== undefined && badge !== false && badge !== 0 && (
              typeof badge === 'boolean' ? (
                <span className="absolute top-1.5 right-1/2 translate-x-3 w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              ) : (
                <span className="absolute -top-0.5 right-1/2 translate-x-4 text-[9px] text-white bg-primary px-1 rounded-full min-w-[14px] text-center leading-[14px]">
                  {badge > 99 ? '99+' : badge}
                </span>
              )
            )}
          </button>
        );
      })}
    </div>
  );
}
