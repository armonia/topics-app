import { useState, useEffect, useCallback } from 'react';
import type { Topic, CreateTopicRequest, UpdateTopicRequest } from '../types';
import { topicsApi } from '../lib/api';
import { createThrottledLocalWriter } from '../lib/throttledLocalWrite';

/**
 * The two caches of this hook go through a throttled writer, and it is not a
 * micro-optimisation: `topics-cache` is the whole topics map (about 1 MB on a
 * workspace of a thousand topics) and it used to be rewritten on EVERY change
 * of the state, so a burst of WebSocket updates was a burst of megabytes into
 * the WebKit localStorage journal, which is never checkpointed while the
 * webview lives. Two seconds of window, plus the skip when the bytes are
 * identical, and the burst costs one write or none. Nobody reads these keys
 * before the next boot, and the writer flushes on `pagehide`, so the delay
 * costs nothing. See `lib/throttledLocalWrite.ts`.
 */
const TOPICS_CACHE_DEBOUNCE_MS = 2000;
const topicsCacheWriter = createThrottledLocalWriter({
  key: 'topics-cache',
  debounceMs: TOPICS_CACHE_DEBOUNCE_MS,
});
const workspaceProjectsCacheWriter = createThrottledLocalWriter({
  key: 'workspace-projects-cache',
  debounceMs: TOPICS_CACHE_DEBOUNCE_MS,
});

function getInitialTopics(): Record<string, Topic> {
  try {
    const cached = localStorage.getItem('topics-cache');
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return {};
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
  const [topics, setTopics] = useState<Record<string, Topic>>(getInitialTopics);
  const [workspaceProjects, setWorkspaceProjects] = useState<string[]>(getInitialWorkspaceProjects);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      setTopics(data.topics);
      if (data.workspaceProjects) {
        setWorkspaceProjects(data.workspaceProjects);
        workspaceProjectsCacheWriter.write(() => JSON.stringify(data.workspaceProjects));
      }
      // Cache to localStorage (throttled: see the writers above)
      topicsCacheWriter.write(() => JSON.stringify(data.topics));
    } catch (err: unknown) {
      console.error('Failed to load topics:', err);
      // Narrow the opaque caught value to the Error-ish fields we read.
      const errLike = (err ?? {}) as { name?: unknown; message?: unknown };
      const isTimeout = errLike.name === 'AbortError';
      setTopics(prev => {
        const hasCachedData = Object.keys(prev).length > 0;
        if (hasCachedData) {
          setError(isTimeout ? 'Server slow, showing cached data' : 'Using cached data, server unreachable');
        } else {
          setError(isTimeout ? 'Server not responding, retrying…' : (err instanceof Error ? err.message : 'Failed to load topics'));
        }
        return prev;
      });
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
  }, []);

  const createTopic = useCallback(async (data: CreateTopicRequest): Promise<Topic | null> => {
    try {
      setError(null);
      const topic = await topicsApi.create(data);
      setTopics(prev => ({ ...prev, [topic.id]: topic }));
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
      setTopics(prev => ({ ...prev, [id]: topic }));
      return topic;
    } catch (err) {
      console.error('Failed to update topic:', err);
      setError(err instanceof Error ? err.message : 'Failed to update topic');
      return null;
    }
  }, []);

  const archiveTopic = useCallback(async (id: string, archived: boolean = true): Promise<boolean> => {
    try {
      setError(null);
      // Optimistic update: immediately set archived flag to prevent count flash
      setTopics(prev => {
        const topic = prev[id];
        if (!topic) return prev;
        return { ...prev, [id]: { ...topic, archived, updatedAt: new Date().toISOString() } };
      });
      const topic = await topicsApi.archive(id, archived);
      // Reconcile with server response
      setTopics(prev => ({ ...prev, [id]: topic }));
      return true;
    } catch (err) {
      console.error('Failed to archive topic:', err);
      // Rollback optimistic update on failure
      setTopics(prev => {
        const topic = prev[id];
        if (!topic) return prev;
        return { ...prev, [id]: { ...topic, archived: !archived } };
      });
      setError(err instanceof Error ? err.message : 'Failed to archive topic');
      return false;
    }
  }, []);

  const archiveProject = useCallback(async (projectPath: string, archived: boolean = true): Promise<boolean> => {
    try {
      setError(null);
      // Optimistic update: immediately set archived flag on all matching topics
      const affectedIds: string[] = [];
      setTopics(prev => {
        const next = { ...prev };
        for (const [id, topic] of Object.entries(next)) {
          if (topic.projectPath === projectPath) {
            next[id] = { ...topic, archived, updatedAt: new Date().toISOString() };
            affectedIds.push(id);
          }
        }
        return next;
      });
      const result = await topicsApi.bulkArchive(projectPath, archived);
      // Reconcile with server response
      setTopics(prev => {
        const next = { ...prev };
        for (const topic of result.topics) {
          next[topic.id] = topic;
        }
        return next;
      });
      return true;
    } catch (err) {
      console.error('Failed to archive project:', err);
      // Rollback optimistic update
      setTopics(prev => {
        const next = { ...prev };
        for (const [id, topic] of Object.entries(next)) {
          if (topic.projectPath === projectPath) {
            next[id] = { ...topic, archived: !archived };
          }
        }
        return next;
      });
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

  // Persist topics cache whenever topics change
  useEffect(() => {
    if (Object.keys(topics).length > 0) {
      topicsCacheWriter.write(() => JSON.stringify(topics));
    }
  }, [topics]);

  // Apply a topic update from WebSocket (cross-window sync)
  const applyTopicFromWS = useCallback((topic: Topic) => {
    setTopics(prev => ({ ...prev, [topic.id]: topic }));
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
  };
}