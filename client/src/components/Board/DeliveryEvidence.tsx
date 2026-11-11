import { useMemo, useState } from 'react';
import { useT } from '../../hooks/useT';
import { getMediaUrl } from '../../lib/api';
import { isPreviewablePath, isVideoPath } from '../../lib/mediaKind';
import { EvidenceViewer } from './EvidenceViewer';
import { buildEvidenceSlides, type EvidenceSlide } from './taskMedia';

/**
 * The delivery's proof, open at the top of the conversation: as wide as the
 * panel, no click needed to see it. A click opens the full-screen viewer.
 */
export function DeliveryEvidence({ paths }: { paths: readonly string[] }) {
  const tr = useT();
  const slides = useMemo(() => buildEvidenceSlides(paths.filter(isPreviewablePath)), [paths]);
  const [open, setOpen] = useState<number | null>(null);
  if (slides.length === 0) return null;
  const thumb = (slide: EvidenceSlide, n: number) => {
    const path = slide.kind === 'pair' ? slide.after : slide.path;
    const cls = 'block w-full rounded border border-app-border bg-black/20 cursor-zoom-in';
    const sbs = slide.kind === 'sideBySide';
    return (
      <button
        key={n}
        type="button"
        data-testid="delivery-evidence-item"
        onClick={() => setOpen(n)}
        className="block w-full text-left"
      >
        {isVideoPath(path)
          ? <video src={getMediaUrl(path)} muted playsInline preload="metadata" className={`${cls} max-h-[60vh] object-contain`} />
          : <img src={getMediaUrl(path)} alt="" loading="lazy" draggable={false} className={`${cls} max-h-[60vh] object-contain`} />}
        {(slide.kind === 'pair' || sbs) && (
          <span className="mt-1 block text-mini uppercase tracking-wide text-app-text-muted">{tr('board.evidence.beforeAfter')}</span>
        )}
      </button>
    );
  };
  return (
    <div data-testid="delivery-evidence" className="space-y-2">
      {slides.map(thumb)}
      {open !== null && <EvidenceViewer slides={slides} start={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
