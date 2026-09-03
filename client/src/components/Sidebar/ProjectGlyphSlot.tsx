import { ROW_GLYPH, ROW_GLYPH_SLOT } from '@/lib/selectionStyles';
import { ProjectFavicon } from '@/components/Shared/ProjectFavicon';
import { useProjectIcon } from '@/components/Shared/projectIconStore';
import { projectGlyphSlotShown } from './rowLeadGlyph';

/**
 * The favicon of a project row, IN THE SHARED SLOT of the column and ONLY
 * when the project ships an icon.
 *
 * The slot is `ROW_GLYPH_SLOT` (18px, centred) and not a hand-written box: it
 * is the box that aligns the column with the board, terminal and browser rows,
 * not the ink (the drawing stays `ROW_GLYPH`, 14px). What changed on 03/09 is
 * that a project WITHOUT an icon draws no box at all, so its name starts
 * right after the accordion (see `rowLeadGlyph.ts`).
 *
 * A component of its own because the answer comes from a hook
 * (`useProjectIcon`) and the project row is drawn by a render function inside
 * `TopicTree`, where a hook cannot live.
 */
export function ProjectGlyphSlot({ path }: { path: string }) {
  const { status } = useProjectIcon(path);
  if (!projectGlyphSlotShown(status)) return null;
  return (
    <span className={ROW_GLYPH_SLOT} data-row-glyph-slot="favicon">
      <ProjectFavicon path={path} size={ROW_GLYPH} />
    </span>
  );
}
