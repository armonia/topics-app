import { useState, useCallback, useEffect, useRef } from 'react';
import {
  contextAnalysisApi,
  contextPreviewApi,
  contextSnapshotsApi,
  type ContextAnalysis,
  type ContextEnvelope,
  type ContextPreview,
} from '../lib/api';
import type { WSMessage } from '../types';
import { DEFAULT_CONTEXT_WINDOW } from '../../../shared/context-thresholds';

/**
 * Type guard + topic-affinity check used by every context-related hook
 * below. A WS message "affects" a topic when it's a `stream:end` for that
 * topic OR a `topic:updated` for that topic.
 *
 * Centralised here because the discriminated `WSMessage` union doesn't
 * always narrow cleanly across `&&` branches in TS; the explicit cast
 * inside this helper isolates the unsafety to one place.
 */
function affectsTopic(msg: WSMessage, topicId: string): boolean {
  if (msg.type === 'stream:end') {
    return (msg as { topicId?: string }).topicId === topicId;
  }
  if (msg.type === 'topic:updated') {
    const t = (msg as { topic?: { id?: string } }).topic;
    return t?.id === topicId;
  }
  return false;
}

function affectsAnyTopic(msg: WSMessage, topicIds: Set<string>): boolean {
  if (msg.type === 'stream:end') {
    const t = (msg as { topicId?: string }).topicId;
    return t !== undefined && topicIds.has(t);
  }
  if (msg.type === 'topic:updated') {
    const id = (msg as { topic?: { id?: string } }).topic?.id;
    return id !== undefined && topicIds.has(id);
  }
  return false;
}

/**
 * Lightweight hook that fetches budgetPercent for multiple topics.
 * Returns a Record<paneId, percent> suitable for PaneTabBar's contextPercent prop.
 */
