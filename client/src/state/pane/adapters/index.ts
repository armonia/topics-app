/**
 * Barrel for the pane-store adapter layer.
 *
 * Everything outside state/pane/ that needs a helper tied to pane state
 * imports from this module. After the Phase-30 cutover the adapters hold
 * only code that can't live inside the pure Immer reducer — side effects
 * (terminal session re-issue, timer maps), projections to view-model
 * shapes, and React hooks.
 */

// Non-hook adapters (pure helpers + reducer-backed side-effects).
export * from './paneConfig';
export * from './closedTabRecord';
export * from './projectLayoutSync';
export * from './terminalLocator';
export * from './browserOriginStore';
export { clampScrollOffset } from './scrollOffset';

// Hook adapters (React wrappers around usePaneStore selectors).
export { loadPanelOrder } from './hooks/usePanelOrder';
export { useClosedTabs } from './hooks/useClosedTabs';

