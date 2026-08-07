/**
 * useSidebarAndLayout — owns layout chrome + sidebar resize protocol +
 * cross-tab settings sync + traffic-light visibility + viewport tracking.
 *
 * Extracted from App.tsx during Phase 3 (hook 1 of 4).
 *
 * Owns (every line moved out of App):
 *  - windowId, isMobile, isPWA, viewportHeight
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

import { useCallback, useEffect, useRef, useState, startTransition, type Dispatch, type SetStateAction } from 'react';
import type { AppSettings } from '../types';
import { useMobile } from './useMobile';
import { useStorageSync } from './useStorageSync';
import { loadSettings, saveSettings, SETTINGS_CHANGED_EVENT } from '../lib/settings';
import { generateUUID } from '../utils/uuid';
import { DRAG_SLOP_PX } from './useGridResize';
import { isDesktop } from '../lib/shell';
import { showTrafficLights, hideTrafficLights } from '../lib/shell/window';
import { usePaneStore } from '../state/pane/store';
import { hasVisiblePane } from '../state/pane/selectors';

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
    viewportTop: number;
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

  // Mobile keyboard: adjust app height when virtual keyboard opens.
  // `viewportTop` mirrors visualViewport.offsetTop: iOS ignores
  // `interactive-widget` and PANS the page when the keyboard would cover the
  // focused input, so the visual viewport starts below y=0 — a fixed top:0
  // container that only shrinks its height leaves the chat input stranded
  // under the keyboard. Tracking the offset keeps the app glued to the
  // VISIBLE area on both engines (Android overlays-content keeps offset 0).
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [viewportTop, setViewportTop] = useState(0);
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
        setViewportTop(vv.offsetTop);
      } else {
        setViewportHeight(null);
        setViewportTop(0);
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

  // Show/hide macOS traffic lights with Topics dropdown (Electron + Tauri).
  useEffect(() => {
    if (!isDesktop) return;
    if (showTopicsMenu) {
      showTrafficLights();
    } else {
      hideTrafficLights();
    }
  }, [showTopicsMenu]);

  // App settings + cross-tab sync
  const [appSettings, setAppSettings] = useState<AppSettings>(loadSettings);
  useStorageSync('app-settings', useCallback((newSettings: AppSettings) => {
    if (newSettings) setAppSettings(newSettings);
  }, []));
  // Stessa tab: l'idratazione dal server (useSettingsSync) scrive localStorage,
  // che NON emette un evento `storage` a chi l'ha scritto. Senza questo, il
  // valore arrivato dal server restava invisibile fino al reload successivo.
  useEffect(() => {
    const reload = () => setAppSettings(loadSettings());
    window.addEventListener(SETTINGS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(SETTINGS_CHANGED_EVENT, reload);
  }, []);

  // Sidebar width / collapsed — collapsed by default in detached + mobile
  const [sidebarWidth, setSidebarWidth] = useState(() => appSettings.sidebarWidth || 256);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (isDetached) return true;
    // SUL TELEFONO SI PARTE DOVE C'È QUALCOSA.
    //
    // «Appena apro Topics dovrei aprire l'ultima tab che ho lasciato aperta. Se
    // no, di default dovrei trovarmi sulla sidebar» (Attilio, 07/08). Prima il
    // cassetto partiva SEMPRE chiuso: con almeno una tab la regola era già
    // giusta per caso, ma a zero tab l'app si apriva su una schermata vuota con
    // l'unica lista di cose nascosta dietro uno swipe. Lo stato della griglia è
    // già idratato da localStorage quando questo initializer gira (bootstrap
    // chiama `hydrateFromLocalSnapshot` prima del primo render), quindi la
    // risposta è disponibile subito e senza un lampo di layout.
    if (isMobile) return hasVisiblePane(usePaneStore.getState());
    return appSettings.sidebarCollapsed || false;
  });

  // Remove pre-render sidebar-collapsed class now that React owns the state
  useEffect(() => {
    document.documentElement.classList.remove('sidebar-pre-collapsed');
  }, []);

  // Il cassetto si chiude quando la finestra SCENDE sotto il breakpoint, non a
  // ogni montaggio: com'era scritto prima (un effetto su `[isMobile]`) scattava
  // anche al primo giro e richiudeva subito la sidebar che l'initializer qui
  // sopra aveva appena deciso di lasciare aperta.
  //
  // È un aggiustamento IN RESA, non un effetto: React lo prescrive proprio per
  // «uno stato che deve cambiare quando ne cambia un altro» — riparte subito,
  // senza dipingere il fotogramma intermedio, e senza la cascata che un
  // `setState` dentro un effetto produce (regola `set-state-in-effect`).
  const [wasMobile, setWasMobile] = useState(isMobile);
  if (isMobile !== wasMobile) {
    setWasMobile(isMobile);
    if (isMobile) setSidebarCollapsed(true);
  }

  const sidebarResizing = useRef(false);
  const sidebarStartX = useRef(0);
  const sidebarStartWidth = useRef(0);
  const sidebarRef = useRef<HTMLDivElement>(null);
  // Full-viewport drag chrome, raised lazily on the first move beyond slop —
  // same protocol as useGridResize (keeps the pointer out of iframes, lets
  // native Electron WebContentsView panes hide via pane-resize-start/end).
  const sidebarDragOverlay = useRef<HTMLDivElement | null>(null);

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
    // Hide native browser views NOW, not lazily on the first past-slop
    // mousemove: a native WKWebView/WebContentsView adjacent to the divider
    // swallows the pointer, so dragging RIGHT (widening) never delivers the
    // mousemove that would have raised the overlay — the drag froze on the
    // first pixel. Dispatching on mousedown mirrors what SplitTree dividers
    // do on dragstart; the matching '-end' fires in onUp. (A bare click or
    // double-click briefly hides the panes — acceptable for a narrow strip.)
    window.dispatchEvent(new Event('topics:pane-resize-start'));
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
    const dropChrome = () => {
      if (sidebarDragOverlay.current) {
        sidebarDragOverlay.current.remove();
        sidebarDragOverlay.current = null;
      }
    };
    const onMove = (e: MouseEvent) => {
      if (!sidebarResizing.current) return;
      // Lost-mouseup recovery: button no longer down — end the drag instead
      // of leaving the overlay armed and the resize tracking the pointer.
      if ((e.buttons & 1) === 0) { onUp(e); return; }
      const delta = e.clientX - sidebarStartX.current;
      // Sub-slop jitter is still a click in progress — raising the overlay
      // here would retarget the mouseup and kill double-click → collapse.
      if (!sidebarDragOverlay.current && Math.abs(delta) <= DRAG_SLOP_PX) return;
      if (!sidebarDragOverlay.current) {
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:col-resize';
        document.body.appendChild(ov);
        sidebarDragOverlay.current = ov;
        // pane-resize-start already fired on mousedown (native views hidden).
      }
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
      dropChrome();
      // Balance the mousedown's pane-resize-start (native views restore).
      window.dispatchEvent(new Event('topics:pane-resize-end'));
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
      // Unmount mid-drag: balance the pane-resize-start already dispatched.
      sidebarResizing.current = false;
      dropChrome();
    };
  }, [isDetached]);

  const toggleSidebar = useCallback(() => {
    // Mark the toggle as a transition. In overlay mode the sidebar slide is a pure
    // composited translateX, but flipping `sidebarCollapsed` (and persisting it via
    // setAppSettings) re-renders the whole un-memoized pane tree — wasted work whose
    // output is identical, yet a ~20-38ms blocking frame at the click with 30+ panes.
    // startTransition lets React time-slice that re-render across frames so the click
    // frame stays under budget; the CSS slide still begins immediately.
    startTransition(() => {
      setSidebarCollapsed(prev => {
        const newVal = !prev;
        if (!isDetached) {
          const newSettings = { ...appSettings, sidebarCollapsed: newVal };
          saveSettings(newSettings);
          setAppSettings(newSettings);
        }
        return newVal;
      });
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
      viewportTop,
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
