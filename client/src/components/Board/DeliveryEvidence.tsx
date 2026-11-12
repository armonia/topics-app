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
    // Fixed aspect box: the bitmap loads after first paint and must not shift the thread under the reader.
    const cls = 'block aspect-[16/10] w-full max-h-[60vh] rounded border border-app-border bg-black/20 object-contain cursor-zoom-in';
    const isComposite = slide.kind === 'sideBySide';
    return (
      <button
        key={n}
        type="button"
        data-testid="delivery-evidence-item"
        aria-label={tr('board.preview.openFullSize')}
        onClick={() => setOpen(n)}
        className="block w-full text-left"
      >
        {isVideoPath(path)
          ? <video src={getMediaUrl(path)} muted playsInline preload="metadata" className={`${cls}`} />
          : <img src={getMediaUrl(path)} alt="" draggable={false} className={`${cls}`} />}
        {(slide.kind === 'pair' || isComposite) && (
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
