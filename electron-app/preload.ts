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
  },

  // Phase B · DAEMON-03 — daemon lifecycle management (macOS)
  daemon: {
    install: () => ipcRenderer.invoke('daemon:install-launchagent'),
    uninstall: () => ipcRenderer.invoke('daemon:uninstall-launchagent'),
    status: () => ipcRenderer.invoke('daemon:status'),
  },

  // Phase E — auto-updater
  updater: {
    checkForUpdates: () => ipcRenderer.invoke('updater:check-for-updates'),
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
    navigate: (viewId: string, url: string) =>
      ipcRenderer.invoke('browser-native:navigate', viewId, url),
    goBack: (viewId: string) => ipcRenderer.invoke('browser-native:go-back', viewId),
    goForward: (viewId: string) => ipcRenderer.invoke('browser-native:go-forward', viewId),
    reload: (viewId: string) => ipcRenderer.invoke('browser-native:reload', viewId),
    setBounds: (viewId: string, bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browser-native:set-bounds', viewId, bounds),
    getCdpTargetId: (viewId: string) => ipcRenderer.invoke('browser-native:get-cdp-target-id', viewId),
    toggleDevTools: (viewId: string) => ipcRenderer.invoke('browser-native:toggle-devtools', viewId),
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
  },

  // Phase 30.1 polish — Overlay menu (transparent BrowserWindow above WebContentsView).
  // Returns the selected item id, or null if cancelled (blur, esc).
  overlay: {
    showMenu: (opts: {
      anchor: { x: number; y: number; width: number; height: number };
      items: Array<{ id: string; label: string; iconName?: string; divider?: boolean }>;
      side?: 'bottom' | 'top' | 'right' | 'left';
      theme?: 'light' | 'dark';
      estimatedWidth?: number;
      estimatedItemHeight?: number;
    }) => ipcRenderer.invoke('overlay:show-menu', opts) as Promise<string | null>,
  },

  // Dialog
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),

  // Open URL in system browser
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

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
