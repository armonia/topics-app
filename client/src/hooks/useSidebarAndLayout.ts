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
import { mediaQueryMatches } from '../lib/mediaQuery';

/**
 * Il cassetto del TELEFONO: aperto o chiuso, ricordato per dispositivo.
 *
 * Chiave propria e non `appSettings.sidebarCollapsed`: quelle viaggiano fra i
 * dispositivi, e qui si sta ricordando dove eravamo su QUESTO schermo — dove
 * per giunta «chiuso» vuol dire una cosa diversa (un cassetto che copre tutto,
 * non una colonna che si stringe).
 */
const MOBILE_DRAWER_KEY = 'topics-mobile-drawer-collapsed';

function readMobileDrawerCollapsed(): boolean | null {
  try {
    const raw = localStorage.getItem(MOBILE_DRAWER_KEY);
    // `null` = non l'abbiamo mai scritto, ed è DIVERSO da «chiuso»: chi legge
    // deve poter distinguere «non lo so» da «era chiuso» per ricadere sul
    // contenuto solo la prima volta.
    return raw === null ? null : raw === '1';
  } catch { return null; }
}

function writeMobileDrawerCollapsed(collapsed: boolean): void {
  try { localStorage.setItem(MOBILE_DRAWER_KEY, collapsed ? '1' : '0'); } catch { /* quota / private mode */ }
}

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
    mediaQueryMatches('(display-mode: standalone)') ||
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
    // SUL TELEFONO SI RIAPRE DOVE ERAVAMO, non dove il contenuto suggerisce.
    //
    // Prima passata (07/08): «se non c'è niente da riaprire, trovarmi sulla
    // sidebar» — e lo decideva `hasVisiblePane`, cioè il CONTENUTO. Sbagliato,
    // e Attilio l'ha visto subito: «se chiudo l'app PWA mentre è sulla sidebar
    // e la riapro, mi apre le tab aperte». Certo: con delle tab aperte quella
    // regola risponde sempre «chiudi», qualunque cosa stessi guardando. Una PWA
    // su iOS viene terminata dal sistema di continuo, quindi «chiudere e
    // riaprire» è la cosa che succede più spesso di tutte — e ogni volta ti
    // riportava altrove.
    //
    // Lo stato del cassetto è un POSTO IN CUI SEI, e va ricordato come tale.
    // Chiave device-local e non `appSettings`: quelle si sincronizzano fra
    // dispositivi, e il cassetto del telefono non ha niente da dire alla
    // finestra del Mac (dove per giunta «chiuso» significa un'altra cosa).
    // `hasVisiblePane` resta, ma solo come PRIMA VOLTA: al primissimo avvio non
    // c'è nessun posto da ricordare, e allora sì che decide il contenuto.
    if (isMobile) {
      const saved = readMobileDrawerCollapsed();
      return saved ?? hasVisiblePane(usePaneStore.getState());
    }
    return appSettings.sidebarCollapsed || false;
  });

  // Si scrive a ogni cambio, in modo sincrono: una PWA che il sistema termina
  // non riceve nessun `beforeunload`, quindi rimandare la scrittura a un
  // «prima di chiudere» vorrebbe dire non scriverla quasi mai.
  useEffect(() => {
    if (!isMobile || isDetached) return;
    writeMobileDrawerCollapsed(sidebarCollapsed);
  }, [isMobile, isDetached, sidebarCollapsed]);

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

  /**
   * LA LARGHEZZA DA APERTA, ricordata a parte dallo stato «chiusa».
   *
   * Chiudere la colonna TRASCINANDO il bordo fino in fondo scriveva — e
   * persisteva — `sidebarWidth: 180`, cioè il minimo del trascinamento; e
   * riaprire (bottone, doppio clic, swipe dal bordo) rimette solo
   * `sidebarCollapsed`, mai la larghezza. Risultato: chi stava a 320 e chiudeva
   * trascinando riapriva a 180 PER SEMPRE — senza aver mai chiesto una colonna
   * stretta: aveva chiesto di chiuderla.
   *
   * Sono due fatti diversi e stanno in due posti diversi: `sidebarWidth` è
   * quanto la colonna misura ADESSO, `sidebarWidthExpanded` è la misura scelta
   * a mano, quella a cui la riapertura torna. Il ref è la copia che legge il
   * gestore del mouse, che vive in un effetto montato una volta sola e di uno
   * stato vedrebbe il valore del primo giro.
   */
  const sidebarExpandedWidth = useRef(appSettings.sidebarWidthExpanded ?? sidebarWidth);
  useEffect(() => {
    if (!sidebarCollapsed) sidebarExpandedWidth.current = sidebarWidth;
  }, [sidebarCollapsed, sidebarWidth]);

  /**
   * RIAPRIRE LA RIMETTE DOV'ERA — e la regola sta in UN posto.
   *
   * Le porte che riaprono la colonna sono tre (il bottone, il doppio clic sul
   * bordo, lo swipe dal bordo su touch), e nessuna di esse ha a che fare con la
   * larghezza: ripetere il ripristino in tutte e tre vorrebbe dire un
   * invariante vero finché tutte e tre se lo ricordano — che è la forma in cui
   * si rompono. Qui reagisce alla TRANSIZIONE chiusa→aperta, qualunque porta
   * l'abbia prodotta.
   *
   * È un aggiustamento IN RESA e non un effetto: React lo prescrive per «uno
   * stato che deve cambiare quando ne cambia un altro» — riparte subito, senza
   * dipingere il fotogramma alla larghezza sbagliata (vedi `wasMobile` sopra).
   *
   * La misura si legge da `appSettings` e NON dal ref qui sopra: un ref è un
   * valore che la resa non deve guardare — non fa ripartire niente quando
   * cambia, e leggerlo qui è proprio il caso che la regola `react-hooks/refs`
   * vieta. Il ref serve al gestore del mouse (che vive fuori dalla resa e di
   * uno stato vedrebbe il valore stantio del primo giro); qui vale lo stato,
   * che `onUp` aggiorna nello stesso batch in cui chiude la colonna.
   */
  const [wasCollapsed, setWasCollapsed] = useState(sidebarCollapsed);
  if (sidebarCollapsed !== wasCollapsed) {
    setWasCollapsed(sidebarCollapsed);
    const target = appSettings.sidebarWidthExpanded ?? 0;
    // In finestra staccata non si persiste niente, quindi `appSettings` non
    // descrive QUESTA finestra: ripristinare da lì imporrebbe la larghezza di
    // un'altra. Lì la colonna resta dov'è.
    if (!sidebarCollapsed && !isDetached && target > 0 && target !== sidebarWidth) setSidebarWidth(target);
  }

  const sidebarResizing = useRef(false);
  const sidebarStartX = useRef(0);
  const sidebarStartWidth = useRef(0);
  const sidebarRef = useRef<HTMLDivElement>(null);
  // Full-viewport drag chrome, raised lazily on the first move beyond slop —
  // same protocol as useGridResize (keeps the pointer out of iframes, lets
  // native Electron WebContentsView panes hide via pane-resize-start/end).
  const sidebarDragOverlay = useRef<HTMLDivElement | null>(null);

  // IL GESTO DEL CASSETTO NON STA PIÙ QUI: sta in `useSidebarSwipe`, che lo
  // tratta come un trascinamento (la colonna segue il dito) invece che come una
  // soglia letta a dito già staccato. Qui restava solo il pezzo di stato che
  // quel gesto muove — `setSidebarCollapsed`, che infatti è già esposto.
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
      // Chiudere NON cancella la misura scelta a mano: `finalWidth` è 180
      // perché quello è il minimo del trascinamento, non perché qualcuno voglia
      // una colonna stretta. La larghezza da aperta resta com'era e viene
      // persistita a parte — è quella che la riapertura ripristina.
      const expanded = collapsed ? (sidebarExpandedWidth.current || finalWidth) : finalWidth;
      sidebarExpandedWidth.current = expanded;
      setSidebarWidth(finalWidth);
      setSidebarCollapsed(collapsed);
      if (!isDetached) {
        const newSettings = {
          ...loadSettings(),
          sidebarWidth: finalWidth,
          sidebarCollapsed: collapsed,
          sidebarWidthExpanded: expanded,
        };
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
      setSidebarCollapsed,
      setAppSettings,
    },
  };
}
