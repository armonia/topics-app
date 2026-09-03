import { useT } from '../../hooks/useT';
import { ZoomableImage } from '../Shared/ImageLightbox';
import { getMediaUrl } from '../../lib/api';
import { stripMarkdown } from '../../lib/stripMarkdown';
import type { DraftPreview } from './draftPreview';

// ── The ghost card ────────────────────────────────────────────────────────
/**
 * WHAT THE FLOATING COMPOSER IS ABOUT TO CREATE, drawn where it will land.
 *
 * Asked on 03/09 (card 058ea722): "I wanted the preview, in the kanban, of a
 * task being opened from the floating [composer]". The composer is at the
 * bottom of the board, the card lands at the top of a column: while writing
 * there was nothing that said which column, which line becomes the title,
 * whether the screenshot rides with it. This is that answer, and it is a
 * GHOST on purpose: dashed, dimmed, not sortable, not clickable as a card.
 * The image is the one thing you can click, and it opens the same lightbox
 * as everywhere else.
 */
export function DraftCard({ draft }: { draft: DraftPreview }) {
  const tr = useT();
  return (
    <div
      data-testid="kanban-draft-card"
      aria-label={tr('board.draft.label')}
      className="rounded-lg border border-dashed border-app-border-light bg-white/[0.03] p-3 opacity-80"
    >
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-app-text-muted">{tr('board.draft.label')}</p>
      {draft.images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {draft.images.slice(0, 3).map((p) => (
            <ZoomableImage key={p} src={getMediaUrl(p)} alt={p.split('/').pop() ?? ''} testId="kanban-draft-image" className="h-16 max-w-full rounded-md object-cover" />
          ))}
        </div>
      )}
      <span className="block break-words text-sm leading-snug text-app-text-heading">{draft.title || tr('board.draft.untitled')}</span>
      {draft.description && (
        <p className="mt-1 line-clamp-2 break-words text-xs leading-snug text-app-text-secondary">{stripMarkdown(draft.description)}</p>
      )}
      {draft.files.length > 0 && (
        <p className="mt-1 truncate text-[11px] text-app-text-muted">{draft.files.join(' · ')}</p>
      )}
    </div>
  );
}
