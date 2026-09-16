/**
 * The ONE kind a browser tab shows between its favicon and its title, when
 * several are true at once. Order, first wins:
 *
 *   agent > disconnected > connecting > degraded > heavy-paused > heavy > chromium > shared
 *
 * The agent stays first: it is the one kind you can act on right now (the glyph
 * is the take-control button), and an agent-driven pane is exempt from the
 * heavy pause anyway. A heavy pane that is also shared or real Chromium shows
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
