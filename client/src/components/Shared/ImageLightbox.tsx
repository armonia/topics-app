import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useT } from '../../hooks/useT';
import { MODAL_LAYER } from '../../lib/modalStyles';

/**
 * ONE LIGHTBOX FOR EVERY IMAGE THE APP LETS YOU CLICK.
 *
 * It was born in the chat (`MessageContent`, a message's media) and stayed
 * there, so the other places where an image is shown small had each their own
 * answer to a click, and two of them had none: a screenshot attached to a
 * task in the floating composer did nothing when clicked, the same one in the
 * task's thread opened a workspace tab if the drawer happened to have one.
 * Reported on 03/09 (card 058ea722): "I attached to the task, and it does not
 * show me the preview when I click on it. It should be consistent across all
 * the AI inputs". So the lightbox is a shared component, and `ZoomableImage`
 * is the one thumbnail that opens it: the chat composer, the task composer,
 * the task drawer's own composer and its thread all draw that.
 *
 * Pinch, drag and double-tap zoom are what the chat had; nothing was removed.
 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  // Escape closes. It did not: the only ways out were the x and a click on
  // the veil, and worse, Escape fell through to the global handler and
  // INTERRUPTED the AI turn behind the image (the lightbox carried no modal
  // marker, so `hasOpenModalSurface` could not see it). `role="dialog"` below
  // makes it visible to that gate.
  const tr = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  useModalDialog({ onClose, panelRef });
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchMid = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);
  const lastSingleTouch = useRef<{ x: number; y: number } | null>(null);

  const getTouchDist = (t: React.TouchList) =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      lastTouchDist.current = getTouchDist(e.touches);
      lastTouchMid.current = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    } else if (e.touches.length === 1 && scale > 1) {
      isDragging.current = true;
      lastSingleTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (e.touches.length === 2 && lastTouchDist.current !== null) {
      const newDist = getTouchDist(e.touches);
      const ratio = newDist / lastTouchDist.current;
      setScale(s => Math.min(Math.max(s * ratio, 1), 5));
      lastTouchDist.current = newDist;
    } else if (e.touches.length === 1 && isDragging.current && lastSingleTouch.current) {
      const dx = e.touches[0].clientX - lastSingleTouch.current.x;
      const dy = e.touches[0].clientY - lastSingleTouch.current.y;
      setOffset(o => ({ x: o.x + dx, y: o.y + dy }));
      lastSingleTouch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchEnd = () => {
    lastTouchDist.current = null;
    lastTouchMid.current = null;
    isDragging.current = false;
    lastSingleTouch.current = null;
    if (scale < 1.05) { setScale(1); setOffset({ x: 0, y: 0 }); }
  };

  const handleBackdropClick = () => {
    if (scale > 1) { setScale(1); setOffset({ x: 0, y: 0 }); }
    else onClose();
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Immagine'}
      data-testid="image-lightbox"
      // `MODAL_LAYER` and not `z-[9999]`: 9999 is not "above the popovers",
      // it is the SAME plane (Z_POPOVER / Z_CONTEXT_MENU). At equal z the DOM
      // order decides, and both are portals on `<body>`: the lightbox sat on
      // top by luck, not by contract. The constant puts it at 10000, where
      // modals are by definition.
      className={`fixed inset-0 bg-black/90 ${MODAL_LAYER} flex items-center justify-center overflow-hidden`}
      style={{ touchAction: 'none' }}
      onClick={handleBackdropClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-full max-h-full object-contain rounded-lg select-none"
        style={{ transform: `scale(${scale}) translate(${offset.x / scale}px, ${offset.y / scale}px)`, transformOrigin: 'center', transition: scale === 1 ? 'transform 0.2s' : 'none', cursor: scale > 1 ? 'grab' : 'zoom-in' }}
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
      <button
        data-testid="lightbox-close"
        aria-label={tr('common.close')}
        className="absolute top-4 right-4 text-white bg-black/50 rounded-full w-10 h-10 flex items-center justify-center"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
      ><X className="w-5 h-5" aria-hidden="true" /></button>
      {scale > 1 && (
        <button
          className="absolute bottom-8 left-1/2 -translate-x-1/2 text-white text-xs bg-black/50 rounded-full px-3 py-1"
          onClick={(e) => { e.stopPropagation(); setScale(1); setOffset({ x: 0, y: 0 }); }}
        >{tr('common.resetZoom')}</button>
      )}
    </div>,
    document.body
  );
}


/**
 * A small image that opens big on click. The thumbnail keeps whatever box its
 * host gives it (`className`); the click is the only thing added, plus the
 * cursor and the keyboard path that say it is one.
 */
export function ZoomableImage({ src, alt, className = '', title, testId }: {
  src: string;
  alt: string;
  className?: string;
  title?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        data-testid={testId}
        src={src}
        alt={alt}
        title={title}
        loading="lazy"
        draggable={false}
        role="button"
        tabIndex={0}
        className={`cursor-zoom-in transition-opacity hover:opacity-90 ${className}`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
      />
      {open && <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
