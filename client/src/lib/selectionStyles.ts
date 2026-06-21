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

/**
 * The RESTING state of the same card grammar: an interactive surface that is
 * not selected (an inactive tab, a sidebar header button). One step quieter
 * than SELECTED_SURFACE_SOFT at rest, raising on hover. Extracted from the
 * tab bar's inline classes (PaneTabBar) so the sidebar header's Search / Add
 * buttons read as the exact same family of controls as the tabs.
 */
export const RESTING_SURFACE =
  'bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08]';

/**
 * Blue "awaiting feedback" wash — a chat whose Claude session is parked waiting
 * for YOU (awaiting-user / -approval / paused). NOT selection (which is neutral)
 * and NOT loading (the blue spinner): it's a translucent fill painted as an
 * absolute overlay OVER the tab/row content, mirroring PaneTabPendingOverlay, so
 * it coexists with SELECTED_SURFACE underneath without clobbering its bg. Shared
 * by the tab bar AND the sidebar row so the two surfaces can't drift. Pair it
 * with `animate-awaiting-pulse` (index.css) for the gentle 2s breathe.
 *
 * NB: loading (running/tool-running) and awaiting are mutually exclusive in
 * time, so this blue fill never shows at the same instant as the blue spinner.
 */
export const AWAITING_FEEDBACK_FILL =
  'bg-primary/12 dark:bg-primary/22 ring-1 ring-inset ring-primary/30';

/**
 * Canonical horizontal padding for a "row of content" — a tab-bar tab AND a
 * sidebar row — so the content inset reads identically on both surfaces. Tabs
 * used to be `px-2.5` (10px) while every sidebar row is `px-2` (8px), which made
 * the tabs look roomier on the left and right than the rows beneath them. One
 * shared value keeps them in lockstep; change it here and both surfaces move
 * together. (The sidebar PROJECT header is the one intentional exception — it
 * tightens its LEFT padding so the accordion chevron sits closer to the edge,
 * but keeps this value on the right so the trailing loaders stay aligned.)
 */
export const ROW_PX = 'px-2';

/**
 * The single horizontal inset (px) of a list of tabs/rows from its panel edge —
 * SHARED by the sidebar AND the tab bar so the two lists line up at the sides
 * AND so a list item's side gap equals a tab's TOP/BOTTOM gap (the spacing reads
 * the same horizontally and vertically). 6px = the vertical breathing room
 * around a tab in the tab bar: the chrome row is 40px tall, a tab is 28px, so
 * (40 − 28) / 2 = 6px above and below each tab. Matching that exactly is why it
 * is 6 and not the old 4 (`py-1`, which is only part of that gap) or 8.
 * Used as: the sidebar card's edge margin (the `mx-1.5` class in `sidebarRowCard`
 * is its class-equivalent), the depth-0 base for sidebar row indentation, and
 * the tab strip's left/right padding (PaneTabBar). Keep them all in step here.
 */
export const ROW_INSET = 6;
/** Indent added per nesting level for sidebar child rows (px). */
export const SIDEBAR_INDENT_STEP = 16;

/**
 * Shared "card" styling for EVERY sidebar row (topics, terminals, browsers,
 * project folders) so the sidebar reads as a column of tab-like cards — the
 * same visual language as the tab bar — instead of a flat list separated by
 * hairline dividers. Deliberately NO border: between stacked rows a border's
 * top+bottom hairlines read as dividing LINES, the exact thing we're removing.
 * A filled, inset, rounded surface is what makes each row a self-contained card.
 *
 * Pass the row's selection state; returns the full set of state classes. Each
 * caller keeps its own height / padding-left (depth indent) / content.
 */
export function sidebarRowCard({ focused, open }: { focused?: boolean; open?: boolean }): string {
  // Card SHAPE (rounded, inset, spaced) is always on; the FILL follows the old
  // color system — background only when selected (SELECTED_SURFACE) or on hover.
  // At rest the card is transparent, so the sidebar stays calm and only the
  // current/hovered row reads as a filled tab.
  // Horizontal inset (mx-1.5 = 6px = ROW_INSET) keeps the card off the
  // sidebar edges by the SAME amount as a tab's top/bottom gap in the tab bar
  // ((40 − 28)/2), so the side gap reads identical to the vertical one. The
  // VERTICAL rhythm matches the tab bar's tight tab gap (gap-0.5 = 2px) — a
  // small my-px so adjacent cards sit close like tabbar tabs, not spread out.
  const base = 'mx-1.5 my-px rounded-lg overflow-hidden transition-colors duration-100 relative';
  if (focused) return `${base} ${SELECTED_SURFACE}`;
  if (open) return `${base} text-app-text hover:bg-app-hover`;
  return `${base} text-app-text-secondary hover:bg-app-hover hover:text-app-text`;
}
