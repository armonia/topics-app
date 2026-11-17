import { PanelLeft } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { ROW_ACTION_BOX } from '../../lib/selectionStyles';

interface SidebarToggleButtonProps {
  onClick: (e?: React.MouseEvent) => void;
  /** 'sm' = 28px (w-7 h-7), 'md' = 32px (w-8 h-8), 'action' = la misura
   *  CONDIVISA dei comandi di riga (`ROW_ACTION_BOX`: 28 col mouse, 36 col
   *  dito). Default: 'md'.
   *
   *  `'action'` esiste per il bottone che RIAPRE la colonna: sta da solo in un
   *  angolo, accanto a niente, ed era l'unico comando dell'app con una misura
   *  sua — «fai il tasto di apertura sidebar grande quanto quello di aggiunta
   *  tab». Prendendola dalla costante non può più divergere da lui. */
  size?: 'sm' | 'md' | 'action';
  title?: string;
  className?: string;
  /** Override the default PanelLeft icon */
  icon?: LucideIcon;
  /** Stable hook for tests, and the only one this button has: everything else
   *  it carries is `title`/`aria-label`, whose value is COPY — translated, so a
   *  locator built on it dies the day the catalogue moves. Defaults to
   *  `sidebar-toggle`; the button that REOPENS the column passes its own, so
   *  the two are told apart when both are on screen. That case is not
   *  hypothetical: LAYOUT-35 asserts the reopen command stays reachable while a
   *  cell is zoomed, and it lives inside the frame (D6). */
  testId?: string;
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
  testId = 'sidebar-toggle',
}: SidebarToggleButtonProps) {
  const dim = size === 'action' ? ROW_ACTION_BOX : size === 'sm' ? 'w-7 h-7' : 'w-8 h-8';
  const iconSize = size === 'md' ? 16 : 14;

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      className={`${dim} flex items-center justify-center rounded hover:bg-app-hover text-app-text-secondary transition-colors app-no-drag flex-shrink-0 ${className}`} {...NO_DRAG_REGION}
      title={title}
      aria-label={title}
      data-testid={testId}
    >
      <Icon size={iconSize} />
    </button>
  );
}
