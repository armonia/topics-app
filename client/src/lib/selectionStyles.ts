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
  // Horizontal inset (mx-2 = 8px) keeps the card off the sidebar edges; the
  // VERTICAL rhythm matches the tab bar's tight tab gap (gap-0.5 = 2px) — a
  // small my-px so adjacent cards sit close like tabbar tabs, not spread out.
  const base = 'mx-2 my-px rounded-lg overflow-hidden transition-colors duration-100 relative';
  if (focused) return `${base} ${SELECTED_SURFACE}`;
  if (open) return `${base} text-app-text hover:bg-app-hover`;
  return `${base} text-app-text-secondary hover:bg-app-hover hover:text-app-text`;
}
