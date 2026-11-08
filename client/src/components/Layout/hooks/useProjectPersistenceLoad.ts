import { useEffect, useRef } from 'react';
import type { PersistedSnapshot, PersistenceGateRefs } from './types';
import { loadPersistedState, markChatSyncComplete, unsubscribeFromProjectLayout } from './projectPersistence';

export interface UseProjectPersistenceLoadArgs {
  projectPath: string;
}

export interface UseProjectPersistenceLoadReturn {
  /** The snapshot loaded from localStorage at mount, possibly mutated
   *  in place by `bumpInitial` when the server-fetch path delivers
   *  fresher data. Effects/handlers that read this MUST tolerate the
   *  in-place mutation (don't snapshot it into a closure variable
   *  expecting it to stay frozen). The initial useState seeders in
   *  the component read it once at mount, which is what the caller
   *  wants — no re-render on bumps. */
  initial: PersistedSnapshot | null;
  /** Cross-hook sync gates. Same ref instances passed to other hooks
   *  so flag flips are visible everywhere. */
  gateRefs: PersistenceGateRefs;
  /** Called when the initial chat-tab restoration completes (whichever
   *  path runs first — server-fetch OR chat-sync mount). Idempotent. */
  markChatSyncDone: () => void;
  /** Register the (single) callback that receives async server-fetched
   *  snapshots. Pass `null` to unregister. */
  setOnServerHydrate: (cb: ((fresh: PersistedSnapshot) => void) | null) => void;
  /** Mutate `initial` in place by merging new fields. Preserves the
   *  original `persisted.current = { ...persisted.current, ...fresh }`
   *  semantics from the pre-refactor code so downstream readers (chat-
   *  sync's first-run branch, restore-active-chat) see the latest data. */
  bumpInitial: (fresh: PersistedSnapshot) => void;
}

/**
 * Owns the read-side of project-window persistence:
 *  - Loads the initial snapshot from localStorage at mount.
 *  - Subscribes to async server hydration via `loadPersistedState`'s
 *    callback param and forwards into the registered onServerHydrate.
 *  - Holds the cross-hook `initialChatsSyncedRef` gate so all hooks
 *    converge on the same "initial restore done" flag.
 *
 * Does NOT save anything — that's `useProjectPersistenceSave`'s job.
 */
export function useProjectPersistenceLoad(
  args: UseProjectPersistenceLoadArgs,
): UseProjectPersistenceLoadReturn {
  const initialChatsSyncedRef = useRef(false);

  // Load snapshot once (per `projectPath`). Use a ref so re-renders don't
  // re-call `loadPersistedState` (which is synchronous I/O — cheap, but
  // unnecessary).
  const snapshotRef = useRef<PersistedSnapshot | null>(null);
  const loadedForPathRef = useRef<string | null>(null);
  // Lazy load-on-path-change: reseed the snapshot synchronously during render
  // when projectPath changes (and on first render). This is the documented
  // "derive from props during render" pattern — consumers read `initial` only
  // in mount-only useState seeders or via a per-render ref mirror, and
  // `bumpInitial` deliberately mutates this ref in place WITHOUT a re-render
  // (see the `initial` JSDoc), so a ref is the correct store here, not state.
  // eslint-disable-next-line react-hooks/refs -- intentional render-time reseed keyed on projectPath; ref store is required to avoid re-render on in-place bumpInitial mutations
  if (loadedForPathRef.current !== args.projectPath) {
    // eslint-disable-next-line react-hooks/refs -- write paired with the guarded read above; reseeds snapshot for the new projectPath
    snapshotRef.current = loadPersistedState(args.projectPath);
    // eslint-disable-next-line react-hooks/refs -- marks the path this snapshot was loaded for, so subsequent same-path renders skip the reload
    loadedForPathRef.current = args.projectPath;
  }

  const onServerHydrateRef = useRef<((fresh: PersistedSnapshot) => void) | null>(null);

  // Async hydration: subscribe to fresher snapshots (WS init / cross-device
  // sync) and forward them to whoever registered onServerHydrate. Reset the
  // initial-restore gate whenever `projectPath` changes (a project switch is a
  // fresh load).
  useEffect(() => {
    initialChatsSyncedRef.current = false;
    loadPersistedState(args.projectPath, (fresh) => {
      // No userEditedRef gate here: cross-device hydration is additive (union)
      // in onServerHydrate, so forwarding a remote snapshot can only ADD tabs
      // this device is missing — it can never clobber a local edit. Echo/stale
      // frames are already filtered in projectLayoutSync.applyServerValue
      // (sourceClientId + server_seq + last-synced-JSON) before reaching here.
      onServerHydrateRef.current?.(fresh);
    });
    // Drop the cross-device subscription when this project unmounts or the path
    // changes, so the per-project callback + its WS fan-out slot don't leak for
    // the life of the page.
    return () => unsubscribeFromProjectLayout(args.projectPath);
  }, [args.projectPath]);

  // eslint-disable-next-line react-hooks/refs -- the returned object exposes/mutates the snapshot reseeded during render above. `initial` is read only in mount-only useState seeders or a per-render ref mirror; `bumpInitial` runs later (server-hydrate) and merges in place by design so readers see fresher data WITHOUT a re-render (see the `initial` JSDoc). A ref is the correct store here, not state.
  return {
    // eslint-disable-next-line react-hooks/refs -- see the disable above: this snapshot read during render is intentional; `initial` is consumed only by mount-only seeders / a per-render ref mirror
    initial: snapshotRef.current,
    gateRefs: { initialChatsSyncedRef },
    markChatSyncDone: () => markChatSyncComplete(args.projectPath),
    setOnServerHydrate: (cb) => {
      onServerHydrateRef.current = cb;
    },
    bumpInitial: (fresh) => {
      snapshotRef.current = { ...snapshotRef.current, ...fresh } as PersistedSnapshot;
    },
  };
}
