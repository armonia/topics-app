/**
 * Layout constants — shared between PanelGrid (top-level) and GroupLayout
 * (project-window). Centralized so a tweak in one place propagates
 * everywhere instead of drifting.
 */

/** Max columns within a single grid row. Beyond this, splits/drops are rejected. */
export const MAX_COLS_PER_ROW = 4;

/** Max top-level rows. Beyond this, top/bottom edge drops are rejected. */
export const MAX_ROWS = 4;

/** Max depth of a per-cell vertical sub-stack (split-down within a column). */
export const MAX_STACK_DEPTH = 4;

/**
 * Pixel distance from a cell's edge that counts as the edge drop zone.
 * Anything inside this band on dragover triggers a left/right/top/bottom
 * split intent; the rest of the cell is the 'center' (tab reorder / merge).
 */
export const EDGE_DROP_PX = 30;
