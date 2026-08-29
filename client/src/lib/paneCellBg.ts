import type { PaneType } from '../state/pane/types';
import { surfaceForPaneType } from './chromeBarSurfaces';

/**
 * Background tier of a layout CELL hosting a content pane (GroupLayout and
 * StandaloneChatGroup keep-alive wrappers - one decision, two call sites).
 *
 * THE DECISION IS NOT HERE ANY MORE, IT IS IN THE TABLE. Which tier a pane gets
 * (and whether its content passes under the glass, and what the labels measure
 * over it) is one row of `CHROME_BAR_SURFACES` in `chromeBarSurfaces.ts`. This
 * function is a lookup into that row, so the tier and the reason for it cannot
 * drift apart: they are the same record.
 *
 * Three tiers under a native-backdrop shell (macOS vibrancy, Windows acrylic):
 * '' fully transparent for panes that paint their own chrome, `pane-frost` for
 * the frosted tier, `bg-surface` for the opaque backdrop that keeps dense text
 * crisp. Which pane sits in which, and why, is the table.
 *
 * THE BROWSER IS IN THE FROSTED TIER, AND IT IS THE TYPE THAT SAYS SO. The cell
 * of a browser pane has no dense text to keep crisp: under the toolbar there is
 * a NATIVE webview painting its own opaque background. The only part of that
 * cell anybody really sees is the CHROME STRIP on top, so the background the
 * cell takes IS the background read under the tabs and the toolbar.
 *
 * That was already the intent, but a CSS rule was stating it by looking at the
 * SHAPE OF THE DOM instead of the type:
 * `html.electron-mac :has(> [data-testid="browser-native-panel"])` required the
 * panel to be a DIRECT child of the cell. Where a caller interposes a div (the
 * browser tabs of a task on the board) the rule did not attach, the cell stayed
 * opaque `bg-surface`, and the same pane came out in two different tints
 * depending on WHO mounted it. It is the drift this family has already paid for
 * twice (the project bar against the top-level one): the tint of a surface must
 * not depend on where it sits in the tree.
 */
export function paneCellBg(type: PaneType): string {
  return surfaceForPaneType(type).cellBg;
}

/**
 * WHO PASSES UNDER THE TAB BAR AND WHO DOES NOT - the list is in
 * `chromeBarSurfaces.ts`, one row per surface, with its reason and the contrast
 * measured over it. What follows is why the inset is the same for everybody.
 *
 * Since the bar became a pane of glass out of the flow (`.pane-chrome-bar`,
 * index.css), a pane's cell begins at the top of the card, that is BEHIND the
 * bar. For the conversation that is exactly what is wanted: the messages scroll
 * under it and the list itself provides the gutter at the top (Virtuoso's
 * `Header` in MessageList), so at rest nothing is hidden and in motion there is
 * depth.
 *
 * CAREFUL, and this was found by measuring: "the chat" is not only the
 * transcript. Above it, in the same column, sit blocks that appear and
 * disappear - the "connect this project?" banner, the outcome of a command, the
 * pinned messages, and on the phone the session activity strip. Leaving the
 * cell without an inset put those BEHIND the glass, and a banner that asks
 * something and cannot be seen is worse than a banner that is not there.
 *
 * So ALL cells carry the inset, the chat included, and the only thing that
 * passes under the bar is the transcript, which takes it back with a negative
 * margin and only when it really is first in the column
 * (`.chat-under-chrome`, index.css). If there is a banner above it, the gutter
 * is worth zero and the cell inset is already doing the job: neither counts
 * twice.
 *
 * The inset is expressed in `var(--chrome-bar-h)` and not in a hand-written
 * `pt-10`: the height is declared ONCE by the card that owns the bar, and the
 * same variable is read by the chat gutter. One number, two readers - if the
 * chrome row changes height, they move together.
 */
export function paneCellTopInset(_type: PaneType): string {
  return 'pt-[var(--chrome-bar-h,0px)]';
}
