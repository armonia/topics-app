/**
 * Layout constants — shared between PanelGrid (top-level) and GroupLayout
 * (project-window). Centralized so a tweak in one place propagates
 * everywhere instead of drifting.
 */

// These are NOT a product limit on how many panes you can tile — they're a
// runaway backstop only (a buggy loop / agent shouldn't be able to spawn
// thousands of slivers). Set generously high so real use never hits them; the
// MIN_PANE_FRACTION floor is what actually keeps panes usable, not a cell count.

/** Max columns within a single grid row (runaway backstop, not a real limit). */
export const MAX_COLS_PER_ROW = 32;

/** Max top-level rows (runaway backstop, not a real limit). */
export const MAX_ROWS = 32;

/** Max depth of a per-cell vertical sub-stack (runaway backstop, not a real limit). */
export const MAX_STACK_DEPTH = 32;

/**
 * Pixel distance from a cell's edge that counts as the edge drop zone.
 * Anything inside this band on dragover triggers a left/right/top/bottom
 * split intent; the rest of the cell is the 'center' (tab reorder / merge).
 */
export const EDGE_DROP_PX = 30;

/**
 * Smallest fraction of a row/column a single pane may shrink to while dragging
 * a divider (and the floor for sub-stack slots). Single source of truth so the
 * resize hook and the vertical sub-stack share one minimum instead of drifting
 * (they previously used 0.10 and 0.05 independently).
 */
export const MIN_PANE_FRACTION = 0.1;

/**
 * Height of a group's tab-bar chrome row (Tailwind `h-10` = 2.5rem = 40px).
 *
 * The TOP full-width-row drop strip is offset by this on BOTH surfaces so it
 * clears the first row's tab bar instead of sitting on top of it. A strip with
 * `pointer-events: auto` over the bar swallows clicks and steals the tab-move
 * drops aimed at the bar: the project layout learned that first, and the
 * standalone grid was still paying it (a tab dropped on the first row's bar
 * landed in a new full-width row instead of that bar).
 */
export const TAB_BAR_H = 40;
