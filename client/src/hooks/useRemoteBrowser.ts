import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

interface RemoteBrowserState {
  url: string;
  title: string;
  loading: boolean;
  connected: boolean;
  screenshotSrc: string | null;
  error: string | null;
}

interface InteractionHandlers {
  onClick: (e: React.MouseEvent<HTMLImageElement>) => void;
  onWheel: (e: React.WheelEvent<HTMLImageElement>) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

interface RemoteBrowser extends RemoteBrowserState, InteractionHandlers {
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  goHome: () => void;
  imgRef: React.RefObject<HTMLImageElement | null>;
}

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 720;

const IDLE_INTERVAL = 2000;
const ACTIVE_INTERVAL = 300;
const ACTIVE_DURATION = 3000;

const SPECIAL_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

function mapCoordinates(
  e: React.MouseEvent<HTMLImageElement>,
  img: HTMLImageElement,
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  const naturalW = img.naturalWidth || VIEWPORT_WIDTH;
  const naturalH = img.naturalHeight || VIEWPORT_HEIGHT;
  const imgAspect = naturalW / naturalH;
  const containerAspect = rect.width / rect.height;

  let displayW: number, displayH: number, offsetX: number, offsetY: number;

  if (containerAspect > imgAspect) {
    displayH = rect.height;
    displayW = displayH * imgAspect;
    offsetX = (rect.width - displayW) / 2;
    offsetY = 0;
  } else {
    displayW = rect.width;
    displayH = displayW / imgAspect;
    offsetX = 0;
    offsetY = (rect.height - displayH) / 2;
  }

  const localX = e.clientX - rect.left - offsetX;
  const localY = e.clientY - rect.top - offsetY;

  if (localX < 0 || localX > displayW || localY < 0 || localY > displayH) {
    return null;
  }

  return {
    x: Math.round((localX / displayW) * naturalW),
    y: Math.round((localY / displayH) * naturalH),
  };
}

export function useRemoteBrowser(contextId: string): RemoteBrowser {
  const encodedId = useMemo(() => encodeURIComponent(contextId), [contextId]);
  const [state, setState] = useState<RemoteBrowserState>({
    url: '',
    title: '',
    loading: false,
    connected: false,
    screenshotSrc: null,
    error: null,
  });

  const imgRef = useRef<HTMLImageElement | null>(null);
  const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeUntilRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const connectedRef = useRef(false); // tracks connected without re-creating callbacks
  const typeBufRef = useRef<string>('');
  const typeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollRef = useRef<number>(0);

  const markActive = useCallback(() => {
    activeUntilRef.current = Date.now() + ACTIVE_DURATION;
  }, []);

  // Send interaction to server (interact endpoints do getOrCreate)
  const interact = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/browsers/${encodedId}/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        connectedRef.current = true;
        setState(s => ({ ...s, connected: true, error: null }));
      }
    } catch {
      // Silently fail — info poll will detect disconnect
    }
  }, [encodedId]);

  // Fetch screenshot — only call when context exists (connected)
  const fetchScreenshot = useCallback(() => {
    if (!mountedRef.current) return;
    const preload = new Image();
    preload.onload = () => {
      if (!mountedRef.current) return;
      setState(s => ({ ...s, screenshotSrc: preload.src }));
    };
    preload.onerror = () => {
      // Don't clear existing screenshot on transient errors
    };
    preload.src = `/api/browsers/${encodedId}/snapshot?t=${Date.now()}`;
  }, [encodedId]);

  // Check if context exists (GET info — does NOT create)
  const fetchInfo = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/browsers/${encodedId}`);
      if (!mountedRef.current) return false;
      if (res.ok) {
        const data = await res.json();
        connectedRef.current = true;
        setState(s => ({
          ...s,
          url: data.url || s.url,
          title: data.title || s.title,
          connected: true,
          loading: false,
        }));
        return true;
      } else if (res.status === 404) {
        connectedRef.current = false;
        setState(s => ({ ...s, connected: false }));
        return false;
      }
    } catch {
      if (mountedRef.current) {
        connectedRef.current = false;
        setState(s => ({ ...s, connected: false }));
      }
    }
    return false;
  }, [encodedId]);

  // Polling loop — only fetch screenshots when context exists
  useEffect(() => {
    mountedRef.current = true;
    connectedRef.current = false;

    const poll = async () => {
      if (!mountedRef.current) return;

      const exists = await fetchInfo();
      // Only fetch screenshot if context exists on server
      // This avoids triggering getOrCreate on the snapshot endpoint
      if (exists) {
        fetchScreenshot();
      }

      const isActive = Date.now() < activeUntilRef.current;
      const interval = isActive ? ACTIVE_INTERVAL : IDLE_INTERVAL;
      pollingRef.current = setTimeout(poll, interval);
    };

    // Initial check
    poll();

    return () => {
      mountedRef.current = false;
      if (pollingRef.current) clearTimeout(pollingRef.current);
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
    };
  }, [contextId, fetchScreenshot, fetchInfo]);

  // --- Interaction handlers ---

  const navigate = useCallback((url: string) => {
    setState(s => ({ ...s, loading: true, url }));
    markActive();
    // interact does getOrCreate — this is intentional for navigate
    interact({ action: 'navigate', url }).then(() => {
      // After navigate completes, immediately fetch screenshot + info
      fetchScreenshot();
      fetchInfo();
    });
  }, [interact, markActive, fetchScreenshot, fetchInfo]);

  const goBack = useCallback(() => {
    if (!connectedRef.current) return;
    markActive();
    interact({ action: 'back' }).then(() => { fetchScreenshot(); fetchInfo(); });
  }, [interact, markActive, fetchScreenshot, fetchInfo]);

  const goForward = useCallback(() => {
    if (!connectedRef.current) return;
    markActive();
    interact({ action: 'forward' }).then(() => { fetchScreenshot(); fetchInfo(); });
  }, [interact, markActive, fetchScreenshot, fetchInfo]);

  const reload = useCallback(() => {
    if (!connectedRef.current) return;
    setState(s => ({ ...s, loading: true }));
    markActive();
    interact({ action: 'reload' }).then(() => { fetchScreenshot(); fetchInfo(); });
  }, [interact, markActive, fetchScreenshot, fetchInfo]);

  const goHome = useCallback(() => {
    navigate('about:blank');
  }, [navigate]);

  const onClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!connectedRef.current) return;
    const img = e.currentTarget;
    const coords = mapCoordinates(e, img);
    if (!coords) return;
    markActive();
    interact({ action: 'click', x: coords.x, y: coords.y }).then(fetchScreenshot);
  }, [interact, markActive, fetchScreenshot]);

  const onWheel = useCallback((e: React.WheelEvent<HTMLImageElement>) => {
    if (!connectedRef.current) return;
    const now = Date.now();
    if (now - lastScrollRef.current < 100) return;
    lastScrollRef.current = now;

    const img = e.currentTarget;
    const coords = mapCoordinates(e as unknown as React.MouseEvent<HTMLImageElement>, img);
    if (!coords) return;

    markActive();
    interact({
      action: 'scroll',
      x: coords.x,
      y: coords.y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
    });
  }, [interact, markActive]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!connectedRef.current) return;
    if (e.metaKey || e.ctrlKey) return;

    e.preventDefault();
    e.stopPropagation();
    markActive();

    if (SPECIAL_KEYS.has(e.key)) {
      if (typeBufRef.current) {
        interact({ action: 'type', text: typeBufRef.current });
        typeBufRef.current = '';
        if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      }
      interact({ action: 'keypress', key: e.key }).then(fetchScreenshot);
    } else if (e.key.length === 1) {
      typeBufRef.current += e.key;
      if (typeTimerRef.current) clearTimeout(typeTimerRef.current);
      typeTimerRef.current = setTimeout(() => {
        if (typeBufRef.current) {
          interact({ action: 'type', text: typeBufRef.current }).then(fetchScreenshot);
          typeBufRef.current = '';
        }
      }, 50);
    }
  }, [interact, markActive, fetchScreenshot]);

  return useMemo(() => ({
    ...state,
    navigate,
    goBack,
    goForward,
    reload,
    goHome,
    onClick,
    onWheel,
    onKeyDown,
    imgRef,
  }), [state, navigate, goBack, goForward, reload, goHome, onClick, onWheel, onKeyDown]);
}
