import { useState, useRef, useCallback, useEffect, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Search, Settings as SettingsIcon, PanelLeft, X, MessageSquare, Terminal, ChevronDown, ChevronRight, Cpu, Activity, BarChart3, Radio, Globe, ExternalLink } from 'lucide-react';
import type { Topic, CreateTopicRequest, AppSettings, SidebarTab } from './types';
import { DEFAULT_TOPIC_ICON } from './lib/topicIcons';
import { useTopics } from './hooks/useTopics';
import { useChat } from './hooks/useChat';
import { useWebSocket } from './hooks/useWebSocket';
import { useTheme } from './hooks/useTheme';
import { useAgents } from './hooks/useAgents';

import { TopicTree } from './components/Sidebar/TopicTree';
import { ContextMenu } from './components/Modals/ContextMenu';
import { PanelGrid } from './components/Layout/PanelGrid';
import { ConnectionStatusBadge } from './components/Layout/ConnectionStatus';
import { loadSettings, saveSettings } from './lib/settings';
import { ToastProvider } from './components/Shared/Toast';
import { ErrorBoundary } from './components/Shared/ErrorBoundary';
import { SkeletonTopicList } from './components/Shared/Skeleton';
import { SidebarStatusBar } from './components/Sidebar/SidebarStatusBar';
import { utilityPanelId, isUtilityPanelId } from './components/Layout/UtilityPanel';
import { createPaneId, isProjectPaneId, isBrowserPaneId } from './lib/paneConfig';
import { generateUUID } from './utils/uuid';
import { globalBoardApi } from './lib/api';

// Lazy-load components that are only shown on demand
const NewTopicModal = lazy(() => import('./components/Modals/NewTopicModal').then(m => ({ default: m.NewTopicModal })));
const GlobalSettings = lazy(() => import('./components/Settings/GlobalSettings').then(m => ({ default: m.GlobalSettings })));
const CommandPalette = lazy(() => import('./components/Shared/CommandPalette').then(m => ({ default: m.CommandPalette })));
const KeyboardShortcuts = lazy(() => import('./components/Shared/KeyboardShortcuts').then(m => ({ default: m.KeyboardShortcuts })));
const FileSearch = lazy(() => import('./components/Project/FileSearch').then(m => ({ default: m.FileSearch })));
const RemoteAccessPanel = lazy(() => import('./components/Sidebar/RemoteAccessPanel').then(m => ({ default: m.RemoteAccessPanel })));
const BrowserSidebarControl = lazy(() => import('./components/Browser/BrowserSidebarControl').then(m => ({ default: m.BrowserSidebarControl })));
const AgentAssignPanel = lazy(() => import('./components/Agents/AgentAssignPanel').then(m => ({ default: m.AgentAssignPanel })));

