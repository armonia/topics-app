/**
 * The ONE kind a browser tab shows on its favicon's corner, when several are
 * true at once. Order, first wins:
 *
 *   agent > disconnected > connecting > degraded > heavy-paused > heavy > chromium > shared
 *
 * The agent stays first: it is the one kind you can act on right now (the tab
 * offers take-control while it lasts), and an agent-driven pane is exempt from
 * the heavy pause anyway. A heavy pane that is also shared or real Chromium shows
 * the heavy glyph: that is the fact that explains why the page is paused.
 */
import type { BrowserPaneChrome } from '../../state/browserPaneChrome';

export type BrowserTabKind =
  | 'agent'
  | 'disconnected'
  | 'connecting'
  | 'degraded'
  | 'heavy-paused'
  | 'heavy'
  | 'chromium'
  | 'shared';

export function browserTabKind(
  chrome: Pick<BrowserPaneChrome, 'agentActive' | 'connection' | 'engine' | 'shared' | 'heavy'>,
): BrowserTabKind | undefined {
  // ABSENT MEANS CONNECTED, not "unknown": the native and iframe panes have no
  // streaming socket, and a pane with no socket cannot have lost one. Reading
  // absence as a problem would put a warning glyph on every native tab.
  const connection = chrome.connection ?? 'connected';
  if (chrome.agentActive) return 'agent';
  if (connection === 'disconnected') return 'disconnected';
  if (connection === 'connecting') return 'connecting';
  // `fallback-http` keeps its own glyph: it is not "connecting" (the page IS
  // updating, over polling) and not "gone". Folding it into the spinner would
  // say "still trying" about a link that already settled.
  if (connection === 'fallback-http') return 'degraded';
  if (chrome.heavy?.paused) return 'heavy-paused';
  if (chrome.heavy) return 'heavy';
  if (chrome.engine === 'chromium') return 'chromium';
  // SHARED IS THE EFFECTIVE RENDER: true only where the page lives on the
  // server and another device can be looking at it. It is NOT gated on
  // `shareMode`: that silenced the icon on the whole web client, where every
  // streaming pane is genuinely the shared session.
  if (chrome.shared) return 'shared';
  return undefined;
}

/**
 * WHICH MARK the favicon's corner carries (TABSLOT-03): one at a time, zero
 * width, so the label never moves when one comes or goes.
 *
 * THE CONSOLE ERRORS WIN, over every kind but a link that is not live. They
 * are the one mark that reports something BROKEN, and the corner is the only
 * thing a tab shows about its page at rest. Until 2026-09-29 a state of the pane
 * (agent, link, heavy) won instead, so the red dot vanished exactly on the tabs
 * doing the most. The kind that loses the corner is not lost: the tab's
 * accessible name and its tooltip say it (`browserKindName`), and "take back
 * control" is a command of its own under the pointer (`BrowserTabTakeControl`).
 *
 * A LINK THAT IS NOT LIVE (gone, reconnecting, polling) beats the errors: the
 * console reaches the pane over that socket, so without it the tally is frozen
 * and the fresh fact is the link. Letting the errors win there hid "connection
 * lost" for good on any tab whose page had thrown once.
 */
const LINK_KINDS: ReadonlySet<BrowserTabKind> = new Set(['disconnected', 'connecting', 'degraded']);

export function browserCornerMark(
  kind: BrowserTabKind | undefined,
  consoleErrors: number,
): 'kind' | 'errors' | undefined {
  if (kind && LINK_KINDS.has(kind)) return 'kind';
  if (consoleErrors > 0) return 'errors';
  return kind ? 'kind' : undefined;
}
