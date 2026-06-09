import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { WSMessage } from '../types';

export type SidebarViewMode = 'timeline' | 'grouped';

/** Loosely-typed persisted sidebar state — the server/storage layer is
 *  schemaless, so incoming values are coerced to a partial of the known
 *  shape (extra keys, if any, are dropped by the spread over DEFAULT_STATE).
 *  Spreading a `Partial<SidebarState>` over the full `DEFAULT_STATE` keeps
 *  every field typed, so the result stays a valid `SidebarState`. */
type PartialSidebarState = Partial<SidebarState>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

interface SidebarState {
  expandedNodes: string[];
  viewMode: SidebarViewMode;
  showArchived: boolean;
  // Legacy fields — kept for backward compat during migration, not used in new UI
  showProjects: boolean;
  showChats: boolean;
  showTerminals: boolean;
  showProjectsArchived: boolean;
  showChatsArchived: boolean;
  browserExpanded: boolean;
}

const STORAGE_KEY = 'topics-sidebar-state';
const SERVER_KEY = 'sidebar-state';
const DEBOUNCE_MS = 1000;

const DEFAULT_STATE: SidebarState = {
  expandedNodes: [],
  viewMode: 'timeline',
  showArchived: false,
  // Legacy defaults
  showProjects: true,
  showChats: true,
  showTerminals: true,
  showProjectsArchived: false,
  showChatsArchived: false,
  browserExpanded: false,
};

function loadFromStorage(): SidebarState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PartialSidebarState;
      // Migrate: if old format (no viewMode), derive from old fields
      if (!parsed.viewMode) {
        parsed.viewMode = 'timeline';
        parsed.showArchived = parsed.showProjectsArchived || parsed.showChatsArchived || false;
      }
      return { ...DEFAULT_STATE, ...parsed };
    }
  } catch {}
  return DEFAULT_STATE;
}

