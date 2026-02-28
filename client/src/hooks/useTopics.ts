import { useState, useEffect, useCallback } from 'react';
import type { Topic, CreateTopicRequest, UpdateTopicRequest } from '../types';
import { topicsApi } from '../lib/api';

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

export function useTopics() {
  const [topics, setTopics] = useState<Record<string, Topic>>(getInitialTopics);
  const [workspaceProjects, setWorkspaceProjects] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTopics = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await topicsApi.getAll();
      setTopics(data.topics);
      if (data.workspaceProjects) setWorkspaceProjects(data.workspaceProjects);
      // Cache to localStorage
      try { localStorage.setItem('topics-cache', JSON.stringify(data.topics)); } catch {}
    } catch (err) {
      console.error('Failed to load topics:', err);
      // If we have cached data, show a less alarming error
      setTopics(prev => {
        const hasCachedData = Object.keys(prev).length > 0;
        if (hasCachedData) {
          setError('Using cached data -- server unreachable');
        } else {
          setError(err instanceof Error ? err.message : 'Failed to load topics');
        }
        return prev;
      });
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
      try { localStorage.setItem('topics-cache', JSON.stringify(topics)); } catch {}
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