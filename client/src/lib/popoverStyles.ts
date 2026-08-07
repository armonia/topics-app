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
 * A standard menu row: icon + label. 44px alti sotto i 768px — la misura di un
 * dito secondo le linee guida iOS — e compatti (~24px) da tablet in su, dove
 * c'è un puntatore.
 *
 * I 44px erano l'ECCEZIONE, ed è il difetto che questa riga chiude: il default
 * era `py-2`, cioè 36px sul telefono, e la variante giusta (`POPOVER_ITEM_TOUCH`,
 * `py-3`) era usata da UN file su 49. Quarantotto menu su quarantanove si
 * toccavano male, e chi leggeva `POPOVER_ITEM` non aveva modo di sospettarlo.
 * Adesso l'eccezione è il default e la variante è solo un alias.
 *
 * NB — un menu con TANTE voci non si rimette in riga togliendogli i 44px: gli si
 * dà un tetto e lo scroll (`max-height` + `overflow-y-auto`), come fa il menu
 * della tab in `PaneTabBar`. Rimpicciolire le righe sposta il problema di
 * qualche voce e rompe il bersaglio per tutti gli altri menu.
 */
export const POPOVER_ITEM =
  'w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-left text-[14px] md:text-[12px] text-app-text hover:bg-app-hover transition-colors';

/**
 * @deprecated Alias di {@link POPOVER_ITEM}, che ORA è già a bersaglio touch.
 *
 * Restava come classe a sé quando il default era più basso; da quando i 44px
 * sono il default, tenerne due copie identiche è solo un modo per farle
 * divergere di nuovo. Sopravvive per non rompere il suo unico call-site
 * (`Shared/PaneAddMenu.tsx`): quando quello passa a `POPOVER_ITEM`, questa riga
 * si cancella.
 */
export const POPOVER_ITEM_TOUCH = POPOVER_ITEM;

/**
 * Le due coppie di testo colorato che passano AA su ENTRAMBI i fondi.
 *
 * Non si scrivono a mano nei call-site: il gradino giusto NON è lo stesso nei
 * due temi, e chi ne sceglie uno solo sbaglia sempre metà dei casi. Misurato
 * sui fondi veri — il vetro chiaro di macOS (#f2f3f6), il fondo popover
 * (#f0f1f4), la superficie scura (#181a20):
 *
 *   red-400   2,56 chiaro · 4,97 scuro   → giusto SOLO al buio
 *   red-500   3,37 · 3,77                → sotto in tutt'e due
 *   red-600   4,22 · 3,01                → sotto in tutt'e due (era questo qui)
 *   red-700   5,69 · 2,71                → giusto SOLO in chiaro
 *   amber-400 1,53 · 8,34                → giusto SOLO al buio
 *   amber-700 4,45 · 2,86                → chiaro per un pelo SOTTO il 4,5
 *   amber-800 6,28 · 2,03                → giusto in chiaro
 *
 * Quindi: 700/800 in chiaro, 400 al buio. La soglia è 4,5:1, che è quella del
 * testo normale — questi sono 11-12px, non testo grande.
 */
export const DANGER_TEXT = 'text-red-700 dark:text-red-400';
export const WARNING_TEXT = 'text-amber-800 dark:text-amber-400';

/** Destructive variant of POPOVER_ITEM (delete / clear / discard). Stesso ritmo
 *  verticale del suo fratello non distruttivo: se divergessero, un menu con una
 *  voce rossa avrebbe una riga più bassa delle altre. */
export const POPOVER_ITEM_DANGER =
  `w-full flex items-center gap-2 px-3 py-3 md:py-1.5 text-left text-[14px] md:text-[12px] ${DANGER_TEXT} hover:bg-red-600/10 transition-colors`;

/** Hairline separator between menu groups. */
export const POPOVER_DIVIDER = 'my-1 h-px bg-app-border';

/**
 * Mobile bottom-sheet variant (DropdownPortal's mobile path): pinned to the
 * bottom edge, only the top corners rounded, top border only. Combine with the
 * call site's safe-area padding.
 */
export const POPOVER_SHEET =
  'glass-surface border-t border-app-border rounded-t-xl shadow-lg py-2 bottom-sheet';
