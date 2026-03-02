// Global type declarations for Electron API

export interface ElectronBrowserTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface ElectronBrowserAPI {
  // Tab management
  createTab: (url?: string) => Promise<{ success: boolean; id?: string; url?: string; title?: string }>;
  closeTab: (id?: string) => Promise<{ success: boolean }>;
  listTabs: () => Promise<{ success: boolean; tabs: ElectronBrowserTab[]; activeTabId: string | null }>;
  activateTab: (id: string) => Promise<{ success: boolean; activeTabId?: string }>;
  
  // Panel visibility
  show: () => Promise<{ success: boolean }>;
  hide: () => Promise<{ success: boolean }>;
  toggle: () => Promise<{ success: boolean; visible?: boolean }>;
  isVisible: () => Promise<{ visible: boolean }>;
  setWidth: (width: number) => Promise<{ success: boolean; width?: number }>;
  
  // Navigation (active tab)
  navigate: (url: string) => Promise<{ success: boolean; url?: string; id?: string }>;
  back: () => Promise<{ success: boolean }>;
  forward: () => Promise<{ success: boolean }>;
  reload: () => Promise<{ success: boolean }>;
  getUrl: () => Promise<{ success: boolean; url?: string }>;
  getTitle: () => Promise<{ success: boolean; title?: string }>;
  canGoBack: () => Promise<{ canGoBack: boolean }>;
  canGoForward: () => Promise<{ canGoForward: boolean }>;
  
  // Advanced
  executeJs: (code: string) => Promise<{ success: boolean; result?: any; error?: string }>;
  screenshot: (tabId?: string) => Promise<{ success: boolean; data?: string; format?: string; error?: string }>;
}

export interface ElectronAPI {
  browser: ElectronBrowserAPI;
  onBrowserEvent: (callback: (data: any) => void) => void;
  removeBrowserEventListener: () => void;
  window: {
    close: () => void;
  };
  app: {
    quit: () => void;
    relaunch: () => Promise<void>;
  };
  platform: string;
  isElectron: boolean;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
