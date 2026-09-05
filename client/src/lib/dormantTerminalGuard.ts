/**
 * dormantTerminalGuard — what the client knows about PARKED terminal sessions,
 * and how it stops a prune from running ahead of that knowledge.
 *
 * The roster (`terminal:sessions`) is built from the server's in-memory session
 * map, so a session that exits leaves it immediately. Two very different things
 * look identical from there:
 *   - the row was DELETED (a shell that ended, a launch that failed): gone,
 *   - the row was parked `dormant` (a claude session that exited with a
 *     `claude_session_id`, or the idle reaper): alive and `--resume`-able.
 * Only `GET /api/terminal/sessions/dormant` separates them, and a list read at
 * mount says nothing about a session that exits ten minutes later.
 *
 * So this guard is not a cache to read: it is a question to ask again.
 * `recheck(ids)` is called the moment a pane's session vanishes; until the
 * answer lands those ids are neither dormant nor gone and the pane stays up.
 * `onUpdate` then re-runs the prune with the fresh sets, where each id is
 * either parked (kept) or in `confirmedGoneIds` (pruned, once and for good).
 *
 * The list is fetched WITHOUT the `cwd` filter on purpose: "is this id parked?"
 * is a property of the id. The filter was scoping a mount-time auto-revive that
 * no longer exists, and it silently missed the parked sessions of a
 * SUBDIRECTORY of the project - which the project window adopts by prefix, and
 * would then have pruned.
 */

import { BOOT_READ_TTL_MS, coalescedFetch } from './coalesceFetch';

/** Answers with the ids the server currently lists as parked. */
export type DormantIdsFetcher = () => Promise<readonly string[]>;

export interface DormantTerminalGuard {
  /** Has a dormant list answered (or failed) at least once? A prune that runs
   *  before this knows nothing and must keep everything. */
  readonly loaded: boolean;
  /** Ids parked as resumable rows: keep their panes. */
  readonly dormantIds: ReadonlySet<string>;
  /** Ids a read taken AFTER their disappearance did not list: prune them. */
  readonly confirmedGoneIds: ReadonlySet<string>;
  /** Initial read (mount). Raises `loaded` even when it fails. */
  load(): void;
  /** These pane sessions just left the roster: re-read before pruning them. */
  recheck(ids: Iterable<string>): void;
}

async function fetchDormantIds(): Promise<readonly string[]> {
  // One guard per project window, all loading at boot: coalesced into one GET.
  const res = await coalescedFetch('/api/terminal/sessions/dormant', undefined, { ttlMs: BOOT_READ_TTL_MS });
  if (!res.ok) throw new Error(`dormant list: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error('dormant list: not an array');
  return body
    .map(row => (row && typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : null))
    .filter((id): id is string => id !== null);
}

/** What the guard knows right now, as a value that can be put in state. */
export interface DormantKnowledge {
  dormantIds: ReadonlySet<string>;
  confirmedGoneIds: ReadonlySet<string>;
}

export interface DormantTerminalGuardOptions {
  /** Called whenever the guard learned something: re-run the prune. Receives a
   *  SNAPSHOT, so a consumer that re-runs on a state change (React) can store it
   *  instead of reading a mutating object. */
  onUpdate: (knowledge: DormantKnowledge) => void;
  /** Seam for tests; defaults to the real endpoint. */
  fetcher?: DormantIdsFetcher;
}

export function createDormantTerminalGuard(options: DormantTerminalGuardOptions): DormantTerminalGuard {
  const fetcher = options.fetcher ?? fetchDormantIds;
  let loaded = false;
  let dormantIds: ReadonlySet<string> = new Set<string>();
  const confirmedGoneIds = new Set<string>();
  /** Ids whose fate this run is meant to settle. */
  let pending = new Set<string>();
  let inFlight = false;

  const run = () => {
    if (inFlight) return;
    inFlight = true;
    const asked = pending;
    pending = new Set<string>();
    void fetcher()
      .then(ids => {
        dormantIds = new Set(ids);
        // Asked about, and the FRESH answer does not park it: really gone. This
        // is the only way a pane ever gets pruned after a disappearance, and it
        // is what stops `verify` from repeating forever.
        for (const id of asked) if (!dormantIds.has(id)) confirmedGoneIds.add(id);
      })
      .catch(() => {
        // No answer. Not knowing must not turn into "never prune": settle the
        // ids we asked about as gone, which is exactly the behaviour that
        // preceded this guard - never worse.
        for (const id of asked) confirmedGoneIds.add(id);
      })
      .finally(() => {
        loaded = true;
        inFlight = false;
        options.onUpdate({ dormantIds, confirmedGoneIds: new Set(confirmedGoneIds) });
        // Ids that vanished while this read was in flight were not covered by
        // it: they get their own read, on their own answer.
        if (pending.size > 0) run();
      });
  };

  return {
    get loaded() { return loaded; },
    get dormantIds() { return dormantIds; },
    get confirmedGoneIds() { return confirmedGoneIds as ReadonlySet<string>; },
    load() {
      run();
    },
    recheck(ids: Iterable<string>) {
      let added = false;
      for (const id of ids) {
        if (dormantIds.has(id) || confirmedGoneIds.has(id) || pending.has(id)) continue;
        pending.add(id);
        added = true;
      }
      if (added) run();
    },
  };
}
