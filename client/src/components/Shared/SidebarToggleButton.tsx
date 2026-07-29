import { PanelLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';

interface SidebarToggleButtonProps {
  onClick: (e?: React.MouseEvent) => void;
  /** 'sm' = 28px (w-7 h-7), 'md' = 32px (w-8 h-8). Default: 'md' */
  size?: 'sm' | 'md';
  title?: string;
  className?: string;
  /** Override the default PanelLeft icon */
  icon?: LucideIcon;
}

/**
 * Shared sidebar toggle button — used for main sidebar + project sidebar.
 * Ensures consistent icon, size, and styling across all layouts.
 */
export function SidebarToggleButton({
  onClick,
  size = 'md',
  title = 'Toggle sidebar',
  className = '',
  icon: Icon = PanelLeft,
}: SidebarToggleButtonProps) {
  const dim = size === 'sm' ? 'w-7 h-7' : 'w-8 h-8';
  const iconSize = size === 'sm' ? 14 : 16;

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      className={`${dim} flex items-center justify-center rounded hover:bg-app-hover text-app-text-secondary transition-colors app-no-drag flex-shrink-0 ${className}`} {...NO_DRAG_REGION}
      title={title}
      aria-label={title}
    >
      <Icon size={iconSize} />
    </button>
  );
}
