const { contextBridge, ipcRenderer } = require('electron');

// Expose APIs to the renderer process (Topics web app)
contextBridge.exposeInMainWorld('electronAPI', {
  // Browser tab management
  browser: {
    // Tab management
    createTab: (url) => ipcRenderer.invoke('browser:createTab', url),
    closeTab: (id) => ipcRenderer.invoke('browser:closeTab', id),
    listTabs: () => ipcRenderer.invoke('browser:listTabs'),
    activateTab: (id) => ipcRenderer.invoke('browser:activateTab', id),
    
    // Panel visibility
    show: () => ipcRenderer.invoke('browser:show'),
    hide: () => ipcRenderer.invoke('browser:hide'),
    toggle: () => ipcRenderer.invoke('browser:toggle'),
    isVisible: () => ipcRenderer.invoke('browser:isVisible'),
    setWidth: (width) => ipcRenderer.invoke('browser:setWidth', width),
    
    // Navigation (active tab)
    navigate: (url) => ipcRenderer.invoke('browser:navigate', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    getUrl: () => ipcRenderer.invoke('browser:getUrl'),
    getTitle: () => ipcRenderer.invoke('browser:getTitle'),
    canGoBack: () => ipcRenderer.invoke('browser:canGoBack'),
    canGoForward: () => ipcRenderer.invoke('browser:canGoForward'),
    
    // Advanced
    executeJs: (code) => ipcRenderer.invoke('browser:executeJs', code),
    screenshot: (tabId) => ipcRenderer.invoke('browser:screenshot', tabId),
  },

  // Listen for browser events from main process
  onBrowserEvent: (callback) => {
    ipcRenderer.on('browser-event', (event, data) => callback(data));
  },
  
  removeBrowserEventListener: () => {
    ipcRenderer.removeAllListeners('browser-event');
  },

  // Window control
  window: {
    close: () => ipcRenderer.invoke('window:close'),
    detach: (topicId) => ipcRenderer.invoke('window:detach', topicId),
    listDetached: () => ipcRenderer.invoke('window:listDetached'),
    focusDetached: (topicId) => ipcRenderer.invoke('window:focusDetached', topicId),
    closeDetached: (topicId) => ipcRenderer.invoke('window:closeDetached', topicId),
    focusMain: () => ipcRenderer.invoke('window:focusMain'),
  },

  // App control
  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
  },

  // Platform info
  platform: process.platform,
  isElectron: true,
});

// Also expose for compatibility with existing Swift message handlers
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
