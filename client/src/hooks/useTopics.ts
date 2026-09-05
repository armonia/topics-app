import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { Topic, CreateTopicRequest, UpdateTopicRequest } from '../types';
import { topicsApi } from '../lib/api';
import { createThrottledLocalWriter } from '../lib/throttledLocalWrite';
import { useRefMirror } from './useRefMirror';
import {
  ARCHIVED_CACHE_KEY,
  LIVE_CACHE_KEY,
  emptyBuckets,
  mergeBuckets,
  persistBuckets,
  readTopicCaches,
  replaceArchived,
  replaceLive,
  toListShape,
  upsertTopics,
  vanishedFrom,
  type BucketsKnown,
  type TopicBuckets,
} from './topicBuckets';

/**
 * The caches of this hook go through a throttled writer, and it is not a
 * micro-optimisation: `topics-cache` was the whole topics map (about 1 MB on a
 * workspace of a thousand topics) and it used to be rewritten on EVERY change
 * of the state, so a burst of WebSocket updates was a burst of megabytes into
 * the WebKit localStorage journal, which is never checkpointed while the
 * webview lives. Two seconds of window, plus the skip when the bytes are
 * identical, and the burst costs one write or none. Nobody reads these keys
 * before the next boot, and the writer flushes on `pagehide`, so the delay
 * costs nothing. See `lib/throttledLocalWrite.ts`.
 *
 * And the map is in TWO halves (see `topicBuckets.ts`): the live topics are
 * the boot list and `topics-cache`; the archived ones - 1,535 of 1,554 on the
 * workspace this was measured on - come later, in idle or when a surface asks,
 * and go to `topics-archived-cache`, written only when the archive changes.
 */
const TOPICS_CACHE_DEBOUNCE_MS = 2000;
const liveCacheWriter = createThrottledLocalWriter({
  key: LIVE_CACHE_KEY,
  debounceMs: TOPICS_CACHE_DEBOUNCE_MS,
});
const archivedCacheWriter = createThrottledLocalWriter({
  key: ARCHIVED_CACHE_KEY,
  debounceMs: TOPICS_CACHE_DEBOUNCE_MS,
});
const workspaceProjectsCacheWriter = createThrottledLocalWriter({
  key: 'workspace-projects-cache',
  debounceMs: TOPICS_CACHE_DEBOUNCE_MS,
});

/**
 * When the archive is asked for after the first live list: at the browser's
 * next idle moment, and no later than this. WebKit (the desktop shell) has no
 * `requestIdleCallback`, so there the wait is the fallback alone - after the
 * first frame, which is all the boot path needs.
 */
const ARCHIVE_IDLE_TIMEOUT_MS = 3000;
const ARCHIVE_IDLE_FALLBACK_MS = 1500;

function whenIdle(fn: () => void): void {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(fn, { timeout: ARCHIVE_IDLE_TIMEOUT_MS });
  } else {
    setTimeout(fn, ARCHIVE_IDLE_FALLBACK_MS);
  }
}

function getInitialBuckets(): TopicBuckets {
  try {
    return readTopicCaches(localStorage);
  } catch {
    return emptyBuckets();
  }
}

