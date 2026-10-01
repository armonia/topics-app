/**
 * THE SERVERS A CHAT RUNS, as the client keeps them (BGVIS-08).
 *
 * A `run_command` that listens on a port and does not wake its chat is a
 * server, not work the chat waits for: the server leaves it out of the
 * background rows of `GET /api/topics/streaming` (so no grey ring, no waiting
 * line, no active agent) and lists it in `services`. This keeps that list by
 * topic for the chat's server row, apart from the background work on purpose:
 * nothing that reads the background work (glyphs, the composer's Stop, the
 * agent list) may see a server.
 *
 * Every poll answers with new objects; an entry that did not change keeps its
 * reference, so the row of a chat whose servers did not change does not render.
 */
import { useSyncExternalStore } from 'react';
import type { RunningServiceSummary, TopicServices } from '../../../shared/background-work';

type ServicesByTopic = ReadonlyMap<string, readonly RunningServiceSummary[]>;

const EMPTY: ServicesByTopic = new Map();
let current: ServicesByTopic = EMPTY;
const listeners = new Set<() => void>();

/** The next map from a poll's `services`, keeping every unchanged entry, and `prev` itself when nothing changed. */
export function mergeServices(prev: ServicesByTopic, rows: ReadonlyArray<TopicServices> | undefined): ServicesByTopic {
  const next = new Map<string, readonly RunningServiceSummary[]>();
  let changed = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.topicId || !Array.isArray(row.services) || row.services.length === 0) continue;
    const old = prev.get(row.topicId);
    if (old && JSON.stringify(old) === JSON.stringify(row.services)) next.set(row.topicId, old);
    else { next.set(row.topicId, row.services); changed = true; }
  }
  if (!changed && next.size === prev.size) return prev;
  return next.size === 0 ? EMPTY : next;
}

/** Adopt a poll's `services` (an older server sends none: no servers). */
export function setRunningServices(rows: ReadonlyArray<TopicServices> | undefined): void {
  const next = mergeServices(current, rows);
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** A chat's servers, running or just ended, or undefined. A stable reference while they do not change. */
export function useTopicRunningServices(topicId: string | undefined): readonly RunningServiceSummary[] | undefined {
  return useSyncExternalStore(subscribe, () => (topicId ? current.get(topicId) : undefined));
}
