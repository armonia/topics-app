/**
 * Spazi (workspaces) reducer — the three SPACE_* actions plus the per-id LWW
 * merge helper the HYDRATE path uses. Mirrors undo.ts: a focused sub-reducer
 * dispatched from paneReducer's switch, mutating the Immer draft in place.
 *
 * Registry semantics (see types.ts SpaceMeta):
 *   - The default space (DEFAULT_SPACE_ID) is IMPLICIT: never a record in
 *     `state.spaces`, never deletable, never renamable — absent `pane.spaceId`
 *     ⟺ default. Mirrors the `group:default` carve-out in panes.ts.
 *   - Deletion is a soft-delete tombstone IN the record (`deleted: true` +
 *     newer updatedAt wins on merge), so a cross-client delete propagates
 *     through the ordinary snapshot channel without new tombstone plumbing.
 *   - `activeSpaceId` is DEVICE-LOCAL (focusedPaneId pattern); SET_ACTIVE_SPACE
 *     only ever mutates local view state + focus handoff.
 */
import type { PaneState, PaneAction, SpaceMeta, Pane } from '../types';
import { DEFAULT_SPACE_ID, SPACES_MAX } from '../types';

/**
 * The space a pane belongs to, resolved against a registry. Absent spaceId,
 * an unknown id, or a soft-deleted record all fall back to the default space
 * — resolution happens at READ time (no state rewrite ⇒ no hydrate
 * ping-pong when a space is deleted remotely while its panes are still
 * stamped with the dead id).
 */
export function resolvePaneSpace(
  pane: Pick<Pane, 'spaceId'> | undefined,
  spaces: Record<string, SpaceMeta> | undefined,
): string {
  const id = pane?.spaceId;
  if (!id || id === DEFAULT_SPACE_ID) return DEFAULT_SPACE_ID;
  const meta = spaces?.[id];
  if (!meta || meta.deleted) return DEFAULT_SPACE_ID;
  return id;
}

/** A space id that currently resolves to a LIVE registry entry (or default). */
export function isLiveSpaceId(
  id: string,
  spaces: Record<string, SpaceMeta> | undefined,
): boolean {
  if (id === DEFAULT_SPACE_ID) return true;
  const meta = spaces?.[id];
  return !!meta && !meta.deleted;
}

/**
 * Count of registry entries that are NOT soft-deleted (the implicit default
 * space is never a record and is not counted). The "can I create another
 * space?" cap MUST use this, not `Object.keys(spaces).length`: SPACE_DELETE
 * keeps a `deleted: true` tombstone in the registry (for cross-device LWW), so
 * counting raw keys permanently disables "+ New Space" after SPACES_MAX
 * create/delete cycles — a dead-end the user can't escape (creating is exactly
 * what would trim the over-cap tombstones).
 */
export function liveSpaceCount(spaces: Record<string, SpaceMeta> | undefined): number {
  if (!spaces) return 0;
  let n = 0;
  for (const meta of Object.values(spaces)) if (!meta.deleted) n++;
  return n;
}

/**
 * Per-id LWW merge of two space registries — the HYDRATE_FROM_SNAPSHOT
 * primitive. NEVER a wholesale replace: local-only records are KEPT (two
 * devices creating different spaces inside the 500ms debounce both survive),
 * remote records win per-id only when their `updatedAt` is strictly newer.
 *
 * Delete is an ABSORBING latch, NOT plain LWW: once EITHER side carries a
 * `deleted: true` tombstone for an id, the merged record stays deleted — even
 * if the other side's non-deleted record has a numerically-higher `updatedAt`.
 * Pure updatedAt-LWW would let a stale pre-delete rename (clock skew, or a
 * rename that raced a peer's delete) resurrect a space; that's a real
 * resurrection bug. Space ids are fresh UUIDs and the only same-id re-upsert is
 * a RENAME of a locally-live space, so there is no legitimate "revive the same
 * deleted id across devices" flow to protect — the delete rightly wins. We keep
 * the newer record's fields (latest name/order) but force `deleted: true`.
 *
 * Capped at SPACES_MAX keeping the most-recently-updated records (runaway
 * backstop — mirrors the closedStack keep-the-tail rule).
 */
