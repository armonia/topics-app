import type { Pane, Group, PaneState, ClosedPaneRecord, SpaceMeta } from './types';
import { resolvePaneSpace } from './reducers/spaces';

export { resolvePaneSpace };

function isDraftId(id: string): boolean {
  return id.startsWith('draft:');
}

interface SnapshotOptions {
  /** Strip pre-promotion draft panes from the output. True for server PUTs and
   *  cross-tab broadcasts; false for same-device persistence. */
  excludeDrafts: boolean;
}

function buildSnapshot(s: PaneState, opts: SnapshotOptions) {
  const panesWithoutScroll: Record<string, Omit<Pane, 'scrollOffset'>> = {};
  for (const [id, p] of Object.entries(s.panes)) {
    if (opts.excludeDrafts && isDraftId(id)) continue;
    const { scrollOffset: _scroll, ...rest } = p;
    panesWithoutScroll[id] = rest;
  }
  const groupsOut: Record<string, Group> = {};
  for (const [gid, g] of Object.entries(s.groups)) {
    if (!opts.excludeDrafts) {
      groupsOut[gid] = g;
      continue;
    }
    const filteredIds = g.paneIds.filter((id) => !isDraftId(id));
    groupsOut[gid] =
      filteredIds.length === g.paneIds.length ? g : { ...g, paneIds: filteredIds };
  }
  // `projects` is intentionally omitted from the snapshot: the reducer's
  // `state.projects[path]` field used to capture App-level pane state under
  // a project key (wrong scope — see projectLayoutSync.ts header) and the
  // result was never consumed authoritatively (consumers silently filtered
  // it out). Stripping it here reduces every server PUT and cross-tab
  // broadcast by ~all of the open-project layout data we don't actually
  // sync. localStorage `topics-project-panes-<hash>` remains the source of
  // truth for inner-project layouts (same-device only).
  const closedStackOut: ClosedPaneRecord[] = s.closedStack
    .filter((rec) => !(opts.excludeDrafts && isDraftId(rec.pane.id)))
    .map((rec) => {
      const { scrollOffset: _nested, ...paneRest } = rec.pane;
      const { scrollOffset: _outer, ...recRest } = rec;
      return { ...recRest, pane: paneRest as Pane };
    });
  return {
    panes: panesWithoutScroll,
    groups: groupsOut,
    groupOrder: s.groupOrder,
    closedStack: closedStackOut,
    // Durable close markers ride BOTH snapshot variants (server + local) so a
    // durable pane stays closed across a reload and cross-device even after its
    // closedStack record fell out of the FIFO-50. Merged per-id on hydrate.
    // FORMATO DEL FILO — retrocompatibile di proposito. `tombstones` esce come
    // MAPPA DI NUMERI, la forma che il sanitizer delle versioni precedenti sa
    // leggere: il suo filtro pretende `typeof v === 'number'` e scarterebbe un
    // oggetto, buttando via OGNI marcatore e riaprendo le pane chiuse. Il `seq`
    // — la grandezza causale su cui si decide — viaggia a fianco in una chiave
    // NUOVA, che un client vecchio ignora senza accorgersene.
    //
    // Da togliere quando non ci sono piu' client sul bundle precedente; fino ad
    // allora questa e' la differenza fra un aggiornamento e una resurrezione.
    // `?? {}`: uno stato costruito a mano (test, migrazioni) puo' non avere la
    // mappa, e prima ci passava attraverso indenne perche' non veniva letta.
    tombstones: Object.fromEntries(Object.entries(s.tombstones ?? {}).map(([id, m]) => [id, m.at])),
    tombstoneSeqs: Object.fromEntries(
      Object.entries(s.tombstones ?? {}).filter(([, m]) => m.seq > 0).map(([id, m]) => [id, m.seq]),
    ),
    // Spazi registry rides the snapshot in BOTH variants (server + local) so
    // membership survives reloads and syncs cross-device; the reducer merges
    // it per-id on hydrate (mergeSpaces), never wholesale.
    // `activeSpaceId` is deliberately NOT here — DEVICE-LOCAL (focusedPaneId
    // pattern): it persists via its own localStorage key (persistLocal) and
    // never crosses the network.
    spaces: s.spaces,
    lastSeq: s.lastSeq,
  };
}

/**
 * Filter a list of app-level pane ids down to the ones visible in
 * `activeSpaceId`. Pure — the single derivation usePanelLifecycle's
 * `visiblePanels` and the store-side selectVisiblePaneIds share, so the two
 * surfaces can't drift. A pane whose entity is missing from `panes` (a
 * transient id mid-registration) counts as the default space, consistent
 * with "absent spaceId ⟺ default".
 *
 * NOTE: this filters the DERIVED render prop only — `openPanels` itself must
 * stay the FULL unfiltered set (the React→store REORDER_PANES bridge would
 * otherwise evict hidden panes from the store).
 */
export function filterVisiblePaneIds(
  paneIds: readonly string[],
  panes: Record<string, Pane>,
  spaces: Record<string, SpaceMeta> | undefined,
  activeSpaceId: string,
): string[] {
  return paneIds.filter((id) => resolvePaneSpace(panes[id], spaces) === activeSpaceId);
}

/**
 * App-level pane ids (the `group:default` tab order) visible in the store's
 * current active space.
 */
export function selectVisiblePaneIds(s: PaneState): string[] {
  const order = s.groups['group:default']?.paneIds ?? [];
  return filterVisiblePaneIds(order, s.panes, s.spaces, s.activeSpaceId);
}

/**
 * Server-syncable snapshot.
 *
 * Excludes device-local fields that MUST NOT cross devices (per CONTEXT.md decisions):
 *  - focusedPaneId (prevents focus thrashing across devices)
 *  - Pane.scrollOffset (per-device scroll position)
 *  - ClosedPaneRecord.scrollOffset (also per-device — PANE-03 scroll restore
 *    runs post-mount via the DOM scroll tracker, not via the synced record)
 *  - Draft panes (id starts with `draft:`). Drafts are pre-promotion scratch
 *    panes — leaking them cross-device causes the bug where a concurrent
 *    Electron client's PUT broadcasts back without the draft, the receiving
 *    browser dispatches HYDRATE_FROM_SNAPSHOT, and `state.panes = clean.panes`
 *    wipes the local draft within ~300ms of creation.
 */
export function selectSyncableSnapshot(s: PaneState) {
  return buildSnapshot(s, { excludeDrafts: true });
}

/**
 * Same-device localStorage snapshot. Like selectSyncableSnapshot but keeps
 * draft panes so a same-device reload restores in-flight scratch panes. Drafts
 * are still device-local; cross-tab consumers must run sanitizeSnapshot on the
 * incoming payload to filter them out.
 */
export function selectLocalSnapshot(s: PaneState) {
  return buildSnapshot(s, { excludeDrafts: false });
}
