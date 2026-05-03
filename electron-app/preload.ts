import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Browser tab management
  browser: {
    createTab: (url: string) => ipcRenderer.invoke('browser:createTab', url),
    closeTab: (id: string) => ipcRenderer.invoke('browser:closeTab', id),
    listTabs: () => ipcRenderer.invoke('browser:listTabs'),
    activateTab: (id: string) => ipcRenderer.invoke('browser:activateTab', id),

    show: () => ipcRenderer.invoke('browser:show'),
    hide: () => ipcRenderer.invoke('browser:hide'),
    toggle: () => ipcRenderer.invoke('browser:toggle'),
    isVisible: () => ipcRenderer.invoke('browser:isVisible'),
    setWidth: (width: number) => ipcRenderer.invoke('browser:setWidth', width),

    navigate: (url: string) => ipcRenderer.invoke('browser:navigate', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    getUrl: () => ipcRenderer.invoke('browser:getUrl'),
    getTitle: () => ipcRenderer.invoke('browser:getTitle'),
    canGoBack: () => ipcRenderer.invoke('browser:canGoBack'),
    canGoForward: () => ipcRenderer.invoke('browser:canGoForward'),

    executeJs: (code: string) => ipcRenderer.invoke('browser:executeJs', code),
    screenshot: (tabId?: string) => ipcRenderer.invoke('browser:screenshot', tabId),
  },

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
