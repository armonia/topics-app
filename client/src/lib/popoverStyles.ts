/**
 * popoverStyles — ONE canonical look for every floating MENU / DROPDOWN /
 * POPOVER / CONTEXT-MENU surface in the app. The sibling of:
 *   - lib/modalStyles.ts     → centered dialogs / modal windows
 *   - lib/selectionStyles.ts → the "selected" surface
 *
 * Before this module each menu hand-rolled its own radius (rounded-md vs
 * rounded-lg vs rounded-xl), shadow (shadow-lg vs shadow-xl) and border token
 * (border-app-border vs -light vs -input), so the browser menus, the chat
 * menus and the context menus all read as visibly different surfaces. The
 * worst offenders were the browser dropdowns (rounded-md + shadow-xl) — which
 * is exactly the divergence this module removes. Importing from here keeps
 * every popover in lockstep, the same precedent modalStyles set for dialogs.
 *
 * The canonical popover is a frosted `glass-surface` card: it floats over
 * OPAQUE content panes (unlike the window chrome, whose blur comes from native
 * vibrancy) so it carries its OWN backdrop-blur via `.glass-surface`. Hairline
 * `border-app-border`, soft 8px radius (`rounded-lg`), and `shadow-lg` for a
 * gentle lift that doesn't read as a heavy modal.
 *
 * Native (Electron) menus rendered above the OS-level WebContentsView use the
 * overlay window (electron-app/overlay.html); its CSS mirrors these same tokens
 * (radius / shadow / translucency) so the native browser menus match the React
 * popovers pixel-for-pixel.
 */

/**
 * The floating panel itself, for menus whose container ALSO provides its own
 * `py-1` vertical rhythm around a list of items (dropdowns, context menus).
 * Add positioning (absolute/fixed + coords), `min-w-*` and `z-*` per call site.
 */
export const POPOVER_SURFACE =
  'glass-surface border border-app-border rounded-lg shadow-lg py-1';

/**
 * Same surface WITHOUT the `py-1` list padding, for panels that manage their
 * own internal layout (a header + scroll body, custom grids, search fields):
 * the console panel, the model picker, the slash-command menu, etc.
 */
export const POPOVER_PANEL =
  'glass-surface border border-app-border rounded-lg shadow-lg';

/**
 * A standard menu row: icon + label, touch-friendly on mobile, compact on
 * desktop. Matches the prevailing item rhythm already used by DropdownPortal /
 * PaneAddMenu so existing menus don't shift when adopting it.
 */
export const POPOVER_ITEM =
  'w-full flex items-center gap-2 px-3 py-2 md:py-1.5 text-left text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors';

/** Destructive variant of POPOVER_ITEM (delete / clear / discard). */
export const POPOVER_ITEM_DANGER =
  'w-full flex items-center gap-2 px-3 py-2 md:py-1.5 text-left text-[14px] md:text-[12px] text-red-600 dark:text-red-400 hover:bg-red-600/10 transition-colors';

/** Hairline separator between menu groups. */
export const POPOVER_DIVIDER = 'my-1 h-px bg-app-border';

/** Small uppercase section label inside a menu. */
export const POPOVER_SECTION_LABEL =
  'px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-app-text-faint';

/**
 * Mobile bottom-sheet variant (DropdownPortal's mobile path): pinned to the
 * bottom edge, only the top corners rounded, top border only. Combine with the
 * call site's safe-area padding.
 */
export const POPOVER_SHEET =
  'glass-surface border-t border-app-border rounded-t-xl shadow-lg py-2 bottom-sheet';

/**
 * Theme colours for the NATIVE Electron overlay menu (overlay.html reads these
 * via CSS vars). Lifted here so every native-menu caller — PaneAddMenu AND the
 * browser toolbar via lib/overlayMenu.ts — passes the SAME themed palette
 * instead of the overlay falling back to a hardcoded white panel (which made
 * the browser's native menus look unthemed next to the rest). Reads the live
 * CSS custom properties off <html> so custom themes are honoured too.
 *
 * The bg is the OPAQUE `--bg-surface`: a transparent Electron overlay window
 * can't reliably backdrop-blur the WebContentsView behind it, so we keep the
 * native panel opaque-but-themed (radius/shadow/colours matched in overlay.html)
 * rather than risk an unfrosted see-through panel over busy page content.
 */
export function overlayThemeColors(): {
  bg: string;
  text: string;
  muted: string;
  border: string;
  hover: string;
} {
  const isDark = document.documentElement.classList.contains('dark');
  const cs = getComputedStyle(document.documentElement);
  const cssVar = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: cssVar('--bg-surface', isDark ? '#1f2937' : '#ffffff'),
    text: cssVar('--text', isDark ? '#e5e7eb' : '#1a1a1a'),
    muted: cssVar('--text-muted', isDark ? '#9ca3af' : '#6b7280'),
    border: cssVar('--border', isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'),
    hover: cssVar('--bg-hover', isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'),
  };
}
