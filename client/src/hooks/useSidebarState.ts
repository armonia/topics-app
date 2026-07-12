import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { WSMessage } from '../types';

export type SidebarViewMode = 'timeline' | 'grouped';

/** Loosely-typed persisted sidebar state — the server/storage layer is
 *  schemaless, so every incoming value MUST pass through
 *  `sanitizeSidebarPayload` before reaching state. A plain spread does NOT
 *  drop extra keys at runtime: a pre-migration-012 client once merged the GET
 *  envelope itself ({ value, payload_version, server_seq }) into its state and
 *  PUT it back, so the stored value grew recursively-nested envelopes that
 *  every later client faithfully re-persisted forever (and the web sidebar
 *  read pinnedItems from the wrong nesting level). */
type PartialSidebarState = Partial<SidebarState>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** True if `v` looks like a ui-state GET envelope rather than the state
 *  itself. Real sidebar state never carries `value`/`server_seq` keys. */
function looksLikeEnvelope(v: Record<string, unknown>): boolean {
  return 'value' in v && ('server_seq' in v || 'payload_version' in v);
}

/** Normalize ANY persisted/broadcast payload into a clean partial state:
 *  descend through recursively-nested GET envelopes (self-heals values
 *  corrupted by the historical double-wrap), then pluck ONLY the known
 *  SidebarState keys — junk like `payload_version` must never re-enter the
 *  React state or it gets PUT straight back to the server. Returns null for
 *  payloads with no usable object at the core. Exported for unit tests. */
export function sanitizeSidebarPayload(raw: unknown): PartialSidebarState | null {
  let cur: unknown = raw;
  for (let depth = 0; isRecord(cur) && looksLikeEnvelope(cur) && depth < 10; depth++) {
    cur = cur.value;
  }
  if (!isRecord(cur)) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_STATE) as (keyof SidebarState)[]) {
    if (key in cur) out[key] = cur[key];
  }
  return out as PartialSidebarState;
}

interface SidebarState {
  expandedNodes: string[];
  viewMode: SidebarViewMode;
  showArchived: boolean;
  /** Pinned ("Fissati") sidebar items, in user pin order (append-on-pin).
   *  Keys use the SidebarItem id conventions: chats = raw topic id, projects
   *  = `project:<rawPath>` (the sidebar-item form, NOT the encoded pane id).
   *  Rides the whole sidebar-state pipeline (localStorage + server ui-state
   *  + WS + cross-tab) for free; the `{...DEFAULT_STATE, ...parsed}` spread
   *  IS the migration (old payloads deserialize with `[]`).
   *  KNOWN LWW CAVEAT (accepted, ruling 2.4): sidebar-state syncs as a
   *  whole-object last-write-wins — two clients pinning different items
   *  within the debounce window clobber each other, and a pre-feature
   *  client's next PUT drops the field entirely. Single release train. */
  pinnedItems: string[];
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
  pinnedItems: [],
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
      const parsed = sanitizeSidebarPayload(JSON.parse(raw));
      if (!parsed) return DEFAULT_STATE;
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
  // Gate for the debounced PUT: a client must HYDRATE from the server before it
  // may write. Without this, a fresh client (empty localStorage) interacting in
  // the window before the initial GET resolves PUTs its DEFAULT_STATE — wiping
  // server-side pinnedItems/expandedNodes for every other client (LWW). This is
  // exactly how the pinned sessions were lost when pin-sync first came alive.
  const hydratedRef = useRef(false);
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
        // PANE-01-ALLOWED: sanitize = unwrap v2 envelope (recursively, healing
        // the historical double-wrap corruption) + strip unknown keys.
        const sv = sanitizeSidebarPayload(envelope);
        if (!mountedRef.current || !sv) return;
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
      .catch(() => {})
      // Success OR failure: only after the initial fetch settles may this
      // client publish. On failure the PUT would fail too, so nothing is lost.
      .finally(() => { hydratedRef.current = true; });
  }, []);

  // WS listener — skip if user made a local change recently (prevents overwrite race)
  useEffect(() => {
    if (!onMessage) return;
    return onMessage((msg: WSMessage) => {
      // If user interacted locally in the last 2s, ignore server pushes to avoid overwriting
      if (Date.now() - lastLocalChangeRef.current < 2000) return;

      if (msg.type === 'ui-state:updated' && msg.key === SERVER_KEY) {
        const sv = sanitizeSidebarPayload(msg.value);
        if (!sv) return;
        const merged: SidebarState = { ...DEFAULT_STATE, ...sv };
        isFromServerRef.current = true;
        setStateRaw(merged);
        saveToStorage(merged);
      }
      if (msg.type === 'ui-state:init' && msg.data && SERVER_KEY in msg.data) {
        const sv = sanitizeSidebarPayload(msg.data[SERVER_KEY]);
        if (!sv) return;
        const merged: SidebarState = { ...DEFAULT_STATE, ...sv };
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
        const sv = sanitizeSidebarPayload(JSON.parse(e.newValue));
        if (!sv) return;
        isFromServerRef.current = true;
        setStateRaw({ ...DEFAULT_STATE, ...sv });
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

    // Never publish before hydrating (see hydratedRef) — the local change is
    // kept in localStorage and the next interaction after hydrate syncs it.
    if (!hydratedRef.current) return;

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

  // Pinning ("Fissati") — pure pin-state ops. The unpin-while-closed archive
  // semantics live in the App-level wrapper (it needs openPanels/topics);
  // this hook only owns the persisted list.
  const pinnedIds = useMemo(() => new Set(state.pinnedItems), [state.pinnedItems]);

  const togglePin = useCallback((id: string) => {
    lastLocalChangeRef.current = Date.now();
    setStateRaw(prev => ({
      ...prev,
      pinnedItems: prev.pinnedItems.includes(id)
        ? prev.pinnedItems.filter(p => p !== id)
        : [...prev.pinnedItems, id],
    }));
  }, []);

  // Stable predicate (reads through stateRef) so ref-backed consumers — the
  // usePanelLifecycle archive guards — never re-bind on pin changes.
  const isPinned = useCallback((id: string) => stateRef.current.pinnedItems.includes(id), []);

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
    // Pinning (Fissati)
    pinnedItems: state.pinnedItems,
    pinnedIds,
    togglePin,
    isPinned,
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