function saveToStorage(state: SidebarState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function useSidebarState(onMessage?: (handler: (msg: WSMessage) => void) => () => void) {
  const [state, setStateRaw] = useState<SidebarState>(loadFromStorage);

  const stateRef = useRef(state);
  // eslint-disable-next-line react-hooks/refs -- intentional state→ref mirror so async/WS callbacks read the latest committed value without re-subscribing
  stateRef.current = state;

  const isFromServerRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Track when user last interacted — ignore WS pushes for 2s after local changes
  const lastLocalChangeRef = useRef(0);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Fetch from server on mount
  // PANE-01-ALLOWED: non-pane ui-state key (sidebar-state: viewMode, expandedNodes, showArchived). Not one of the 6 legacy pane keys.
  // GET /api/ui-state/:key endpoint returns { value, payload_version, server_seq } // PANE-01-ALLOWED
  // as of migration 012; unwrap .value for the legacy consumer shape.
  useEffect(() => {
    fetch(`/api/ui-state/${encodeURIComponent(SERVER_KEY)}`) // PANE-01-ALLOWED: sidebar-state key, not pane state
      .then((r): Promise<unknown> | null => r.ok ? r.json() : null)
      .then((envelope: unknown) => {
        // PANE-01-ALLOWED: unwrap v2 envelope { value, payload_version, server_seq }
        const serverValue: unknown = isRecord(envelope) && 'value' in envelope ? envelope.value : envelope;
        if (!mountedRef.current || !isRecord(serverValue)) return;
        const sv = serverValue as PartialSidebarState;
        const merged: SidebarState = { ...DEFAULT_STATE, ...sv };
        // Migrate server state too
        if (!sv.viewMode) {
          merged.viewMode = 'timeline';
          merged.showArchived = sv.showProjectsArchived || sv.showChatsArchived || false;
        }
        isFromServerRef.current = true;
        setStateRaw(merged);
        saveToStorage(merged);
      })
      .catch(() => {});
  }, []);

  // WS listener — skip if user made a local change recently (prevents overwrite race)
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: WSMessage) => {
      // If user interacted locally in the last 2s, ignore server pushes to avoid overwriting
      if (Date.now() - lastLocalChangeRef.current < 2000) return;

      if (msg.type === 'ui-state:updated' && msg.key === SERVER_KEY) {
        if (!isRecord(msg.value)) return;
        const merged: SidebarState = { ...DEFAULT_STATE, ...(msg.value as PartialSidebarState) };
        isFromServerRef.current = true;
        setStateRaw(merged);
        saveToStorage(merged);
      }
      if (msg.type === 'ui-state:init' && msg.data && SERVER_KEY in msg.data) {
        const raw = msg.data[SERVER_KEY];
        if (!isRecord(raw)) return;
        const merged: SidebarState = { ...DEFAULT_STATE, ...(raw as PartialSidebarState) };
        isFromServerRef.current = true;
        setStateRaw(merged);
        saveToStorage(merged);
      }
    });
  }, [onMessage]);

  // Cross-tab sync via storage events
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try {
        isFromServerRef.current = true;
        setStateRaw({ ...DEFAULT_STATE, ...(JSON.parse(e.newValue) as PartialSidebarState) });
      } catch {}
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // Debounced PUT to server on local change
  useEffect(() => {
    if (isFromServerRef.current) {
      isFromServerRef.current = false;
      return;
    }

    // Write localStorage immediately
    saveToStorage(state);

    // Debounce server PUT
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      // PANE-01-ALLOWED: non-pane ui-state key (sidebar-state). Debounced PUT for view mode / expanded nodes.
      fetch(`/api/ui-state/${encodeURIComponent(SERVER_KEY)}`, { // PANE-01-ALLOWED
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      }).catch(() => {});
    }, DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [state]);

  // Helper to update a single field
  const updateField = useCallback(<K extends keyof SidebarState>(key: K, value: SidebarState[K]) => {
    lastLocalChangeRef.current = Date.now();
    setStateRaw(prev => ({ ...prev, [key]: value }));
  }, []);

  // Memoize the Set so consumers get a stable reference when contents don't change
  const expandedNodes = useMemo(() => new Set(state.expandedNodes), [state.expandedNodes]);

  const toggleNode = useCallback((id: string) => {
    lastLocalChangeRef.current = Date.now();
    setStateRaw(prev => {
      const set = new Set(prev.expandedNodes);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return { ...prev, expandedNodes: Array.from(set) };
    });
  }, []);

  // New view mode controls
  const setViewMode = useCallback((v: SidebarViewMode) => updateField('viewMode', v), [updateField]);
  const toggleViewMode = useCallback(() => {
    lastLocalChangeRef.current = Date.now();
    setStateRaw(prev => ({ ...prev, viewMode: prev.viewMode === 'timeline' ? 'grouped' : 'timeline' }));
  }, []);
  const setShowArchived = useCallback((v: boolean) => updateField('showArchived', v), [updateField]);
  const toggleShowArchived = useCallback(() => {
    lastLocalChangeRef.current = Date.now();
    setStateRaw(prev => ({ ...prev, showArchived: !prev.showArchived }));
  }, []);

  // Legacy setters (still used during transition by App.tsx browser section etc.)
  const setShowProjects = useCallback((v: boolean) => updateField('showProjects', v), [updateField]);
  const setShowChats = useCallback((v: boolean) => updateField('showChats', v), [updateField]);
  const setShowTerminals = useCallback((v: boolean) => updateField('showTerminals', v), [updateField]);
  const setShowProjectsArchived = useCallback((v: boolean) => updateField('showProjectsArchived', v), [updateField]);
  const setShowChatsArchived = useCallback((v: boolean) => updateField('showChatsArchived', v), [updateField]);

  const setBrowserExpanded = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setStateRaw(prev => ({
      ...prev,
      browserExpanded: typeof v === 'function' ? v(prev.browserExpanded) : v,
    }));
  }, []);

  return {
    expandedNodes,
    toggleNode,
    // New
    viewMode: state.viewMode,
    setViewMode,
    toggleViewMode,
    showArchived: state.showArchived,
    setShowArchived,
    toggleShowArchived,
    // Legacy
    showProjects: state.showProjects,
    setShowProjects,
    showChats: state.showChats,
    setShowChats,
    showTerminals: state.showTerminals,
    setShowTerminals,
    showProjectsArchived: state.showProjectsArchived,
    setShowProjectsArchived,
    showChatsArchived: state.showChatsArchived,
    setShowChatsArchived,
    browserExpanded: state.browserExpanded,
    setBrowserExpanded,
  };
}
