/**
 * The lit edge of a split cell's title (SPLIT-03). Its drag is the real tab's
 * now (`PaneTabBar` as the title, 25/11). Kept apart from CellHeader.tsx so
 * that file exports components only.
 */
import type React from 'react';

/** The lit edge of the cell with the focus: an inset line under its title, so
 *  the bar keeps its height and nothing moves when the focus changes. */
export const FOCUSED_CELL_EDGE: React.CSSProperties = { boxShadow: 'inset 0 -2px 0 var(--primary)' };
