import { walkFileTree, type FileNode } from "./file-tree";

const FALLBACK_TTL_MS = 5_000;
const WATCHED_MAX_AGE_MS = 60_000;
const MAX_ENTRIES = 200;

type Entry = { tree: FileNode[]; timestamp: number };
const cache = new Map<string, Entry>();
const walksInFlight = new Map<string, Promise<FileNode[]>>();
const watchedPaths = new Set<string>();

function keyOf(root: string, depth: number): string {
  return `${root}\0${depth}`;
}

/** Reads from memory while the file watcher is live, for at most 60 s from the walk; 5 s without it. */
export async function getFileTree(
  root: string,
  depth: number,
  walk: typeof walkFileTree = walkFileTree,
  now: () => number = () => performance.now(),
): Promise<FileNode[]> {
  const key = keyOf(root, depth);
  const hit = cache.get(key);
  const maxAge = watchedPaths.has(root) ? WATCHED_MAX_AGE_MS : FALLBACK_TTL_MS;
  if (hit) {
    const timestamp = now();
    if (timestamp - hit.timestamp < maxAge) {
      return hit.tree;
    }
  }
  const inFlight = walksInFlight.get(key);
  if (inFlight) return inFlight;

  const round = walk(root, depth).then((tree) => {
    // A watcher may invalidate an in-flight walk; do not cache its stale result.
    if (walksInFlight.get(key) === round) {
      if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
        const oldest = [...cache].reduce((a, b) => a[1].timestamp <= b[1].timestamp ? a : b)[0];
        cache.delete(oldest);
      }
      cache.set(key, { tree, timestamp: now() });
    }
    return tree;
  }).finally(() => {
    if (walksInFlight.get(key) === round) walksInFlight.delete(key);
  });
  walksInFlight.set(key, round);
  return round;
}

/** Invalidates every cached depth for this project. */
export function invalidateFileTreeCache(root: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${root}\0`)) cache.delete(key);
  for (const key of walksInFlight.keys()) if (key.startsWith(`${root}\0`)) walksInFlight.delete(key);
}

export function setFileTreeWatcher(root: string, active: boolean): void {
  if (active) watchedPaths.add(root);
  else watchedPaths.delete(root);
}
