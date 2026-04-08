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

  // Dialog
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),

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
