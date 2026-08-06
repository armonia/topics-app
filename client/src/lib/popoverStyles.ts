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
 */

/**
 * Stacking scale for floating surfaces. Tokenised so no call-site writes a
 * literal `z-[9999]` for a popover again, and so the ordering is stated in ONE
 * place: context-menus and dropdowns share a plane (they never coexist over the
 * same spot), and modals/palettes sit above them. The mobile bottom-sheet scrim
 * sits just under its sheet.
 *
 * Values are deliberately high (9998–10000) to clear the app's ad-hoc `z-[100]`
 * chrome; a popover must float over everything except a modal.
 *
 * «Except a modal» era FALSO fino al 2026-08-06, ed è per questo che ⌘N
 * sembrava aprire tutti i dropdown insieme: le palette a schermo intero
 * (⌘N, ⌘K, il pannello scorciatoie) scrivevano `z-[60]` a mano, cioè
 * DUEMILA volte sotto un popover a 9999. Entrambi figli di `document.body`,
 * stesso stacking context: il dropdown già aperto si disegnava nitido sopra
 * la palette E sopra il suo velo scuro. `Z_MODAL` chiude il buco — nessuna
 * superficie modale deve più scriversi uno z-index a mano.
 */
/**
 * Viewport inset every floating surface must stay within. It is the default of
 * `computeMenuPosition` (lib/popoverPosition.ts); exported here so the popovers
 * that position themselves by hand clamp to the SAME edge instead of each
 * inventing a number (or, as several did, not clamping at all and running off
 * the screen).
 */
export const POPOVER_MARGIN = 8;

export const Z_POPOVER = 9999;
export const Z_CONTEXT_MENU = 9999; // same plane as popovers, by design
export const Z_POPOVER_SCRIM = 9998; // mobile bottom-sheet backdrop, just under the sheet
/** Palette e dialoghi a schermo intero: SOPRA ogni popover, per definizione. */
export const Z_MODAL = 10000;

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

/**
 * Variante a bersaglio TOUCH: identica a `POPOVER_ITEM` tranne la riga più alta
 * sotto i 768px (`py-3` invece di `py-2`). Serve ai menu che si aprono anche
 * come foglio sul telefono, dove 8px di padding fanno un bersaglio da ~30px —
 * sotto la soglia di un dito. Era una copia locale in `PaneAddMenu`, con la
 * divergenza NON dichiarata: chi leggeva `POPOVER_ITEM` credeva che tutte le
 * righe fossero uguali, e non lo erano.
 */
export const POPOVER_ITEM_TOUCH =
  'w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-left text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors';

/** Destructive variant of POPOVER_ITEM (delete / clear / discard). */
export const POPOVER_ITEM_DANGER =
  'w-full flex items-center gap-2 px-3 py-2 md:py-1.5 text-left text-[14px] md:text-[12px] text-red-600 dark:text-red-400 hover:bg-red-600/10 transition-colors';

/** Hairline separator between menu groups. */
export const POPOVER_DIVIDER = 'my-1 h-px bg-app-border';

/**
 * Mobile bottom-sheet variant (DropdownPortal's mobile path): pinned to the
 * bottom edge, only the top corners rounded, top border only. Combine with the
 * call site's safe-area padding.
 */
export const POPOVER_SHEET =
  'glass-surface border-t border-app-border rounded-t-xl shadow-lg py-2 bottom-sheet';
