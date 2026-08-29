import { PANE_TYPES, type PaneType } from '../state/pane/types';

/**
 * THE INVENTORY OF WHAT LIVES UNDER THE CHROME BAR, as data instead of prose.
 *
 * The tab bar is a pane of glass out of the flow (`.pane-chrome-bar`, index.css)
 * with no background of its own, so the question "what is under the labels" has
 * one answer per kind of pane. That answer used to be a paragraph inside
 * `paneCellBg.ts`: the chat passes under, the terminal and the native browser
 * pane and the dense tables do not, each for its own reason. A paragraph cannot
 * be checked, and "where possible" is an adjective until somebody writes down
 * the list it stands for.
 *
 * So the list is here, one entry per SURFACE FAMILY, and it carries three
 * things that used to be scattered:
 *
 *  - `cellBg` — the background tier of the layout cell. `paneCellBg()` is now a
 *    lookup into this table, not a second copy of the same decision.
 *  - `scrollsUnderChrome` — whether that surface's content really rises behind
 *    the glass, plus the reason it does not when it does not.
 *  - `contrast` — the WORST-CASE contrast of the tab labels over that surface,
 *    read off composited pixels. This is the part that makes an exception
 *    verifiable: a surface is not excluded because somebody decided it reads
 *    badly, it is excluded with a number next to it.
 *
 * WHAT THE NUMBERS MEAN, and why an excluded surface still has them. The method
 * is the same for everybody (`tests/e2e/helpers/chrome-contrast.ts`): sweep 14
 * scroll offsets over deliberately hostile content, capture the label rect,
 * separate glyph from ground with a coverage mask, keep the WORST reading. Two
 * quantities come out of it and they answer two different questions:
 *
 *  - the RATIO says whether the labels stay legible over that surface (the bar
 *    to clear is WCAG AA for text, 4.5:1);
 *  - the backdrop SPREAD across the sweep says whether anything moves under the
 *    glass at all. A spread at 0.0000 is not a hard backdrop, it is NO backdrop:
 *    it is exactly what an excluded surface should read, and it is exactly what
 *    the chat read for weeks while a wrapper was clipping the transcript away
 *    (see `.chrome-passthrough-y`). Same measurement, opposite expectation:
 *    that is why `scrollsUnderChrome` is the flag the spec asserts on.
 *
 * WHAT THE TABLE SAYS ONCE IT IS FILLED IN, and it was not obvious before the
 * numbers existed. The three excluded families read IDENTICALLY, to two
 * decimals, in both themes (9.00:1 dark, 15.54:1 light) even though their cells
 * paint three different tiers. That is not a broken measurement: with nothing
 * moving under the glass the label's local ground is its own tab chip in dark
 * and its halo in light (`text-shadow: var(--bg)`, index.css), so the tier
 * underneath barely reaches the glyph. The tier starts to matter exactly when
 * something SCROLLS under it, which is the chat, and the chat is the worst row
 * of this table (6.89:1 dark) rather than the best. The cost of the overlay is
 * paid by the one surface that gets the effect, and it is still half again over
 * the AA bar.
 *
 * The numbers below are the last recorded readings, dated, and they are
 * documentation. The live check is `tests/e2e/chrome-bar-surface-inventory.spec.ts`,
 * which reads THIS table as its matrix: adding a family here adds a measured
 * case there, and an entry that claims an exception with no probe fails loudly
 * instead of sitting in a comment nobody re-reads.
 */

/** The background tier a layout cell paints under a pane (Tailwind class, '' = transparent). */
export type CellBgTier = '' | 'pane-frost' | 'bg-surface';

/** WCAG 2.1 AA for body text. The bar every surface in this table has to clear. */
export const AA_TEXT = 4.5;

export interface SurfaceContrast {
  /** Worst-case ratio over the sweep, dark theme. */
  dark: number;
  /** Worst-case ratio over the sweep, light theme. */
  light: number;
  /**
   * Backdrop luminance spread across the sweep, per theme: how much the ground
   * under the labels MOVED. It is the numeric form of `scrollsUnderChrome`, and
   * the reason both numbers are recorded rather than a verdict: 0.0000 is what
   * an exception looks like, and it is also what a broken passthrough looked
   * like for weeks on the chat.
   */
  spreadDark: number;
  spreadLight: number;
  /** ISO day of the reading, so a number nobody re-measured says how old it is. */
  measuredOn: string;
  /** The spec that produced it and re-produces it. */
  measuredBy: string;
}

export interface ChromeBarSurface {
  /** Stable key of the family, used by the spec to name its cases. */
  id: string;
  /** Every pane type that behaves like this surface. The union is exhaustive. */
  paneTypes: readonly PaneType[];
  /** Cell background tier (see `paneCellBg`). */
  cellBg: CellBgTier;
  /**
   * Does this surface's own content rise BEHIND the glass? The cell inset is
   * the same for everybody (`paneCellTopInset`); what differs is whether the
   * content takes it back with a negative margin, and today only the chat
   * transcript does (`.chat-under-chrome:first-child`).
   */
  scrollsUnderChrome: boolean;
  /** Why it passes under, or why it is an exception. One sentence, no hedging. */
  why: string;
  /**
   * How the e2e sweep opens this surface: a pane-store seed id
   * (`terminal:<id>`, `browser:<id>`, `__dashboard__`, ...) or `runtime` when the
   * spec has to create the pane itself (a chat topic). `null` means the family
   * is not measurable from the web shell, and then `contrast` has to say so.
   */
  probe: string | null;
  /** Last recorded worst-case reading, or `null` if it was never measured. */
  contrast: SurfaceContrast | null;
  /** Set only when `contrast` is null: what stops the measurement. */
  unmeasurable?: string;
}

