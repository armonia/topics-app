import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Browser IPC removed in plan 30-01 (Phase 30 BROWSER-CHAT-01).
  // 19 orphan handlers in main.ts had zero callers in client/src/.
  // Browser control inside Topics now flows through Playwright (server/browser-service.ts)
  // and will be exposed via WebSocket in plan 30-02.
  // The `browser-event` channel (onBrowserEvent below) STAYS — it's an inbound
  // listener for events sent by notifyTopics() in main.ts.

  onBrowserEvent: (callback: (data: unknown) => void) => {
    ipcRenderer.on('browser-event', (_event, data) => callback(data));
  },

  removeBrowserEventListener: () => {
    ipcRenderer.removeAllListeners('browser-event');
  },

  onNavigateToTopic: (callback: (topicId: string) => void) => {
    ipcRenderer.on('navigate-to-topic', (_event, topicId) => callback(topicId));
  },
  removeNavigateToTopicListener: () => {
    ipcRenderer.removeAllListeners('navigate-to-topic');
  },

  // Native "Reopen Closed Tab" menu accelerator (⇧⌘T) → renderer. The renderer
  // reopens the most recently closed tab via the same shared handler the
  // keyboard chord and ⌘K palette use.
  onReopenClosedTab: (callback: () => void) => {
    ipcRenderer.on('reopen-closed-tab', () => callback());
  },
  removeReopenClosedTabListener: () => {
    ipcRenderer.removeAllListeners('reopen-closed-tab');
  },

  reportFocusedTopic: (topicId: string) => {
    ipcRenderer.send('topic:focused', topicId);
  },

  // Window control
  window: {
    close: () => ipcRenderer.invoke('window:close'),
    detach: (topicId: string) => ipcRenderer.invoke('window:detach', topicId),
    listDetached: () => ipcRenderer.invoke('window:listDetached'),
    focusDetached: (topicId: string) => ipcRenderer.invoke('window:focusDetached', topicId),
    closeDetached: (topicId: string) => ipcRenderer.invoke('window:closeDetached', topicId),
    focusMain: () => ipcRenderer.invoke('window:focusMain'),
    showTrafficLights: () => ipcRenderer.invoke('window:showTrafficLights'),
    hideTrafficLights: () => ipcRenderer.invoke('window:hideTrafficLights'),
  },

  // App control
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    toggleAlwaysOnTop: () => ipcRenderer.invoke('app:toggle-always-on-top'),
    getAlwaysOnTop: () => ipcRenderer.invoke('app:get-always-on-top'),
    getVersion: () => ipcRenderer.invoke('app:get-version'),
  },

  // Performance diagnostics — per-process CPU + GPU acceleration status, so the
  // status-bar dropdown can tell "the PC is busy" from "Topics' renderer is".
  perf: {
    getMetrics: () => ipcRenderer.invoke('perf:get-metrics'),
  },

  // Phase B · DAEMON-03 — daemon lifecycle management (macOS)
  daemon: {
    install: () => ipcRenderer.invoke('daemon:install-launchagent'),
    uninstall: () => ipcRenderer.invoke('daemon:uninstall-launchagent'),
    status: () => ipcRenderer.invoke('daemon:status'),
  },

  // Phase E — auto-updater (opt-in; see electron-app/main.ts § "Auto-update")
  updater: {
    checkForUpdates: () => ipcRenderer.invoke('updater:check-for-updates'),
    // NEW (2026-05-11): explicit download trigger. With autoDownload disabled
    // server-side, the UI MUST call this for the update to actually fetch.
    downloadUpdate: () => ipcRenderer.invoke('updater:download-update'),
    status: () => ipcRenderer.invoke('updater:status'),
    quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
    onStatus: (handler: (status: { state: string; progress?: number; error?: string }) => void) => {
      const listener = (_evt: unknown, status: any) => handler(status);
      ipcRenderer.on('updater:status', listener);
      return () => ipcRenderer.removeListener('updater:status', listener);
    },
  },

  // Phase F — UX polish
  theme: {
    setResolved: (resolved: 'light' | 'dark') => ipcRenderer.invoke('theme:set-resolved', resolved),
  },
  notification: {
    showScoped: (payload: {
      trigger: 'agent_completed' | 'permission_requested';
      title?: string;
      body: string;
      topicId?: string;
    }) => ipcRenderer.invoke('notification:show-scoped', payload),
  },
  caffeinate: {
    setMode: (mode: 'off' | 'power' | 'always') => ipcRenderer.invoke('caffeinate:set-mode', mode),
    getMode: () => ipcRenderer.invoke('caffeinate:get-mode'),
    onReleased: (handler: (info: { reason: string }) => void) => {
      const listener = (_evt: unknown, info: any) => handler(info);
      ipcRenderer.on('caffeinate:released', listener);
      return () => ipcRenderer.removeListener('caffeinate:released', listener);
    },
  },

  // Phase 30.1 BROWSER-CHAT-06 — Native browser bridge.
  // The renderer detects Electron mode via `window.electronAPI?.browserNative?.isAvailable`
  // and conditionally mounts a placeholder div backed by setBounds calls.
  // In web mode (browser, not Electron), this whole property is undefined.
  browserNative: {
    isAvailable: true as const,
    create: (opts: { topicId: string; partitionId: string; initialUrl?: string }) =>
      ipcRenderer.invoke('browser-native:create', opts),
    destroy: (viewId: string) => ipcRenderer.invoke('browser-native:destroy', viewId),
    // Liveness heartbeat — the renderer pings this every few seconds while a
    // native browser pane is mounted. Main keeps the view alive as long as the
    // pings keep coming; a view that stops being pinged (= the tab was genuinely
    // closed) is reaped. This decouples the WebContentsView lifetime from React
    // mount/unmount churn so the agent's CDP target stays valid between turns.
    keepalive: (viewId: string) => ipcRenderer.invoke('browser-native:keepalive', viewId),
    navigate: (viewId: string, url: string) =>
      ipcRenderer.invoke('browser-native:navigate', viewId, url),
    goBack: (viewId: string) => ipcRenderer.invoke('browser-native:go-back', viewId),
    goForward: (viewId: string) => ipcRenderer.invoke('browser-native:go-forward', viewId),
    reload: (viewId: string) => ipcRenderer.invoke('browser-native:reload', viewId),
    setBounds: (viewId: string, bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browser-native:set-bounds', viewId, bounds),
    getCdpTargetId: (viewId: string) => ipcRenderer.invoke('browser-native:get-cdp-target-id', viewId),
    toggleDevTools: (viewId: string, mode?: 'right' | 'bottom' | 'left' | 'undocked' | 'detach') =>
      ipcRenderer.invoke('browser-native:toggle-devtools', viewId, mode),
    onUrlChange: (viewId: string, callback: (url: string) => void) => {
      const channel = `browser-native:url-change:${viewId}`;
      const listener = (_evt: unknown, url: string) => callback(url);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onTitleChange: (viewId: string, callback: (title: string) => void) => {
      const channel = `browser-native:title-change:${viewId}`;
      const listener = (_evt: unknown, title: string) => callback(title);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onLoadingChange: (viewId: string, callback: (loading: boolean) => void) => {
      const channel = `browser-native:loading-change:${viewId}`;
      const listener = (_evt: unknown, loading: boolean) => callback(loading);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onFaviconChange: (viewId: string, callback: (faviconUrl: string) => void) => {
      const channel = `browser-native:favicon-change:${viewId}`;
      const listener = (_evt: unknown, faviconUrl: string) => callback(faviconUrl);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    findInPage: (viewId: string, text: string, options?: { forward?: boolean; matchCase?: boolean; findNext?: boolean }) =>
      ipcRenderer.invoke('browser-native:find-in-page', viewId, text, options),
    stopFind: (viewId: string) => ipcRenderer.invoke('browser-native:stop-find', viewId),
    onFindResult: (viewId: string, callback: (r: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) => {
      const channel = `browser-native:find-result:${viewId}`;
      const listener = (_evt: unknown, r: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => callback(r);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    setZoom: (viewId: string, delta: number | 'reset') =>
      ipcRenderer.invoke('browser-native:set-zoom', viewId, delta) as Promise<number>,
    // Device emulation (mobile/tablet/custom; null = desktop/disable).
    setDevice: (viewId: string, params: null | { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean; userAgent?: string }) =>
      ipcRenderer.invoke('browser-native:set-device', viewId, params) as Promise<void>,
    // Back/forward navigation history (for the Chrome-style long-press menu).
    getNavEntries: (viewId: string) =>
      ipcRenderer.invoke('browser-native:nav-entries', viewId) as Promise<{ entries: { url: string; title: string; index: number }[]; activeIndex: number }>,
    goToNavIndex: (viewId: string, index: number) =>
      ipcRenderer.invoke('browser-native:go-to-index', viewId, index) as Promise<void>,
    // Page console messages (toolbar quick-console badge + panel).
    onConsoleMessage: (viewId: string, callback: (entry: { id: number; level: string; text: string; source?: string }) => void) => {
      const channel = `browser-native:console:${viewId}`;
      const listener = (_e: unknown, entry: { id: number; level: string; text: string; source?: string }) => callback(entry);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onPermissionRequest: (callback: (info: { requestId: string; permission: string; url: string; partitionId: string }) => void) => {
      const listener = (_evt: unknown, info: { requestId: string; permission: string; url: string; partitionId: string }) => callback(info);
      ipcRenderer.on('browser-native:permission-request', listener);
      return () => ipcRenderer.removeListener('browser-native:permission-request', listener);
    },
    respondPermission: (requestId: string, granted: boolean) =>
      ipcRenderer.send('browser-native:permission-response', { requestId, granted }),
    onDownloadStart: (callback: (info: { id: string; url: string; filename: string; totalBytes: number }) => void) => {
      const listener = (_evt: unknown, info: { id: string; url: string; filename: string; totalBytes: number }) => callback(info);
      ipcRenderer.on('browser-native:download-start', listener);
      return () => ipcRenderer.removeListener('browser-native:download-start', listener);
    },
    onDownloadProgress: (callback: (info: { id: string; state: string; received: number; total: number; isPaused: boolean }) => void) => {
      const listener = (_evt: unknown, info: { id: string; state: string; received: number; total: number; isPaused: boolean }) => callback(info);
      ipcRenderer.on('browser-native:download-progress', listener);
      return () => ipcRenderer.removeListener('browser-native:download-progress', listener);
    },
    onDownloadDone: (callback: (info: { id: string; state: string; savedPath: string }) => void) => {
      const listener = (_evt: unknown, info: { id: string; state: string; savedPath: string }) => callback(info);
      ipcRenderer.on('browser-native:download-done', listener);
      return () => ipcRenderer.removeListener('browser-native:download-done', listener);
    },
    showDownloadInFolder: (savedPath: string) => ipcRenderer.invoke('browser-native:show-download-in-folder', savedPath),
    inspectAtPoint: (viewId: string, x: number, y: number) =>
      ipcRenderer.invoke('browser-native:inspect-at-point', viewId, x, y) as Promise<null | {
        domPath: string;
        cssPath: string;
        bbox: { x: number; y: number; w: number; h: number };
        text?: string;
        attributes?: Record<string, string>;
      }>,
    onReflow: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('browser-native:reflow', listener);
      return () => ipcRenderer.removeListener('browser-native:reflow', listener);
    },
    // A page (or the agent) called window.close() — close the owning browser pane.
    onPageCloseRequest: (callback: (contextId: string) => void) => {
      const listener = (_e: unknown, payload: { contextId?: string }) => {
        if (payload && typeof payload.contextId === 'string') callback(payload.contextId);
      };
      ipcRenderer.on('browser-native:page-close-request', listener);
      return () => ipcRenderer.removeListener('browser-native:page-close-request', listener);
    },
  },

  // Phase 30.1 polish — Overlay menu (transparent BrowserWindow above WebContentsView).
  // Returns the selected item id, or null if cancelled (blur, esc).
  overlay: {
    showMenu: (opts: {
      anchor: { x: number; y: number; width: number; height: number };
      items: Array<{ id: string; label: string; iconName?: string; iconColor?: string; divider?: boolean }>;
      side?: 'bottom' | 'top' | 'right' | 'left';
      theme?: 'light' | 'dark';
      estimatedWidth?: number;
      estimatedItemHeight?: number;
      gap?: number;
      colors?: { bg?: string; text?: string; muted?: string; border?: string; hover?: string };
    }) => ipcRenderer.invoke('overlay:show-menu', opts) as Promise<string | null>,
  },

  // Overlay host — full-screen React modals (⌘K, Settings) rendered in a
  // transparent always-on-top window ABOVE the native browser WebContentsView.
  // The MAIN renderer uses show/hide/onAction/onClosed; the OVERLAY window
  // (loaded with ?overlay=1) uses onRender/action/closed.
  overlayHost: {
    /** (main) Show a modal in the overlay window with a data snapshot. */
    show: (payload: { modal: string; data?: unknown }) => ipcRenderer.send('overlay-host:show', payload),
    /** (main) Hide the overlay window. */
    hide: () => ipcRenderer.send('overlay-host:hide'),
    /** (main) Receive a relayed modal action {type,args}. Returns an unsubscribe. */
    onAction: (cb: (action: { type: string; args: unknown[] }) => void) => {
      const l = (_e: unknown, a: { type: string; args: unknown[] }) => cb(a);
      ipcRenderer.on('overlay-host:action', l);
      return () => ipcRenderer.removeListener('overlay-host:action', l);
    },
    /** (main) The overlay closed itself (Esc / backdrop). Returns an unsubscribe. */
    onClosed: (cb: () => void) => {
      const l = () => cb();
      ipcRenderer.on('overlay-host:closed', l);
      return () => ipcRenderer.removeListener('overlay-host:closed', l);
    },
    /** (overlay) Receive the modal+data to render, or null to clear. Returns an unsubscribe. */
    onRender: (cb: (state: { modal: string; data?: unknown } | null) => void) => {
      const l = (_e: unknown, s: { modal: string; data?: unknown } | null) => cb(s);
      ipcRenderer.on('overlay-host:render', l);
      return () => ipcRenderer.removeListener('overlay-host:render', l);
    },
    /** (overlay) Relay a modal action back to the main renderer. */
    action: (action: { type: string; args: unknown[] }) => ipcRenderer.send('overlay-host:action', action),
    /** (overlay) Tell main the modal closed itself. */
    closed: () => ipcRenderer.send('overlay-host:closed'),
  },

  // Dialog
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),

  // Open URL in system browser
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Per-region native vibrancy (macOS floating-splits). The renderer streams
  // panel rects (top-left CSS px) on settled layout; main upserts blur views
  // under them and clears during gestures. Fire-and-forget (send, not invoke).
  vibrancy: {
    setRegions: (rects: Array<{ x: number; y: number; w: number; h: number; radius?: number }>) =>
      ipcRenderer.send('vibrancy:set-regions', rects),
    clear: () => ipcRenderer.send('vibrancy:clear'),
  },

  // Platform info
  platform: process.platform,
  isElectron: true,
});

// Compatibility with existing Swift message handlers
contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {
    closeWindow: {
      postMessage: () => ipcRenderer.invoke('window:close'),
    },
    quitApp: {
      postMessage: () => ipcRenderer.invoke('app:quit'),
    },
  },
});

console.log('[Preload] electronAPI exposed to renderer');