export function mergeSpaces(
  local: Record<string, SpaceMeta> | undefined,
  remote: Record<string, SpaceMeta> | undefined,
): Record<string, SpaceMeta> {
  const out: Record<string, SpaceMeta> = { ...(local ?? {}) };
  for (const [id, meta] of Object.entries(remote ?? {})) {
    if (id === DEFAULT_SPACE_ID) continue; // implicit — never a record
    const existing = out[id];
    if (!existing) {
      out[id] = meta;
    } else if (existing.deleted || meta.deleted) {
      // Absorbing delete: keep the newer record's fields, but the tombstone
      // never lifts via a concurrent non-deleted write.
      const base = meta.updatedAt > existing.updatedAt ? meta : existing;
      out[id] = base.deleted ? base : { ...base, deleted: true };
    } else if (meta.updatedAt > existing.updatedAt) {
      out[id] = meta;
    }
  }
  const ids = Object.keys(out);
  if (ids.length <= SPACES_MAX) return out;
  const kept = ids
    .sort((a, b) => (out[b].updatedAt ?? 0) - (out[a].updatedAt ?? 0))
    .slice(0, SPACES_MAX);
  const capped: Record<string, SpaceMeta> = {};
  for (const id of kept) capped[id] = out[id];
  return capped;
}

/**
 * First app-level pane (walking groupOrder, then any stray groups) that lives
 * in `spaceId` — the focus-handoff target when the current focus leaves the
 * visible set. Returns null when the space is empty.
 */
function firstPaneInSpace(state: PaneState, spaceId: string): string | null {
  const seen = new Set<string>();
  const orderedGroupIds = [
    ...state.groupOrder,
    ...Object.keys(state.groups).filter((g) => !state.groupOrder.includes(g)),
  ];
  for (const gid of orderedGroupIds) {
    const group = state.groups[gid];
    if (!group) continue;
    for (const paneId of group.paneIds) {
      if (seen.has(paneId)) continue;
      seen.add(paneId);
      if (resolvePaneSpace(state.panes[paneId], state.spaces) === spaceId) return paneId;
    }
  }
  return null;
}

export function spacesReducer(state: PaneState, action: PaneAction): void {
  // Older persisted fixtures / pre-Spazi snapshots may lack the field.
  if (!state.spaces) state.spaces = {};

  switch (action.type) {
    case 'SPACE_UPSERT': {
      const { space } = action.payload;
      if (!space.id || space.id === DEFAULT_SPACE_ID) break; // default is implicit
      const existing = state.spaces[space.id];
      const nextOrder =
        space.order ??
        existing?.order ??
        // Append after the current registry tail.
        Object.values(state.spaces).reduce((m, s) => Math.max(m, s.order + 1), 0);
      state.spaces[space.id] = {
        id: space.id,
        name: space.name ?? existing?.name ?? '',
        order: nextOrder,
        // The reducer owns the LWW key — a fresh stamp on every upsert so the
        // newest create/rename/reorder wins the per-id merge. An upsert also
        // clears a soft-delete (re-creating a deleted id revives it).
        updatedAt: Date.now(),
      };
      break;
    }
    case 'SPACE_DELETE': {
      const { id } = action.payload;
      if (!id || id === DEFAULT_SPACE_ID) break; // never deletable
      const existing = state.spaces[id];
      // Mint the tombstone even for a locally-unknown id — a remote registry
      // may still carry it, and the newer deleted record wins the merge.
      state.spaces[id] = {
        id,
        name: existing?.name ?? '',
        order: existing?.order ?? 0,
        updatedAt: Date.now(),
        deleted: true,
      };
      // Reassign member panes to the default space (absent ⟺ default, so we
      // drop the field rather than stamping DEFAULT_SPACE_ID).
      for (const pane of Object.values(state.panes)) {
        if (pane.spaceId === id) delete pane.spaceId;
      }
      // Device-local fixup: if this window was LOOKING at the deleted space,
      // fall back to the default one.
      if (state.activeSpaceId === id) state.activeSpaceId = DEFAULT_SPACE_ID;
      break;
    }
    case 'SET_ACTIVE_SPACE': {
      // A dead/unknown target resolves to the default space so the window can
      // never strand itself on a space that no longer exists.
      const target = isLiveSpaceId(action.payload.id, state.spaces)
        ? action.payload.id
        : DEFAULT_SPACE_ID;
      if (state.activeSpaceId === target) break;
      state.activeSpaceId = target;
      // Focus handoff: keyboard shortcuts and the close-next-focus math must
      // never target an invisible pane. If the focused pane isn't in the new
      // space (or nothing is focused), focus the first visible pane — or null
      // for an empty space.
      const focused = state.focusedPaneId ? state.panes[state.focusedPaneId] : undefined;
      if (!focused || resolvePaneSpace(focused, state.spaces) !== target) {
        state.focusedPaneId = firstPaneInSpace(state, target);
      }
      break;
    }
  }
}
