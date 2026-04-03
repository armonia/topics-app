const { app, BrowserWindow, BrowserView, ipcMain, Menu, Tray, nativeImage, shell, session, Notification } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');

// For self-signed TLS certs on localhost
const httpAgent = new https.Agent({ rejectUnauthorized: false });
function serverGet(urlPath, callback) {
  const url = new URL(urlPath, SERVER_URL || 'https://localhost:3333');
  const mod = url.protocol === 'https:' ? https : http;
  return mod.get(url.href, { agent: url.protocol === 'https:' ? httpAgent : undefined }, callback);
}
function serverRequest(urlPath, options = {}) {
  const url = new URL(urlPath, SERVER_URL || 'https://localhost:3333');
  const mod = url.protocol === 'https:' ? https : http;
  return mod.request(url.href, { ...options, agent: url.protocol === 'https:' ? httpAgent : undefined });
}

let mainWindow = null;
let tray = null;
let updateLayout = null;

// Multi-window support: detached topic windows
const detachedWindows = new Map(); // topicId -> BrowserWindow

// Browser tabs management
const browserTabs = new Map(); // id -> { view, url, title, visible }
let activeTabId = null;
let browserPanelVisible = false;
let browserPanelWidth = 0.4; // 40% width when visible

// Server URL - use DEV_URL env var for hot reload development
const SERVER_URL = process.env.DEV_URL || 'https://localhost:3333';
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

// CDP port for browser control (Electron DevTools)
// Use a port far from Chrome Topics (19222) to avoid conflicts
const CDP_PORT = 19333;
// Separate port for CDP info HTTP server
const CDP_INFO_PORT = 19334;

// Generate unique tab ID
let tabIdCounter = 0;
function generateTabId() {
  return `tab-${++tabIdCounter}-${Date.now()}`;
}

