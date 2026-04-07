import { memo } from 'react';
import { Search, List, LayoutGrid, Archive } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SidebarViewMode } from '@/hooks/useSidebarState';

interface SidebarControlsProps {
  onOpenCommandPalette: () => void;
  viewMode: SidebarViewMode;
  onToggleViewMode: () => void;
  showArchived: boolean;
  onToggleArchived: () => void;
}

export const SidebarControls = memo(function SidebarControls({
  onOpenCommandPalette,
  viewMode,
  onToggleViewMode,
  showArchived,
  onToggleArchived,
}: SidebarControlsProps) {
  return (
    <div className="px-2 py-2 flex-shrink-0 flex items-center gap-1.5">
      {/* Search — opens command palette */}
      <button
        onClick={onOpenCommandPalette}
        className="flex-1 min-w-0 flex items-center gap-2 pl-2.5 pr-2 py-1.5 text-[13px] bg-transparent border border-app-border rounded-md text-app-placeholder hover:border-primary/50 hover:text-app-text-muted transition-colors cursor-pointer"
        aria-label="Open command palette"
      >
        <Search size={14} className="text-app-text-tertiary flex-shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left truncate">Search...</span>
        <kbd className="kbd flex-shrink-0">&#8984;K</kbd>
      </button>

      {/* View mode toggle */}
      <button
        onClick={onToggleViewMode}
        className={cn(
          'flex-shrink-0 w-7 h-7 flex items-center justify-center rounded transition-colors',
          'hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text'
        )}
        title={viewMode === 'timeline' ? 'Switch to grouped view' : 'Switch to timeline view'}
        aria-label={viewMode === 'timeline' ? 'Switch to grouped view' : 'Switch to timeline view'}
      >
        {viewMode === 'timeline' ? <LayoutGrid size={14} /> : <List size={14} />}
      </button>

      {/* Archive toggle */}
      <button
        onClick={onToggleArchived}
        className={cn(
          'flex-shrink-0 w-7 h-7 flex items-center justify-center rounded transition-colors',
          showArchived
            ? 'text-primary bg-primary/10'
            : 'hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text'
        )}
        title={showArchived ? 'Hide archived' : 'Show archived'}
        aria-label={showArchived ? 'Hide archived items' : 'Show archived items'}
      >
        <Archive size={14} />
      </button>
    </div>
  );
});
