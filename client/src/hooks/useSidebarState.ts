import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

export type SidebarViewMode = 'timeline' | 'grouped';

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
      const parsed = JSON.parse(raw);
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

export function useSidebarState(onMessage?: (handler: (msg: any) => void) => () => void) {
  const [state, setStateRaw] = useState<SidebarState>(loadFromStorage);

  const stateRef = useRef(state);
  stateRef.current = state;

  const isFromServerRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Track when user last interacted — ignore WS pushes for 2s after local changes
  const lastLocalChangeRef = useRef(0);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Fetch from server on mount
  useEffect(() => {
    fetch(`/api/ui-state/${encodeURIComponent(SERVER_KEY)}`)
      .then(r => r.ok ? r.json() : null)
      .then(serverValue => {
        if (!mountedRef.current || serverValue === null || serverValue === undefined) return;
        const merged = { ...DEFAULT_STATE, ...serverValue };
        // Migrate server state too
        if (!serverValue.viewMode) {
          merged.viewMode = 'timeline';
          merged.showArchived = serverValue.showProjectsArchived || serverValue.showChatsArchived || false;
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
    return onMessage((msg: any) => {
      // If user interacted locally in the last 2s, ignore server pushes to avoid overwriting
      if (Date.now() - lastLocalChangeRef.current < 2000) return;

      if (msg.type === 'ui-state:updated' && msg.key === SERVER_KEY) {
        const merged = { ...DEFAULT_STATE, ...msg.value };
        isFromServerRef.current = true;
        setStateRaw(merged);
        saveToStorage(merged);
      }
      if (msg.type === 'ui-state:init' && msg.data && SERVER_KEY in msg.data) {
        const merged = { ...DEFAULT_STATE, ...msg.data[SERVER_KEY] };
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
        setStateRaw({ ...DEFAULT_STATE, ...JSON.parse(e.newValue) });
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
      fetch(`/api/ui-state/${encodeURIComponent(SERVER_KEY)}`, {
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
