import { useState, useRef, useCallback, useEffect, useMemo, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Settings as SettingsIcon, X, MessageSquare, TerminalSquare, ChevronDown, Cpu, Activity, BarChart3, Radio, Globe, Timer } from 'lucide-react';
import { SidebarToggleButton } from './components/Shared/SidebarToggleButton';
import { ClaudeIcon } from './components/Shared/ClaudeIcon';
import type { Topic, CreateTopicRequest, AppSettings, SidebarTab, TerminalSessionInfo } from './types';
import { DEFAULT_TOPIC_ICON } from './lib/topicIcons';
import { useTopics } from './hooks/useTopics';
import { useChat } from './hooks/useChat';
import { useWebSocket } from './hooks/useWebSocket';
import { useTheme } from './hooks/useTheme';
import { useAgents } from './hooks/useAgents';
import { useClaudeSkipPermissions } from './hooks/useClaudePrefs';
import { useMobile } from './hooks/useMobile';
import { useStorageSync } from './hooks/useStorageSync';
import { useSidebarState } from './hooks/useSidebarState';
import { useBrowserContexts } from './hooks/useBrowserContexts';

import { TopicTree } from './components/Sidebar/TopicTree';
import { SidebarControls } from './components/Sidebar/SidebarControls';
import { ContextMenu } from './components/Modals/ContextMenu';
import { PanelGrid } from './components/Layout/PanelGrid';
import { ConnectionStatusBadge } from './components/Layout/ConnectionStatus';
import { loadSettings, saveSettings } from './lib/settings';
import { ToastProvider } from './components/Shared/Toast';
import { ErrorBoundary } from './components/Shared/ErrorBoundary';
import { SkeletonTopicList } from './components/Shared/Skeleton';
import { SidebarStatusBar } from './components/Sidebar/SidebarStatusBar';
import { DropdownPortal } from './components/Shared/DropdownPortal';
import { utilityPanelId, isUtilityPanelId } from './components/Layout/UtilityPanel';
import { createPaneId, isProjectPaneId, isBrowserPaneId, isTerminalPaneId, isDraftPaneId, createDraftPaneId, getBrowserContextFromPaneId, getProjectPathFromPaneId } from './lib/paneConfig';
import { generateUUID } from './utils/uuid';
import { globalBoardApi } from './lib/api';

// Lazy-load components that are only shown on demand
const NewTopicModal = lazy(() => import('./components/Modals/NewTopicModal').then(m => ({ default: m.NewTopicModal })));
const GlobalSettings = lazy(() => import('./components/Settings/GlobalSettings').then(m => ({ default: m.GlobalSettings })));
const CommandPalette = lazy(() => import('./components/Shared/CommandPalette').then(m => ({ default: m.CommandPalette })));
const KeyboardShortcuts = lazy(() => import('./components/Shared/KeyboardShortcuts').then(m => ({ default: m.KeyboardShortcuts })));
const FileSearch = lazy(() => import('./components/Project/FileSearch').then(m => ({ default: m.FileSearch })));
const RemoteAccessPanel = lazy(() => import('./components/Sidebar/RemoteAccessPanel').then(m => ({ default: m.RemoteAccessPanel })));
// BrowserSidebarControl replaced by useBrowserContexts hook + unified TopicTree
const AgentAssignPanel = lazy(() => import('./components/Agents/AgentAssignPanel').then(m => ({ default: m.AgentAssignPanel })));
const TOPICS_MENU_PAGES = [
  { id: 'dashboard' as const, icon: BarChart3, label: 'Statistics' },
  { id: 'cron' as const, icon: Timer, label: 'Cron Jobs' },
];

// Generate unique window ID (persists across reloads via sessionStorage)
const getWindowId = () => {
  let id = sessionStorage.getItem('topics-window-id');
  if (!id) {
    id = generateUUID();
    sessionStorage.setItem('topics-window-id', id);
  }
  return id;
};

// Persist open panels to localStorage (main window only)
const OPEN_PANELS_KEY = 'topics-open-panels';
const FOCUSED_PANEL_KEY = 'topics-focused-panel';
const loadSavedPanels = (): string[] => {
  try {
    // Try localStorage first, fall back to sessionStorage (Safari PWA reliability)
    const saved = localStorage.getItem(OPEN_PANELS_KEY) || sessionStorage.getItem(OPEN_PANELS_KEY);
    const panels: string[] = saved ? JSON.parse(saved) : [];
    // Keep drafts that have valid metadata and are < 24h old
    const draftMetaRaw = localStorage.getItem('draft-meta');
    const savedDraftMeta = draftMetaRaw ? JSON.parse(draftMetaRaw) : {};
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    return panels.filter(id => {
      if (!id.startsWith('draft:')) return true;
      const meta = savedDraftMeta[id];
      if (!meta?.createdAt) return false;
      return (now - new Date(meta.createdAt).getTime()) < TWENTY_FOUR_HOURS;
    });
  } catch {
    return [];
  }
};

const loadSavedFocused = (): string | null => {
  try {
    return localStorage.getItem(FOCUSED_PANEL_KEY) || sessionStorage.getItem(FOCUSED_PANEL_KEY);
  } catch {
    return null;
  }
};

let panelsSaveTimer: ReturnType<typeof setTimeout> | null = null;

const savePanelsState = (panels: string[], focused: string | null) => {
  try {
    const panelsJson = JSON.stringify(panels);
    localStorage.setItem(OPEN_PANELS_KEY, panelsJson);
    sessionStorage.setItem(OPEN_PANELS_KEY, panelsJson);
    if (focused) {
      localStorage.setItem(FOCUSED_PANEL_KEY, focused);
      sessionStorage.setItem(FOCUSED_PANEL_KEY, focused);
    } else {
      localStorage.removeItem(FOCUSED_PANEL_KEY);
      sessionStorage.removeItem(FOCUSED_PANEL_KEY);
    }
    // ISSUE 21 fix: write a coordination timestamp so other persistence layers
    // can detect partial saves on reload
    localStorage.setItem('topics-panels-save-ts', String(Date.now()));
    // If panels are empty, also clear grid-layout to prevent inconsistency
    if (panels.length === 0) {
      localStorage.removeItem('topics-grid-layout');
      localStorage.removeItem('topics-project-layout');
    }
  } catch {
    // Ignore storage errors
  }

  // Debounced server sync (2s) — only sync openPanels, NOT focusedPanelId
  // focusedPanelId is per-device state and must not be broadcast to other clients
  if (panelsSaveTimer) clearTimeout(panelsSaveTimer);
  panelsSaveTimer = setTimeout(() => {
    fetch('/api/ui-state/panels', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openPanels: panels }),
    }).catch(() => {});
  }, 2000);
};

export function _SafeAreaFill() {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: 'env(safe-area-inset-bottom, 0px)',
        background: 'var(--bg-surface)',
        zIndex: 99998,
        pointerEvents: 'none',
      }}
    />
  );
}

export function _SafeAreaDebug() {
  const [info, setInfo] = useState({ safe: '...', bodyBg: '...', appBg: '...' });
  useEffect(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden;';
    document.body.appendChild(probe);
    requestAnimationFrame(() => {
      const safe = probe.offsetHeight;
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      const appEl = document.getElementById('root')?.firstElementChild as HTMLElement;
      const appBg = appEl ? getComputedStyle(appEl).backgroundColor : '?';
      document.body.removeChild(probe);
      setInfo({ safe: safe + 'px', bodyBg, appBg });
    });
  }, []);
  return (
    <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 99999, pointerEvents: 'none', padding: '2px 6px', background: 'rgba(200,0,0,0.9)', color: 'white', fontSize: '10px', fontFamily: 'monospace', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      <span>safe: {info.safe}</span>
      <span>body: {info.bodyBg}</span>
      <span>app: {info.appBg}</span>
      <span>dvh: {window.innerHeight}px</span>
    </div>
  );
}