const TOPICS_MENU_PAGES = [
  { id: 'dashboard' as const, icon: BarChart3, label: 'Statistics' },
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

  // Pending focus for a topic inside a project tab
  const [pendingProjectFocus, setPendingProjectFocus] = useState<{ projectPath: string; topicId: string } | null>(null);

  // Cross-window drag state
  const [externalDragTopicId, setExternalDragTopicId] = useState<string | null>(null);
  const [externalDragSourceWindow, setExternalDragSourceWindow] = useState<string | null>(null);

  // Pending pane request (e.g. add terminal to a project from sidebar)
  const [pendingProjectPane, setPendingProjectPane] = useState<{ projectPath: string; type: import('./types').PaneType } | null>(null);
  // Pending terminal pane request (from quick-create)
  const [pendingTerminalPane, setPendingTerminalPane] = useState<{ sessionId: string; name: string } | null>(null);
  // Initial tab override for standalone panels (e.g. "New Terminal" opens with terminal tab)
  const [panelInitialTab, setPanelInitialTab] = useState<Record<string, import('./types').PanelTab>>({});

  // Modals
  const [showSearch, setShowSearch] = useState(false);
  const [showNewTopic, setShowNewTopic] = useState<false | { projectPath?: string }>(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [assignAgentsTarget, setAssignAgentsTarget] = useState<{ topicId: string; topicName: string } | null>(null);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const newMenuRef = useRef<HTMLDivElement>(null);
  const newMenuDropdownRef = useRef<HTMLDivElement>(null);
  const remoteAccessBtnRef = useRef<HTMLButtonElement>(null);
  const remoteAccessDropdownRef = useRef<HTMLDivElement>(null);
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
    workspaceProjects,
    loading: topicsLoading,
    error: topicsError,
    createTopic,
    updateTopic,
    archiveTopic,
    archiveProject,
    applyTopicFromWS,
  } = useTopics();

  // Validate saved panels exist (remove deleted/archived topics, move project-linked topics)
  useEffect(() => {
    if (!topicsLoading && Object.keys(topics).length > 0 && !isDetached) {
      const projectPanesToAdd: string[] = [];
      const validPanels = openPanels.filter(id => {
        if (isUtilityPanelId(id) || isProjectPaneId(id) || isBrowserPaneId(id)) return true;
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
      }
    }
  }, [topics, topicsLoading, isDetached]); // Don't include openPanels/focusedPanelId to avoid loops

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
    onWSMessage: chatStreamHandler,
    error: chatError,
  } = useChat();

  const { status: wsStatus, unreadData, sendWS, onMessage: onWSMessage } = useWebSocket();

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

  // Browser sidebar section state
  const [browserContextCount, setBrowserContextCount] = useState(0);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [pendingBrowserPane, setPendingBrowserPane] = useState(false);
  const handlePendingBrowserPaneConsumed = useCallback(() => setPendingBrowserPane(false), []);
  useEffect(() => {
    fetch('/api/browser/status').then(r => r.ok ? r.json() : null).then(data => {
      if (data?.details?.length) {
        setBrowserContextCount(data.details.length);
        setBrowserExpanded(true);
      }
    }).catch(() => {});
  }, []);

  // Open a utility page (Activity/Journal/Agents/Dashboard/All Boards) as a pane in the main panel
  const handleOpenAsPage = useCallback((type: 'activity' | 'agents' | 'dashboard' | 'all-boards') => {
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
            new Notification(topic.name, {
              body: msg.preview || 'New message',
              tag: `topic-${msg.topicId}`,
            });
          }
        }
      }
      // Handle topic auto-switch: open target panel (messages move happens on :complete)
      if (msg.type === 'topic:switch' && msg.toTopicId) {
        const toId = msg.toTopicId as string;
        // Open target panel immediately (source stays until :complete removes messages)
        if (!openPanels.includes(toId)) {
          setOpenPanels(prev => [...prev, toId]);
        }
        setFocusedPanelId(toId);
      }
      // Handle topic switch complete: move messages between sessions and close source
      if (msg.type === 'topic:switch:complete' && msg.fromSessionKey && msg.toSessionKey) {
        const fromId = msg.fromTopicId as string;
        const fromSK = msg.fromSessionKey as string;
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
      if (focusedPanelId === topicId) {
        setFocusedPanelId(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
  }, [focusedPanelId]);

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
      if (focusedPanelId === paneId) {
        setFocusedPanelId(next.length > 0 ? next[next.length - 1] : null);
      }
      return next;
    });
  }, [focusedPanelId]);

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
    const topic = await createTopic({
      name: 'New Chat',
      icon: DEFAULT_TOPIC_ICON,
      color: '#0066ff',
      projectPath: projectPath || undefined,
    });
    if (topic) {
      if (projectPath) {
        // Topic belongs to a project — keep focus on the project pane
        // and navigate to the new topic inside the project window
        const projectPaneId = createPaneId('project', projectPath);
        if (!openPanels.includes(projectPaneId)) {
          setOpenPanels(prev => [...prev, projectPaneId]);
        }
        setFocusedPanelId(projectPaneId);
        setPendingProjectFocus({ projectPath, topicId: topic.id });
      } else {
        openPanel(topic.id, 'permanent', true);
      }
    }
    return topic;
  };

  // Quick-create standalone terminal (creates a terminal session and adds as pane)
  const handleQuickCreateTerminal = async () => {
    try {
      const res = await fetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'shell', name: 'Shell' }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setPendingTerminalPane({ sessionId: data.id, name: data.name || 'Shell' });
    } catch {}
  };

  // Add a non-chat pane (terminal, browser) to a project window
  const handleAddProjectPane = useCallback((projectPath: string, type: import('./types').PaneType) => {
    // Ensure the project pane is open
    const projectPaneId = createPaneId('project', projectPath);
    if (isMobile) {
      setOpenPanels([projectPaneId]);
      setSidebarCollapsed(true);
    } else if (!openPanels.includes(projectPaneId)) {
      setOpenPanels(prev => [...prev, projectPaneId]);
    }
    setFocusedPanelId(projectPaneId);
    setPendingProjectPane({ projectPath, type });
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
        setShowFileSearch(prev => !prev);
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
        if (showFileSearch) { setShowFileSearch(false); e.preventDefault(); return; }
        if (showShortcuts) { setShowShortcuts(false); e.preventDefault(); return; }
        if (showSearch) { setShowSearch(false); e.preventDefault(); return; }
        if (showNewTopic) { setShowNewTopic(false); e.preventDefault(); return; }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [focusedPanelId, openPanels, handleClosePanel, showSearch, showNewTopic, showFileSearch, toggleSidebar, isElectron]);

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
        }}
      >
        {/* Safe area spacer for PWA notch */}
        {isPWA && <div style={{ height: 'env(safe-area-inset-top, 0px)', flexShrink: 0 }} />}
        
        {/* Header - draggable for window move */}
        <div className={`flex items-center justify-between px-2 border-b border-app-border flex-shrink-0 app-drag-region ${isMobile ? 'h-11' : 'h-10'}`}>
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
              className="w-8 h-8 md:w-7 md:h-7 flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer"
              style={{ pointerEvents: 'auto' }}
              title="Activity"
              aria-label="Activity"
            >
              <Activity size={14} strokeWidth={1.5} />
            </button>
            <button
              onClick={() => handleOpenAsPage('agents')}
              className="w-8 h-8 md:w-7 md:h-7 flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer relative"
              style={{ pointerEvents: 'auto' }}
              title="Agents"
              aria-label="Agents"
            >
              <Cpu size={14} strokeWidth={1.5} />
              {agentLiveCount > 0 && (
                <span className="absolute -top-0.5 -right-1.5 md:-top-1 md:-right-2.5 min-w-[14px] h-[14px] flex items-center justify-center bg-primary text-white text-[8px] font-bold rounded-full leading-none px-1">
                  {agentLiveCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setExpandedTool(expandedTool === 'remote' ? null : 'remote')}
              className={`w-8 h-8 md:w-7 md:h-7 flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer ${expandedTool === 'remote' ? 'bg-app-hover text-app-text' : ''}`}
              style={{ pointerEvents: 'auto' }}
              title="Remote Access"
              aria-label="Remote Access"
              ref={remoteAccessBtnRef}
            >
              <Radio size={14} strokeWidth={1.5} />
            </button>
            <div ref={newMenuRef} className="flex items-center gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!showNewMenu) {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setNewMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
                  }
                  setShowNewMenu(!showNewMenu);
                }}
                className="w-8 h-8 md:w-7 md:h-7 flex items-center justify-center text-app-text-tertiary hover:text-app-text hover:bg-app-hover rounded-md transition-colors cursor-pointer"
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
            workspaceProjects={workspaceProjects}
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
            onArchiveProject={handleArchiveProject}
            onNewTopicInProject={(projectPath) => handleQuickCreateTopic(projectPath)}
            onAddProjectPane={handleAddProjectPane}
            onProjectClick={handleProjectClick}
            isSessionStreaming={isSessionStreaming}
            stopSession={stopSession}
            onOpenProjectBoard={handleOpenProjectBoard}
            boardTaskCounts={boardTaskCounts}
          />
          )}
          </ErrorBoundary>
        </div>

        {/* Browser section — anchored at bottom, above status bar */}
        <div className="border-t border-app-border flex-shrink-0">
          <div className="group flex items-center h-8 hover:bg-app-hover transition-colors">
            <button
              onClick={() => setBrowserExpanded(!browserExpanded)}
              aria-expanded={browserExpanded}
              aria-label="Browser section"
              className="flex items-center gap-2 flex-1 h-full text-left"
              style={{ paddingLeft: 12 }}
            >
              <Globe size={14} strokeWidth={1.5} className="text-app-text-secondary flex-shrink-0" />
              <span className="text-[13px] text-app-text">Browser</span>
              <ChevronRight
                size={12}
                strokeWidth={1.5}
                aria-hidden="true"
                className={`transition-transform duration-150 text-app-text-tertiary ${browserExpanded ? 'rotate-90' : ''}`}
              />
            </button>
            <div className="flex items-center gap-1 pr-3">
              {browserContextCount > 0 && (
                <span className="text-[10px] text-white bg-primary px-1.5 rounded-full min-w-[18px] text-center leading-[14px]">
                  {browserContextCount}
                </span>
              )}
            </div>
          </div>
          {browserExpanded && (
            <Suspense fallback={<div className="px-3 py-2 text-[10px] text-app-text-muted">Loading...</div>}>
              <BrowserSidebarControl enabled onContextCount={setBrowserContextCount} onOpenBrowser={() => {
                setPendingBrowserPane(true);
              }} />
            </Suspense>
          )}
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
          <button
            onClick={toggleSidebar}
            className={`bg-surface border border-app-border-light rounded-lg flex items-center justify-center text-app-text-secondary hover:bg-app-hover shadow-sm transition-colors ${
              isMobile ? 'w-10 h-10' : 'w-8 h-8'
            }`}
            title="Expand sidebar (⌘B)"
            aria-label="Expand sidebar"
          >
            <PanelLeft size={isMobile ? 20 : 16} />
          </button>
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
          <X size={16} strokeWidth={2} />
        </button>
      )}

      {/* Main Content */}
      <div id="main-content" role="main" className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
        {/* Safe area spacer for PWA notch when sidebar is closed */}
        {isPWA && sidebarCollapsed && <div style={{ height: 'env(safe-area-inset-top, 0px)', flexShrink: 0, background: 'inherit' }} />}
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
          pendingTerminalPane={pendingTerminalPane}
          onPendingTerminalPaneConsumed={() => setPendingTerminalPane(null)}
          pendingBrowserPane={pendingBrowserPane}
          onPendingBrowserPaneConsumed={handlePendingBrowserPaneConsumed}
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
              <Icon size={14} strokeWidth={1.5} />
              <span className="flex-1 text-left">{label}</span>
            </button>
          ))}
          <button
            onClick={() => { setShowSettings(true); setShowTopicsMenu(false); setExpandedTool(null); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors"
          >
            <SettingsIcon size={14} strokeWidth={1.5} />
            <span className="flex-1 text-left">Settings</span>
          </button>
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
            <MessageSquare size={14} /><span className="flex-1 text-left">New Chat</span>
            {isElectron && <kbd className="kbd text-app-text-muted">⌘N</kbd>}
          </button>
          <button onClick={() => { handleQuickCreateTerminal(); setShowNewMenu(false); }} className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text hover:bg-app-hover transition-colors">
            <Terminal size={14} /><span>New Terminal</span>
          </button>
        </div>,
        document.body
      )}

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
            onNewTopic={handleQuickCreateTopic}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => { setShowSearch(false); setShowSettings(true); }}
            themeMode={themeMode}
            projectPath={focusedPanelId ? topics[focusedPanelId]?.projectPath || undefined : undefined}
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
