/**
 * The title of a cell in a split, with the tabs at the side (SPLIT-03).
 *
 * With the strip gone, a split cell said neither what it held nor whether it
 * had the focus, and its layout commands hid in a long-press sheet. Inside a
 * split the title now does three things a tab did: it carries the cell's
 * name lit when the cell has the focus, it drags like the tab of the pane in
 * front, and it offers the two commands a split cell needs at hand — zoom,
 * and back into the main panel. Outside a split nothing changes.
 */
import { Combine, Maximize2, Minimize2 } from 'lucide-react';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { ROW_ACTION_BOX } from '../../lib/selectionStyles';
import { useT } from '../../hooks/useT';
import type { ZoomScope } from './zoomScope';

const ICON_BUTTON = `${ROW_ACTION_BOX} flex-shrink-0 flex items-center justify-center rounded-md text-app-text-muted hover:text-app-text hover:bg-app-hover app-no-drag`;

export function CellHeaderCommands({
  paneId, canZoom, isZoomed, onToggleZoom, onReattach,
}: {
  paneId: string;
  canZoom?: boolean;
  isZoomed?: boolean;
  onToggleZoom?: (paneId: string, scope: ZoomScope) => void;
  /** Back into the main panel; absent for the main panel itself. */
  onReattach?: (paneId: string) => void;
}) {
  const t = useT();
  const zoomable = !!onToggleZoom && (!!isZoomed || !!canZoom);
  if (!zoomable && !onReattach) return null;
  return (
    <div className="flex items-center gap-0.5 app-no-drag" {...NO_DRAG_REGION} data-testid="cell-header-commands">
      {zoomable && (
        <button
          type="button"
          className={ICON_BUTTON}
          title={t(isZoomed ? 'tab.menu.unzoom' : 'tab.menu.zoom')}
          aria-label={t(isZoomed ? 'tab.menu.unzoom' : 'tab.menu.zoom')}
          data-testid="cell-header-zoom"
          onClick={() => onToggleZoom?.(paneId, 'derived')}
        >
          {isZoomed ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      )}
      {onReattach && !isZoomed && (
        <button
          type="button"
          className={ICON_BUTTON}
          title={t('tab.reattach')}
          aria-label={t('tab.reattach')}
          data-testid="cell-header-reattach"
          onClick={() => onReattach(paneId)}
        >
          <Combine size={14} />
        </button>
      )}
    </div>
  );
}