function createWindow() {
  console.log('[Topics Electron] Creating main window...');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hidden',
    backgroundColor: '#1a1a1a',
    icon: path.join(__dirname, 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
    },
    show: false,
  });

  // Layout function for browser panel tabs
  updateLayout = () => {
    if (!mainWindow) return;
    const [width, height] = mainWindow.getSize();

    if (browserPanelVisible && activeTabId && browserTabs.has(activeTabId)) {
      // Split view: Browser tabs overlay on right
      const topicsWidth = Math.floor(width * (1 - browserPanelWidth));
      // Tell React app to constrain its width
      mainWindow.webContents.send('browser-panel-layout', { topicsWidth, totalWidth: width });

      // Show only active tab's view
      for (const [id, tab] of browserTabs) {
        if (id === activeTabId) {
          tab.view.setBounds({ x: topicsWidth, y: 0, width: width - topicsWidth, height });
        } else {
          // Hide other tabs off-screen
          tab.view.setBounds({ x: width + 1000, y: 0, width: 0, height: 0 });
        }
      }
    } else {
      // Topics takes full width
      mainWindow.webContents.send('browser-panel-layout', { topicsWidth: null, totalWidth: width });

      // Hide all browser tabs
      for (const [id, tab] of browserTabs) {
        tab.view.setBounds({ x: width + 1000, y: 0, width: 0, height: 0 });
      }
    }
  };

  mainWindow.on('resize', updateLayout);

  // Load Topics app directly in main window (not BrowserView — enables -webkit-app-region: drag)
  mainWindow.loadURL(SERVER_URL);

  // Show when ready
  mainWindow.webContents.once('did-finish-load', () => {
    console.log('[Topics Electron] Topics loaded, showing window');
    mainWindow.show();
  });

  mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
    console.error('[Topics Electron] Failed to load:', code, desc);
  });

  mainWindow.on('closed', () => {
    console.log('[Topics Electron] Main window closed');
  });

  // Handle external links and detached windows
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    // Check if this is a topic pop-out (detached window)
    if (frameName && frameName.startsWith('topic-')) {
      const topicId = frameName.replace('topic-', '');
      createDetachedWindow(topicId, url, features);
      return { action: 'deny' }; // We handle it ourselves
    }
    
    if (url.startsWith('http://localhost') || url.startsWith(SERVER_URL)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Prevent closing, just hide (like Swift version)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// Create a detached window for a topic (drag-out)
function createDetachedWindow(topicId, url, features = '') {
  console.log('[Topics Electron] Creating detached window for topic:', topicId);
  
  // Parse features string (e.g., "width=900,height=700")
  let width = 900, height = 700;
  if (features) {
    const widthMatch = features.match(/width=(\d+)/);
    const heightMatch = features.match(/height=(\d+)/);
    if (widthMatch) width = parseInt(widthMatch[1]);
    if (heightMatch) height = parseInt(heightMatch[1]);
  }
  
  // Close existing detached window for this topic if any
  if (detachedWindows.has(topicId)) {
    const existing = detachedWindows.get(topicId);
    if (!existing.isDestroyed()) {
      existing.focus();
      return existing;
    }
  }
  
  const detachedWin = new BrowserWindow({
    width,
    height,
    minWidth: 500,
    minHeight: 400,
    titleBarStyle: 'hidden',
    backgroundColor: '#1a1a1a',
    icon: path.join(__dirname, 'icon.icns'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  
  detachedWindows.set(topicId, detachedWin);
  
  // Load the topic URL
  detachedWin.loadURL(url);
  
  // Handle closing
  detachedWin.on('closed', () => {
    detachedWindows.delete(topicId);
    console.log('[Topics Electron] Detached window closed for topic:', topicId);
  });
  
  // Handle window.open in detached windows (for further drag-out or external links)
  detachedWin.webContents.setWindowOpenHandler(({ url: newUrl, frameName }) => {
    if (frameName && frameName.startsWith('topic-')) {
      const newTopicId = frameName.replace('topic-', '');
      createDetachedWindow(newTopicId, newUrl);
      return { action: 'deny' };
    }
    if (newUrl.startsWith('http://localhost') || newUrl.startsWith(SERVER_URL)) {
      return { action: 'allow' };
    }
    shell.openExternal(newUrl);
    return { action: 'deny' };
  });
  
  return detachedWin;
}

// Create a new browser tab
function createBrowserTab(initialUrl = 'about:blank') {
  const id = generateTabId();
  
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  
  mainWindow.addBrowserView(view);
  
  const tab = {
    view,
    url: initialUrl,
    title: 'New Tab',
    visible: false,
  };
  
  browserTabs.set(id, tab);
  
  // Track URL changes
  view.webContents.on('did-navigate', (event, url) => {
    tab.url = url;
    notifyTopics('tab-navigated', { id, url, title: tab.title });
  });
  
  view.webContents.on('did-navigate-in-page', (event, url) => {
    tab.url = url;
    notifyTopics('tab-navigated', { id, url, title: tab.title });
  });
  
  view.webContents.on('page-title-updated', (event, title) => {
    tab.title = title;
    notifyTopics('tab-title-updated', { id, title, url: tab.url });
  });
  
  // Load initial URL if provided
  if (initialUrl && initialUrl !== 'about:blank') {
    view.webContents.loadURL(initialUrl);
  }
  
  return { id, url: tab.url, title: tab.title };
}

// Close a browser tab
function closeBrowserTab(id) {
  const tab = browserTabs.get(id);
  if (!tab) return false;
  
  mainWindow.removeBrowserView(tab.view);
  tab.view.webContents.destroy();
  browserTabs.delete(id);
  
  // If we closed the active tab, activate another one
  if (activeTabId === id) {
    activeTabId = browserTabs.size > 0 ? browserTabs.keys().next().value : null;
  }
  
  updateLayout();
  return true;
}

// Notify Topics view of browser events
function notifyTopics(event, data) {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('browser-event', { event, ...data });
  }
}

// ============ Tray State ============

const trayState = {
  gatewayConnected: false,
  agentCount: 0,
  unread: new Map(),       // topicId -> { unreadCount }
  topics: new Map(),       // topicId -> { id, name, color, icon }
  focusedTopicId: null,    // which topic the renderer is showing
};

// Tray icon images (loaded once)
let trayIcons = {};

function loadTrayIcons() {
  // Use the existing tray-icon.png as base for all states
  const baseIcon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png')).resize({ width: 18, height: 18 });
  baseIcon.setTemplateImage(true);

  // All three states use the same base icon — visual differentiation comes from
  // tray.setTitle() (unread count) and tooltip text (gateway status)
  trayIcons = {
    normal: baseIcon,
    unread: baseIcon,
    disconnected: baseIcon,
  };
}

// ============ WebSocket Bridge ============

let trayWS = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 1000;
let topicCacheTimer = null;

function startWSBridge() {
  if (trayWS) return;
  const wsUrl = SERVER_URL.replace(/^http/, 'ws') + '/ws';
  console.log('[Topics Electron] WS bridge connecting to', wsUrl);

  try {
    trayWS = new WebSocket(wsUrl, { rejectUnauthorized: false });
  } catch (err) {
    console.error('[Topics Electron] WS bridge connection error:', err.message);
    scheduleWSReconnect();
    return;
  }

  trayWS.on('open', () => {
    console.log('[Topics Electron] WS bridge connected');
    wsReconnectDelay = 1000; // reset backoff
    fetchTopicCache();
    // Refresh topic cache every 60s
    if (topicCacheTimer) clearInterval(topicCacheTimer);
    topicCacheTimer = setInterval(fetchTopicCache, 60000);
  });

  trayWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWSMessage(msg);
    } catch (e) {}
  });

  trayWS.on('close', () => {
    console.log('[Topics Electron] WS bridge disconnected');
    trayWS = null;
    scheduleWSReconnect();
  });

  trayWS.on('error', (err) => {
    console.error('[Topics Electron] WS bridge error:', err.message);
    if (trayWS) { try { trayWS.close(); } catch (e) {} }
    trayWS = null;
    scheduleWSReconnect();
  });
}

