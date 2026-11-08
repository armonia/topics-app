/**
 * zoomScope — who comes along when a conversation is zoomed, and how wide the
 * gesture asked to go.
 *
 * Zooming the CELL of a chat would leave out exactly the half the agent just
 * produced: the auto-split sends the browser it opened into a group NEXT TO the
 * chat, not into its cell. So the set is the anchored conversation plus the tabs
 * that conversation opened, derived from identities that already exist and are
 * durable (design D7): the browser pane id that equals the topic's context, the
 * context recorded on the topic, and the parent session of a sub-agent terminal.
 * No new field on `Pane`: one would leave through `buildSnapshot` and come back
 * deleted by `sanitizePane`.
 *
 * FOUR functions, and two of them are NOT the same one wearing different names.
 *
 *   - `resolveZoomCells` is pure and runs on EVERY render. Given a scope it
 *     translates it into cells, and nothing else: `derived` resolves the set,
 *     `cell` resolves the anchor's own cell. No degradation lives here, by
 *     design — running per render it would move the scope under the user's hands
 *     every time a pane opens or closes.
 *   - `resolveEntryScope` runs ONCE, at the gesture. It answers "what did this
 *     gesture actually buy?": `cell` when the modifier asked for it, `cell` again
 *     when the derived set already covers every live cell (so the simple gesture
 *     degrades instead of being a silent no-op), and `null` when there is a
 *     single live cell, i.e. when the command is not offered at all. Its answer
 *     is what the store keeps, and it is the only place degradation exists.
 *
 * Everything is INJECTED — panes, topics, terminals, the spawner map, the rows
 * and the item map. No store import: `sessionKeyForPaneId` already documents the
 * silent failure of deriving a session key from a pane id, and a module that
 * reached into a store could not be tested against the layouts that matter.
 */
import { createPaneId, isKnownPanePrefix } from '../../state/pane/adapters/paneConfig';
import { cellKeysForPanes, liveCellKeys, type ZoomItemMap, type ZoomRow } from './paneZoom';

/** How wide the zoom is. Fixed at entry, never recomputed while it is open:
 *  `derived` = the conversation and the tabs it opened, `cell` = the anchor's
 *  cell alone. It names the OUTCOME of the gesture, not the key that was held. */
export type ZoomScope = 'derived' | 'cell';

/** The zoomed tab, plus the conversation it stands for when it is a chat. A
 *  non-chat tab anchors on itself: the classic maximize is the degenerate case
 *  of this, not a separate function. */
export interface ZoomAnchor {
  readonly paneId: string;
  readonly topicId: string | null;
}

/** A pane of the surface. Structural: the surfaces' own `Pane` satisfies it. */
export interface ZoomPane {
  readonly id: string;
  readonly type?: string;
  readonly topicId?: string;
}

/** The bits of a topic this module reads. */
export interface ZoomTopic {
  readonly sessionKey?: string;
  readonly browserState?: { readonly contextId?: string };
}

/** One terminal session of the roster. */
export interface ZoomTerminal {
  readonly id: string;
  readonly parentSessionKey?: string | null;
}

/** What it takes to turn an anchor into a set of PANES. */
export interface ZoomPaneDeps {
  /** The panes this surface holds, in its own order. */
  readonly openPanes: readonly ZoomPane[];
  readonly topics: Readonly<Record<string, ZoomTopic>>;
  readonly terminals: readonly ZoomTerminal[];
  /** The spawner registry, topic id → browser context id (`useSpawnedBrowserMap`).
   *  It lives in sessionStorage, so it enters in UNION and never in subtraction:
   *  after an app restart the set is SMALLER, never wrong, and the smallest case
   *  is still the zoom of one cell. */
  readonly spawnedBrowserByTopic: Readonly<Record<string, string>>;
}

/** What it takes to turn an anchor into a set of CELLS. */
export interface ZoomCellDeps extends ZoomPaneDeps {
  readonly rows: readonly ZoomRow[];
  readonly itemMap: ZoomItemMap;
}

/** The state a zoomed surface holds, as far as this module needs it. */
export interface ZoomTarget {
  readonly anchorPaneId: string;
  readonly scope: ZoomScope;
}

/**
 * The anchor of a zoom started on `paneId`.
 *
 * A chat anchors on its CONVERSATION (`topicId`), anything else on the pane
 * itself (`topicId: null`). The topic is read from the pane when the surface
 * carries it (a project window mounts chats as `chat:<topicId>`), and otherwise
 * from the id itself, which in the standalone grid IS the topic id.
 *
 * The topic is NOT required to exist in `topics`: a topic still loading would
 * only cost the set its browser context and its sub-agents, and answering "this
 * is not a conversation" for a chat tab would be a worse lie than a smaller set.
 */