/**
 * THE LIST. Order is reading order, not precedence: the families are disjoint
 * and `surfaceForPaneType` asserts it.
 */
export const CHROME_BAR_SURFACES: readonly ChromeBarSurface[] = [
  {
    id: 'chat',
    paneTypes: ['chat'],
    cellBg: 'pane-frost',
    scrollsUnderChrome: true,
    why: 'The transcript is the one surface the overlay exists for: it takes the cell inset back with a negative margin and hands it out again as a gutter inside the scrolled content, so at rest nothing is hidden and in motion there is depth.',
    probe: 'runtime',
    contrast: {
      dark: 6.89,
      light: 8.49,
      spreadDark: 0.0291,
      spreadLight: 0.4293,
      measuredOn: '2026-08-29',
      measuredBy: 'tests/e2e/chrome-bar-worst-case-contrast.spec.ts',
    },
  },
  {
    id: 'terminal',
    paneTypes: ['terminal'],
    cellBg: '',
    scrollsUnderChrome: false,
    why: 'xterm is a grid of rows measured on its container: there is no scrolled content to add a gutter to, so every row that ends under the bar is a row lost, and the first one is the line being typed.',
    probe: 'terminal:inventory-probe',
    contrast: {
      dark: 9.0,
      light: 15.54,
      spreadDark: 0,
      spreadLight: 0,
      measuredOn: '2026-08-29',
      measuredBy: 'tests/e2e/chrome-bar-surface-inventory.spec.ts',
    },
  },
  {
    id: 'browser',
    paneTypes: ['browser'],
    cellBg: 'pane-frost',
    scrollsUnderChrome: false,
    why: 'On the Tauri shell the pane is a native WKWebView painted ABOVE the whole DOM, so "passing under" inverts: it would be the bar disappearing behind the webview. The frosted tier still applies, because the only part of that cell anybody sees is the chrome strip on top.',
    probe: 'browser:inventory-probe',
    contrast: {
      dark: 9.0,
      light: 15.54,
      spreadDark: 0,
      spreadLight: 0,
      measuredOn: '2026-08-29',
      measuredBy: 'tests/e2e/chrome-bar-surface-inventory.spec.ts',
    },
  },
  {
    id: 'boards',
    paneTypes: ['kanban', 'board'],
    cellBg: 'pane-frost',
    scrollsUnderChrome: false,
    why: 'A board scrolls its columns, and each column carries its own sticky header. Two headers overlapping is not an effect, it is a mess.',
    probe: null,
    contrast: null,
    unmeasurable:
      'A board needs a seeded project and its cards to render a column; the sweep would measure the fixture, not the surface. Left declared and unmeasured on purpose rather than measured on an empty state.',
  },
  {
    id: 'own-chrome',
    paneTypes: ['project'],
    cellBg: '',
    scrollsUnderChrome: false,
    why: 'The project pane paints its own chrome and frosts itself, so the cell stays fully transparent and there is no cell backdrop for anything to pass over.',
    probe: null,
    contrast: null,
    unmeasurable:
      'The pane draws its own bar; the chrome strip measured for the other families is not the surface at risk here.',
  },
  {
    id: 'dense',
    paneTypes: [
      'file',
      'files',
      'git',
      'plan',
      'dashboard',
      'process-log',
      'context',
      'editor',
      'cron',
      'profile',
      'remote-access',
      'system-status',
      'processes',
    ],
    cellBg: 'bg-surface',
    scrollsUnderChrome: false,
    why: 'Dense tables and trees (dashboard, files, session viewers) keep an opaque backdrop so small text stays crisp, and they have sticky headers of their own in the same place the glass would be.',
    probe: '__dashboard__',
    contrast: {
      dark: 9.0,
      light: 15.54,
      spreadDark: 0,
      spreadLight: 0,
      measuredOn: '2026-08-29',
      measuredBy: 'tests/e2e/chrome-bar-surface-inventory.spec.ts',
    },
  },
];

/** Index built once: the families are disjoint, so a pane type has one home. */
const BY_PANE_TYPE: ReadonlyMap<PaneType, ChromeBarSurface> = (() => {
  const map = new Map<PaneType, ChromeBarSurface>();
  for (const surface of CHROME_BAR_SURFACES) {
    for (const type of surface.paneTypes) map.set(type, surface);
  }
  return map;
})();

/**
 * The surface family of a pane type.
 *
 * A type with no family is a bug in the table and not a case to fall back on:
 * the unit test walks `PANE_TYPES` and fails on the first orphan, so a new pane
 * type cannot land by inheriting somebody else's backdrop by accident. At
 * runtime it degrades to the dense (opaque) family, which is the safe tier for
 * text nobody measured yet.
 */
export function surfaceForPaneType(type: PaneType): ChromeBarSurface {
  return BY_PANE_TYPE.get(type) ?? CHROME_BAR_SURFACES[CHROME_BAR_SURFACES.length - 1];
}

/** Every pane type the table does not cover. Empty is the invariant. */
export function paneTypesWithoutSurface(): PaneType[] {
  return PANE_TYPES.filter((type) => !BY_PANE_TYPE.has(type));
}
