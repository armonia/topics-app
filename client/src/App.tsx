import { useState, useRef, useCallback, useEffect, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Search, Settings as SettingsIcon, PanelLeft, X, MessageSquare, Terminal, ChevronDown, Cpu, Activity, BookOpen, Clock, Radio, Server, Globe, ExternalLink, ChevronRight } from 'lucide-react';
import type { Topic, CreateTopicRequest, AppSettings, SidebarTab } from './types';
import { useTopics } from './hooks/useTopics';
import { useChat } from './hooks/useChat';
import { useWebSocket } from './hooks/useWebSocket';
import { useTheme } from './hooks/useTheme';
import { TopicTree } from './components/Sidebar/TopicTree';
import { ContextMenu } from './components/Modals/ContextMenu';
import { PanelGrid } from './components/Layout/PanelGrid';
import { ConnectionStatusBadge, ConnectionStatusBar } from './components/Layout/ConnectionStatus';
import { loadSettings, saveSettings } from './lib/settings';
import { ToastProvider } from './components/Shared/Toast';
import { ErrorBoundary } from './components/Shared/ErrorBoundary';
import { SkeletonTopicList } from './components/Shared/Skeleton';
import { SidebarStatusBar } from './components/Sidebar/SidebarStatusBar';
import { utilityPanelId, isUtilityPanelId } from './components/Layout/UtilityPanel';
import { generateUUID } from './utils/uuid';

// Lazy-load components that are only shown on demand
const NewTopicModal = lazy(() => import('./components/Modals/NewTopicModal').then(m => ({ default: m.NewTopicModal })));
const GlobalSettings = lazy(() => import('./components/Settings/GlobalSettings').then(m => ({ default: m.GlobalSettings })));
const CommandPalette = lazy(() => import('./components/Shared/CommandPalette').then(m => ({ default: m.CommandPalette })));
const KeyboardShortcuts = lazy(() => import('./components/Shared/KeyboardShortcuts').then(m => ({ default: m.KeyboardShortcuts })));
const FileSearch = lazy(() => import('./components/Project/FileSearch').then(m => ({ default: m.FileSearch })));
const CronJobsPanel = lazy(() => import('./components/Sidebar/CronJobsPanel').then(m => ({ default: m.CronJobsPanel })));
const RemoteAccessPanel = lazy(() => import('./components/Sidebar/RemoteAccessPanel').then(m => ({ default: m.RemoteAccessPanel })));
const SystemStatusPanel = lazy(() => import('./components/Sidebar/SystemStatusPanel').then(m => ({ default: m.SystemStatusPanel })));
const BrowserSidebarControl = lazy(() => import('./components/Browser/BrowserSidebarControl').then(m => ({ default: m.BrowserSidebarControl })));

const TOPICS_MENU_PAGES = [
  { id: 'activity' as const, icon: Activity, label: 'Activity' },
  { id: 'journal' as const, icon: BookOpen, label: 'Journal' },
  { id: 'agents' as const, icon: Cpu, label: 'Agents' },
];