function App() {
  // Unique ID for this window (for cross-window drag coordination)
  const windowId = getWindowId();
  
  // Mobile detection
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  
  // PWA standalone mode detection
  const [isPWA] = useState(() => 
    window.matchMedia('(display-mode: standalone)').matches || 
    (window.navigator as any).standalone === true
  );
  
  // Touch detection
  const { isTouch: _isTouch } = useMobile();

  // Electron detection
  const isElectron = !!(window as any).electronAPI?.isElectron;
  
  // Check if we're in detached/pop-out mode (single topic window)
  const urlParams = new URLSearchParams(window.location.search);
  const detachedTopicId = urlParams.get('topic');
  const isDetached = !!detachedTopicId;

  // Multi-panel state (restore from localStorage for main window)
  const [openPanels, setOpenPanels] = useState<string[]>(() => {
    if (isDetached && detachedTopicId) return [detachedTopicId];
    return loadSavedPanels();
  });
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(() => {
    if (isDetached && detachedTopicId) return detachedTopicId;
    return loadSavedFocused();
  });
  const focusedPanelIdRef = useRef(focusedPanelId);
  // ISSUE 3 fix: move ref assignment from render to useEffect
  useEffect(() => { focusedPanelIdRef.current = focusedPanelId; }, [focusedPanelId]);

  // Persist panels state to localStorage (main window only)
  useEffect(() => {
    if (isDetached) return;
    // Skip save if the change came from server/WS (avoid echo loop)
    if (panelsFromServerRef.current) {
      panelsFromServerRef.current = false;
      return;
    }
    // Don't push stale local panels to server before initial sync completes
    if (!serverSyncedRef.current) return;
    savePanelsState(openPanels, focusedPanelId);
  }, [openPanels, focusedPanelId, isDetached]);

  // Cross-tab sync for panels via storage events
  // ISSUE 9 fix: only sync openPanels across tabs, NOT focusedPanelId (focus is per-tab intent)
  useStorageSync(OPEN_PANELS_KEY, useCallback((panels: string[]) => {
    if (!isDetached && Array.isArray(panels)) setOpenPanels(panels);
  }, [isDetached]));

  // Server fetch on mount: always apply server's openPanels as canonical source
  const panelsServerFetchedRef = useRef(false);
  const panelsFromServerRef = useRef(false); // guard to skip saving echo from server/WS
  const serverSyncedRef = useRef(false); // true once initial server state is received (prevents stale overwrites)
  useEffect(() => {
    if (isDetached || panelsServerFetchedRef.current) return;
    panelsServerFetchedRef.current = true;
    fetch('/api/ui-state/panels')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || !Array.isArray(data.openPanels)) {
          serverSyncedRef.current = true;
          return;
        }
        // Always apply server's openPanels (canonical cross-device state)
        // focusedPanelId stays per-device (from localStorage only)
        panelsFromServerRef.current = true;
        try { localStorage.setItem(OPEN_PANELS_KEY, JSON.stringify(data.openPanels)); } catch {}
        setOpenPanels(data.openPanels);
        // ISSUE 21 fix: if openPanels is empty, clear stale grid-layout to prevent
        // inconsistent state where grid references panels that don't exist
        if (data.openPanels.length === 0) {
          try { localStorage.removeItem('topics-grid-layout'); } catch {}
          try { localStorage.removeItem('topics-project-layout'); } catch {}
        }
        // If current focus is stale (not in synced panels), auto-focus first panel
        setFocusedPanelId(prev => {
          if (prev && data.openPanels.includes(prev)) return prev;
          return data.openPanels[0] || null;
        });
        serverSyncedRef.current = true;
      })
      .catch(() => { serverSyncedRef.current = true; });
  }, [isDetached]);

  // Save state on visibility change (Safari PWA doesn't always fire beforeunload)
  useEffect(() => {
    if (isDetached) return;
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden') {
        savePanelsState(openPanels, focusedPanelId);
      }
    };
    const saveOnPageHide = () => savePanelsState(openPanels, focusedPanelId);
    document.addEventListener('visibilitychange', saveOnHide);
    window.addEventListener('pagehide', saveOnPageHide);
    return () => {
      document.removeEventListener('visibilitychange', saveOnHide);
      window.removeEventListener('pagehide', saveOnPageHide);
    };
  }, [openPanels, focusedPanelId, isDetached]);

  // Track topic switches initiated by this client (so topic:switch:complete only affects own switches)
  const ownTopicSwitchesRef = useRef<Set<string>>(new Set());

  // Pending focus for a topic inside a project tab
  const [pendingProjectFocus, setPendingProjectFocus] = useState<{ projectPath: string; topicId: string } | null>(null);
  // Active topic per project (for sidebar highlighting) — keyed by projectPath
  const [projectActiveTopics, setProjectActiveTopics] = useState<Record<string, string | null>>({});
  const handleProjectActiveTopicChange = useCallback((projectPath: string, topicId: string | null) => {
    setProjectActiveTopics(prev => prev[projectPath] === topicId ? prev : { ...prev, [projectPath]: topicId });
  }, []);
  const [projectOpenPanes, setProjectOpenPanes] = useState<Record<string, string[]>>({});
  const handleProjectOpenPanesChange = useCallback((projectPath: string, paneIds: string[]) => {
    setProjectOpenPanes(prev => {
      const existing = prev[projectPath];
      if (existing && existing.length === paneIds.length && existing.every((id, i) => id === paneIds[i])) return prev;
      return { ...prev, [projectPath]: paneIds };
    });
  }, []);

  // Cross-window drag state
  const [externalDragTopicId, setExternalDragTopicId] = useState<string | null>(null);
  const [externalDragSourceWindow, setExternalDragSourceWindow] = useState<string | null>(null);

  // Pending pane request (e.g. add terminal to a project from sidebar)
  const [pendingProjectPane, setPendingProjectPane] = useState<{ projectPath: string; type: import('./types').PaneType; terminalSessionId?: string; terminalType?: 'shell' | 'claude-code' } | null>(null);
  // Initial tab override for standalone panels (e.g. "New Terminal" opens with terminal tab)
  const [panelInitialTab, setPanelInitialTab] = useState<Record<string, import('./types').PanelTab>>({});
  // Draft chat state: tracks metadata for draft panes (not yet persisted on server)
  const [draftMeta, setDraftMeta] = useState<Record<string, { projectPath?: string; createdAt?: string }>>(() => {
    try {
      const saved = localStorage.getItem('draft-meta');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });

  // Persist draftMeta to localStorage
  useEffect(() => {
    try { localStorage.setItem('draft-meta', JSON.stringify(draftMeta)); } catch {}
  }, [draftMeta]);

  // Terminal sessions state (fetched from server, updated via WS)
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionInfo[]>([]);
  const terminalSessionsLoaded = useRef(false);
  // ISSUE 13 fix: track recently created terminal session IDs with timestamps
  // to avoid cleanup race when server WS broadcast hasn't caught up yet
  const recentlyCreatedTerminalsRef = useRef<Map<string, number>>(new Map());
  const fetchTerminalSessions = useCallback(() => {
    fetch('/api/terminal/sessions').then(r => r.json()).then((data: TerminalSessionInfo[]) => {
      terminalSessionsLoaded.current = true;
      setTerminalSessions(data);
    }).catch(() => {});
  }, []);

  // Cleanup drafts > 24h on mount
  useEffect(() => {
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    setDraftMeta(prev => {
      const next: typeof prev = {};
      let changed = false;
      for (const [id, meta] of Object.entries(prev)) {
        if (meta.createdAt && (now - new Date(meta.createdAt).getTime()) >= TWENTY_FOUR_HOURS) {
          changed = true;
          try { localStorage.removeItem(`draft-content-${id}`); } catch {}
        } else {
          next[id] = meta;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // Modals
  const [showSearch, setShowSearch] = useState(false);
  const [showNewTopic, setShowNewTopic] = useState<false | { projectPath?: string }>(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showFileSearch, setShowFileSearch] = useState<false | { projectPath: string }>(false);
  const [assignAgentsTarget, setAssignAgentsTarget] = useState<{ topicId: string; topicName: string } | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [claudeSkipPermissions, setClaudeSkipPermissions] = useClaudeSkipPermissions();
  const newMenuBtnRef = useRef<HTMLButtonElement>(null);
  const remoteAccessBtnRef = useRef<HTMLButtonElement>(null);
  const remoteAccessDropdownRef = useRef<HTMLDivElement>(null);
  const [showTopicsMenu, setShowTopicsMenu] = useState(false);
  const [expandedTool, setExpandedTool] = useState<SidebarTab | null>(null);
  const topicsMenuRef = useRef<HTMLDivElement>(null);
  const topicsDropdownRef = useRef<HTMLDivElement>(null);
  const [topicsMenuPos, setTopicsMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Close topics menu on outside click or Escape
  useEffect(() => {
    if (!showTopicsMenu) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (topicsMenuRef.current?.contains(t) || topicsDropdownRef.current?.contains(t)) return;
      setShowTopicsMenu(false); setExpandedTool(null);
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setShowTopicsMenu(false); setExpandedTool(null); e.stopPropagation(); } };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k, true);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k, true); };
  }, [showTopicsMenu]);

  // Close remote access dropdown on outside click or Escape
  useEffect(() => {
    if (expandedTool !== 'remote') return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (remoteAccessBtnRef.current?.contains(t) || remoteAccessDropdownRef.current?.contains(t)) return;
      setExpandedTool(null);
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setExpandedTool(null); e.stopPropagation(); } };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k, true);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k, true); };
  }, [expandedTool]);


  // App settings
  const [appSettings, setAppSettings] = useState<AppSettings>(loadSettings);

  // Cross-tab sync for settings
  useStorageSync('app-settings', useCallback((newSettings: AppSettings) => {
    if (newSettings) setAppSettings(newSettings);
  }, []));

  // Sidebar resize state - collapsed by default in detached windows and mobile
  const [sidebarWidth, setSidebarWidth] = useState(() => appSettings.sidebarWidth || 256);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return isDetached || isMobile ? true : (appSettings.sidebarCollapsed || false);
  });

  // Remove pre-render sidebar-collapsed class now that React owns the state
  useEffect(() => {
    document.documentElement.classList.remove('sidebar-pre-collapsed');
  }, []);
  
  // Auto-collapse sidebar on mobile
  useEffect(() => {
    if (isMobile && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    }
  }, [isMobile]);
  const sidebarResizing = useRef(false);
  const sidebarStartX = useRef(0);
  const sidebarStartWidth = useRef(0);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Mobile swipe-to-dismiss sidebar
  const touchStartX = useRef<number | null>(null);
  const handleSidebarTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);
  const handleSidebarTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current !== null) {
      const delta = e.changedTouches[0].clientX - touchStartX.current;
      if (delta < -60) {
        setSidebarCollapsed(true);
      }
      touchStartX.current = null;
    }
  }, []);

  // Sidebar resize handlers — bypass React during drag for fluid resizing
  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarResizing.current = true;
    sidebarStartX.current = e.clientX;
    sidebarStartWidth.current = sidebarCollapsed ? 0 : sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // Disable CSS transition during drag for instant feedback
    if (sidebarRef.current) {
      sidebarRef.current.style.transition = 'none';
    }
  }, [sidebarWidth, sidebarCollapsed]);

  const handleSidebarDoubleClick = useCallback(() => {
    setSidebarCollapsed(prev => {
      const newVal = !prev;
      if (!isDetached) {
        const newSettings = { ...appSettings, sidebarCollapsed: newVal };
        saveSettings(newSettings);
        setAppSettings(newSettings);
      }
      return newVal;
    });
  }, [appSettings, isDetached]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!sidebarResizing.current) return;
      const delta = e.clientX - sidebarStartX.current;
      const newWidth = Math.max(180, Math.min(400, sidebarStartWidth.current + delta));
      // Update DOM directly — no React re-render per pixel
      if (sidebarRef.current) {
        sidebarRef.current.style.width = `${newWidth}px`;
        sidebarRef.current.style.opacity = '';
      }
    };
    const onUp = (e: MouseEvent) => {
      if (!sidebarResizing.current) return;
      sidebarResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Re-enable CSS transition
      if (sidebarRef.current) {
        sidebarRef.current.style.transition = '';
      }
      // Sync final width to React state
      const delta = e.clientX - sidebarStartX.current;
      const finalWidth = Math.max(180, Math.min(400, sidebarStartWidth.current + delta));
      const collapsed = finalWidth <= 180 && delta < -20;
      setSidebarWidth(collapsed ? 180 : finalWidth);
      setSidebarCollapsed(collapsed);
      // Persist (but not from detached windows — they'd overwrite main window's sidebar state)
      if (!isDetached) {
        const newSettings = { ...loadSettings(), sidebarWidth: collapsed ? 180 : finalWidth, sidebarCollapsed: collapsed };
        saveSettings(newSettings);
        setAppSettings(newSettings);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDetached]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const newVal = !prev;
      if (!isDetached) {
        const newSettings = { ...appSettings, sidebarCollapsed: newVal };
        saveSettings(newSettings);
        setAppSettings(newSettings);
      }
      return newVal;
    });
  }, [appSettings, isDetached]);

  const {
    topics,
    workspaceProjects,
    loading: topicsLoading,
    error: topicsError,
    loadTopics,
    createTopic,
    updateTopic,
    archiveTopic,
    archiveProject,
    applyTopicFromWS,
  } = useTopics();

  // Resolve projectPath from focused pane — works for both project panes and topic panes
  const focusedProjectPath = useMemo(() => {
    if (!focusedPanelId) return undefined;
    if (isProjectPaneId(focusedPanelId)) return getProjectPathFromPaneId(focusedPanelId) || undefined;
    return topics[focusedPanelId]?.projectPath || undefined;
  }, [focusedPanelId, topics]);

  // ISSUE 12 fix: track previous openPanels and topics to detect when they actually change
  const prevOpenPanelsForValidation = useRef<string[]>(openPanels);
  const prevTopicsForValidation = useRef(topics);
  // Validate saved panels exist (remove deleted/archived topics, move project-linked topics)
  useEffect(() => {
    if (!topicsLoading && Object.keys(topics).length > 0 && !isDetached) {
      // Guard: skip if neither openPanels nor topics changed since last validation
      // (prevents loops when this effect itself triggers setOpenPanels)
      const panelsChanged = openPanels !== prevOpenPanelsForValidation.current;
      const topicsChanged = topics !== prevTopicsForValidation.current;
      prevTopicsForValidation.current = topics;
      if (!panelsChanged && !topicsChanged) return;

      const projectPanesToAdd: string[] = [];
      const validPanels = openPanels.filter(id => {
        if (isUtilityPanelId(id) || isProjectPaneId(id) || isBrowserPaneId(id) || isTerminalPaneId(id) || isDraftPaneId(id)) return true;
        const topic = topics[id];
        if (!topic || topic.archived) return false;
        // Topic linked to a project → remove from standalone, ensure project pane is open
        if (topic.projectPath) {
          const paneId = createPaneId('project', topic.projectPath);
          if (!projectPanesToAdd.includes(paneId)) projectPanesToAdd.push(paneId);
          return false;
        }
        return true;
      });
      // Add project panes for topics that were moved
      for (const p of projectPanesToAdd) {
        if (!validPanels.includes(p)) validPanels.push(p);
      }
      const changed = validPanels.length !== openPanels.length || validPanels.some((v, i) => v !== openPanels[i]);
      if (changed) {
        prevOpenPanelsForValidation.current = validPanels;
        setOpenPanels(validPanels);
        // Don't reset focus for browser panes (managed locally by StandaloneChatGroup)
        if (focusedPanelId && !validPanels.includes(focusedPanelId) && !isBrowserPaneId(focusedPanelId)) {
          // If focused topic was moved to a project, focus the project pane
          const movedTopic = topics[focusedPanelId];
          if (movedTopic?.projectPath) {
            const projectPaneId = createPaneId('project', movedTopic.projectPath);
            setFocusedPanelId(projectPaneId);
            setPendingProjectFocus({ projectPath: movedTopic.projectPath, topicId: focusedPanelId });
          } else {
            setFocusedPanelId(validPanels.length > 0 ? validPanels[0] : null);
          }
        }
      } else {
        prevOpenPanelsForValidation.current = openPanels;
      }
    }
  }, [topics, topicsLoading, isDetached, openPanels, focusedPanelId]);

  const {
    sendMessage,
    editMessage,
    switchBranch,
    stopSession,
    getSessionMessages,
    addMessageFromWS,
    isSessionLoading,
    isSessionStreaming,
    loadHistory,
    appendMediaToLastAssistant,
    clearSession,
    drainQueue,
    expiredMessages,
    retryExpired,
    clearExpired,
    onWSMessage: chatStreamHandler,
    error: chatError,
    gatewayConnected: _gatewayConnected,
    isOwnStream,
  } = useChat();

  const { status: wsStatus, unreadData, sendWS, onMessage: onWSMessage } = useWebSocket();

  // Wire up chat stream handler to WebSocket (enables cross-window streaming)
  useEffect(() => {
    return onWSMessage(chatStreamHandler);
  }, [onWSMessage, chatStreamHandler]);

  // Cross-device panels sync via WS (ui-state:updated / ui-state:init with "panels" key)
  // Only sync openPanels — focusedPanelId is per-device and must not be overwritten by other clients
  useEffect(() => {
    if (isDetached) return;
    return onWSMessage((msg: any) => {
      let data: { openPanels?: string[] } | null = null;
      if (msg.type === 'ui-state:updated' && msg.key === 'panels') {
        data = msg.value;
      } else if (msg.type === 'ui-state:init' && msg.data?.panels) {
        data = msg.data.panels;
      }
      if (!data || !Array.isArray(data.openPanels)) return;
      panelsFromServerRef.current = true;
      serverSyncedRef.current = true;
      try { localStorage.setItem(OPEN_PANELS_KEY, JSON.stringify(data.openPanels)); } catch {}
      setOpenPanels(data.openPanels);
      // ISSUE 21 fix: clear stale grid-layout when openPanels becomes empty via WS
      if (data.openPanels.length === 0) {
        try { localStorage.removeItem('topics-grid-layout'); } catch {}
        try { localStorage.removeItem('topics-project-layout'); } catch {}
      }
      // If current focus is not in the new panel list, auto-focus the first panel
      setFocusedPanelId(prev => {
        if (prev && data!.openPanels!.includes(prev)) return prev; // keep current focus
        return data!.openPanels![0] || null;
      });
    });
  }, [onWSMessage, isDetached]);

  // Drain outbound message queue and reload open panel histories when WS reconnects
  const prevWsStatus = useRef(wsStatus);
  useEffect(() => {
    if (prevWsStatus.current !== 'connected' && wsStatus === 'connected') {
      drainQueue();
      // Re-fetch message history for all open topics to clear stale partial/failed states
      for (const panelId of openPanels) {
        const topic = topics[panelId];
        if (topic) {
          loadHistory(topic.sessionKey);
        }
      }
    }
    prevWsStatus.current = wsStatus;
  }, [wsStatus, drainQueue, openPanels, topics, loadHistory]);
  const { themeMode, toggleTheme, setTheme } = useTheme(onWSMessage);
  const { activeSessions, idleSessions } = useAgents({ activeMinutes: 120, enabled: true });
  const agentLiveCount = activeSessions.length + idleSessions.length;



  // Board task counts per project (for sidebar badges)
  const [boardTaskCounts, setBoardTaskCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    globalBoardApi.listTasks().then(data => {
      const counts: Record<string, number> = {};
      for (const t of data.tasks) {
        if (t.status !== 'done') counts[t.projectId] = (counts[t.projectId] || 0) + 1;
      }
      setBoardTaskCounts(counts);
    }).catch(() => {});
  }, []);
  // Keep board task counts in sync via WS
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'task:created' || msg.type === 'task:moved' || msg.type === 'task:updated' || msg.type === 'task:deleted') {
        // Re-fetch counts on any task change
        globalBoardApi.listTasks().then(data => {
          const counts: Record<string, number> = {};
          for (const t of data.tasks) {
            if (t.status !== 'done') counts[t.projectId] = (counts[t.projectId] || 0) + 1;
          }
          setBoardTaskCounts(counts);
        }).catch(() => {});
      }
    });
  }, [onWSMessage]);

  // Fetch terminal sessions + reload topics on mount + WS reconnect
  useEffect(() => { fetchTerminalSessions(); }, [fetchTerminalSessions]);
  useEffect(() => {
    if (wsStatus === 'connected') {
      fetchTerminalSessions();
      loadTopics();
    }
  }, [wsStatus, fetchTerminalSessions, loadTopics]);
  // Keep terminal sessions in sync via WS
  useEffect(() => {
    return onWSMessage((msg) => {
      if (msg.type === 'terminal:sessions' && Array.isArray(msg.sessions)) {
        setTerminalSessions(msg.sessions as TerminalSessionInfo[]);
      }
    });
  }, [onWSMessage]);

  // Clean stale terminal panes from openPanels when sessions change (skip until first fetch)
  // ISSUE 13 fix: exclude recently created sessions from cleanup (5s grace period)
  useEffect(() => {
    if (!terminalSessionsLoaded.current) return;
    const sessionIds = new Set(terminalSessions.map(s => s.id));
    const now = Date.now();
    const GRACE_MS = 5000;
    // Prune expired entries from recentlyCreated
    for (const [id, ts] of recentlyCreatedTerminalsRef.current) {
      if (now - ts > GRACE_MS) recentlyCreatedTerminalsRef.current.delete(id);
    }
    setOpenPanels(prev => {
      const filtered = prev.filter(id => {
        if (!id.startsWith('terminal:')) return true;
        const sessionId = id.slice('terminal:'.length);
        // Keep if server knows about it OR if it was recently created (grace period)
        return sessionIds.has(sessionId) || recentlyCreatedTerminalsRef.current.has(sessionId);
      });
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [terminalSessions]);

  // Browser pane management
  const [pendingBrowserPane, setPendingBrowserPane] = useState<string | null>(null);
  const handlePendingBrowserPaneConsumed = useCallback(() => setPendingBrowserPane(null), []);
  const openBrowserPane = useCallback((contextId: string) => {
    setPendingBrowserPane(contextId);
    if (isMobile) {
      setSidebarCollapsed(true);
    }
  }, [isMobile]);
  const [, setOpenBrowserContextIds] = useState<string[]>([]);
  const _focusedBrowserContextId = focusedPanelId ? getBrowserContextFromPaneId(focusedPanelId) : null;

  const sidebarContentRef = useRef<HTMLDivElement>(null);

  // Open a utility page (Activity/Journal/Agents/Dashboard/All Boards) as a pane in the main panel
  const handleOpenAsPage = useCallback((type: 'activity' | 'agents' | 'dashboard' | 'all-boards' | 'cron') => {
    const id = utilityPanelId(type);
    if (isMobile) {
      setOpenPanels([id]);
      setSidebarCollapsed(true);
    } else if (!openPanels.includes(id)) {
      setOpenPanels(prev => [...prev, id]);
    }
    setFocusedPanelId(id);
  }, [openPanels, isMobile]);

  // Listen for WS messages to trigger notifications
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    const unsub = onWSMessage((msg) => {
      // Cross-window topic sync (archive, update, create)
      if ((msg.type === 'topic:archived' || msg.type === 'topic:updated' || msg.type === 'topic:created') && msg.topic) {
        applyTopicFromWS(msg.topic as Topic);
      }

      // Real-time message sync across windows (skip if this client owns the stream)
      if (msg.type === 'message:new' && msg.sessionKey && msg.content) {
        const sessionKey = msg.sessionKey as string;
        // Skip if this client has an active SSE stream for this session — we already have the messages
        if (isOwnStream(sessionKey)) return;
        const role = msg.role as 'user' | 'assistant';
        const content = msg.content as string;

        // Check if we already have this message (avoid duplicates)
        const existingMessages = getSessionMessages(sessionKey);
        const lastMsgOfRole = [...existingMessages].reverse().find(m => m.role === role);
        if (!lastMsgOfRole || lastMsgOfRole.content !== content) {
          // Add message from another window
          addMessageFromWS(sessionKey, {
            role,
            content,
            timestamp: new Date().toISOString(),
          });
        }
      }
      
      // Notifications for messages in non-focused topics
      // Rules: only assistant messages, only when tab is not visible, only when topic is not focused
      if (
        msg.type === 'message:new' &&
        msg.role === 'assistant' &&
        msg.topicId !== focusedPanelId &&
        document.visibilityState === 'hidden'
      ) {
        if ('Notification' in window && Notification.permission === 'granted') {
          const topic = topics[msg.topicId];
          if (topic) {
            new Notification(topic.name, {
              body: msg.preview || 'New message',
              tag: `topic-${msg.topicId}`,
            });
          }
        }
      }
      // Handle topic auto-switch: open target panel (messages move happens on :complete)
      // Only handle if this client initiated the stream (prevents ghost panels on LAN clients)
      if (msg.type === 'topic:switch' && msg.toTopicId) {
        const fromSK = msg.fromSessionKey as string;
        if (!fromSK || isOwnStream(fromSK)) {
          const toId = msg.toTopicId as string;
          // Track this as our own switch so topic:switch:complete also applies
          if (fromSK) ownTopicSwitchesRef.current.add(fromSK);
          // Open target panel immediately (source stays until :complete removes messages)
          if (!openPanels.includes(toId)) {
            setOpenPanels(prev => [...prev, toId]);
          }
          setFocusedPanelId(toId);
        }
      }
      // Handle topic switch complete: move messages between sessions and close source
      // Only handle if we previously processed topic:switch for this session
      if (msg.type === 'topic:switch:complete' && msg.fromSessionKey && msg.toSessionKey) {
        const fromSK = msg.fromSessionKey as string;
        if (!ownTopicSwitchesRef.current.has(fromSK)) return;
        ownTopicSwitchesRef.current.delete(fromSK);
        const fromId = msg.fromTopicId as string;
        const toSK = msg.toSessionKey as string;
        const userContent = msg.userContent as string;
        const assistantContent = msg.assistantContent as string;
        // Remove last 2 messages (user + assistant) from source session in-memory
        clearSession(fromSK);
        // Re-load source session from server (now without the moved messages)
        loadHistory(fromSK);
        // Add messages to target session in-memory
        if (userContent) {
          addMessageFromWS(toSK, { role: 'user', content: userContent, timestamp: new Date().toISOString() });
        }
        if (assistantContent) {
          addMessageFromWS(toSK, { role: 'assistant', content: assistantContent, timestamp: new Date().toISOString() });
        }
        // Close source panel
        setOpenPanels(prev => prev.filter(id => id !== fromId));
        // Focus target
        const toId = msg.toTopicId as string;
        setFocusedPanelId(toId);
      }
      // Handle media files detected after a chat response
      if (msg.type === 'message:media' && msg.sessionKey && msg.media) {
        appendMediaToLastAssistant(msg.sessionKey, msg.media as string[]);
      }
      // Handle clear command
      if (msg.type === 'clear' && msg.sessionKey) {
        clearSession(msg.sessionKey as string);
      }
      // Inject inline card when a sub-agent is spawned for a topic
      if (msg.type === 'agents:spawned' && msg.topicId && msg.sessionKey) {
        const parentTopic = topics[msg.topicId as string];
        if (parentTopic) {
          addMessageFromWS(parentTopic.sessionKey, {
            role: 'assistant',
            content: `{{AGENT_SPAWN:${msg.sessionKey}|${(msg.label as string) || 'Claude Code'}}}`,
            timestamp: new Date().toISOString(),
          });
        }
      }
    });

    return unsub;
  }, [onWSMessage, focusedPanelId, topics, appendMediaToLastAssistant, clearSession, loadHistory, addMessageFromWS, getSessionMessages, applyTopicFromWS, openPanels]);

  // Listen for cross-window drag messages
  useEffect(() => {
    const unsub = onWSMessage((msg) => {
      // Another window started dragging
      if (msg.type === 'drag:start' && msg.sourceWindowId !== windowId) {
        setExternalDragTopicId(msg.topicId as string);
        setExternalDragSourceWindow(msg.sourceWindowId as string);
      }
      
      // Drag ended (cancelled or dropped elsewhere)
      if (msg.type === 'drag:end' && msg.sourceWindowId !== windowId) {
        setExternalDragTopicId(null);
        setExternalDragSourceWindow(null);
      }
      
      // Another window accepted our drag - remove the panel
      if (msg.type === 'drag:accepted' && msg.sourceWindowId === windowId) {
        const topicId = msg.topicId as string;
        setOpenPanels(prev => prev.filter(id => id !== topicId));
        if (focusedPanelId === topicId) {
          setFocusedPanelId(null);
        }
      }
    });

    return unsub;
  }, [onWSMessage, windowId, focusedPanelId]);

  // Handle dropping a panel from another window into this one
  const handleExternalDrop = useCallback(() => {
    if (externalDragTopicId && externalDragSourceWindow) {
      // Add the panel to this window
      if (!openPanels.includes(externalDragTopicId)) {
        setOpenPanels(prev => [...prev, externalDragTopicId]);
        setFocusedPanelId(externalDragTopicId);
      }
      // Notify the source window to remove it
      sendWS({
        type: 'drag:drop',
        topicId: externalDragTopicId,
        windowId: windowId,
        sourceWindowId: externalDragSourceWindow,
      });
      setExternalDragTopicId(null);
      setExternalDragSourceWindow(null);
    }
  }, [externalDragTopicId, externalDragSourceWindow, openPanels, sendWS, windowId]);

  // Panel layout mode: 'side' = add to existing row, 'below' = new row
  const [nextPanelMode, setNextPanelMode] = useState<'side' | 'below'>('side');
  // Track "preview" panel that can be replaced by next single-click
  const [previewPanelId, setPreviewPanelId] = useState<string | null>(null);

  // Panel management
  // Single click = open in "preview" mode (replaces previous preview panel)
  // Cmd/Ctrl+click = open permanently below  
  // Double click = open permanently (won't be replaced)
  // autoFocus = false: add panel but don't focus it (used for new topic creation)
  const openPanel = useCallback((topicId: string, mode: 'preview' | 'permanent' | 'below', autoFocus = true) => {
    if (openPanels.includes(topicId)) {
      // Already open - focus it (if autoFocus)
      if (autoFocus) {
        setFocusedPanelId(topicId);
      }
      if (mode === 'permanent' && previewPanelId === topicId) {
        setPreviewPanelId(null);
      }
      return;
    }

    // Calculate new panels list
    let newPanels: string[];
    if (isMobile) {
      // Mobile: single panel only — replace whatever is open
      newPanels = [topicId];
    } else if (mode === 'preview' && previewPanelId) {
      // Replace existing preview
      newPanels = openPanels.filter(id => id !== previewPanelId).concat(topicId);
    } else {
      // Add new panel
      newPanels = [...openPanels, topicId];
    }

    setOpenPanels(newPanels);
    if (autoFocus) {
      setFocusedPanelId(topicId);
    }
    setPreviewPanelId(mode === 'preview' ? topicId : null);
    setNextPanelMode(mode === 'below' ? 'below' : 'side');
  }, [openPanels, previewPanelId, isMobile]);

  // Electron: listen for navigate-to-topic from tray/notifications
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onNavigateToTopic) return;
    api.onNavigateToTopic((topicId: string) => {
      if (topicId) openPanel(topicId, 'permanent');
    });
  }, [openPanel]);

  // Electron: report focused topic for notification suppression
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.reportFocusedTopic) return;
    api.reportFocusedTopic(focusedPanelId || null);
  }, [focusedPanelId]);

  const handleTopicClick = useCallback((topicId: string, e?: React.MouseEvent) => {
    const topic = topics[topicId];
    // If this topic belongs to a project, open/focus the project tab instead
    if (topic?.projectPath) {
      const projectPaneId = createPaneId('project', topic.projectPath);
      if (isMobile) {
        setOpenPanels([projectPaneId]);
        setSidebarCollapsed(true);
      } else if (!openPanels.includes(projectPaneId)) {
        setOpenPanels(prev => [...prev, projectPaneId]);
      }
      setFocusedPanelId(projectPaneId);
      setPendingProjectFocus({ projectPath: topic.projectPath, topicId });
      return;
    }
    if (e && (e.metaKey || e.ctrlKey)) {
      openPanel(topicId, 'below');
    } else {
      openPanel(topicId, 'preview');
    }
    // Close sidebar on mobile after selecting a topic
    if (isMobile) {
      setSidebarCollapsed(true);
    }
  }, [openPanel, isMobile, topics, openPanels]);

  const handleTopicDoubleClick = useCallback((topicId: string, _e?: React.MouseEvent) => {
    openPanel(topicId, 'permanent');
  }, [openPanel]);

  const handleClosePanel = useCallback((topicId: string) => {
    setOpenPanels(prev => {
      const next = prev.filter(id => id !== topicId);
      if (focusedPanelIdRef.current === topicId) {
        setFocusedPanelId(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
    // Clean up draft metadata if closing a draft pane
    if (isDraftPaneId(topicId)) {
      setDraftMeta(prev => {
        const next = { ...prev };
        delete next[topicId];
        return next;
      });
    }
  }, []);

  // ISSUE 22 fix: batch-close multiple panels atomically in a single state update
  const _handleCloseMultiplePanels = useCallback((panelIds: string[]) => {
    const toCloseSet = new Set(panelIds);
    setOpenPanels(prev => {
      const next = prev.filter(id => !toCloseSet.has(id));
      if (focusedPanelIdRef.current && toCloseSet.has(focusedPanelIdRef.current)) {
        setFocusedPanelId(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
    // Clean up draft metadata for any drafts being closed
    const draftsToClose = panelIds.filter(isDraftPaneId);
    if (draftsToClose.length > 0) {
      setDraftMeta(prev => {
        const next = { ...prev };
        for (const id of draftsToClose) delete next[id];
        return next;
      });
    }
  }, []);

  const handleProjectClick = useCallback((projectPath: string) => {
    const paneId = createPaneId('project', projectPath);
    if (isMobile) {
      setOpenPanels([paneId]);
      setSidebarCollapsed(true);
    } else if (!openPanels.includes(paneId)) {
      setOpenPanels(prev => [...prev, paneId]);
    }
    setFocusedPanelId(paneId);
  }, [openPanels, isMobile]);

  const handleCloseProject = useCallback((projectPath: string) => {
    const paneId = createPaneId('project', projectPath);
    setOpenPanels(prev => {
      const next = prev.filter(id => id !== paneId);
      if (focusedPanelIdRef.current === paneId) {
        setFocusedPanelId(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
  }, []);

  const handleFocusPanel = useCallback((topicId: string) => {
    setFocusedPanelId(topicId);
  }, []);

  const handleReorderPanels = useCallback((panels: string[]) => {
    setOpenPanels(panels);
  }, []);

  const handleOpenPanelAt = useCallback((topicId: string, index: number) => {
    setOpenPanels(prev => {
      // Remove if already open (reposition)
      const without = prev.filter(id => id !== topicId);
      const insertAt = Math.min(index, without.length);
      const next = [...without];
      next.splice(insertAt, 0, topicId);
      return next;
    });
    setFocusedPanelId(topicId);
  }, []);

  const handleCreateTopic = async (data: CreateTopicRequest) => {
    const topic = await createTopic(data);
    if (topic) {
      if (data.projectPath) {
        // Topic belongs to a project — focus the project pane
        const projectPaneId = createPaneId('project', data.projectPath);
        if (!openPanels.includes(projectPaneId)) {
          setOpenPanels(prev => [...prev, projectPaneId]);
        }
        setFocusedPanelId(projectPaneId);
        setPendingProjectFocus({ projectPath: data.projectPath, topicId: topic.id });
      } else {
        openPanel(topic.id, 'permanent', false);
      }
    }
    return topic;
  };

  // Quick-create empty chat (bypasses modal)
  // projectPath must be explicitly provided to bind to a project
  const handleQuickCreateTopic = async (projectPath?: string) => {
    if (projectPath) {
      // Project-bound: create immediately on server (existing behavior)
      const topic = await createTopic({
        name: 'New Chat',
        icon: DEFAULT_TOPIC_ICON,
        color: '#0066ff',
        projectPath,
      });
      if (topic) {
        const projectPaneId = createPaneId('project', projectPath);
        if (!openPanels.includes(projectPaneId)) {
          setOpenPanels(prev => [...prev, projectPaneId]);
        }
        setFocusedPanelId(projectPaneId);
        setPendingProjectFocus({ projectPath, topicId: topic.id });
      }
      return topic;
    }
    // Standalone: open a draft pane (no API call until first message)
    const draftId = createDraftPaneId();
    setDraftMeta(prev => ({ ...prev, [draftId]: { createdAt: new Date().toISOString() } }));
    openPanel(draftId, 'permanent', true);
    return null;
  };

  // Promote a draft pane to a real topic on first message
  const promoteDraft = useCallback(async (draftId: string, firstMessage: string, options?: { planMode?: boolean }) => {
    const meta = draftMeta[draftId] || {};
    const topic = await createTopic({
      name: 'New Chat',
      icon: DEFAULT_TOPIC_ICON,
      color: '#0066ff',
      projectPath: meta.projectPath,
    });
    if (!topic) return;
    // Replace draft ID with real topic ID in openPanels
    setOpenPanels(prev => prev.map(id => id === draftId ? topic.id : id));
    if (focusedPanelId === draftId) {
      setFocusedPanelId(topic.id);
    }
    // Clean up draft metadata
    setDraftMeta(prev => {
      const next = { ...prev };
      delete next[draftId];
      try { localStorage.removeItem(`draft-content-${draftId}`); } catch {}
      return next;
    });
    // Send the first message with the real session key
    await sendMessage(topic.sessionKey, firstMessage, options);
  }, [draftMeta, createTopic, focusedPanelId, sendMessage]);

  // Quick-create standalone terminal (creates a terminal session and adds as pane)
  const handleQuickCreateTerminal = useCallback(async (termType: 'shell' | 'claude-code' = 'shell', skipPermissions = true) => {
    try {
      const name = termType === 'claude-code' ? 'Claude Code' : 'Shell';
      const body: Record<string, unknown> = { type: termType, name };
      if (termType === 'claude-code') body.skipPermissions = skipPermissions;
      const res = await fetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return;
      const data = await res.json();
      const paneId = createPaneId('terminal', data.id);
      // ISSUE 13 fix: register in grace period set so cleanup won't remove it
      recentlyCreatedTerminalsRef.current.set(data.id, Date.now());
      // Optimistic update so label is available immediately
      setTerminalSessions(prev => prev.some(s => s.id === data.id) ? prev : [...prev, { id: data.id, name: data.name || name, createdAt: data.createdAt, cwd: data.cwd, command: data.command, clients: 0, topicId: data.topicId, type: data.type }]);
      setOpenPanels(prev => prev.includes(paneId) ? prev : [...prev, paneId]);
      setFocusedPanelId(paneId);
      if (isMobile) setSidebarCollapsed(true);
    } catch {}
  }, [isMobile]);

  // Close a terminal session from the sidebar
  const handleCloseTerminal = useCallback(async (sessionId: string) => {
    fetch(`/api/terminal/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    setTerminalSessions(prev => prev.filter(s => s.id !== sessionId));
    const paneId = createPaneId('terminal', sessionId);
    setOpenPanels(prev => prev.filter(p => p !== paneId));
  }, []);

  // Open an existing terminal session from the sidebar (reattach)
  const handleTerminalClick = useCallback((sessionId: string, _sessionName: string) => {
    // Check if this terminal belongs to a project (cwd matches a project path)
    const session = terminalSessions.find(s => s.id === sessionId);
    if (session?.cwd) {
      // Check if cwd matches any known project path
      const knownProjectPaths = new Set<string>();
      for (const t of Object.values(topics)) {
        if (t.projectPath) knownProjectPaths.add(t.projectPath);
      }
      for (const p of workspaceProjects) knownProjectPaths.add(p);

      if (knownProjectPaths.has(session.cwd)) {
        const projectPath = session.cwd;
        const projectPaneId = createPaneId('project', projectPath);
        // Open project pane if not already open
        if (isMobile) {
          setOpenPanels([projectPaneId]);
          setSidebarCollapsed(true);
        } else if (!openPanels.includes(projectPaneId)) {
          setOpenPanels(prev => [...prev, projectPaneId]);
        }
        setFocusedPanelId(projectPaneId);
        setPendingProjectPane({ projectPath, type: 'terminal' as import('./types').PaneType, terminalSessionId: sessionId });
        if (isMobile) setSidebarCollapsed(true);
        return;
      }
    }
    const paneId = createPaneId('terminal', sessionId);
    if (!openPanels.includes(paneId)) {
      setOpenPanels(prev => [...prev, paneId]);
    }
    setFocusedPanelId(paneId);
    if (isMobile) setSidebarCollapsed(true);
  }, [openPanels, isMobile, terminalSessions, topics, workspaceProjects]);

  // Add a non-chat pane (terminal, browser) to a project window
  const handleAddProjectPane = useCallback((projectPath: string, type: import('./types').PaneType, subType?: string) => {
    // Ensure the project pane is open
    const projectPaneId = createPaneId('project', projectPath);
    if (isMobile) {
      setOpenPanels([projectPaneId]);
      setSidebarCollapsed(true);
    } else if (!openPanels.includes(projectPaneId)) {
      setOpenPanels(prev => [...prev, projectPaneId]);
    }
    setFocusedPanelId(projectPaneId);
    setPendingProjectPane({
      projectPath,
      type,
      terminalType: type === 'terminal' ? (subType as 'shell' | 'claude-code' || 'shell') : undefined,
    });
  }, [openPanels, isMobile]);

  // Open the board pane for a project (from sidebar or context menu)
  const handleOpenProjectBoard = useCallback((projectPath: string) => {
    handleAddProjectPane(projectPath, 'board');
  }, [handleAddProjectPane]);

  const handleArchiveProject = useCallback(async (projectPath: string, archive: boolean) => {
    const success = await archiveProject(projectPath, archive);
    if (success && archive) {
      handleCloseProject(projectPath);
    }
    return success;
  }, [archiveProject, handleCloseProject]);

  const handleTopicContextMenu = useCallback((e: React.MouseEvent, topic: Topic) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, topic });
  }, []);

  // Sidebar state
  // searchQuery removed — sidebar search now opens command palette
  const sidebar = useSidebarState(onWSMessage);
  const browserCtx = useBrowserContexts(true, onWSMessage);
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  // Auto-expand projects that have an open project tab
  useEffect(() => {
    const projectIds = openPanels
      .filter(id => id.startsWith('project:'))
      .map(id => id); // project pane IDs like "project:%2Ftmp%2Fpath"
    // Also map to the buildSidebarItems id format: "project:/path"
    const sidebarProjectIds = openPanels
      .filter(id => id.startsWith('project:'))
      .map(id => `project:${decodeURIComponent(id.slice('project:'.length))}`);
    if (sidebarProjectIds.length > 0) {
      setExpandedProjects(prev => {
        const set = new Set(prev);
        let changed = false;
        for (const sid of sidebarProjectIds) {
          if (!set.has(sid)) { set.add(sid); changed = true; }
        }
        return changed ? Array.from(set) : prev;
      });
    }
  }, [openPanels]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; topic: Topic } | null>(null);

  const _getChildren = useCallback((parentId: string | null): Topic[] => {
    // Don't filter archived here - let the caller decide (renderLevel handles it)
    return Object.values(topics).filter(t => t.parentId === parentId);
  }, [topics]);

  const _getArchivedTopics = useCallback((): Topic[] => {
    return Object.values(topics).filter(t => t.archived);
  }, [topics]);


  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === 'k') {
        e.preventDefault();
        setShowSearch(prev => !prev);
        return;
      }

      if (isElectron && isMod && e.key === 'n') {
        e.preventDefault();
        if (e.shiftKey) {
          setShowNewTopic({}); // ⌘⇧N = templates modal
        } else {
          handleQuickCreateTopic(); // ⌘N = quick create
        }
        return;
      }

      if (isMod && e.key === 'p') {
        e.preventDefault();
        setShowSearch(prev => !prev);
        return;
      }

      if (isMod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setShowFileSearch(prev => {
          if (prev) return false;
          // Try focused pane's projectPath first (works for both project panes and topic panes)
          if (focusedProjectPath) return { projectPath: focusedProjectPath };
          // Fallback: find any topic with a projectPath
          const projectPaths = [...new Set(Object.values(topics).map(t => t.projectPath).filter(Boolean))] as string[];
          if (projectPaths.length === 1) return { projectPath: projectPaths[0] };
          if (projectPaths.length > 1) return { projectPath: projectPaths[0] }; // use first available
          return false; // no projects
        });
        return;
      }

      if (isMod && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      if (isElectron && isMod && e.key === 'w') {
        e.preventDefault();
        if (focusedPanelId) {
          handleClosePanel(focusedPanelId);
        }
        return;
      }

      if (isElectron && isMod && e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (idx < openPanels.length) {
          setFocusedPanelId(openPanels[idx]);
        }
        return;
      }

      // ⌘? or ⌘/ — keyboard shortcuts help
      if (isMod && (e.key === '?' || e.key === '/')) {
        e.preventDefault();
        setShowShortcuts(prev => !prev);
        return;
      }

      if (e.key === 'Escape') {
        if (showFileSearch !== false) { setShowFileSearch(false); e.preventDefault(); return; }
        if (showShortcuts) { setShowShortcuts(false); e.preventDefault(); return; }
        if (showSearch) { setShowSearch(false); e.preventDefault(); return; }
        if (showNewTopic) { setShowNewTopic(false); e.preventDefault(); return; }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focusedPanelId, openPanels, handleClosePanel, showSearch, showNewTopic, showFileSearch, toggleSidebar, isElectron, topics]);

  // Listen for "open-all-boards" custom event from sidebar
  useEffect(() => {
    const handler = () => handleOpenAsPage('all-boards');
    window.addEventListener('open-all-boards', handler);
    return () => window.removeEventListener('open-all-boards', handler);
  }, [handleOpenAsPage]);

  // Close window if all panels are gone (for detached windows)
  useEffect(() => {
    if (isDetached && openPanels.length === 0) {
      // For detached windows with no panels, show close prompt
      // window.close() only works if window was opened by JS
      window.close();
      // Fallback: redirect back to main (resets to normal window)
      setTimeout(() => {
        window.location.href = window.location.origin;
      }, 200);
    }
  }, [isDetached, openPanels.length]);

  return (
    <ToastProvider>
    <div
      className="flex bg-app-bg overflow-hidden max-w-[100vw]"
      style={{
        fontSize: `${appSettings.fontSize}px`,
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,

      }}
    >
      {/* Skip to main content link for keyboard users */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:bg-primary focus:text-white focus:px-4 focus:py-2 focus:rounded-lg focus:text-sm">
        Skip to main content
      </a>
      {/* Mobile sidebar overlay */}
      {isMobile && !sidebarCollapsed && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setSidebarCollapsed(true)}
          aria-hidden="true"
        />
      )}
      
      {/* Sidebar */}
      <div
        ref={sidebarRef}
        onTouchStart={isMobile ? handleSidebarTouchStart : undefined}
        onTouchEnd={isMobile ? handleSidebarTouchEnd : undefined}
        role="navigation"
        aria-label="Topics sidebar"
        className={`bg-surface flex flex-col flex-shrink-0 sidebar-transition overflow-hidden ${
          isMobile ? 'fixed inset-y-0 left-0 z-50 w-[280px]' : ''
        }`}
        style={{ 
          width: isMobile ? (sidebarCollapsed ? 0 : '280px') : (sidebarCollapsed ? 0 : `${sidebarWidth}px`),
          transform: isMobile && sidebarCollapsed ? 'translateX(-100%)' : 'translateX(0)',
          paddingTop: isPWA ? 'env(safe-area-inset-top, 0px)' : undefined,
        }}
      >

        
        {/* Header - draggable for window move */}
        <div className={`flex items-center justify-between px-2 border-b border-app-border flex-shrink-0 app-drag-region ${'h-10'}`}>
          <div className="flex items-center gap-2">
            {/* Close button on mobile */}
            {isMobile && (
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="w-8 h-8 -ml-1 mr-1 flex items-center justify-center text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 rounded-md app-no-drag"
                aria-label="Close sidebar"
              >
                <X size={20} aria-hidden="true" />
              </button>
            )}
            {/* Topics button - opens combined settings & tools menu */}
            <div className="app-no-drag" ref={topicsMenuRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!showTopicsMenu) {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setTopicsMenuPos({ top: rect.bottom + 4, left: rect.left });
                  }
                  setShowTopicsMenu(!showTopicsMenu);
                }}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors cursor-pointer ${
                  showTopicsMenu ? 'bg-app-hover' : 'hover:bg-app-hover'
                }`}
                style={{ pointerEvents: 'auto' }}
                title="Settings & Tools"
              >
                <span className={`font-semibold text-app-text tracking-[-0.01em] text-[15px]`}>Topics</span>
                <ChevronDown size={12} className={`text-app-text-muted transition-transform ${showTopicsMenu ? 'rotate-180' : ''}`} />
              </button>
            </div>
            {wsStatus !== 'connected' ? (
              <span className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 animate-pulse">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse flex-shrink-0" />
                {wsStatus === 'connecting' ? 'Connecting…' : wsStatus === 'reconnecting' ? 'Reconnecting…' : 'Offline'}
              </span>
            ) : (
              <>
                <ConnectionStatusBadge status={wsStatus} />
                {topicsLoading && (
                  <div className="w-3 h-3 border border-gray-300 dark:border-gray-600 border-t-transparent rounded-full animate-spin" aria-hidden />
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-1 relative z-50 app-no-drag" style={{ pointerEvents: 'auto' }}>
            <button
              onClick={() => handleOpenAsPage('activity')}
              className="w-7 h-7 flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer"
              style={{ pointerEvents: 'auto' }}
              title="Activity"
              aria-label="Activity"
            >
              <Activity size={14} />
            </button>
            <button
              onClick={() => handleOpenAsPage('agents')}
              className="w-7 h-7 flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer relative"
              style={{ pointerEvents: 'auto' }}
              title="Agents"
              aria-label="Agents"
            >
              <Cpu size={14} />
              {agentLiveCount > 0 && (
                <span className="absolute -top-0.5 -right-1.5 md:-top-1 md:-right-2.5 min-w-[14px] h-[14px] flex items-center justify-center bg-primary text-white text-[8px] font-bold rounded-full leading-none px-1">
                  {agentLiveCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setExpandedTool(expandedTool === 'remote' ? null : 'remote')}
              className={`w-7 h-7 flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer ${expandedTool === 'remote' ? 'bg-app-hover text-app-text' : ''}`}
              style={{ pointerEvents: 'auto' }}
              title="Remote Access"
              aria-label="Remote Access"
              ref={remoteAccessBtnRef}
            >
              <Radio size={14} />
            </button>
            <button
              ref={newMenuBtnRef}
              onClick={(e) => { e.stopPropagation(); setShowNewMenu(!showNewMenu); }}
              className="w-7 h-7 flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
              style={{ pointerEvents: 'auto' }}
              title="New (⌘N)"
              aria-label="New"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* Search + view controls */}
        <SidebarControls
          onOpenCommandPalette={() => setShowSearch(true)}
          viewMode={sidebar.viewMode}
          onToggleViewMode={sidebar.toggleViewMode}
          showArchived={sidebar.showArchived}
          onToggleArchived={sidebar.toggleShowArchived}
        />
        {topicsError && <div className="px-2 text-red-500 text-[11px]">{topicsError}</div>}

        <div ref={sidebarContentRef} className="flex-1 flex flex-col min-h-0" data-testid="sidebar-topic-list">
          <ErrorBoundary fallbackMessage="Sidebar error">
          {topicsLoading && Object.keys(topics).length === 0 ? (
            <div className="overflow-y-auto sidebar-scroll"><SkeletonTopicList count={5} /></div>
          ) : (
          <TopicTree
            topics={topics}
            workspaceProjects={workspaceProjects}
            searchQuery=""
            expandedNodes={sidebar.expandedNodes}
            onToggleNode={sidebar.toggleNode}
            focusedTopicId={focusedPanelId}
            projectActiveTopics={projectActiveTopics}
            previewPanelId={previewPanelId}
            openPanels={openPanels}
            onTopicClick={handleTopicClick}
            onTopicDoubleClick={handleTopicDoubleClick}
            onTopicContextMenu={handleTopicContextMenu}
            unreadData={unreadData}
            onArchiveTopic={archiveTopic}
            onArchiveProject={handleArchiveProject}
            onNewTopicInProject={(projectPath) => handleQuickCreateTopic(projectPath)}
            onAddProjectPane={handleAddProjectPane}
            onProjectClick={handleProjectClick}
            isSessionStreaming={isSessionStreaming}
            stopSession={stopSession}
            onOpenProjectBoard={handleOpenProjectBoard}
            boardTaskCounts={boardTaskCounts}
            onNewChat={() => handleQuickCreateTopic()}
            onNewBrowser={() => openBrowserPane(`new-${Date.now()}`)}
            terminalSessions={terminalSessions}
            browserContexts={browserCtx.contexts}
            onTerminalClick={handleTerminalClick}
            onNewTerminal={handleQuickCreateTerminal}
            onCloseTerminal={handleCloseTerminal}
            onOpenBrowser={(contextId) => openBrowserPane(contextId)}
            onCloseBrowser={browserCtx.closeContext}
            viewMode={sidebar.viewMode}
            showArchived={sidebar.showArchived}
            expandedProjects={expandedProjects}
            onToggleProject={setExpandedProjects}
            projectOpenPanes={projectOpenPanes}
          />
          )}
          </ErrorBoundary>
        </div>

        {/* Status bar */}
        <ErrorBoundary fallbackMessage="Status bar error">
        <SidebarStatusBar />
        </ErrorBoundary>
      </div>

      {/* Sidebar resize handle - hide on mobile */}
      {!isMobile && (
        <div
          className="w-[1px] flex-shrink-0 cursor-col-resize relative bg-app-border hover:bg-primary transition-colors z-20"
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={handleSidebarDoubleClick}
        >
          <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
        </div>
      )}

      {/* Collapsed sidebar expand button - only when no panels are open (panels have inline button in their header) */}
      {sidebarCollapsed && openPanels.length === 0 && (
        <div
          className="absolute left-2 z-30 flex items-center gap-1"
          style={{ top: isMobile && isPWA ? 'calc(0.5rem + env(safe-area-inset-top, 0px))' : '0.5rem' }}
        >
          <SidebarToggleButton onClick={toggleSidebar} title="Expand sidebar (⌘B)" className="bg-surface border border-app-border-light rounded-lg shadow-sm" />
        </div>
      )}

      {/* Window close button (top-right) - only in Electron and when no panels open */}
      {isElectron && openPanels.length === 0 && (
        <button
          onClick={() => {
            // Use native bridge if available (macOS app), fallback to window.close()
            const webkit = (window as any).webkit;
            if (webkit?.messageHandlers?.closeWindow) {
              webkit.messageHandlers.closeWindow.postMessage(null);
            } else {
              window.close();
            }
          }}
          className="absolute right-2 z-30 w-7 h-7 bg-transparent hover:bg-red-500/10 dark:hover:bg-red-500/20 rounded-md flex items-center justify-center text-app-text-secondary hover:text-red-500 transition-colors"
          style={{ top: '0.5rem' }}
          title="Close window (⌘W)"
        >
          <X size={16} />
        </button>
      )}

      {/* Main Content */}
      <div id="main-content" role="main" className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden bg-app-bg"
        style={{ contain: 'layout style', paddingTop: isPWA ? 'env(safe-area-inset-top, 0px)' : undefined }}
>

        {/* Connection status is now shown inline in the sidebar top line */}
        <ErrorBoundary fallbackMessage="Panel error">
        <PanelGrid
          openPanels={openPanels}
          focusedPanelId={focusedPanelId}
          topics={topics}
          onFocusPanel={handleFocusPanel}
          onClosePanel={handleClosePanel}
          onReorderPanels={handleReorderPanels}
          onOpenPanelAt={handleOpenPanelAt}
          nextPanelMode={nextPanelMode}
          onPanelModeUsed={() => setNextPanelMode('side')}
          getSessionMessages={getSessionMessages}
          isSessionLoading={isSessionLoading}
          isSessionStreaming={isSessionStreaming}
          stopSession={stopSession}
          sendMessage={sendMessage}
          editMessage={editMessage}
          switchBranch={switchBranch}
          loadHistory={loadHistory}
          chatError={chatError}
          expiredMessages={expiredMessages}
          retryExpired={retryExpired}
          clearExpired={clearExpired}
          sendWS={sendWS}
          onWSMessage={onWSMessage}
          onUpdateTopic={updateTopic}
          windowId={windowId}
          externalDragTopicId={externalDragTopicId}
          onExternalDrop={handleExternalDrop}
          onToggleSidebar={toggleSidebar}
          panelInitialTab={panelInitialTab}
          onPanelInitialTabConsumed={(topicId) => setPanelInitialTab(prev => { const n = { ...prev }; delete n[topicId]; return n; })}
          pendingProjectPane={pendingProjectPane}
          onPendingProjectPaneConsumed={() => setPendingProjectPane(null)}
          onNewChatInProject={(projectPath) => handleQuickCreateTopic(projectPath)}
          onNewChat={() => handleQuickCreateTopic()}
          pendingProjectFocus={pendingProjectFocus}
          onPendingProjectFocusConsumed={() => setPendingProjectFocus(null)}
          onProjectActiveTopicChange={handleProjectActiveTopicChange}
          onProjectOpenPanesChange={handleProjectOpenPanesChange}
          terminalSessions={terminalSessions}
          onCreateTerminal={handleQuickCreateTerminal}
          pendingBrowserPane={pendingBrowserPane}
          onPendingBrowserPaneConsumed={handlePendingBrowserPaneConsumed}
          onOpenBrowserContextIds={setOpenBrowserContextIds}
          promoteDraft={promoteDraft}
          draftMeta={draftMeta}
        />
        </ErrorBoundary>
      </div>

      {/* Portal dropdowns (rendered outside sidebar to escape overflow-hidden) */}
      {showTopicsMenu && createPortal(
        <div
          ref={topicsDropdownRef}
          className="bg-surface border border-app-border rounded-lg shadow-lg min-w-[200px]"
          style={{ position: 'fixed', top: topicsMenuPos.top, left: topicsMenuPos.left, zIndex: 9999 }}
        >
          {TOPICS_MENU_PAGES.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => { handleOpenAsPage(id); setShowTopicsMenu(false); setExpandedTool(null); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors mt-1"
            >
              <Icon size={14} />
              <span className="flex-1 text-left">{label}</span>
            </button>
          ))}
          <button
            onClick={() => { setShowSettings(true); setShowTopicsMenu(false); setExpandedTool(null); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
          >
            <SettingsIcon size={14} />
            <span className="flex-1 text-left">Settings</span>
          </button>
          <div className="h-1" />
        </div>,
        document.body
      )}

      <DropdownPortal open={showNewMenu} anchorRef={newMenuBtnRef} onClose={() => setShowNewMenu(false)}>
        <button onClick={() => { handleQuickCreateTopic(); setShowNewMenu(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
          <MessageSquare size={14} /><span className="flex-1 text-left">New Chat</span>
          {isElectron && <kbd className="kbd text-app-text-muted">⌘N</kbd>}
        </button>
        <button onClick={() => { handleQuickCreateTerminal('shell'); setShowNewMenu(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
          <TerminalSquare size={14} /><span>Shell</span>
        </button>
        <button onClick={() => { handleQuickCreateTerminal('claude-code', claudeSkipPermissions); setShowNewMenu(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
          <ClaudeIcon size={14} className="text-[#D97757]" /><span className="flex-1 text-left">Claude Code</span>
          <label className="flex items-center gap-1 text-[10px] text-app-text-muted" onClick={e => e.stopPropagation()}>
            <input type="checkbox" checked={claudeSkipPermissions} onChange={e => setClaudeSkipPermissions(e.target.checked)} className="w-3 h-3 rounded accent-[#D97757]" />
            <span>yolo</span>
          </label>
        </button>
        <button onClick={() => { openBrowserPane(`new-${Date.now()}`); setShowNewMenu(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
          <Globe size={14} /><span>Browser</span>
        </button>
      </DropdownPortal>

      {expandedTool === 'remote' && !showTopicsMenu && remoteAccessBtnRef.current && createPortal(
        <div
          ref={remoteAccessDropdownRef}
          className="bg-surface border border-app-border rounded-lg shadow-lg min-w-[300px]"
          style={{
            position: 'fixed',
            top: remoteAccessBtnRef.current.getBoundingClientRect().bottom + 4,
            right: window.innerWidth - remoteAccessBtnRef.current.getBoundingClientRect().right,
            zIndex: 9999,
          }}
        >
          <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Loading...</div>}>
            <RemoteAccessPanel enabled />
          </Suspense>
        </div>,
        document.body
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          topic={contextMenu.topic}
          onClose={() => setContextMenu(null)}
          onUpdate={updateTopic}
          onDelete={archiveTopic}
          onAssignAgents={(topicId, topicName) => setAssignAgentsTarget({ topicId, topicName })}
          onOpenBoard={handleOpenProjectBoard}
        />
      )}

      {/* New topic modal */}
      {showNewTopic && (
        <Suspense fallback={null}>
          <NewTopicModal
            isOpen={!!showNewTopic}
            onClose={() => setShowNewTopic(false)}
            onCreate={handleCreateTopic}
            projectPath={showNewTopic ? showNewTopic.projectPath : undefined}
          />
        </Suspense>
      )}

      {/* Settings modal */}
      {showSettings && (
        <Suspense fallback={null}>
          <GlobalSettings
            isOpen={showSettings}
            onClose={() => setShowSettings(false)}
            settings={appSettings}
            onSettingsChange={setAppSettings}
            themeMode={themeMode}
            onThemeChange={setTheme}
          />
        </Suspense>
      )}

      {/* Agent Assign Panel */}
      {assignAgentsTarget && (
        <Suspense fallback={null}>
          <AgentAssignPanel
            topicId={assignAgentsTarget.topicId}
            topicName={assignAgentsTarget.topicName}
            onClose={() => setAssignAgentsTarget(null)}
          />
        </Suspense>
      )}

      {/* Command Palette (⌘K / ⌘P) */}
      {showSearch && (
        <Suspense fallback={null}>
          <CommandPalette
            isOpen={showSearch}
            onClose={() => setShowSearch(false)}
            topics={topics}
            onOpenTopic={(id) => handleTopicClick(id)}
            onOpenProject={handleProjectClick}
            onNewTopic={handleQuickCreateTopic}
            onNewClaude={() => handleQuickCreateTerminal('claude-code', claudeSkipPermissions)}
            onNewTerminal={() => handleQuickCreateTerminal('shell')}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => { setShowSearch(false); setShowSettings(true); }}
            onOpenFileSearch={() => {
              setShowSearch(false);
              // Resolve projectPath the same way as Cmd+Shift+F
              if (focusedProjectPath) { setShowFileSearch({ projectPath: focusedProjectPath }); return; }
              const projectPaths = [...new Set(Object.values(topics).map(t => t.projectPath).filter(Boolean))] as string[];
              if (projectPaths.length >= 1) { setShowFileSearch({ projectPath: projectPaths[0] }); }
            }}
            themeMode={themeMode}
            projectPath={focusedProjectPath}
            onOpenFile={(path) => {
              window.dispatchEvent(new CustomEvent('open-file', { detail: { path, topicId: focusedPanelId } }));
              setShowSearch(false);
            }}
            isElectron={isElectron}
          />
        </Suspense>
      )}

      {/* Keyboard Shortcuts (⌘?) */}
      {showShortcuts && (
        <Suspense fallback={null}>
          <KeyboardShortcuts
            isOpen={showShortcuts}
            onClose={() => setShowShortcuts(false)}
            isElectron={isElectron}
          />
        </Suspense>
      )}

      {showFileSearch !== false && (
        <Suspense fallback={null}>
          <FileSearch
            projectPath={showFileSearch.projectPath}
            onOpenFile={(path, lineNumber) => {
              window.dispatchEvent(new CustomEvent('open-file', { detail: { path, lineNumber, topicId: focusedPanelId } }));
            }}
            onClose={() => setShowFileSearch(false)}
          />
        </Suspense>
      )}

    </div>
    </ToastProvider>
  );
}

export default App;