function scheduleWSReconnect() {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
    startWSBridge();
  }, wsReconnectDelay);
}

function stopWSBridge() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (topicCacheTimer) { clearInterval(topicCacheTimer); topicCacheTimer = null; }
  if (trayWS) { try { trayWS.close(); } catch (e) {} trayWS = null; }
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'unread:init':
      trayState.unread.clear();
      if (msg.data) {
        for (const [topicId, info] of Object.entries(msg.data)) {
          if (info && info.unreadCount > 0) {
            trayState.unread.set(topicId, { unreadCount: info.unreadCount });
          }
        }
      }
      onStateChanged();
      break;

    case 'unread:updated':
      if (msg.unreadCount > 0) {
        trayState.unread.set(msg.topicId, { unreadCount: msg.unreadCount });
      } else {
        trayState.unread.delete(msg.topicId);
      }
      onStateChanged();
      break;

    case 'gateway:status':
      const wasConnected = trayState.gatewayConnected;
      trayState.gatewayConnected = !!msg.connected;
      if (wasConnected !== trayState.gatewayConnected) {
        notifyGatewayStatus(trayState.gatewayConnected);
      }
      onStateChanged();
      break;

    case 'agents:sessions':
      if (Array.isArray(msg.sessions)) {
        const prevCount = trayState.agentCount;
        trayState.agentCount = msg.sessions.filter(s => s.status === 'active').length;
        // Notify on agent completion
        if (prevCount > trayState.agentCount) {
          const completed = msg.sessions.find(s => s.status === 'completed');
          if (completed) notifyAgentCompleted(completed);
        }
      }
      onStateChanged();
      break;

    case 'message':
      if (msg.sessionKey && msg.message) {
        handleNewMessage(msg);
      }
      break;

    case 'approval:created':
      notifyApproval(msg);
      break;

    case 'pong':
      break; // ignore heartbeats
  }
}

// ============ Topic Cache ============

