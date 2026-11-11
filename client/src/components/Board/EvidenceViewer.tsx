import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useExitGhost } from '../../lib/exitGhost';
import { MODAL_LAYER } from '../../lib/modalStyles';
import { getMediaUrl } from '../../lib/api';
import { isVideoPath } from '../../lib/mediaKind';
import type { EvidenceSlide } from './taskMedia';

const MAX_SCALE = 8;

/** Before/after on ONE frame: a divider the pointer (or a finger) drags. */
function CompareFrame({ slide }: { slide: Extract<EvidenceSlide, { kind: 'pair' | 'sideBySide' }> }) {
  const tr = useT();
  const [pos, setPos] = useState(50);
  const [ratio, setRatio] = useState(16 / 9);
  const frameRef = useRef<HTMLDivElement>(null);
  const move = useCallback((clientX: number) => {
    const el = frameRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)));
  }, []);
  const half = slide.kind === 'sideBySide';
  const beforeSrc = getMediaUrl(slide.kind === 'pair' ? slide.before : slide.path);
  const afterSrc = getMediaUrl(slide.kind === 'pair' ? slide.after : slide.path);
  // A composite holds both halves in one bitmap: each layer shows its own half
  // by doubling the image width and shifting it.
  const layer = (src: string, side: 'before' | 'after') => (
    <img
      src={src}
      alt=""
      draggable={false}
      className={half ? 'absolute top-0 h-full max-w-none' : 'absolute inset-0 h-full w-full object-contain'}
      style={half ? { width: '200%', left: side === 'before' ? 0 : '-100%' } : undefined}
    />
  );
  return (
    <div
      ref={frameRef}
      data-testid="evidence-compare"
      className="relative select-none touch-none overflow-hidden rounded-lg shadow-2xl"
      style={{ aspectRatio: ratio, width: `min(94vw, calc(88vh * ${ratio}))` }}
      onPointerDown={(e) => {
        e.stopPropagation();
        move(e.clientX);
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic pointers have nothing to capture */ }
      }}
      onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch') move(e.clientX); }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Probe: reads the bitmap's natural size so the frame has the right shape. */}
      <img
        src={afterSrc}
        alt=""
        aria-hidden
        className="hidden"
        onLoad={(e) => {
          const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
          if (w && h) setRatio((half ? w / 2 : w) / h);
        }}
      />
      {layer(afterSrc, 'after')}
      <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>{layer(beforeSrc, 'before')}</div>
      <span className="absolute left-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-compact leading-4 text-white" data-testid="evidence-label-before">{tr('board.evidence.before')}</span>
      <span className="absolute right-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-compact leading-4 text-white" data-testid="evidence-label-after">{tr('board.evidence.after')}</span>
      <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow" style={{ left: `${pos}%` }}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(pos)}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-label={tr('board.evidence.slider')}
          data-testid="evidence-slider"
          className="sr-only"
        />
        <div className="absolute top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black/60" />
      </div>
    </div>
  );
}

/** A single image or video at its true resolution, with wheel/pinch zoom and drag. */
function ZoomStage({ path }: { path: string }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const url = getMediaUrl(path);

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => {
      const next = Math.max(1, Math.min(MAX_SCALE, s * factor));
      if (next === 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // Native and non-passive: the wheel must zoom the image, not scroll behind it.
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0025)); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  if (isVideoPath(path)) {
    return <video src={url} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} className="max-h-[90vh] max-w-[94vw] rounded-lg shadow-2xl" />;
  }
  return (
    <div
      ref={stageRef}
      data-testid="evidence-stage"
      className="flex h-full w-full touch-none items-center justify-center"
      onPointerDown={(e) => {
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        if (pointers.current.size === 2) {
          const [a, b] = [...pointers.current.values()];
          pinch.current = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        }
      }}
      onPointerMove={(e) => {
        const prev = pointers.current.get(e.pointerId);
        if (!prev) return;
        const cur = { x: e.clientX, y: e.clientY };
        pointers.current.set(e.pointerId, cur);
        if (pointers.current.size === 2 && pinch.current) {
          const [a, b] = [...pointers.current.values()];
          const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
          zoomBy(d / pinch.current);
          pinch.current = d;
        } else if (pointers.current.size === 1 && scale > 1) {
          setOffset((o) => ({ x: o.x + cur.x - prev.x, y: o.y + cur.y - prev.y }));
        }
      }}
      onPointerUp={(e) => { pointers.current.delete(e.pointerId); pinch.current = null; }}
      onPointerCancel={(e) => { pointers.current.delete(e.pointerId); pinch.current = null; }}
      onDoubleClick={(e) => { e.stopPropagation(); if (scale > 1) { setScale(1); setOffset({ x: 0, y: 0 }); } else setScale(2.5); }}
    >
      <img
        src={url}
        alt=""
        draggable={false}
        data-testid="evidence-image"
        data-scale={scale.toFixed(2)}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] max-w-[96vw] rounded-lg object-contain shadow-2xl"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, cursor: scale > 1 ? 'grab' : 'zoom-in' }}
      />
    </div>
  );
}

/**
 * Full-screen viewer for a delivery's evidence: dark ground, true resolution,
 * wheel and pinch zoom, arrows between slides, a before/after divider when the
 * slide is a comparison. Esc or the X closes it.
 */
export function EvidenceViewer({ slides, start = 0, onClose }: {
  slides: readonly EvidenceSlide[];
  start?: number;
  onClose: () => void;
}) {
  const tr = useT();
  const [i, setI] = useState(Math.max(0, Math.min(start, slides.length - 1)));
  const panelRef = useRef<HTMLDivElement>(null);
  useModalDialog({ onClose, panelRef });
  useExitGhost(panelRef, true, 'modal');
  const prev = slides.length > 1 ? () => setI((n) => Math.max(0, n - 1)) : undefined;
  const next = slides.length > 1 ? () => setI((n) => Math.min(slides.length - 1, n + 1)) : undefined;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev?.(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); next?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const slide = slides[i];
  if (!slide) return null;
  const btn = 'absolute top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-3 text-white hover:bg-white/20';
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={tr('board.preview.label')}
      data-testid="preview-lightbox"
      onClick={onClose}
      className={`fixed inset-0 ${MODAL_LAYER} flex items-center justify-center bg-black/95 modal-backdrop-enter`}
    >
      {slides.length > 1 && (
        <div data-testid="lightbox-posizione" className="absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-compact leading-4 text-white">{i + 1} / {slides.length}</div>
      )}
      <button onClick={onClose} title={tr('board.preview.close')} aria-label={tr('board.preview.close')} data-testid="lightbox-close" className="absolute right-4 top-4 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"><X className="h-5 w-5" /></button>
      {prev && <button onClick={(e) => { e.stopPropagation(); prev(); }} title={tr('board.preview.prev')} aria-label={tr('board.preview.prev')} data-testid="lightbox-prev" className={`${btn} left-4 z-10`}><ChevronLeft className="h-6 w-6" /></button>}
      {next && <button onClick={(e) => { e.stopPropagation(); next(); }} title={tr('board.preview.next')} aria-label={tr('board.preview.next')} data-testid="lightbox-next" className={`${btn} right-4 z-10`}><ChevronRight className="h-6 w-6" /></button>}
      {slide.kind === 'single' ? <ZoomStage key={slide.path} path={slide.path} /> : <CompareFrame key={i} slide={slide} />}
    </div>,
    document.body,
  );
}
