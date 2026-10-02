/**
 * THE AGENT OPENED A PAGE: ONE MARKER PER CONTEXT, PER MESSAGE (CHAT-BROWSER-01).
 *
 * An opening used to be a generic MCP row, and 602 of 624 of them (30 days to
 * 29/09) ended up folded inside a «N actions» row or a finished turn's summary:
 * the browser came up beside the chat and the transcript said nothing about it.
 * So a successful `open_browser_pane` / `browser_open` is lifted out of the tool
 * run and drawn as a marker that stays in sight, like an image.
 *
 * Agents re-open a lot (73 turns of 340 open three times or more, 92 openings
 * reload the URL just opened), so every opening of the SAME context inside one
 * message folds into the marker of the first one, which shows the last page and
 * lists them all. Two contexts stay two markers.
 *
 * Pure, so the rule is tested without a DOM.
 */
import type { ToolCall } from '../../types';
import { browserPageLabel, resolveToolDetail } from './toolDetail';

/** One opening, as the marker lists it. */
export interface BrowserMarkerPage {
  toolCallId: string;
  url: string;
  title?: string;
  name?: string;
  /** When it landed (epoch ms); absent on rows without timestamps. */
  at?: number;
}

export interface BrowserMarker {
  /** The first opening's tool call id: the marker's identity inside the message. */
  id: string;
  /** Absent on rows older than BROWSER-CHAT-05: the click then uses the topic's own context. */
  contextId?: string;
  /** Every opening of this context, in order. The last one is the page shown. */
  pages: BrowserMarkerPage[];
  /** False when the last opening loaded the page on no screen. */
  visible?: boolean;
}

/** The opening a tool call made, or null when it is not a successful one. */
export function browserOpenOf(tc: ToolCall): (BrowserMarkerPage & { contextId?: string; visible?: boolean }) | null {
  // Only a call that FINISHED well: a running one may still fail, and a failed
  // one opened nothing (it stays a tool row, with its error, in its group).
  if (tc.status !== 'success') return null;
  const detail = resolveToolDetail(tc);
  if (detail.type !== 'browser') return null;
  const at = tc.endedAt ?? tc.startedAt;
  return {
    toolCallId: tc.id,
    url: detail.url,
    ...(detail.title ? { title: detail.title } : {}),
    ...(detail.name ? { name: detail.name } : {}),
    ...(typeof at === 'number' ? { at } : {}),
    ...(detail.contextId ? { contextId: detail.contextId } : {}),
    ...(typeof detail.visible === 'boolean' ? { visible: detail.visible } : {}),
  };
}

/**
 * Which tool calls of a message are markers.
 *
 * The map holds an entry ONLY for successful openings: the marker itself under
 * the id of the first opening of its context, and `null` under every later one
 * (folded into that marker, so it is not drawn again). A call with no entry is
 * an ordinary tool row.
 */
export function coalesceBrowserOpens(tools: readonly ToolCall[]): Map<string, BrowserMarker | null> {
  const plan = new Map<string, BrowserMarker | null>();
  const byContext = new Map<string, BrowserMarker>();
  for (const tc of tools) {
    const open = browserOpenOf(tc);
    if (!open) continue;
    const { contextId, visible, ...page } = open;
    // No context = the topic's implicit one: every such opening is the same page.
    const key = contextId ?? '';
    const known = byContext.get(key);
    if (known) {
      known.pages.push(page);
      if (visible === undefined) delete known.visible;
      else known.visible = visible;
      plan.set(tc.id, null);
      continue;
    }
    const marker: BrowserMarker = {
      id: tc.id,
      ...(contextId ? { contextId } : {}),
      pages: [page],
      ...(visible !== undefined ? { visible } : {}),
    };
    byContext.set(key, marker);
    plan.set(tc.id, marker);
  }
  return plan;
}

/** The page a marker shows: the last one opened. */
export function currentPage(marker: BrowserMarker): BrowserMarkerPage {
  return marker.pages[marker.pages.length - 1];
}

/** The marker's title: the agent's name for the tab, else the page title, else the host. */
export function markerTitle(marker: BrowserMarker): string {
  return browserPageLabel(currentPage(marker));
}

/** Where the page lives now, as the marker says it. Derived, never stored. */
export type BrowserMarkerState = 'window' | 'tab' | 'closed' | 'offscreen';

/** Which surface holds a context: see `locateBrowserContext`. */
export type BrowserPlaceKind = 'layout' | 'task' | 'window';

export function browserMarkerState(place: BrowserPlaceKind | null, visible: boolean | undefined): BrowserMarkerState {
  if (place === 'window') return 'window';
  if (place) return 'tab';
  // Loaded but never shown, and nothing shows it now: «closed» would be false.
  return visible === false ? 'offscreen' : 'closed';
}
