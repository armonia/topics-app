/**
 * Canonical "selected / current" surface — ONE neutral raised-card look shared
 * by the tab bar (the focused tab) and the sidebar (the focused row/folder), so
 * selection reads identically on both surfaces.
 *
 * Deliberately NEUTRAL (no blue/green tint, no coloured accent bar): the old
 * primary-blue sidebar highlight read as "random" next to near-invisible tabs.
 * Now the focused thing looks the same everywhere — a subtly raised card.
 *
 * Tabs are rounded pills and add their own `rounded-md`; sidebar rows apply
 * these classes full-width. The shared part is the fill + ring + shadow + text.
 */
// A clean FILL only — no ring/shadow. On full-width sidebar rows a ring+shadow
// bled onto neighbours (focused folder + its active child read as "overlapping"
// rows), and made merely-open rows look selected. A single solid fill is
// unambiguous and never collides with an adjacent row.
export const SELECTED_SURFACE =
  'bg-black/[0.06] dark:bg-white/[0.14] text-app-text';

/**
 * Softer sibling of SELECTED_SURFACE: a tab that is the active one in a SPLIT
 * group that doesn't currently own focus. Visible within its group, but clearly
 * a step below the focused surface so only ONE thing reads as "current".
 */
export const SELECTED_SURFACE_SOFT =
  'bg-black/[0.03] dark:bg-white/[0.06] text-app-text-secondary';
