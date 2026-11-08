/**
 * What a surface hands to the sheet of one of its tabs (`TabSheet`).
 *
 * The callbacks are the ones the tab strip already receives from its host
 * (`PaneTabBarProps`): the sheet adds no new callback to any host, it only
 * gives the existing ones a place. A module of its own so the eager host and
 * the lazy body can share the shape without importing each other.
 */
import type { Pane } from '../../types';
import type { ZoomScope } from '../Layout/zoomScope';

/** Where the tab lives: the strip of a group, the topic's browser window, the phone title. */
export type TabSheetSurface = 'bar' | 'window' | 'title';

export interface TabSheetActions {
  panes: Pane[];
  activePaneId: string | null;
  onActivate?: (paneId: string) => void;
  onClose?: (paneId: string) => void;
  onCloseImmediate?: (paneId: string) => void;
  onCloseOthers?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onSplitDown?: (paneId: string) => void;
  onToggleZoom?: (paneId: string, scope: ZoomScope) => void;
  canZoom?: boolean;
  isZoomed?: boolean;
  onResetLayout?: () => void;
  canMoveToSpace?: boolean;
  onRenameChat?: (topicId: string, name: string) => void;
  onRenameBrowser?: (paneId: string, name: string) => void;
  onSettings?: (paneId: string) => void;
  onPopOut?: (paneId: string) => void;
  onPopOutGroup?: () => void;
  onStopStreaming?: (paneId: string) => void;
  onToggleFissato?: (pinKey: string) => void;
  isFissato?: (pinKey: string) => boolean;
  projectPinKey?: string;
  nonClosablePaneIds?: Set<string>;
  linkContext?: { projectPath?: string; taskId?: string };
  onOpenPaneInProject?: (paneId: string) => void;
  onDetach?: (paneId: string) => void;
  onReattach?: (paneId: string) => void;
}

/** A sheet of the topic's browser window: its two commands of its own. */
export interface TabSheetWindowActions {
  openAsTab: () => void;
  close: () => void;
}

export interface TabSheetTarget {
  pane: Pane;
  /** The name the tab shows. */
  label: string;
  surface: TabSheetSurface;
  /** The tab is the pane in front of the person. */
  focused: boolean;
  actions: TabSheetActions;
  window?: TabSheetWindowActions;
}
