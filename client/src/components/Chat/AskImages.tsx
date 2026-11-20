import { useState } from 'react';
import { ImageOff, Maximize2 } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { getMediaUrl } from '../../lib/api';
import { askImagePath } from '../../../../shared/ask-images';
import { basename } from '../../lib/path-utils';
import { ImageLightbox } from '../Shared/ImageLightbox';

/**
 * The pictures of a question: a strip under its text, each one opening in the
 * viewer the chat already has. A picture that does not load says so in place of
 * a broken square.
 */
export function QuestionImages({ images }: { images: string[] }) {
  const tr = useT();
  const [open, setOpen] = useState<number | null>(null);
  const [broken, setBroken] = useState<Set<number>>(new Set());
  return (
    <div className="flex flex-wrap gap-2 pb-1" data-testid="ask-question-images">
      {images.map((ref, i) => {
        const path = askImagePath(ref);
        const name = basename(path) || path;
        return broken.has(i) ? (
          <div key={ref} data-testid="ask-image-missing" className="inline-flex items-center gap-1.5 rounded-md bg-app-hover px-2 py-1.5 text-compact text-app-text-muted">
            <ImageOff aria-hidden className="h-4 w-4" />{tr('ask.image.missing')}: {name}
          </div>
        ) : (
          <button
            key={ref}
            type="button"
            onClick={() => setOpen(i)}
            aria-label={`${tr('ask.image.open')}: ${name}`}
            className="rounded-md border border-app-border overflow-hidden hover:opacity-90"
          >
            <img
              data-testid="ask-question-image"
              src={getMediaUrl(path)}
              alt={name}
              loading="lazy"
              className="max-h-40 max-w-full object-contain bg-app-hover"
              onError={() => setBroken((prev) => new Set(prev).add(i))}
            />
          </button>
        );
      })}
      {open !== null && images[open] && (
        <ImageLightbox src={getMediaUrl(askImagePath(images[open]!))} alt={basename(askImagePath(images[open]!))} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

/**
 * The picture of one option. It sits INSIDE the option's label, so touching it
 * picks the option; the corner button is the other gesture, and opens the
 * viewer without choosing.
 */
export function OptionImage({ image, label }: { image: string; label: string }) {
  const tr = useT();
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [viewer, setViewer] = useState(false);
  const src = getMediaUrl(askImagePath(image));
  if (state === 'missing') {
    return (
      <div data-testid="ask-image-missing" className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-app-hover px-2 py-1.5 text-compact text-app-text-muted">
        <ImageOff aria-hidden className="h-4 w-4" />{tr('ask.image.missing')}
      </div>
    );
  }
  return (
    <div className="relative mt-1 inline-block max-w-full" data-testid="ask-option-image-box">
      {state === 'loading' && (
        <div data-testid="ask-image-loading" aria-hidden className="absolute inset-0 animate-pulse rounded-md bg-app-hover" />
      )}
      <img
        data-testid="ask-option-image"
        src={src}
        alt={label}
        loading="lazy"
        className="max-h-40 max-w-full rounded-md border border-app-border object-contain min-h-16 min-w-24"
        onLoad={() => setState('ready')}
        onError={() => setState('missing')}
      />
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setViewer(true); }}
        aria-label={`${tr('ask.image.open')}: ${label}`}
        data-testid="ask-option-image-zoom"
        className="absolute right-1 top-1 rounded bg-black/55 p-1 text-white hover:bg-black/75"
      >
        <Maximize2 aria-hidden className="h-3.5 w-3.5" />
      </button>
      {viewer && <ImageLightbox src={src} alt={label} onClose={() => setViewer(false)} />}
    </div>
  );
}
