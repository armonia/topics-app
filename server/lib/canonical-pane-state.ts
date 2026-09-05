/**
 * A project pane names its folder the way it was opened; the topics name it
 * the way it IS.
 *
 * `server/routes/topics.ts` stores `topic.projectPath` canonical (links
 * resolved, see `canonical-project-path.ts`). The pane `project:<path>` in
 * `pane-store-v2` keeps the RAW path it was born with, and the client matches
 * the two by string (`useProjectChatSync`, `signals.ts`). A window opened
 * from a pane whose path goes through a symlink therefore shows NO chat: every
 * topic of that folder is filed under the resolved path. Browser and file
 * panes never go through that comparison, which is why it looked like a
 * chat-only fault. And the raw pane feeds itself: the sidebar derives a
 * project entry from the persisted pane ids, so every click reopens it raw.
 *
 * The fix lives on the SERVER, on the value it serves and on the row it
 * repairs at boot: the client keeps its own path unchanged.
 *
 * WHY A TOMBSTONE AND NOT JUST THE RENAME. The client hydrate is a UNION of the
 * local snapshot (localStorage) and the server one. Serving the canonical pane
 * while a device still holds the raw one in localStorage would show TWO tabs
 * of the same project. Absence is not a close (that is the rule of
 * `services/pane-retirement-cascade.ts`); a tombstone on the raw id is. It
 * carries `seq: 0`, the "I do not know when" marker that beats every local
 * `openedSeq`, so the raw copy dies on every device. A `project:` pane holds no
 * topic and no terminal session, so the retirement cascade that tombstone
 * triggers archives nothing (proven in the test file next to this one).
 *
 * PURE: the canonicalisation arrives as a parameter, so the tests never touch
 * the filesystem and the boot repair and the read path share one decision.
 */
import { projectPanesKey } from "../../shared/project-keys";

const PROJECT_PANE_PREFIX = "project:";

/** Snapshot keys whose entries are keyed by pane id but must NOT be remapped:
 *  a tombstone names the id that was CLOSED, and the raw id is exactly the
 *  one to keep closed. Moving it onto the canonical id would mark the live
 *  pane as closed. */
const TOMBSTONE_KEYS = new Set(["tombstones", "tombstoneSeqs"]);

export interface ProjectPathPair {
  raw: string;
  canon: string;
}

export interface CanonicalPaneSnapshotResult {
  /** The snapshot to serve. The SAME reference as the input when nothing changed. */
  value: unknown;
  /** Every raw path found, with the canonical path it resolves to. Empty = untouched. */
  pairs: ProjectPathPair[];
}

export interface UiStateKeyRename {
  from: string;
  to: string;
}

export function projectPaneId(projectPath: string): string {
  return PROJECT_PANE_PREFIX + encodeURIComponent(projectPath);
}

/** The path a `project:` pane id encodes, or null for any other id (or a corrupt encoding). */
export function projectPathOfPaneId(id: string): string | null {
  if (!id.startsWith(PROJECT_PANE_PREFIX)) return null;
  try {
    return decodeURIComponent(id.slice(PROJECT_PANE_PREFIX.length));
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Rewrite a `pane-store-v2` snapshot so every project pane names its folder
 * by the canonical path.
 *
 * For each pane `project:<raw>` whose `canon(raw)` differs: the pane id and
 * every string equal to the raw id or the raw path (pane `projectPath`,
 * `closedStack[].projectPath`, group `paneIds`, any map keyed by pane id) are
 * rewritten. When the canonical pane ALREADY exists, the raw pane is dropped
 * and its references point at the existing one, so no duplicate is born. In
 * both cases the raw id gets a tombstone (see the file header).
 */
export function canonicalPaneSnapshot(
  value: unknown,
  canon: (p: string) => string,
  now: number = Date.now(),
): CanonicalPaneSnapshotResult {
  if (!isPlainObject(value) || !isPlainObject(value.panes)) return { value, pairs: [] };

  const pairs: ProjectPathPair[] = [];
  const remap = new Map<string, string>();
  for (const id of Object.keys(value.panes)) {
    const raw = projectPathOfPaneId(id);
    if (raw === null) continue;
    const c = canon(raw);
    if (!c || c === raw) continue;
    pairs.push({ raw, canon: c });
    remap.set(id, projectPaneId(c));
    remap.set(raw, c);
  }
  if (pairs.length === 0) return { value, pairs };

  const rewrite = (o: unknown): unknown => {
    if (typeof o === "string") return remap.get(o) ?? o;
    if (Array.isArray(o)) {
      const out = o.map(rewrite);
      // A tab strip listing raw and canonical side by side now lists the same id twice.
      return out.every((x) => typeof x === "string") ? [...new Set(out as string[])] : out;
    }
    if (isPlainObject(o)) {
      const out: Record<string, unknown> = {};
      const entries = Object.entries(o);
      // Two passes, canonical keys first: the raw entry takes a slot only when
      // it is still free, so an existing canonical pane always wins over the
      // raw twin (same rule as `dropVanishedProjectPanes`).
      for (const [k, v] of entries) if (!remap.has(k)) out[k] = rewrite(v);
      for (const [k, v] of entries) {
        if (!remap.has(k)) continue;
        const nk = remap.get(k)!;
        if (nk in out) continue;
        out[nk] = rewrite(v);
      }
      return out;
    }
    return o;
  };

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = TOMBSTONE_KEYS.has(k) ? v : rewrite(v);
  }

  // A pane may live in ONE group. After the remap, a raw pane in group A and
  // its canonical twin in group B would put the same id in two tab strips.
  if (isPlainObject(out.groups)) {
    const canonicalIds = new Set(pairs.map((p) => projectPaneId(p.canon)));
    const claimed = new Set<string>();
    for (const g of Object.values(out.groups)) {
      if (!isPlainObject(g) || !Array.isArray(g.paneIds)) continue;
      g.paneIds = g.paneIds.filter((id) => {
        if (typeof id !== "string" || !canonicalIds.has(id)) return true;
        if (claimed.has(id)) return false;
        claimed.add(id);
        return true;
      });
    }
  }

  const tombstones = isPlainObject(out.tombstones) ? { ...out.tombstones } : {};
  for (const p of pairs) {
    const rawId = projectPaneId(p.raw);
    if (!(rawId in tombstones)) tombstones[rawId] = { at: now, seq: 0 };
  }
  out.tombstones = tombstones;

  return { value: out, pairs };
}

/**
 * The per-project `ui_state` rows that must follow the pane: their key is a
 * HASH of the path, so once the raw path leaves the snapshot nobody can
 * compute the old key any more. The hash comes from `shared/project-keys.ts`,
 * the single source the client reads with.
 */
export function projectPanesKeyRenames(pairs: readonly ProjectPathPair[]): UiStateKeyRename[] {
  const out: UiStateKeyRename[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    const from = projectPanesKey(p.raw);
    const to = projectPanesKey(p.canon);
    if (from === to || seen.has(from)) continue;
    seen.add(from);
    out.push({ from, to });
  }
  return out;
}