export function useMultiContextPercent(
  paneToTopicId: Record<string, string>,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): Record<string, number> {
  const [percents, setPercents] = useState<Record<string, number>>({});

  // Stable serialization for dependency tracking
  const key = Object.entries(paneToTopicId).map(([p, t]) => `${p}:${t}`).sort().join(',');

  const fetchAll = useCallback(async () => {
    const entries = Object.entries(paneToTopicId);
    if (!entries.length) return;
    const results: Record<string, number> = {};
    await Promise.all(
      entries.map(async ([paneId, topicId]) => {
        try {
          const analysis = await contextAnalysisApi.analyze(topicId);
          results[paneId] = analysis.budgetPercent || 0;
        } catch {
          results[paneId] = 0;
        }
      }),
    );
    setPercents(results);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the stable serialization of paneToTopicId; depending on the object directly would re-create fetchAll on every render even when contents are unchanged
  }, [key]);

  useEffect(() => {
    fetchAll();
    // Reduced from 30s to 60s — WS events trigger immediate refresh
    const interval = setInterval(fetchAll, 60000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // Listen for WS events that indicate context may have changed
  useEffect(() => {
    if (!onMessage) return;
    const topicIds = new Set(Object.values(paneToTopicId));
    const unsub = onMessage((msg: WSMessage) => {
      if (affectsAnyTopic(msg, topicIds)) {
        // Debounce slightly to avoid fetching mid-update
        setTimeout(fetchAll, 500);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the stable serialization of paneToTopicId; the topicIds Set is rebuilt from it inside, so depending on the object directly would only churn the subscription needlessly
  }, [onMessage, key, fetchAll]);

  return percents;
}

export function useContextInspector(
  topicId: string | null,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
) {
  const [analysis, setAnalysis] = useState<ContextAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Staleness guard. The inspector instance is NOT keyed by topic (project
  // panel swaps the active topic in place), so a slow analyze() for topic A
  // can resolve AFTER the user switched to B — without the guard it would
  // display A's sources under B's header, and "Edit source" → Save would
  // overwrite B's memory with A's stale preview text.
  const topicIdRef = useRef(topicId);
  topicIdRef.current = topicId;

  const load = useCallback(async () => {
    if (!topicId) return;
    const id = topicId;
    setLoading(true);
    setError(null);
    try {
      const result = await contextAnalysisApi.analyze(id);
      if (topicIdRef.current !== id) return; // stale — another topic is active now
      setAnalysis(result);
    } catch (err) {
      if (topicIdRef.current !== id) return;
      setError(err instanceof Error ? err.message : 'Failed to analyze context');
    } finally {
      if (topicIdRef.current === id) setLoading(false);
    }
  }, [topicId]);

  useEffect(() => {
    // Clear the previous topic's data the moment the target changes — even
    // BEFORE the new fetch lands, the old sources must not render under the
    // new topic's header (that window is what made stale edits possible).
    setAnalysis(null);
    setError(null);
    load();
  }, [load]);

  // Listen for WS events that indicate context may have changed
  useEffect(() => {
    if (!onMessage || !topicId) return;
    const unsub = onMessage((msg: WSMessage) => {
      if (affectsTopic(msg, topicId)) {
        setTimeout(load, 500);
      }
    });
    return unsub;
  }, [onMessage, topicId, load]);

  return {
    sources: analysis?.sources || [],
    totalTokens: analysis?.totalTokens || 0,
    // Fallback = il default condiviso, non un 200k cablato: l'analisi arriva
    // con la finestra del modello del topic, e mentre non c'e' ancora si assume
    // la stessa cosa che assume il server.
    budgetLimit: analysis?.budgetLimit || DEFAULT_CONTEXT_WINDOW,
    budgetPercent: analysis?.budgetPercent || 0,
    warnings: analysis?.warnings || [],
    loading,
    error,
    reload: load,
  };
}

// ─── Canonical envelope hooks (change `topic-context-canonical`) ──────────
//
// These hooks expose the new `/context-preview` and `/context-snapshots`
// endpoints. They are SEPARATE from `useContextInspector` so existing
// consumers keep working unchanged. New UI sections (Provider, History,
// Adaptation Notes, Last sent) opt in by calling these hooks.

/**
 * Fetches the canonical preview envelope + adapted payload for a topic.
 * Refreshes on stream:end and topic:updated WS events. The envelope mirrors
 * what the model would receive if the user posted right now.
 */
export function useContextPreview(
  topicId: string | null,
  providerName?: string,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
) {
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same staleness guard as useContextInspector (instance not keyed by topic).
  const targetKey = `${topicId}|${providerName ?? ''}`;
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;

  const load = useCallback(async () => {
    if (!topicId) return;
    const key = targetKey;
    setLoading(true);
    setError(null);
    try {
      const result = await contextPreviewApi.fetch(topicId, providerName);
      if (targetRef.current !== key) return; // stale — target changed mid-flight
      setPreview(result);
    } catch (err) {
      if (targetRef.current !== key) return;
      setError(err instanceof Error ? err.message : 'Failed to fetch context preview');
    } finally {
      if (targetRef.current === key) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetKey derives from topicId+providerName
  }, [topicId, providerName]);

  useEffect(() => {
    setPreview(null);
    setError(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!onMessage || !topicId) return;
    const unsub = onMessage((msg: WSMessage) => {
      if (affectsTopic(msg, topicId)) {
        setTimeout(load, 500);
      }
    });
    return unsub;
  }, [onMessage, topicId, load]);

  return { preview, loading, error, reload: load };
}

/**
 * Fetches the per-topic snapshot ring (in-memory, last 5 sends). Refreshes
 * on stream:end so the inspector "Last sent" tab is always up to date.
 *
 * Snapshots reset on server restart by design (no disk persistence). The
 * UI should show an empty state explaining this when the list is empty.
 */
export function useContextSnapshots(
  topicId: string | null,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
) {
  const [snapshots, setSnapshots] = useState<ContextEnvelope[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Same staleness guard as useContextInspector (instance not keyed by topic).
  const topicIdRef = useRef(topicId);
  topicIdRef.current = topicId;

  const load = useCallback(async () => {
    if (!topicId) return;
    const id = topicId;
    setLoading(true);
    setError(null);
    try {
      const result = await contextSnapshotsApi.list(id);
      if (topicIdRef.current !== id) return; // stale — another topic is active now
      setSnapshots(result.snapshots);
    } catch (err) {
      if (topicIdRef.current !== id) return;
      setError(err instanceof Error ? err.message : 'Failed to load snapshots');
    } finally {
      if (topicIdRef.current === id) setLoading(false);
    }
  }, [topicId]);

  const clear = useCallback(async () => {
    if (!topicId) return;
    try {
      await contextSnapshotsApi.clear(topicId);
      setSnapshots([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear snapshots');
    }
  }, [topicId]);

  useEffect(() => {
    setSnapshots([]);
    setError(null);
    load();
  }, [load]);

  useEffect(() => {
    if (!onMessage || !topicId) return;
    const unsub = onMessage((msg: WSMessage) => {
      // Snapshots are only updated when a stream completes — topic config
      // changes don't push a new envelope. Use the stream-end leg of the
      // generic helper for consistency.
      if (msg.type === 'stream:end' && (msg as { topicId?: string }).topicId === topicId) {
        setTimeout(load, 500);
      }
    });
    return unsub;
  }, [onMessage, topicId, load]);

  return { snapshots, loading, error, reload: load, clear };
}