function fetchTopicCache() {
  const req = serverGet('/api/topics', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        // API returns { topics: { id: {...}, ... }, workspaceProjects: [...] }
        const topicsMap = json.topics || json;
        trayState.topics.clear();
        for (const [id, t] of Object.entries(topicsMap)) {
          if (t && !t.archived) {
            trayState.topics.set(id, { id, name: t.name, color: t.color, icon: t.icon });
          }
        }
        scheduleTrayMenuRebuild();
      } catch (e) {}
    });
  });
  req.on('error', () => {});
}

function getTopicName(topicId) {
  const topic = trayState.topics.get(topicId);
  if (topic) return topic.name;
  // Unknown topic — trigger cache refresh
  fetchTopicCache();
  return topicId;
}

// ============ Dynamic Tray Menu ============

let menuRebuildTimer = null;

function scheduleTrayMenuRebuild() {
  if (menuRebuildTimer) return;
  menuRebuildTimer = setTimeout(() => {
    menuRebuildTimer = null;
    rebuildTrayMenu();
    updateTrayIcon();
    updateDockBadge();
  }, 1000);
}

function onStateChanged() {
  scheduleTrayMenuRebuild();
}

function rebuildTrayMenu() {
  if (!tray) return;

  const appLabel = isDev ? 'Topics DEV' : 'Topics';
  const items = [];

  // Gateway status
  items.push({
    label: trayState.gatewayConnected ? 'Gateway: Connected  \u2713' : 'Gateway: Disconnected  \u2717',
    enabled: false,
  });

  // Agent count
  if (trayState.agentCount > 0) {
    items.push({ label: `Agents: ${trayState.agentCount} active`, enabled: false });
  }

  // Unread topics
  const unreadTopics = [];
  for (const [topicId, info] of trayState.unread) {
    unreadTopics.push({ topicId, unreadCount: info.unreadCount, name: getTopicName(topicId) });
  }
  unreadTopics.sort((a, b) => b.unreadCount - a.unreadCount);

  if (unreadTopics.length > 0) {
    items.push({ type: 'separator' });
    for (const topic of unreadTopics.slice(0, 10)) {
      items.push({
        label: `${topic.name} (${topic.unreadCount})`,
        click: () => navigateToTopic(topic.topicId),
      });
    }
    items.push({ type: 'separator' });
    items.push({
      label: 'Mark All Read',
      click: () => markAllRead(),
    });
  }

  items.push({ type: 'separator' });
  items.push({
    label: 'Open at Login',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: (menuItem) => {
      app.setLoginItemSettings({ openAtLogin: menuItem.checked });
    },
  });
  items.push({ label: `Show ${appLabel}`, click: () => { mainWindow.show(); mainWindow.focus(); } });
  items.push({ label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } });

  const contextMenu = Menu.buildFromTemplate(items);
  tray.setContextMenu(contextMenu);

  // Update tooltip
  const totalUnread = getTotalUnread();
  if (totalUnread > 0) {
    tray.setToolTip(`${appLabel} (${totalUnread} unread)`);
  } else {
    tray.setToolTip(appLabel);
  }
}

function getTotalUnread() {
  let total = 0;
  for (const info of trayState.unread.values()) {
    total += info.unreadCount;
  }
  return total;
}

// ============ Dynamic Tray Icon ============

function updateTrayIcon() {
  if (!tray || !trayIcons.normal) return;

  const totalUnread = getTotalUnread();

  // Icon priority: unread > disconnected > normal
  if (totalUnread > 0) {
    tray.setImage(trayIcons.unread);
    tray.setTitle(String(totalUnread), { fontType: 'monospacedDigit' });
  } else if (!trayState.gatewayConnected) {
    tray.setImage(trayIcons.disconnected);
    tray.setTitle('');
  } else {
    tray.setImage(trayIcons.normal);
    tray.setTitle('');
  }
}

function updateDockBadge() {
  if (process.platform !== 'darwin' || !app.dock) return;
  const totalUnread = getTotalUnread();
  if (totalUnread > 0) {
    app.dock.setBadge(String(totalUnread));
  } else {
    app.dock.setBadge(isDev ? 'DEV' : '');
  }
}