export function resolveZoomAnchor(paneId: string, deps: ZoomPaneDeps): ZoomAnchor {
  const pane = deps.openPanes.find((p) => p.id === paneId);
  if (pane && pane.type !== 'chat') return { paneId, topicId: null };
  if (pane?.topicId) return { paneId, topicId: pane.topicId };
  const bare = paneId.startsWith('chat:') ? paneId.slice('chat:'.length) : paneId;
  // A draft, a browser, a terminal, a project, a utility panel: known prefixes,
  // and none of them is a conversation.
  return { paneId, topicId: isKnownPanePrefix(bare) ? null : bare };
}

/**
 * The panes of the anchored conversation: the anchor first, then — in the
 * surface's own order — the browser panes carrying its context and the
 * terminals of its sub-agents.
 *
 * Candidates are derived from the durable identities and then INTERSECTED with
 * the panes actually open here. Without that intersection `browser:<topicId>`
 * would always be "in the set" as a string nobody renders, and the set would
 * describe a layout that does not exist.
 *
 * What it deliberately does NOT walk: a browser opened by one of those sub-agent
 * terminals. The conversation's own context and its sub-agents are what the
 * requirement names; a second hop would widen a set the user has no way to see.
 */
export function computeZoomPaneIds(anchor: ZoomAnchor, deps: ZoomPaneDeps): string[] {
  const paneIds = [anchor.paneId];
  if (!anchor.topicId) return paneIds;

  const topic = deps.topics[anchor.topicId];
  const wanted = new Set<string>();
  // `browser:<contextId>`, with the context resolved exactly as the server does
  // it: `topic.browserState?.contextId ?? topic.id`. Both are taken, plus the
  // window-local spawner registry, because they are three sources for one
  // relation and any of them can be the only one that knows.
  for (const contextId of [anchor.topicId, topic?.browserState?.contextId, deps.spawnedBrowserByTopic[anchor.topicId]]) {
    if (contextId) wanted.add(createPaneId('browser', contextId));
  }
  const sessionKey = topic?.sessionKey;
  if (sessionKey) {
    for (const terminal of deps.terminals) {
      if (terminal.parentSessionKey === sessionKey) wanted.add(createPaneId('terminal', terminal.id));
    }
  }

  for (const pane of deps.openPanes) {
    if (pane.id !== anchor.paneId && wanted.has(pane.id)) paneIds.push(pane.id);
  }
  return paneIds;
}

/**
 * The cells a zoom reveals, for the scope it was opened with.
 *
 * One `if`, not two code paths: uncovering, pruning, the frame and residency all
 * read this one answer. The set of cells stays LIVE — recomputed here on every
 * render — so with `derived` a browser the agent opens while you watch walks in
 * by itself, and with `cell` it does not, which is the declared price of having
 * asked for "this one only".
 */
export function resolveZoomCells(target: ZoomTarget, deps: ZoomCellDeps): ReadonlySet<string> {
  const paneIds = target.scope === 'cell'
    ? [target.anchorPaneId]
    : computeZoomPaneIds(resolveZoomAnchor(target.anchorPaneId, deps), deps);
  return cellKeysForPanes(deps.rows, deps.itemMap, paneIds);
}

/**
 * The scope to REMEMBER for a gesture on `paneId`, or `null` when the gesture
 * is not on offer.
 *
 * `null` means the surface has a single live cell: there is nothing to take
 * away, and it is the same layout on which the availability predicate is false
 * — both read `liveCellKeys`, so they agree by construction and not by
 * coincidence.
 *
 * When the derived set already covers every live cell, a `derived` request comes
 * back as `cell`: the simple gesture degrades to the anchor's cell instead of
 * becoming a silent no-op, which is what it was on precisely the layout the
 * feature exists for (a chat, its two browsers and a sub-agent terminal filling
 * four cells). The degradation is resolved HERE, once, and what the store keeps
 * is its result — so the scope cannot change under the user's hands, and a
 * browser opened afterwards is a pane outside the set instead of a silent
 * widening.
 */
export function resolveEntryScope(
  paneId: string,
  requested: ZoomScope,
  deps: ZoomCellDeps,
): ZoomScope | null {
  const live = liveCellKeys(deps.rows, deps.itemMap);
  if (live.size <= 1) return null;
  if (requested === 'cell') return 'cell';
  const derived = resolveZoomCells({ anchorPaneId: paneId, scope: 'derived' }, deps);
  for (const key of live) {
    if (!derived.has(key)) return 'derived';
  }
  return 'cell';
}
