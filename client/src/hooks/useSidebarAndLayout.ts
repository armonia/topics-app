/**
 * useSidebarAndLayout — owns layout chrome + sidebar resize protocol +
 * cross-tab settings sync + traffic-light visibility + viewport tracking.
 *
 * Extracted from App.tsx during Phase 3 (hook 1 of 4).
 *
 * Owns (every line moved out of App):
 *  - windowId, isMobile, isPWA, viewportHeight, isElectron
 *  - appSettings (with cross-tab useStorageSync)
 *  - sidebarWidth, sidebarCollapsed
 *  - sidebar resize refs + touch refs + edge-touch refs
 *  - All sidebar handlers (touch, resize start/end, double-click,
 *    toggle), keep-trans, pre-render class removal, auto-collapse
 *    on mobile, visualViewport tracking, traffic-light visibility,
 *    cross-tab settings sync.
 *
 * NOT owned: showTopicsMenu lives in App (modal state stays per
 * CRITIQUE C10), but is passed in here so the traffic-light effect can
 * react to it without exporting an electron-API call into App's render.
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AppSettings } from '../types';
import { useMobile } from './useMobile';
import { useStorageSync } from './useStorageSync';
import { loadSettings, saveSettings } from '../lib/settings';
import { generateUUID } from '../utils/uuid';

const getWindowId = (): string => {
  let id = sessionStorage.getItem('topics-window-id');
  if (!id) {
    id = generateUUID();
    sessionStorage.setItem('topics-window-id', id);
  }
  return id;
};

export interface UseSidebarAndLayoutArgs {
  isDetached: boolean;
  /** App owns the topics-menu modal state; passed in for the traffic-light effect. */
  showTopicsMenu: boolean;
}

export interface UseSidebarAndLayoutReturn {
  state: {
    appSettings: AppSettings;
    sidebarWidth: number;
    sidebarCollapsed: boolean;
    isMobile: boolean;
    isPWA: boolean;
    viewportHeight: number | null;
    isElectron: boolean;
    windowId: string;
  };
  refs: {
    sidebarRef: React.RefObject<HTMLDivElement | null>;
  };
  handlers: {
    toggleSidebar: () => void;
    handleSidebarResizeStart: (e: React.MouseEvent) => void;
    handleSidebarDoubleClick: () => void;
    handleSidebarTouchStart: (e: React.TouchEvent) => void;
    handleSidebarTouchEnd: (e: React.TouchEvent) => void;
    handleEdgeTouchStart: (e: React.TouchEvent) => void;
    handleEdgeTouchEnd: (e: React.TouchEvent) => void;
    setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
    setAppSettings: Dispatch<SetStateAction<AppSettings>>;
  };
}

export function useSidebarAndLayout(args: UseSidebarAndLayoutArgs): UseSidebarAndLayoutReturn {
  const { isDetached, showTopicsMenu } = args;

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
    (window.navigator as unknown as { standalone?: boolean }).standalone === true,
  );

  // Touch detection (kept for parity with original App.tsx; underscore-marked
  // there as unused — preserved here for any future reads).
  useMobile();

  // Mobile keyboard: adjust app height when virtual keyboard opens
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const fullHeightRef = useRef(window.innerHeight);
  useEffect(() => {
    if (!isMobile || !window.visualViewport) return;
    const vv = window.visualViewport;
    const trackFullHeight = () => {
      if (vv.height >= window.innerHeight * 0.85) {
        fullHeightRef.current = window.innerHeight;
      }
    };
    window.addEventListener('resize', trackFullHeight);

    const onResize = () => {
      const isKeyboardOpen = vv.height < fullHeightRef.current * 0.85;
      if (isKeyboardOpen) {
        setViewportHeight(vv.height);
      } else {
        setViewportHeight(null);
        requestAnimationFrame(() => {
          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
        });
      }
    };
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
      window.removeEventListener('resize', trackFullHeight);
    };
  }, [isMobile]);

  // Electron detection (constant per session)
  const isElectron = !!(window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI?.isElectron;

  // Show/hide macOS traffic lights with Topics dropdown
  useEffect(() => {
    if (!isElectron) return;
    const api = (window as unknown as { electronAPI?: { window?: { showTrafficLights?: () => void; hideTrafficLights?: () => void } } }).electronAPI?.window;
    if (showTopicsMenu) {
      api?.showTrafficLights?.();
    } else {
      api?.hideTrafficLights?.();
    }
  }, [showTopicsMenu, isElectron]);

  // App settings + cross-tab sync
  const [appSettings, setAppSettings] = useState<AppSettings>(loadSettings);
  useStorageSync('app-settings', useCallback((newSettings: AppSettings) => {
    if (newSettings) setAppSettings(newSettings);
  }, []));

  // Sidebar width / collapsed — collapsed by default in detached + mobile
  const [sidebarWidth, setSidebarWidth] = useState(() => appSettings.sidebarWidth || 256);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return isDetached || isMobile ? true : (appSettings.sidebarCollapsed || false);
  });

  // Remove pre-render sidebar-collapsed class now that React owns the state
  useEffect(() => {
    document.documentElement.classList.remove('sidebar-pre-collapsed');
  }, []);

  // Auto-collapse sidebar on mobile
  useEffect(() => {
    if (isMobile && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mirror original deps
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

  // Mobile swipe-from-left-edge to open sidebar
  const edgeTouchStartX = useRef<number | null>(null);
  const handleEdgeTouchStart = useCallback((e: React.TouchEvent) => {
    if (sidebarCollapsed && e.touches[0].clientX < 30) {
      edgeTouchStartX.current = e.touches[0].clientX;
    }
  }, [sidebarCollapsed]);
  const handleEdgeTouchEnd = useCallback((e: React.TouchEvent) => {
    if (edgeTouchStartX.current !== null) {
      const delta = e.changedTouches[0].clientX - edgeTouchStartX.current;
      if (delta > 60) {
        setSidebarCollapsed(false);
      }
      edgeTouchStartX.current = null;
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
      if (sidebarRef.current) {
        sidebarRef.current.style.transition = '';
      }
      const delta = e.clientX - sidebarStartX.current;
      const finalWidth = Math.max(180, Math.min(400, sidebarStartWidth.current + delta));
      const collapsed = finalWidth <= 180 && delta < -20;
      setSidebarWidth(collapsed ? 180 : finalWidth);
      setSidebarCollapsed(collapsed);
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

  return {
    state: {
      appSettings,
      sidebarWidth,
      sidebarCollapsed,
      isMobile,
      isPWA,
      viewportHeight,
      isElectron,
      windowId,
    },
    refs: { sidebarRef },
    handlers: {
      toggleSidebar,
      handleSidebarResizeStart,
      handleSidebarDoubleClick,
      handleSidebarTouchStart,
      handleSidebarTouchEnd,
      handleEdgeTouchStart,
      handleEdgeTouchEnd,
      setSidebarCollapsed,
      setAppSettings,
    },
  };
}