// ============ Mark All Read ============

function markAllRead() {
  for (const topicId of trayState.unread.keys()) {
    const req = serverRequest(`/api/topics/${topicId}/read`, { method: 'POST' });
    req.on('error', () => {});
    req.end();
  }
}

// ============ Navigate to Topic ============

function navigateToTopic(topicId) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('navigate-to-topic', topicId);
  }
}

// ============ Notification Manager ============

const activeNotifications = new Map(); // id -> { notification, createdAt }
const notificationCooldowns = new Map(); // topicId -> lastNotifiedAt
let notificationCleanupTimer = null;

function startNotificationCleanup() {
  notificationCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of activeNotifications) {
      if (now - entry.createdAt > 5 * 60 * 1000) {
        activeNotifications.delete(id);
      }
    }
  }, 60000);
}

function stopNotificationCleanup() {
  if (notificationCleanupTimer) {
    clearInterval(notificationCleanupTimer);
    notificationCleanupTimer = null;
  }
  activeNotifications.clear();
}

function showNotification({ id, title, body, topicId }) {
  if (!Notification.isSupported()) return;

  const notif = new Notification({ title, body, silent: false });
  const notifId = id || `notif-${Date.now()}`;

  activeNotifications.set(notifId, { notification: notif, createdAt: Date.now() });

  notif.on('click', () => {
    activeNotifications.delete(notifId);
    if (topicId) {
      navigateToTopic(topicId);
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  notif.on('close', () => {
    activeNotifications.delete(notifId);
  });

  notif.show();
}

function isTopicOnCooldown(topicId) {
  const last = notificationCooldowns.get(topicId);
  if (last && Date.now() - last < 10000) return true;
  return false;
}

function setTopicCooldown(topicId) {
  notificationCooldowns.set(topicId, Date.now());
}

// ============ Notification Triggers ============

function handleNewMessage(msg) {
  // Extract topicId from sessionKey (format: "topic:TOPIC_ID" or similar)
  const topicId = msg.sessionKey?.replace('topic:', '');
  if (!topicId) return;

  // Skip if window is focused on this topic
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused() && trayState.focusedTopicId === topicId) {
    return;
  }

  // Rate limit
  if (isTopicOnCooldown(topicId)) return;
  setTopicCooldown(topicId);

  const topicName = getTopicName(topicId);
  const messageText = msg.message?.content || msg.message?.text || '';
  const preview = messageText.length > 100 ? messageText.substring(0, 100) + '...' : messageText;

  showNotification({
    id: `msg-${topicId}-${Date.now()}`,
    title: topicName,
    body: preview || 'New message',
    topicId,
  });
}

function notifyAgentCompleted(session) {
  showNotification({
    id: `agent-${session.id}-${Date.now()}`,
    title: 'Agent completed',
    body: session.agent_id || session.agentId || 'Agent session finished',
    topicId: session.topic_id || session.topicId,
  });
}

function notifyApproval(msg) {
  const topicId = msg.topicId || msg.topic_id;
  showNotification({
    id: `approval-${Date.now()}`,
    title: 'Approval needed',
    body: msg.toolName || msg.tool_name || 'Action requires approval',
    topicId,
  });
}

function notifyGatewayStatus(connected) {
  if (connected) {
    showNotification({
      id: `gateway-online-${Date.now()}`,
      title: 'OpenClaw online',
      body: 'Gateway connection restored',
    });
  } else {
    showNotification({
      id: `gateway-offline-${Date.now()}`,
      title: 'OpenClaw offline',
      body: 'Gateway connection lost',
    });
  }
}

// ============ App Menu (Edit/View shortcuts) ============
function createAppMenu() {
  const isMac = process.platform === 'darwin';
  
  const template = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { 
          label: 'Open at Login',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (menuItem) => {
            app.setLoginItemSettings({ openAtLogin: menuItem.checked });
          }
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    // Edit menu (critical for copy/paste)
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' }
      ]
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { 
          label: 'Refresh',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow && !mainWindow.webContents.isDestroyed()) {
              mainWindow.webContents.reload();
            }
          }
        },
        { 
          label: 'Hard Reload (Clear Cache)',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: async () => {
            if (mainWindow && !mainWindow.webContents.isDestroyed()) {
              await session.defaultSession.clearCache();
              mainWindow.webContents.reload();
            }
          }
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
        ] : [
          { role: 'close' }
        ])
      ]
    }
  ];
  
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createTray() {
  loadTrayIcons();
  console.log('[Topics Electron] Creating tray, icon empty?', trayIcons.normal.isEmpty(), 'size:', trayIcons.normal.getSize());
  tray = new Tray(trayIcons.normal);
  console.log('[Topics Electron] Tray created');

  // Build initial menu
  rebuildTrayMenu();

  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ============ IPC Handlers ============

// --- Tab Management ---
ipcMain.handle('browser:createTab', async (event, url) => {
  const result = createBrowserTab(url || 'about:blank');
  activeTabId = result.id;
  browserPanelVisible = true;
  updateLayout();
  return { success: true, ...result };
});

ipcMain.handle('browser:closeTab', async (event, id) => {
  const success = closeBrowserTab(id || activeTabId);
  return { success };
});

ipcMain.handle('browser:listTabs', async () => {
  const tabs = [];
  for (const [id, tab] of browserTabs) {
    tabs.push({
      id,
      url: tab.url,
      title: tab.title,
      active: id === activeTabId,
    });
  }
  return { success: true, tabs, activeTabId };
});

ipcMain.handle('browser:activateTab', async (event, id) => {
  if (!browserTabs.has(id)) return { success: false, error: 'Tab not found' };
  activeTabId = id;
  browserPanelVisible = true;
  updateLayout();
  return { success: true, activeTabId };
});

// --- Panel Visibility ---
ipcMain.handle('browser:show', async () => {
  browserPanelVisible = true;
  // Create a tab if none exist
  if (browserTabs.size === 0) {
    const result = createBrowserTab('about:blank');
    activeTabId = result.id;
  }
  updateLayout();
  return { success: true };
});

ipcMain.handle('browser:hide', async () => {
  browserPanelVisible = false;
  updateLayout();
  return { success: true };
});

ipcMain.handle('browser:toggle', async () => {
  browserPanelVisible = !browserPanelVisible;
  if (browserPanelVisible && browserTabs.size === 0) {
    const result = createBrowserTab('about:blank');
    activeTabId = result.id;
  }
  updateLayout();
  return { success: true, visible: browserPanelVisible };
});

ipcMain.handle('browser:isVisible', async () => {
  return { visible: browserPanelVisible };
});

ipcMain.handle('browser:setWidth', async (event, width) => {
  browserPanelWidth = Math.max(0.2, Math.min(0.8, width));
  updateLayout();
  return { success: true, width: browserPanelWidth };
});

// --- Navigation (active tab) ---
ipcMain.handle('browser:navigate', async (event, url) => {
  if (!activeTabId || !browserTabs.has(activeTabId)) {
    // Create a new tab
    const result = createBrowserTab(url);
    activeTabId = result.id;
    browserPanelVisible = true;
    updateLayout();
    return { success: true, url, id: result.id };
  }
  
  const tab = browserTabs.get(activeTabId);
  browserPanelVisible = true;
  updateLayout();
  await tab.view.webContents.loadURL(url);
  return { success: true, url };
});

ipcMain.handle('browser:back', async () => {
  const tab = browserTabs.get(activeTabId);
  if (tab && tab.view.webContents.canGoBack()) {
    tab.view.webContents.goBack();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('browser:forward', async () => {
  const tab = browserTabs.get(activeTabId);
  if (tab && tab.view.webContents.canGoForward()) {
    tab.view.webContents.goForward();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('browser:reload', async () => {
  const tab = browserTabs.get(activeTabId);
  if (tab) {
    tab.view.webContents.reload();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('browser:getUrl', async () => {
  const tab = browserTabs.get(activeTabId);
  if (tab) {
    return { success: true, url: tab.view.webContents.getURL() };
  }
  return { success: false };
});

ipcMain.handle('browser:getTitle', async () => {
  const tab = browserTabs.get(activeTabId);
  if (tab) {
    return { success: true, title: tab.view.webContents.getTitle() };
  }
  return { success: false };
});

ipcMain.handle('browser:executeJs', async (event, code) => {
  const tab = browserTabs.get(activeTabId);
  if (tab) {
    try {
      const result = await tab.view.webContents.executeJavaScript(code);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  return { success: false, error: 'No active tab' };
});

ipcMain.handle('browser:canGoBack', async () => {
  const tab = browserTabs.get(activeTabId);
  return { canGoBack: tab ? tab.view.webContents.canGoBack() : false };
});

ipcMain.handle('browser:canGoForward', async () => {
  const tab = browserTabs.get(activeTabId);
  return { canGoForward: tab ? tab.view.webContents.canGoForward() : false };
});

// --- Screenshot (for a specific tab) ---
ipcMain.handle('browser:screenshot', async (event, tabId) => {
  const tab = browserTabs.get(tabId || activeTabId);
  if (!tab) return { success: false, error: 'Tab not found' };
  
  try {
    const image = await tab.view.webContents.capturePage();
    const buffer = image.toPNG();
    return { success: true, data: buffer.toString('base64'), format: 'png' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Window Control ---
ipcMain.handle('window:close', () => {
  mainWindow.hide();
});

ipcMain.handle('app:quit', () => {
  app.isQuitting = true;
  app.quit();
});

ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

// --- Detached Windows ---
ipcMain.handle('window:detach', async (event, topicId) => {
  const url = `${SERVER_URL}?topic=${topicId}`;
  createDetachedWindow(topicId, url);
  return { success: true };
});

ipcMain.handle('window:listDetached', async () => {
  const windows = [];
  for (const [topicId, win] of detachedWindows) {
    if (!win.isDestroyed()) {
      windows.push({ topicId, focused: win.isFocused() });
    }
  }
  return { windows };
});

ipcMain.handle('window:focusDetached', async (event, topicId) => {
  const win = detachedWindows.get(topicId);
  if (win && !win.isDestroyed()) {
    win.focus();
    return { success: true };
  }
  return { success: false };
});

ipcMain.handle('window:closeDetached', async (event, topicId) => {
  const win = detachedWindows.get(topicId);
  if (win && !win.isDestroyed()) {
    win.close();
    return { success: true };
  }
  return { success: false };
});

// --- Topic Focus Tracking (for notification suppression) ---
ipcMain.on('topic:focused', (event, topicId) => {
  trayState.focusedTopicId = topicId || null;
});

ipcMain.handle('window:focusMain', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return { success: true };
  }
  return { success: false };
});

// ============ CDP HTTP Server for OpenClaw ============

// Create a simple HTTP server that provides CDP endpoint info
function startCDPInfoServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Custom /tabs endpoint for easier browser tab management
    if (req.url === '/tabs') {
      const tabs = [];
      for (const [id, tab] of browserTabs) {
        if (!tab.view.webContents.isDestroyed()) {
          tabs.push({
            id,
            url: tab.url || tab.view.webContents.getURL(),
            title: tab.title || tab.view.webContents.getTitle() || 'Tab',
            active: id === activeTabId,
          });
        }
      }
      res.end(JSON.stringify({ tabs, activeTabId, browserPanelVisible }));
      return;
    }
    
    if (req.url === '/json/list' || req.url === '/json') {
      // List all debuggable targets
      const targets = [];
      
      // Topics view
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        const debuggerUrl = mainWindow.webContents.debugger.isAttached() ? '' : '';
        targets.push({
          id: 'topics-main',
          type: 'page',
          title: mainWindow.webContents.getTitle() || 'Topics',
          url: mainWindow.webContents.getURL(),
          webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}/devtools/page/topics-main`,
          devtoolsFrontendUrl: '',
        });
      }
      
      // Browser tabs
      for (const [id, tab] of browserTabs) {
        if (!tab.view.webContents.isDestroyed()) {
          targets.push({
            id,
            type: 'page',
            title: tab.title || tab.view.webContents.getTitle() || 'Tab',
            url: tab.url || tab.view.webContents.getURL(),
            webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}/devtools/page/${id}`,
            devtoolsFrontendUrl: '',
          });
        }
      }
      
      res.end(JSON.stringify(targets));
      return;
    }
    
    if (req.url === '/json/version') {
      res.end(JSON.stringify({
        Browser: 'Topics-Electron/1.0',
        'Protocol-Version': '1.3',
        'User-Agent': 'Topics Electron App',
        'V8-Version': process.versions.v8,
        'WebKit-Version': '',
        webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}`,
      }));
      return;
    }
    
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  
  server.listen(CDP_INFO_PORT, '127.0.0.1', () => {
    console.log(`[Topics Electron] CDP info server listening on http://127.0.0.1:${CDP_INFO_PORT}`);
  });
  
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const altPort = CDP_INFO_PORT + 1;
      console.log(`[Topics Electron] Port ${CDP_INFO_PORT} in use, trying ${altPort}`);
      server.listen(altPort, '127.0.0.1', () => {
        console.log(`[Topics Electron] CDP info server listening on http://127.0.0.1:${altPort}`);
      });
    } else {
      console.error('[Topics Electron] CDP server error:', err);
    }
  });
}

// ============ Production Asset Watcher ============

let assetWatcher = null;
let reloadDebounceTimer = null;

function startAssetWatcher() {
  // Watch /public/ for client asset rebuilds (production hot reload)
  const publicDir = path.join(__dirname, '..', 'public');
  if (!fs.existsSync(publicDir)) {
    console.log('[Topics Electron] /public/ directory not found, skipping asset watcher');
    return;
  }

  try {
    assetWatcher = fs.watch(publicDir, { recursive: true }, (eventType, filename) => {
      // Debounce: wait 500ms for Vite to finish writing all chunks
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        console.log(`[Topics Electron] Asset change detected (${filename}), reloading...`);
        reloadAllAppWindows();
      }, 500);
    });

    console.log('[Topics Electron] Asset watcher started on /public/');
  } catch (err) {
    console.error('[Topics Electron] Failed to start asset watcher:', err.message);
  }
}

function reloadAllAppWindows() {
  // Reload main window
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.reload();
  }

  // Reload all detached topic windows
  for (const [topicId, win] of detachedWindows) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.reload();
    }
  }

  // NOTE: BrowserView instances (browser tabs) are NOT reloaded —
  // they point to external URLs, not the app's client assets.
}

function stopAssetWatcher() {
  if (reloadDebounceTimer) {
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = null;
  }
  if (assetWatcher) {
    assetWatcher.close();
    assetWatcher = null;
    console.log('[Topics Electron] Asset watcher stopped');
  }
}

// ============ App Lifecycle ============

app.whenReady().then(() => {
  // In dev mode, set the dock icon and app name to distinguish from prod
  if (isDev && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'icon.png'));
    app.setName('Topics DEV');
  }

  createAppMenu();
  createWindow();
  createTray();
  startWSBridge();
  startNotificationCleanup();
  startCDPInfoServer();
  startAssetWatcher();

  // Enable auto-start at login on first launch
  const loginSettings = app.getLoginItemSettings();
  if (!loginSettings.openAtLogin && !loginSettings.wasOpenedAtLogin) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  stopWSBridge();
  stopNotificationCleanup();
  stopAssetWatcher();
});

// Allow self-signed TLS certificates for localhost
app.commandLine.appendSwitch('ignore-certificate-errors-spki-list', '');
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (new URL(url).hostname === 'localhost') {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

// Enable remote debugging for the whole app
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
