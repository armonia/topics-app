import { titoloDaTesto } from '../../../../shared/task-title';
import type { StagedAttachment } from '../../lib/attachments';

/**
 * THE CARD BEFORE IT EXISTS: what the floating composer is about to create,
 * as the column will show it.
 *
 * Asked on 03/09 (card 058ea722): "I wanted the preview, in the kanban, of a
 * task being opened from the floating [composer]". The composer sits at the
 * bottom of the board and the card lands at the top of a column: between
 * writing and pressing Enter there was nothing on the board that said WHERE
 * the task would go and WHAT it would look like (which line becomes the
 * title, which image rides with it). The preview is a ghost card in the birth
 * column, drawn from this value, and it goes when the text goes.
 *
 * Pure: the same title split the create uses (`titoloDaTesto`), so what the
 * ghost shows is what the server receives, not an approximation of it.
 */
export interface DraftPreview {
  /** The first line, cut the way the create cuts it. */
  title: string;
  /** The rest of the text, or null when it is all title. */
  description: string | null;
  /** The column the task will be born in. */
  status: 'todo' | 'backlog';
  /** Uploaded image attachments, by path (served through /api/media). */
  images: string[];
  /** The names of the attachments that are not images. */
  files: string[];
}

/**
 * The ghost of the composer's current state, or null when there is nothing
 * to show: no text and no attachment. A composer with only an attachment
 * still has a card to preview (the create sends "(allegato)" in that case,
 * and the image is the whole point of that card).
 */
export function draftPreviewOf(
  text: string,
  attachments: readonly StagedAttachment[],
  status: 'todo' | 'backlog',
): DraftPreview | null {
  const raw = text.trim();
  if (!raw && attachments.length === 0) return null;
  const images = attachments.filter((a) => a.isImage).map((a) => a.path);
  const files = attachments.filter((a) => !a.isImage).map((a) => a.name);
  if (!raw) {
    return { title: attachments[0]?.name ?? '', description: null, status, images, files };
  }
  const { title, description } = titoloDaTesto(raw);
  return { title, description, status, images, files };
}
