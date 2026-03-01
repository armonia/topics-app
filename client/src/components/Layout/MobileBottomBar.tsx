import { memo } from 'react';
import { PanelLeft, Plus, MessageSquare, Globe, Terminal, FolderTree, Cpu, Activity, BookOpen, BarChart3, Kanban, Code2 } from 'lucide-react';
import type { Pane } from '../../types';
import { useKeyboardVisible } from '../../hooks/useKeyboardVisible';
import { PANE_CONFIG } from '../../lib/paneConfig';
import { haptic } from '../../hooks/useMobile';

const ICONS: Record<string, React.FC<{ size: number; className?: string }>> = {
  MessageSquare, FolderTree, Globe, Terminal, Activity, BookOpen, Cpu, BarChart3, Kanban,
};

interface MobileBottomBarProps {
  panes: Pane[];
  activePaneId: string | null;
  onActivate: (paneId: string) => void;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  streamingPaneIds?: Set<string>;
}

export const MobileBottomBar = memo(function MobileBottomBar({
  panes,
  activePaneId,
  onActivate,
  onToggleSidebar,
  onNewChat,
  streamingPaneIds,
}: MobileBottomBarProps) {
  const keyboardVisible = useKeyboardVisible();

  if (keyboardVisible) return null;

  return (
    <div
      className="flex items-center h-12 bg-surface border-t border-app-border px-1 gap-0.5 flex-shrink-0 lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      {/* Sidebar toggle */}
      {onToggleSidebar && (
        <button
          onClick={() => { haptic('light'); onToggleSidebar(); }}
          className="w-11 h-11 flex items-center justify-center rounded-lg text-app-text-secondary active:bg-app-hover transition-colors flex-shrink-0"
          aria-label="Toggle sidebar"
        >
          <PanelLeft size={20} />
        </button>
      )}

      {/* Tabs - scrollable */}
      <div
        className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto scrollbar-none"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {panes.map((pane) => {
          const config = PANE_CONFIG[pane.type];
          const Icon = ICONS[config.icon] || MessageSquare;
          const isActive = activePaneId === pane.id;
          const isStreaming = streamingPaneIds?.has(pane.id);

          return (
            <button
              key={pane.id}
              onClick={() => { haptic('light'); onActivate(pane.id); }}
              className={`relative flex items-center justify-center w-11 h-11 rounded-lg transition-colors duration-150 flex-shrink-0 ${
                isActive
                  ? 'bg-primary/15 text-primary'
                  : 'text-app-text-secondary active:bg-app-hover'
              }`}
              aria-label={pane.title || config.label}
              title={pane.title || config.label}
            >
              <Icon size={18} className={isStreaming ? 'animate-pulse' : ''} />
              {/* Active indicator dot */}
              {isActive && (
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
              )}
              {/* Color dot for project panes */}
              {pane.color && (
                <span
                  className="absolute top-1 right-1 w-2 h-2 rounded-full"
                  style={{ backgroundColor: pane.color }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* New chat button */}
      {onNewChat && (
        <button
          onClick={() => { haptic('light'); onNewChat(); }}
          className="w-11 h-11 flex items-center justify-center rounded-lg text-app-text-secondary active:bg-app-hover transition-colors flex-shrink-0"
          aria-label="New chat"
        >
          <Plus size={20} />
        </button>
      )}
    </div>
  );
});