const TOPICS_MENU_TOOLS: { id: SidebarTab; icon: typeof Clock; label: string }[] = [
  { id: 'cron', icon: Clock, label: 'Cron Jobs' },
  { id: 'remote', icon: Radio, label: 'Remote Access' },
  { id: 'system', icon: Server, label: 'System Status' },
  { id: 'browser', icon: Globe, label: 'Browser' },
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
    const saved = localStorage.getItem(OPEN_PANELS_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
};

const loadSavedFocused = (): string | null => {
  try {
    return localStorage.getItem(FOCUSED_PANEL_KEY);
  } catch {
    return null;
  }
};

const savePanelsState = (panels: string[], focused: string | null) => {
  try {
    localStorage.setItem(OPEN_PANELS_KEY, JSON.stringify(panels));
    if (focused) {
      localStorage.setItem(FOCUSED_PANEL_KEY, focused);
    } else {
      localStorage.removeItem(FOCUSED_PANEL_KEY);
    }
  } catch {
    // Ignore storage errors
  }
};

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
  
  // Persist panels state to localStorage (main window only)
  useEffect(() => {
    if (!isDetached) {
      savePanelsState(openPanels, focusedPanelId);
    }
  }, [openPanels, focusedPanelId, isDetached]);

  // Projects opened standalone (without a chat topic)
  const [openProjects, setOpenProjects] = useState<string[]>([]);

  // Cross-window drag state
  const [externalDragTopicId, setExternalDragTopicId] = useState<string | null>(null);
  const [externalDragSourceWindow, setExternalDragSourceWindow] = useState<string | null>(null);

  // Pending pane request (e.g. add terminal to a project from sidebar)
  const [pendingProjectPane, setPendingProjectPane] = useState<{ projectPath: string; type: import('./types').PaneType } | null>(null);
  // Initial tab override for standalone panels (e.g. "New Terminal" opens with terminal tab)
  const [panelInitialTab, setPanelInitialTab] = useState<Record<string, import('./types').PanelTab>>({});

  // Modals
  const [showSearch, setShowSearch] = useState(false);
  const [showNewTopic, setShowNewTopic] = useState<false | { projectPath?: string }>(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const newMenuDropdownRef = useRef<HTMLDivElement>(null);
  const [showTopicsMenu, setShowTopicsMenu] = useState(false);
  const [expandedTool, setExpandedTool] = useState<SidebarTab | null>(null);
  const topicsMenuRef = useRef<HTMLDivElement>(null);
  const topicsDropdownRef = useRef<HTMLDivElement>(null);
  const [topicsMenuPos, setTopicsMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [newMenuPos, setNewMenuPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  // Close new menu on outside click or Escape
  useEffect(() => {
    if (!showNewMenu) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (newMenuRef.current?.contains(t) || newMenuDropdownRef.current?.contains(t)) return;
      setShowNewMenu(false);
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setShowNewMenu(false); e.stopPropagation(); } };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k, true);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k, true); };
  }, [showNewMenu]);

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

  // App settings
  const [appSettings, setAppSettings] = useState<AppSettings>(loadSettings);

  // Sidebar resize state - collapsed by default in detached windows and mobile
  const [sidebarWidth, setSidebarWidth] = useState(() => appSettings.sidebarWidth || 256);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return isDetached || isMobile ? true : (appSettings.sidebarCollapsed || false);
  });
  
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
    loading: topicsLoading,
    error: topicsError,
    createTopic,
    updateTopic,
    archiveTopic,
    applyTopicFromWS,
  } = useTopics();

  // Validate saved panels exist (remove deleted topics)
  useEffect(() => {
    if (!topicsLoading && Object.keys(topics).length > 0 && !isDetached) {
      const validPanels = openPanels.filter(id => isUtilityPanelId(id) || (topics[id] && !topics[id].archived));
      if (validPanels.length !== openPanels.length) {
        setOpenPanels(validPanels);
        if (focusedPanelId && !validPanels.includes(focusedPanelId)) {
          setFocusedPanelId(validPanels.length > 0 ? validPanels[0] : null);
        }
      }
    }
  }, [topics, topicsLoading, isDetached]); // Don't include openPanels/focusedPanelId to avoid loops

  const {
    sendMessage,
    stopSession,
    getSessionMessages,
    addMessageFromWS,
    isSessionLoading,
    isSessionStreaming,
    loadHistory,
    appendMediaToLastAssistant,
    clearSession,
    drainQueue,
    onWSMessage: chatStreamHandler,
    error: chatError,
  } = useChat();

  const { status: wsStatus, unreadData, sendWS, onMessage: onWSMessage, reconnect: wsReconnect, lastConnectedAt: wsLastConnectedAt } = useWebSocket();

  // Wire up chat stream handler to WebSocket (enables cross-window streaming)
  useEffect(() => {
    return onWSMessage(chatStreamHandler);
  }, [onWSMessage, chatStreamHandler]);

  // Drain outbound message queue when WS reconnects
  const prevWsStatus = useRef(wsStatus);
  useEffect(() => {
    if (prevWsStatus.current !== 'connected' && wsStatus === 'connected') {
      drainQueue();
    }
    prevWsStatus.current = wsStatus;
  }, [wsStatus, drainQueue]);
  const { themeMode, toggleTheme, setTheme } = useTheme();

  // Badge data from SidebarStatusBar (agent count)
  const [sidebarBadges, setSidebarBadges] = useState<Partial<Record<SidebarTab, number | boolean>>>({});
  const handleSidebarBadgeData = useCallback((badges: Partial<Record<SidebarTab, number | boolean>>) => {
    setSidebarBadges(prev => {
      const keys = Object.keys(badges) as SidebarTab[];
      const changed = keys.some(k => prev[k] !== badges[k]);
      return changed ? { ...prev, ...badges } : prev;
    });
  }, []);

  // Open a utility page (Activity/Journal/Agents) as a pane in the main panel
  const handleOpenAsPage = useCallback((type: 'activity' | 'journal' | 'agents' | 'dashboard') => {
    const id = utilityPanelId(type);
    if (!openPanels.includes(id)) {
      setOpenPanels(prev => [...prev, id]);
    }
    setFocusedPanelId(id);
  }, [openPanels]);

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

      // Real-time message sync across windows
      if (msg.type === 'message:new' && msg.sessionKey && msg.content) {
        const sessionKey = msg.sessionKey as string;
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
      if (msg.type === 'message:new' && msg.topicId !== focusedPanelId) {
        if ('Notification' in window && Notification.permission === 'granted') {
          const topic = topics[msg.topicId];
          if (topic) {
            new Notification(`${topic.icon} ${topic.name}`, {
              body: msg.preview || 'New message',
              tag: `topic-${msg.topicId}`,
            });
          }
        }
      }
      // Handle media files detected after a chat response
      if (msg.type === 'message:media' && msg.sessionKey && msg.media) {
        appendMediaToLastAssistant(msg.sessionKey, msg.media as string[]);
      }
      // Handle clear command
      if (msg.type === 'clear' && msg.sessionKey) {
        clearSession(msg.sessionKey as string);
      }
    });

    return unsub;
  }, [onWSMessage, focusedPanelId, topics, appendMediaToLastAssistant, clearSession, addMessageFromWS, getSessionMessages, applyTopicFromWS]);

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

  const handleTopicClick = useCallback((topicId: string, e?: React.MouseEvent) => {
    // If this topic belongs to a project, remove standalone project entry
    // (the project window will show via the topic's projectPath grouping)
    const topic = topics[topicId];
    if (topic?.projectPath) {
      setOpenProjects(prev => prev.filter(p => p !== topic.projectPath));
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
  }, [openPanel, isMobile, topics]);

  const handleTopicDoubleClick = useCallback((topicId: string, _e?: React.MouseEvent) => {
    openPanel(topicId, 'permanent');
  }, [openPanel]);

  const handleClosePanel = useCallback((topicId: string) => {
    setOpenPanels(prev => {
      const next = prev.filter(id => id !== topicId);
      if (focusedPanelId === topicId) {
        setFocusedPanelId(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
  }, [focusedPanelId]);

  const handleProjectClick = useCallback((projectPath: string) => {
    // If a topic from this project is already open, no need for standalone entry
    const hasOpenTopic = openPanels.some(id => topics[id]?.projectPath === projectPath);
    if (hasOpenTopic) return;
    // Replace any previous preview project with this one
    setOpenProjects([projectPath]);
  }, [openPanels, topics]);

  const handleCloseProject = useCallback((projectPath: string) => {
    // Remove ALL topics belonging to this project from openPanels
    const projectTopicIds = openPanels.filter(id => topics[id]?.projectPath === projectPath);
    if (projectTopicIds.length > 0) {
      setOpenPanels(prev => {
        const next = prev.filter(id => !projectTopicIds.includes(id));
        if (focusedPanelId && projectTopicIds.includes(focusedPanelId)) {
          setFocusedPanelId(next.length > 0 ? next[next.length - 1] : null);
        }
        return next;
      });
    }
    // Also remove from standalone open projects
    setOpenProjects(prev => prev.filter(p => p !== projectPath));
  }, [openPanels, topics, focusedPanelId]);

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
      openPanel(topic.id, 'permanent', false);
    }
    return topic;
  };

  // Quick-create empty chat (bypasses modal)
  // projectPath must be explicitly provided to bind to a project
  const handleQuickCreateTopic = async (projectPath?: string) => {
    const topic = await createTopic({
      name: 'New Chat',
      icon: '💬',
      color: '#0066ff',
      projectPath: projectPath || undefined,
    });
    if (topic) {
      openPanel(topic.id, 'permanent', true);
    }
    return topic;
  };

  // Quick-create standalone terminal (creates a topic with terminal tab active)
  const handleQuickCreateTerminal = async () => {
    const topic = await createTopic({
      name: 'Terminal',
      icon: '⬛',
      color: '#8b5cf6',
    });
    if (topic) {
      setPanelInitialTab(prev => ({ ...prev, [topic.id]: 'terminal' }));
      openPanel(topic.id, 'permanent', true);
    }
    return topic;
  };

  // Add a non-chat pane (terminal, browser) to a project window
  const handleAddProjectPane = useCallback((projectPath: string, type: import('./types').PaneType) => {
    // If no topic of this project is open, open the first available topic first
    const hasOpenTopic = openPanels.some(id => topics[id]?.projectPath === projectPath);
    if (!hasOpenTopic) {
      const projectTopic = Object.values(topics).find(t => t.projectPath === projectPath && !t.archived);
      if (projectTopic) {
        setOpenPanels(prev => [...prev, projectTopic.id]);
        setFocusedPanelId(projectTopic.id);
      }
    }
    setPendingProjectPane({ projectPath, type });
  }, [openPanels, topics]);

  const handleTopicContextMenu = useCallback((e: React.MouseEvent, topic: Topic) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, topic });
  }, []);

  // Sidebar state
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; topic: Topic } | null>(null);

  const handleToggleNode = useCallback((topicId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(topicId)) next.delete(topicId);
      else next.add(topicId);
      return next;
    });
  }, []);

  const getChildren = useCallback((parentId: string | null): Topic[] => {
    // Don't filter archived here - let the caller decide (renderLevel handles it)
    return Object.values(topics).filter(t => t.parentId === parentId);
  }, [topics]);

  const getArchivedTopics = useCallback((): Topic[] => {
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

      if (isMod && e.key === 'n') {
        e.preventDefault();
        if (e.shiftKey) {
          setShowNewTopic({}); // ⌘⇧N = templates modal
        } else {
          handleQuickCreateTopic(); // ⌘N = quick create
        }
        return;
      }

      if (isMod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setShowFileSearch(prev => !prev);
        return;
      }

      if (isMod && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      if (isMod && e.key === 'w') {
        e.preventDefault();
        if (focusedPanelId) {
          handleClosePanel(focusedPanelId);
        }
        return;
      }

      if (isMod && e.key >= '1' && e.key <= '9') {
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
        if (showFileSearch) { setShowFileSearch(false); e.preventDefault(); return; }
        if (showShortcuts) { setShowShortcuts(false); e.preventDefault(); return; }
        if (showSearch) { setShowSearch(false); e.preventDefault(); return; }
        if (showNewTopic) { setShowNewTopic(false); e.preventDefault(); return; }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focusedPanelId, openPanels, handleClosePanel, showSearch, showNewTopic, showFileSearch, toggleSidebar]);

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
      className="h-screen flex bg-app-bg"
      style={{ fontSize: `${appSettings.fontSize}px` }}
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
        }}
      >
        {/* Safe area spacer for PWA notch */}
        {isPWA && <div style={{ height: 'env(safe-area-inset-top, 0px)', flexShrink: 0 }} />}
        
        {/* Header - draggable for window move */}
        <div className={`flex items-center justify-between px-2 border-b border-app-border flex-shrink-0 app-drag-region ${isMobile ? 'h-14' : 'h-10'}`}>
          <div className="flex items-center gap-2">
            {/* Close button on mobile */}
            {isMobile && (
              <button
                onClick={() => setSidebarCollapsed(true)}
                className="w-11 h-11 -ml-1 mr-1 flex items-center justify-center text-app-text-secondary hover:bg-black/5 dark:hover:bg-white/5 rounded-md app-no-drag"
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
                <span className={`font-semibold text-app-text tracking-[-0.01em] ${isMobile ? 'text-[17px]' : 'text-[15px]'}`}>Topics</span>
                <ChevronDown size={12} className={`text-app-text-muted transition-transform ${showTopicsMenu ? 'rotate-180' : ''}`} />
              </button>
            </div>
            <ConnectionStatusBadge status={wsStatus} />
            {topicsLoading && (
              <div className="w-3 h-3 border border-gray-300 dark:border-gray-600 border-t-transparent rounded-full animate-spin" aria-hidden />
            )}
          </div>
          <div className="flex items-center gap-1 relative z-50 app-no-drag" style={{ pointerEvents: 'auto' }}>
            <div ref={newMenuRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!showNewMenu) {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setNewMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                  }
                  setShowNewMenu(!showNewMenu);
                }}
                className="w-11 h-11 md:w-7 md:h-7 flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer"
                style={{ pointerEvents: 'auto' }}
                title="New chat or terminal (⌘N)"
                aria-label="New"
              >
                <Plus size={15} strokeWidth={1.5} />
              </button>
            </div>
          </div>
        </div>

        {/* Search + Topic list */}
        <div className="px-2 py-2 flex-shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-app-text-tertiary" aria-hidden="true" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search topics..."
              aria-label="Search topics"
              className="w-full pl-8 pr-3 py-1.5 text-[13px] bg-transparent border border-app-border rounded-md focus:outline-none focus:border-primary text-app-text placeholder-app-placeholder transition-colors"
            />
          </div>
          {topicsError && <div className="text-red-500 text-[11px] mt-1">{topicsError}</div>}
        </div>

        <div className="flex-1 overflow-y-auto sidebar-scroll">
          <ErrorBoundary fallbackMessage="Sidebar error">
          {topicsLoading && Object.keys(topics).length === 0 ? (
            <SkeletonTopicList count={5} />
          ) : (
          <TopicTree
            topics={topics}
            searchQuery={searchQuery}
            expandedNodes={expandedNodes}
            onToggleNode={handleToggleNode}
            focusedTopicId={focusedPanelId}
            previewPanelId={previewPanelId}
            openPanels={openPanels}
            onTopicClick={handleTopicClick}
            onTopicDoubleClick={handleTopicDoubleClick}
            onTopicContextMenu={handleTopicContextMenu}
            getChildren={getChildren}
            getArchivedTopics={getArchivedTopics}
            unreadData={unreadData}
            onArchiveTopic={archiveTopic}
            onNewTopicInProject={(projectPath) => handleQuickCreateTopic(projectPath)}
            onAddProjectPane={handleAddProjectPane}
            onProjectClick={handleProjectClick}
            isSessionStreaming={isSessionStreaming}
            stopSession={stopSession}
          />
          )}
          </ErrorBoundary>
        </div>
        
        {/* Status bar */}
        <ErrorBoundary fallbackMessage="Status bar error">
        <SidebarStatusBar onOpenTab={(tab) => {
          if (tab === 'agents' || tab === 'activity' || tab === 'journal' || tab === 'dashboard') {
            handleOpenAsPage(tab);
          }
        }} onBadgeData={handleSidebarBadgeData} />
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

      {/* Collapsed sidebar expand button - only when no panels (mobile has button in chat header) */}
      {sidebarCollapsed && (!isMobile || openPanels.length === 0) && (
        <button
          onClick={toggleSidebar}
          className={`absolute left-2 z-30 bg-surface border border-app-border-light rounded-lg flex items-center justify-center text-app-text-secondary hover:bg-app-hover shadow-sm transition-colors ${
            isMobile ? 'w-10 h-10' : 'w-8 h-8'
          }`}
          style={{ top: isMobile && isPWA ? 'calc(0.5rem + env(safe-area-inset-top, 0px))' : '0.5rem' }}
          title="Expand sidebar (⌘B)"
          aria-label="Expand sidebar"
        >
          <PanelLeft size={isMobile ? 20 : 16} />
        </button>
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
          <X size={16} strokeWidth={2} />
        </button>
      )}

      {/* Main Content */}
      <div id="main-content" role="main" className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Safe area spacer for PWA notch when sidebar is closed */}
        {isPWA && sidebarCollapsed && <div style={{ height: 'env(safe-area-inset-top, 0px)', flexShrink: 0, background: 'inherit' }} />}
        <ConnectionStatusBar status={wsStatus} onRetry={wsReconnect} lastConnectedAt={wsLastConnectedAt} />
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
          loadHistory={loadHistory}
          chatError={chatError}
          sendWS={sendWS}
          onWSMessage={onWSMessage}
          onUpdateTopic={updateTopic}
          openProjects={openProjects}
          onCloseProject={handleCloseProject}
          windowId={windowId}
          externalDragTopicId={externalDragTopicId}
          onExternalDrop={handleExternalDrop}
          onToggleSidebar={isMobile ? toggleSidebar : undefined}
          wsStatus={wsStatus}
          panelInitialTab={panelInitialTab}
          onPanelInitialTabConsumed={(topicId) => setPanelInitialTab(prev => { const n = { ...prev }; delete n[topicId]; return n; })}
          pendingProjectPane={pendingProjectPane}
          onPendingProjectPaneConsumed={() => setPendingProjectPane(null)}
          onNewChatInProject={(projectPath) => handleQuickCreateTopic(projectPath)}
          onNewChat={() => handleQuickCreateTopic()}
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
          {/* Settings */}
          <button
            onClick={() => { setShowSettings(true); setShowTopicsMenu(false); setExpandedTool(null); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors mt-1"
          >
            <SettingsIcon size={14} strokeWidth={1.5} />
            <span className="flex-1 text-left">Settings</span>
          </button>

          <div className="border-t border-app-border my-1" />

          {/* Pages section */}
          <div className="px-2 pt-1 pb-1">
            <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wider">Pages</span>
          </div>
          {TOPICS_MENU_PAGES.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => { handleOpenAsPage(id); setShowTopicsMenu(false); setExpandedTool(null); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
            >
              <Icon size={14} strokeWidth={1.5} />
              <span className="flex-1 text-left">{label}</span>
              {id === 'agents' && sidebarBadges.agents !== undefined && sidebarBadges.agents !== false && sidebarBadges.agents !== 0 && typeof sidebarBadges.agents === 'number' && (
                <span className="text-[9px] text-white bg-primary px-1 rounded-full min-w-[14px] text-center leading-[14px]">
                  {sidebarBadges.agents > 99 ? '99+' : sidebarBadges.agents}
                </span>
              )}
              <ExternalLink size={10} className="text-app-text-muted flex-shrink-0" />
            </button>
          ))}

          <div className="border-t border-app-border my-1" />

          {/* Tools section */}
          <div className="px-2 pt-1 pb-1">
            <span className="text-[10px] font-medium text-app-text-muted uppercase tracking-wider">Tools</span>
          </div>
          {TOPICS_MENU_TOOLS.map(({ id, icon: Icon, label }) => {
            const isToolExpanded = expandedTool === id;
            return (
              <div
                key={id}
                className="relative"
                onMouseEnter={() => setExpandedTool(id)}
                onMouseLeave={() => setExpandedTool(null)}
              >
                <button
                  onClick={() => setExpandedTool(isToolExpanded ? null : id)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors ${isToolExpanded ? 'bg-app-hover' : ''}`}
                >
                  <Icon size={14} strokeWidth={1.5} />
                  <span className="flex-1 text-left">{label}</span>
                  <ChevronRight size={12} className="text-app-text-muted" />
                </button>
                {isToolExpanded && (
                  <div className="absolute left-full top-0 ml-1 bg-surface border border-app-border rounded-lg shadow-lg min-w-[260px] max-h-[350px] overflow-y-auto" style={{ zIndex: 10000 }}>
                    <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Loading...</div>}>
                      {id === 'cron' && <CronJobsPanel enabled />}
                      {id === 'remote' && <RemoteAccessPanel enabled />}
                      {id === 'system' && <SystemStatusPanel enabled />}
                      {id === 'browser' && <BrowserSidebarControl enabled />}
                    </Suspense>
                  </div>
                )}
              </div>
            );
          })}
          <div className="h-1" />
        </div>,
        document.body
      )}

      {showNewMenu && createPortal(
        <div
          ref={newMenuDropdownRef}
          className="bg-surface border border-app-border rounded-lg shadow-lg py-1 min-w-[150px]"
          style={{ position: 'fixed', top: newMenuPos.top, right: newMenuPos.right, zIndex: 9999 }}
        >
          <button onClick={() => { handleQuickCreateTopic(); setShowNewMenu(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
            <MessageSquare size={14} /><span>New Chat</span>
          </button>
          <button onClick={() => { handleQuickCreateTerminal(); setShowNewMenu(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
            <Terminal size={14} /><span>New Terminal</span>
          </button>
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

      {/* Command Palette (⌘K) */}
      {showSearch && (
        <Suspense fallback={null}>
          <CommandPalette
            isOpen={showSearch}
            onClose={() => setShowSearch(false)}
            topics={topics}
            onOpenTopic={(id) => handleTopicClick(id)}
            onNewTopic={handleQuickCreateTopic}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => { setShowSearch(false); setShowSettings(true); }}
            themeMode={themeMode}
          />
        </Suspense>
      )}

      {/* Keyboard Shortcuts (⌘?) */}
      {showShortcuts && (
        <Suspense fallback={null}>
          <KeyboardShortcuts
            isOpen={showShortcuts}
            onClose={() => setShowShortcuts(false)}
          />
        </Suspense>
      )}

      {showFileSearch && focusedPanelId && topics[focusedPanelId]?.projectPath && (
        <Suspense fallback={null}>
          <FileSearch
            projectPath={topics[focusedPanelId].projectPath!}
            onOpenFile={(path) => {
              // Dispatch to the focused panel's file opener
              window.dispatchEvent(new CustomEvent('open-file', { detail: { path, topicId: focusedPanelId } }));
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
