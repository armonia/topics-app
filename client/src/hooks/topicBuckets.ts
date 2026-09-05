/**
 * The topics map in two halves: the LIVE topics and the ARCHIVED ones.
 *
 * WHY TWO. On 2026-09-05 the workspace of the person using the app held 1,554
 * topics, 1,535 of them archived. The boot payload carried all of them (872 KB,
 * 1.4 s on a loaded machine) for the 19 the sidebar draws, and `topics-cache`
 * rewrote all 872 KB into the WebKit localStorage journal on every change of
 * any topic - the journal had reached 5 GB. So:
 *
 *  - the live half is the boot list (`GET /api/topics`) and `topics-cache`;
 *  - the archived half comes later (`GET /api/topics?archived=1`, in idle or
 *    when a surface asks for it) and lives in `topics-archived-cache`, which
 *    is written ONLY when the archived set changes - a rename of a live chat
 *    must not cost a rewrite of 1,535 rows it did not touch.
 *
 * Consumers still read ONE map (`mergeBuckets`): a topic is a topic wherever it
 * sits. What this module guarantees is IDENTITY: every operation returns the
 * same bucket object when that bucket did not change, so the cache writer can
 * key its "did anything change" on `!==` and never serialise the archive to
 * find out it was identical. See `persistBuckets` and STORAGE-WAL-01.
 */
import type { Topic } from '../types';
import type { ThrottledWriter } from '../lib/throttledLocalWrite';

/** The live topics, as the first frame reads them. */
export const LIVE_CACHE_KEY = 'topics-cache';
/** The archived topics, written only when the archive changes. */
export const ARCHIVED_CACHE_KEY = 'topics-archived-cache';

export interface TopicBuckets {
  live: Record<string, Topic>;
  archived: Record<string, Topic>;
}

/** Which halves the server has answered for at least once. Before that, an
 *  EMPTY bucket is "not loaded yet", not "there are none", and must not be
 *  written over a cache that may hold the truth. */
export interface BucketsKnown {
  live: boolean;
  archived: boolean;
}

export function emptyBuckets(): TopicBuckets {
  return { live: {}, archived: {} };
}

/** The whole map as consumers read it: one lookup, both halves. */
export function mergeBuckets(b: TopicBuckets): Record<string, Topic> {
  return { ...b.archived, ...b.live };
}

/** A map sorted by its flag: how both caches are written, and how a
 *  `topics-cache` written before the split (live and archived mixed) is read. */
export function splitByArchived(map: Record<string, Topic>): TopicBuckets {
  const out = emptyBuckets();
  for (const [id, topic] of Object.entries(map)) {
    (topic.archived ? out.archived : out.live)[id] = topic;
  }
  return out;
}

/**
 * Put each topic in the bucket its flag says, and out of the other one.
 * Returns the SAME object when nothing changed, and keeps the identity of a
 * bucket no topic entered or left.
 */
export function upsertTopics(b: TopicBuckets, topics: Iterable<Topic>): TopicBuckets {
  let live: Record<string, Topic> | null = null;
  let archived: Record<string, Topic> | null = null;
  for (const topic of topics) {
    if (topic.archived) {
      archived ??= { ...b.archived };
      archived[topic.id] = topic;
      if (topic.id in b.live) {
        live ??= { ...b.live };
        delete live[topic.id];
      }
    } else {
      live ??= { ...b.live };
      live[topic.id] = topic;
      if (topic.id in b.archived) {
        archived ??= { ...b.archived };
        delete archived[topic.id];
      }
    }
  }
  if (!live && !archived) return b;
  return { live: live ?? b.live, archived: archived ?? b.archived };
}

/**
 * The live list came back from the server: it IS the live bucket now. A topic
 * it carries leaves the archive (reopened on another device); the archive is
 * otherwise untouched, identity included.
 */
export function replaceLive(b: TopicBuckets, live: Record<string, Topic>): TopicBuckets {
  let archived: Record<string, Topic> | null = null;
  for (const id of Object.keys(live)) {
    if (id in b.archived) {
      archived ??= { ...b.archived };
      delete archived[id];
    }
  }
  return { live, archived: archived ?? b.archived };
}

/**
 * The ids that were live and are in neither half of the fresh list: archived
 * on another device while this one was disconnected, or deleted. Somebody has
 * to ask the server which - `GET /api/topics/:id` says.
 */
export function vanishedFrom(b: TopicBuckets, live: Record<string, Topic>): string[] {
  return Object.keys(b.live).filter((id) => !(id in live) && !(id in b.archived));
}

/** The archive came back from the server: it IS the archived bucket now, and
 *  an id it carries leaves the live bucket. */
export function replaceArchived(b: TopicBuckets, archived: Record<string, Topic>): TopicBuckets {
  let live: Record<string, Topic> | null = null;
  for (const id of Object.keys(archived)) {
    if (id in b.live) {
      live ??= { ...b.live };
      delete live[id];
    }
  }
  return { live: live ?? b.live, archived };
}

function parseMap(raw: string | null): Record<string, Topic> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, Topic>;
  } catch { /* a cache is a hint, never an error */ }
  return null;
}

/**
 * The two caches as the first frame reads them. Each entry goes where its
 * flag says, whichever key it was found under: a `topics-cache` written before
 * the split still carries the archive, and the first boot after the update
 * paints the same sidebar - then writes the two caches apart.
 */
export function readTopicCaches(storage: Pick<Storage, 'getItem'>): TopicBuckets {
  let out = emptyBuckets();
  for (const key of [LIVE_CACHE_KEY, ARCHIVED_CACHE_KEY]) {
    const map = parseMap(storage.getItem(key));
    if (map) out = upsertTopics(out, Object.values(map));
  }
  return out;
}

/**
 * Write each half that changed, and only that one. `prev` is the buckets the
 * last write saw (`null` on the first frame). A bucket that is empty and not
 * yet answered for by the server is skipped: it is "not loaded", not "none".
 */
export function persistBuckets(
  prev: TopicBuckets | null,
  next: TopicBuckets,
  writers: { live: ThrottledWriter; archived: ThrottledWriter },
  known: BucketsKnown,
): void {
  for (const half of ['live', 'archived'] as const) {
    if (prev && prev[half] === next[half]) continue;
    if (!known[half] && Object.keys(next[half]).length === 0) continue;
    const map = next[half];
    writers[half].write(() => JSON.stringify(map));
  }
}

/**
 * What ONE topic looks like in the LIST. `GET /api/topics/:id` answers whole -
 * prompt and browser state included - and the map (and its cache) must not
 * grow those fields one lookup at a time; the flag is what a list keeps.
 */
export function toListShape(topic: Topic): Topic {
  const { systemPrompt, browserState: _browserState, ...rest } = topic;
  return systemPrompt ? { ...rest, hasSystemPrompt: true } : rest;
}
