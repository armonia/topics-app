/**
 * Phase 30 BROWSER-CHAT-04 — placeholder for the select-element overlay.
 * Full implementation lives here in Task 6.
 */
import { useEffect, useState, useCallback, useRef } from 'react';

export interface SelectElementOverlayProps {
  contextId: string;
  active: boolean;
  /** The displayed streaming surface to map clicks against. Since the WebRTC
   *  migration this is the <video> (the JPEG <img> was removed); a plain <img>
   *  is still accepted for any legacy caller. Same letterbox/aspect math. */
  surfaceRef: React.RefObject<HTMLImageElement | HTMLVideoElement | null>;
  pageScaleFactor: number;
  onPick: (element: {
    path: string;
    cssPath: string;
    bbox: { x: number; y: number; w: number; h: number };
    text?: string;
  }) => void;
  onCancel: () => void;
}

/** Intrinsic frame size of the display surface — <img> (naturalWidth) or the
 *  WebRTC <video> (videoWidth). Falls back to the 1280×720 viewport basis. */
function surfaceIntrinsic(el: HTMLImageElement | HTMLVideoElement): { w: number; h: number } {
  const img = el as HTMLImageElement;
  const vid = el as HTMLVideoElement;
  return { w: img.naturalWidth || vid.videoWidth || 1280, h: img.naturalHeight || vid.videoHeight || 720 };
}

export function SelectElementOverlay({
  contextId,
  active,
  surfaceRef,
  pageScaleFactor,
  onPick,
  onCancel,
}: SelectElementOverlayProps) {
  const [hoverBox, setHoverBox] = useState<{ left: number; top: number; w: number; h: number } | null>(null);
  const lastFetchRef = useRef<number>(0);

  // Map screenshot client coords -> page coords (devicePixelRatio scaled).
  const mapCoordsToPage = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const img = surfaceRef.current;
      if (!img) return null;
      const rect = img.getBoundingClientRect();
      const { w: naturalW, h: naturalH } = surfaceIntrinsic(img);
      const imgAspect = naturalW / naturalH;
      const containerAspect = rect.width / rect.height;
      let displayW: number;
      let displayH: number;
      let offsetX: number;
      let offsetY: number;
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
      const localX = clientX - rect.left - offsetX;
      const localY = clientY - rect.top - offsetY;
      if (localX < 0 || localX > displayW || localY < 0 || localY > displayH) return null;
      const scale = pageScaleFactor || 1;
      return {
        x: Math.round(((localX / displayW) * naturalW) / scale),
        y: Math.round(((localY / displayH) * naturalH) / scale),
      };
    },
    [surfaceRef, pageScaleFactor],
  );

  // Map page bbox -> overlay client coords (inverse of mapCoordsToPage on bbox).
  const pageBboxToClient = useCallback(
    (bbox: { x: number; y: number; w: number; h: number }) => {
      const img = surfaceRef.current;
      if (!img) return null;
      const rect = img.getBoundingClientRect();
      const { w: naturalW, h: naturalH } = surfaceIntrinsic(img);
      const imgAspect = naturalW / naturalH;
      const containerAspect = rect.width / rect.height;
      let displayW: number;
      let displayH: number;
      let offsetX: number;
      let offsetY: number;
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
      const scale = pageScaleFactor || 1;
      return {
        left: rect.left + offsetX + (bbox.x * scale * displayW) / naturalW,
        top: rect.top + offsetY + (bbox.y * scale * displayH) / naturalH,
        w: (bbox.w * scale * displayW) / naturalW,
        h: (bbox.h * scale * displayH) / naturalH,
      };
    },
    [surfaceRef, pageScaleFactor],
  );

  // Debounced inspect on mousemove (max 1 fetch per 100ms) so the user gets
  // continuous highlight feedback without hammering the server.
  const handleMouseMove = useCallback(
    async (e: React.MouseEvent) => {
      if (!active) return;
      const now = Date.now();
      if (now - lastFetchRef.current < 100) return;
      lastFetchRef.current = now;
      const coords = mapCoordsToPage(e.clientX, e.clientY);
      if (!coords) return;
      try {
        const res = await fetch(`/api/browsers/${encodeURIComponent(contextId)}/inspect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(coords),
        });
        if (!res.ok) return;
        const info = await res.json();
        if (!info?.bbox) return;
        const client = pageBboxToClient(info.bbox);
        if (client) setHoverBox(client);
      } catch {
        // Ignore — next mousemove retries.
      }
    },
    [active, contextId, mapCoordsToPage, pageBboxToClient],
  );

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
      const coords = mapCoordsToPage(e.clientX, e.clientY);
      if (!coords) return;
      try {
        const res = await fetch(`/api/browsers/${encodeURIComponent(contextId)}/inspect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(coords),
        });
        if (!res.ok) return;
        const info = await res.json();
        if (info?.bbox) {
          // Phase 30 BROWSER-CHAT-04 — dispatch chat:insert-text so any chat
          // input wired to listen receives the picked element as a context
          // message. Loosely coupled (no prop drilling). Parent's onPick can
          // also subscribe to selectedElement state via the hook.
          const text = `Selected element: ${info.cssPath} @ ${info.path} (bbox: ${info.bbox.x},${info.bbox.y},${info.bbox.w},${info.bbox.h})${info.text ? ` text: "${info.text}"` : ''}`;
          window.dispatchEvent(new CustomEvent('chat:insert-text', { detail: { text } }));
          onPick(info);
        }
      } catch {
        // Ignore — user can retry.
      }
    },
    [active, contextId, mapCoordsToPage, onPick],
  );

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onCancel]);

  if (!active) return null;
  return (
    <>
      <div
        className="absolute inset-0 z-40 cursor-crosshair"
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        data-testid="browser-select-element-overlay"
      />
      {hoverBox && (
        <div
          className="fixed z-50 pointer-events-none border-2 border-primary bg-primary/10"
          style={{ left: hoverBox.left, top: hoverBox.top, width: hoverBox.w, height: hoverBox.h }}
          data-testid="browser-select-element-highlight"
        />
      )}
      <div className="absolute top-2 left-2 z-50 px-3 py-1.5 bg-primary text-white text-[11px] rounded-md shadow-md pointer-events-none">
        Select Element — Esc to cancel
      </div>
    </>
  );
}