function getInitialWorkspaceProjects(): string[] {
  try {
    const cached = localStorage.getItem('workspace-projects-cache');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

export function useTopics() {
  const [buckets, setBuckets] = useState<TopicBuckets>(getInitialBuckets);
  const bucketsRef = useRefMirror(buckets);
  /** Which halves the server has answered for at least once (see persistBuckets). */
  const knownRef = useRef<BucketsKnown>({ live: false, archived: false });
  const archivedLoadRef = useRef<Promise<void> | null>(null);
  const archiveScheduledRef = useRef(false);
  const [workspaceProjects, setWorkspaceProjects] = useState<string[]>(getInitialWorkspaceProjects);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** The one map every consumer reads: both halves, one lookup. */
  const topics = useMemo(() => mergeBuckets(buckets), [buckets]);

  /**
   * ONE topic, from the map or from the server. The map is the live list plus
   * whatever of the archive has arrived; a link, a notification or a tab can
   * name a closed chat before that, and `GET /api/topics/:id` answers for any
   * one of them. `reopen` is the 2-state model's "open": an archived topic is
   * unarchived on the server BEFORE it enters the map, so the validation that
   * evicts archived tabs never sees it archived. `null` when the topic is
   * gone (404) or the server did not answer.
   */
  const ensureTopic = useCallback(async (id: string, opts?: { reopen?: boolean }): Promise<Topic | null> => {
    const known = bucketsRef.current.live[id] ?? bucketsRef.current.archived[id];
    if (known) return known;
    try {
      let topic = toListShape(await topicsApi.get(id));
      if (opts?.reopen && topic.archived) topic = toListShape(await topicsApi.archive(id, false));
      setBuckets(prev => upsertTopics(prev, [topic]));
      return topic;
    } catch (err) {
      console.warn(`Topic ${id} could not be resolved:`, err);
      return null;
    }
  }, [bucketsRef]);

  /**
   * The archive, once. Deduplicated: every surface that needs the archived
   * topics (the sidebar's archived section, the search palette, the idle load
   * after boot) calls this and the first call is the only request.
   */
  const ensureArchivedTopics = useCallback((): Promise<void> => {
    if (knownRef.current.archived) return Promise.resolve();
    if (archivedLoadRef.current) return archivedLoadRef.current;
    const load = (async () => {
      try {
        const data = await topicsApi.getArchived();
        knownRef.current.archived = true;
        setBuckets(prev => replaceArchived(prev, data.topics));
      } catch (err) {
        console.error('Failed to load archived topics:', err);
      } finally {
        archivedLoadRef.current = null;
      }
    })();
    archivedLoadRef.current = load;
    return load;
  }, []);

  const loadTopics = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      // Timeout after 6s — fall back to cache instead of hanging forever
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      let data: Awaited<ReturnType<typeof topicsApi.getAll>>;
      try {
        data = await topicsApi.getAll(controller.signal);
      } finally {
        clearTimeout(timer);
      }
      knownRef.current.live = true;
      // A live topic that is in neither half of the fresh list was archived on
      // another device while this one was disconnected, or deleted. Asked for
      // one by one - usually none - only once the archive is loaded: before
      // that the archive load itself brings them.
      const vanished = knownRef.current.archived ? vanishedFrom(bucketsRef.current, data.topics) : [];
      setBuckets(prev => replaceLive(prev, data.topics));
      for (const id of vanished) void ensureTopic(id);
      if (data.workspaceProjects) {
        setWorkspaceProjects(data.workspaceProjects);
        workspaceProjectsCacheWriter.write(() => JSON.stringify(data.workspaceProjects));
      }
      // The archive comes AFTER the first frame, not with it: this is the
      // boot path and every WS reconnect, and 99% of the rows are archived.
      if (!archiveScheduledRef.current) {
        archiveScheduledRef.current = true;
        whenIdle(() => { void ensureArchivedTopics(); });
      }
    } catch (err: unknown) {
      console.error('Failed to load topics:', err);
      // Narrow the opaque caught value to the Error-ish fields we read.
      const errLike = (err ?? {}) as { name?: unknown; message?: unknown };
      const isTimeout = errLike.name === 'AbortError';
      const hasCachedData = Object.keys(bucketsRef.current.live).length > 0;
      if (hasCachedData) {
        setError(isTimeout ? 'Server slow, showing cached data' : 'Using cached data, server unreachable');
      } else {
        setError(isTimeout ? 'Server not responding, retrying…' : (err instanceof Error ? err.message : 'Failed to load topics'));
      }
      // Auto-retry once after timeout or network error. Engine spread:
      // Chromium says "Failed to fetch", Firefox "NetworkError", WebKit
      // (the Tauri WKWebView shell!) says "Load failed" — missing that last
      // one meant a desktop client that hiccuped during a server restart
      // NEVER retried: the "Using cached data" notice stuck forever while
      // the WS was already reconnected (reported live 2026-07-11).
      const message = typeof errLike.message === 'string' ? errLike.message : '';
      const isNetworkError =
        message.includes('Failed to fetch') ||
        message.includes('NetworkError') ||
        message.includes('Load failed');
      if (isTimeout || isNetworkError) {
        setTimeout(() => loadTopics(), 3000);
      }
    } finally {
      setLoading(false);
    }
  }, [bucketsRef, ensureTopic, ensureArchivedTopics]);

  const createTopic = useCallback(async (data: CreateTopicRequest): Promise<Topic | null> => {
    try {
      setError(null);
      const topic = await topicsApi.create(data);
      setBuckets(prev => upsertTopics(prev, [topic]));
      return topic;
    } catch (err) {
      console.error('Failed to create topic:', err);
      setError(err instanceof Error ? err.message : 'Failed to create topic');
      return null;
    }
  }, []);

  const updateTopic = useCallback(async (id: string, data: UpdateTopicRequest): Promise<Topic | null> => {
    try {
      setError(null);
      const topic = await topicsApi.update(id, data);
      setBuckets(prev => upsertTopics(prev, [topic]));
      return topic;
    } catch (err) {
      console.error('Failed to update topic:', err);
      setError(err instanceof Error ? err.message : 'Failed to update topic');
      return null;
    }
  }, []);

  const archiveTopic = useCallback(async (id: string, archived: boolean = true): Promise<boolean> => {
    // The flag flip moves the topic from one half to the other: `upsertTopics`
    // reads the flag and does the move, optimistic and reconciled alike.
    const flip = (prev: TopicBuckets, to: boolean): TopicBuckets => {
      const topic = prev.live[id] ?? prev.archived[id];
      if (!topic) return prev;
      return upsertTopics(prev, [{ ...topic, archived: to, updatedAt: new Date().toISOString() }]);
    };
    try {
      setError(null);
      // Optimistic update: immediately set archived flag to prevent count flash
      setBuckets(prev => flip(prev, archived));
      const topic = await topicsApi.archive(id, archived);
      // Reconcile with server response
      setBuckets(prev => upsertTopics(prev, [topic]));
      return true;
    } catch (err) {
      console.error('Failed to archive topic:', err);
      // Rollback optimistic update on failure
      setBuckets(prev => flip(prev, !archived));
      setError(err instanceof Error ? err.message : 'Failed to archive topic');
      return false;
    }
  }, []);

  const archiveProject = useCallback(async (projectPath: string, archived: boolean = true): Promise<boolean> => {
    const flipProject = (prev: TopicBuckets, to: boolean): TopicBuckets => {
      const now = new Date().toISOString();
      const changed: Topic[] = [];
      for (const topic of [...Object.values(prev.live), ...Object.values(prev.archived)]) {
        if (topic.projectPath === projectPath) changed.push({ ...topic, archived: to, updatedAt: now });
      }
      return upsertTopics(prev, changed);
    };
    try {
      setError(null);
      // Optimistic update: immediately set archived flag on all matching topics
      setBuckets(prev => flipProject(prev, archived));
      const result = await topicsApi.bulkArchive(projectPath, archived);
      // Reconcile with server response
      setBuckets(prev => upsertTopics(prev, result.topics));
      return true;
    } catch (err) {
      console.error('Failed to archive project:', err);
      // Rollback optimistic update
      setBuckets(prev => flipProject(prev, !archived));
      setError(err instanceof Error ? err.message : 'Failed to archive project');
      return false;
    }
  }, []);

  const linkTopics = useCallback(async (id: string, targetId: string): Promise<boolean> => {
    try {
      setError(null);
      await topicsApi.link(id, { targetId });
      await loadTopics();
      return true;
    } catch (err) {
      console.error('Failed to link topics:', err);
      setError(err instanceof Error ? err.message : 'Failed to link topics');
      return false;
    }
  }, [loadTopics]);

  const unlinkTopics = useCallback(async (id: string, targetId: string): Promise<boolean> => {
    try {
      setError(null);
      await topicsApi.unlink(id, targetId);
      await loadTopics();
      return true;
    } catch (err) {
      console.error('Failed to unlink topics:', err);
      setError(err instanceof Error ? err.message : 'Failed to unlink topics');
      return false;
    }
  }, [loadTopics]);

  // Persist the half that changed - and only that one - whenever the buckets
  // change. The identity of an untouched half is what tells them apart: a
  // rename of a live chat never serialises 1,535 archived rows to find out
  // they were the same.
  const persistedRef = useRef<TopicBuckets | null>(null);
  useEffect(() => {
    persistBuckets(
      persistedRef.current,
      buckets,
      { live: liveCacheWriter, archived: archivedCacheWriter },
      knownRef.current,
    );
    persistedRef.current = buckets;
  }, [buckets]);

  // Apply a topic update from WebSocket (cross-window sync). The flag decides
  // the half: a `topic:archived` for a chat closed elsewhere moves it over.
  const applyTopicFromWS = useCallback((topic: Topic) => {
    setBuckets(prev => upsertTopics(prev, [topic]));
  }, []);

  useEffect(() => {
    loadTopics();
  }, [loadTopics]);

  return {
    topics,
    workspaceProjects,
    loading,
    error,
    loadTopics,
    createTopic,
    updateTopic,
    archiveTopic,
    archiveProject,
    applyTopicFromWS,
    linkTopics,
    unlinkTopics,
    ensureTopic,
    ensureArchivedTopics,
  };
}
