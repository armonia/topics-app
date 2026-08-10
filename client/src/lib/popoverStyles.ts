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
/**
 * Palette e dialoghi a schermo intero: SOPRA ogni popover, per definizione.
 *
 * È QUI che il piano dei modali è dichiarato, e da qui lo prende `MODAL_LAYER`
 * (`lib/modalStyles.ts`) — che è la forma con cui i modali lo usano davvero,
 * una classe Tailwind. Il legame è nel tipo di `MODAL_LAYER`, così cambiare
 * questo numero non compila finché non è cambiato anche là: prima erano due
 * letterali indipendenti tenuti insieme da un commento, ed è esattamente il
 * modo in cui `z-[60]` era finito 9939 sotto un dropdown.
 */
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
 * Una riga di menu: icona + etichetta. **45px dove c'è un dito**, 30px dove c'è
 * un puntatore.
 *
 * IL CANCELLO È IL DITO, NON LA LARGHEZZA. Era `md:`, cioè un test sui 768px
 * usato come sostituto della domanda vera, e le due cose non coincidono.
 * Misurato con queste classi sul CSS costruito:
 *
 *     390×844  (iPhone verticale)   → 45px   ✓
 *     844×390  (iPhone ORIZZONTALE) → 30px   ✗  stesso dito, riga da mouse
 *     820×1180 (iPad verticale)     → 30px   ✗  e qui `isMobile` è già true,
 *                                              cioè il foglio dal basso si apre
 *                                              col layout da telefono e le righe
 *                                              da mouse
 *     1440×900 (portatile)          → 30px   ✓
 *
 * Ora il gate è `coarse:` (`any-pointer: coarse`, dichiarata in index.css), che
 * è la stessa domanda che `useMobile.ts` fa con `isTouch` — e la sua regola,
 * scritta lì, è «affordance touch → isTouch». Il default torna a essere la riga
 * compatta e il dito è la variante: è il verso giusto, perché una riga da mouse
 * su un telefono è un errore, mentre una riga da dito su un desktop è solo
 * spazio sprecato.
 *
 * NB — un menu con TANTE voci non si rimette in riga togliendogli i 45px: gli si
 * dà un tetto e lo scroll (`max-height` + `overflow-y-auto`), come fa il menu
 * della tab in `PaneTabBar` e come ora fa il foglio dal basso in `Menu.tsx`.
 * Rimpicciolire le righe sposta il problema di qualche voce e rompe il bersaglio
 * per tutti gli altri menu.
 */
export const POPOVER_ITEM =
  'w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-left text-[12px] coarse:text-[14px] text-app-text hover:bg-app-hover transition-colors';


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

/**
 * Il verde dello stato «tutto a posto», misurato come i suoi fratelli — ma sul
 * fondo VERO, cioè col velo `/15` già steso sotto.
 *
 * Il velo è il punto. Un velo del 15% della stessa tinta sposta il fondo VERSO
 * il testo, quindi misurare su bianco puro conta un contrasto che a video non
 * c'è. Su questa scala la scelta ovvia sbaglia:
 *   green-600 su green-500/15  2,81 · 7,79   → il valore in uso, sotto di quasi la metà
 *   green-700 su green-500/15  4,32 · 7,79   → manca la soglia per un pelo
 *   green-800 su green-500/15  6,20 · 7,79   → giusto in entrambi i temi
 * Soglia 4,5:1: questi chip sono da 11px, cioè testo normale, non testo grande.
 */
export const SUCCESS_TEXT = 'text-green-800 dark:text-green-400';

/** Destructive variant of POPOVER_ITEM (delete / clear / discard). Stesso ritmo
 *  verticale del suo fratello non distruttivo: se divergessero, un menu con una
 *  voce rossa avrebbe una riga più bassa delle altre. */
export const POPOVER_ITEM_DANGER =
  `w-full flex items-center gap-2 px-3 py-1.5 coarse:py-3 text-left text-[12px] coarse:text-[14px] ${DANGER_TEXT} hover:bg-red-600/10 transition-colors`;

/** Hairline separator between menu groups. */
export const POPOVER_DIVIDER = 'my-1 h-px bg-app-border';

/**
 * Mobile bottom-sheet variant (DropdownPortal's mobile path): pinned to the
 * bottom edge, only the top corners rounded, top border only. Combine with the
 * call site's safe-area padding.
 */
export const POPOVER_SHEET =
  'glass-surface border-t border-app-border rounded-t-xl shadow-lg py-2 bottom-sheet';
