const { app, BrowserWindow, BrowserView, ipcMain, Menu, Tray, nativeImage, shell, session } = require('electron');
const path = require('path');
const http = require('http');

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
const SERVER_URL = process.env.DEV_URL || 'http://localhost:3333';
const isDev = !app.isPackaged;

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

// ============ Unread Count Polling ============
let unreadTimer = null;
let lastUnreadCount = 0;

function startUnreadPolling() {
  // Poll every 5 seconds for unread count
  unreadTimer = setInterval(fetchUnreadCount, 5000);
  // Initial fetch
  fetchUnreadCount();
}

async function fetchUnreadCount() {
  try {
    const http = require('http');
    const req = http.get('http://localhost:3333/api/unread', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          let totalUnread = 0;
          let topicsWithUnread = 0;
          
          for (const [key, value] of Object.entries(json)) {
            if (value && value.unreadCount > 0) {
              totalUnread += value.unreadCount;
              topicsWithUnread++;
            }
          }
          
          updateBadges(topicsWithUnread, totalUnread);
        } catch (e) {}
      });
    });
    req.on('error', () => {});
    req.end();
  } catch (e) {}
}

function updateBadges(topicsWithUnread, totalUnread) {
  // Update tray tooltip with count
  const appLabel = isDev ? 'Topics DEV' : 'Topics';
  if (tray) {
    if (topicsWithUnread > 0) {
      tray.setToolTip(`${appLabel} (${topicsWithUnread} with unread)`);
    } else {
      tray.setToolTip(appLabel);
    }
  }

  // Update dock badge (macOS)
  if (process.platform === 'darwin' && app.dock) {
    if (totalUnread > 0) {
      app.dock.setBadge(String(totalUnread));
    } else {
      app.dock.setBadge(isDev ? 'DEV' : '');
    }
  }
  
  lastUnreadCount = totalUnread;
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
  const iconPath = path.join(__dirname, 'tray-icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.resize({ width: 18, height: 18 }));

  const contextMenu = Menu.buildFromTemplate([
    { label: isDev ? 'Show Topics DEV' : 'Show Topics', click: () => mainWindow.show() },
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
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);

  tray.setToolTip(isDev ? 'Topics DEV' : 'Topics');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
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
  startUnreadPolling();
  startCDPInfoServer();

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

// Enable remote debugging for the whole app
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
