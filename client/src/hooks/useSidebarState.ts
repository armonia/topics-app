import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

interface SidebarState {
  expandedNodes: string[];
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
    if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) };
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

  useEffect(() => () => { mountedRef.current = false; }, []);

  // Fetch from server on mount
  useEffect(() => {
    fetch(`/api/ui-state/${encodeURIComponent(SERVER_KEY)}`)
      .then(r => r.ok ? r.json() : null)
      .then(serverValue => {
        if (!mountedRef.current || serverValue === null || serverValue === undefined) return;
        const merged = { ...DEFAULT_STATE, ...serverValue };
        isFromServerRef.current = true;
        setStateRaw(merged);
        saveToStorage(merged);
      })
      .catch(() => {});
  }, []);

  // WS listener
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: any) => {
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
    setStateRaw(prev => ({ ...prev, [key]: value }));
  }, []);

  // Memoize the Set so consumers get a stable reference when contents don't change
  const expandedNodes = useMemo(() => new Set(state.expandedNodes), [state.expandedNodes]);

  const toggleNode = useCallback((id: string) => {
    setStateRaw(prev => {
      const set = new Set(prev.expandedNodes);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return { ...prev, expandedNodes: Array.from(set) };
    });
  }, []);

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
