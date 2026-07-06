import { useState, useCallback, useEffect, useRef } from 'react';
import type { WSMessage } from '../types';
import { memoryApi } from '../lib/api';

interface UseMemoryOptions {
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export function useMemory(topicId: string | null, options?: UseMemoryOptions) {
  const [topicMemory, setTopicMemory] = useState('');
  const [globalMemory, setGlobalMemory] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Staleness guard (same pattern as useContextInspector): the memory panel
  // is not remounted per topic, so a slow fetch for topic A resolving after a
  // switch to B would display A's memory under B's header — and a subsequent
  // save would overwrite B's REAL memory with A's stale text.
  const topicIdRef = useRef(topicId);
  topicIdRef.current = topicId;

  const load = useCallback(async () => {
    if (!topicId) return;
    const id = topicId;
    setLoading(true);
    setError(null);
    try {
      const data = await memoryApi.getForTopic(id);
      if (topicIdRef.current !== id) return; // stale — another topic is active
      setTopicMemory(data.topicContent);
      setGlobalMemory(data.globalContent);
    } catch (err) {
      if (topicIdRef.current !== id) return;
      setError(err instanceof Error ? err.message : 'Failed to load memory');
    } finally {
      if (topicIdRef.current === id) setLoading(false);
    }
  }, [topicId]);

  useEffect(() => {
    // Clear the previous topic's text the moment the target changes — the old
    // content must not sit editable under the new topic's header while the
    // fresh fetch is in flight.
    setTopicMemory('');
    setError(null);
    load();
  }, [load]);

  // Subscribe to WS memory:updated events to refresh data. Destructure
  // onMessage so the effect depends on the precise function identity rather
  // than the whole `options` object (which callers often pass as an inline
  // literal, churning the subscription on every render).
  const onMessage = options?.onMessage;
  useEffect(() => {
    if (!onMessage || !topicId) return;
    const unsub = onMessage((msg: WSMessage) => {
      if (msg.type === 'memory:updated') {
        if (msg.scope === 'global' || (msg.scope === 'topic' && msg.topicId === topicId)) {
          load();
        }
      }
    });
    return unsub;
  }, [onMessage, topicId, load]);

  const saveTopicMemory = useCallback(async (content: string) => {
    if (!topicId) return;
    setSaving(true);
    try {
      await memoryApi.updateTopic(topicId, content);
      setTopicMemory(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [topicId]);

  const saveGlobalMemory = useCallback(async (content: string) => {
    setSaving(true);
    try {
      await memoryApi.updateGlobal(content);
      setGlobalMemory(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, []);

  const appendToTopicMemory = useCallback(async (content: string) => {
    if (!topicId) return;
    setSaving(true);
    try {
      await memoryApi.appendToTopic(topicId, content);
      const data = await memoryApi.getForTopic(topicId);
      setTopicMemory(data.topicContent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to append');
    } finally {
      setSaving(false);
    }
  }, [topicId]);

  const clearTopicMemory = useCallback(async () => {
    if (!topicId) return;
    setSaving(true);
    try {
      await memoryApi.deleteTopic(topicId);
      setTopicMemory('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear');
    } finally {
      setSaving(false);
    }
  }, [topicId]);

  const clearGlobalMemory = useCallback(async () => {
    setSaving(true);
    try {
      await memoryApi.deleteGlobal();
      setGlobalMemory('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear');
    } finally {
      setSaving(false);
    }
  }, []);

  return {
    topicMemory,
    globalMemory,
    loading,
    saving,
    error,
    saveTopicMemory,
    saveGlobalMemory,
    appendToTopicMemory,
    clearTopicMemory,
    clearGlobalMemory,
    reload: load,
  };
}
