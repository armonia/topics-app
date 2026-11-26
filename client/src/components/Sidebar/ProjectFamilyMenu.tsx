/**
 * ACCORPA / SEPARA in the project's context menu. The logic is `useProjectFamily`
 * (shared with the board settings panel); this is only the entries.
 */
// Relative imports, not `@/`: `bun test` does not resolve the alias.
import { useState } from 'react';
import { FolderTree, Link2, Unlink } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useProjectFamily } from '../../hooks/useProjectFamily';
import { POPOVER_DIVIDER, POPOVER_ITEM } from '../../lib/popoverStyles';
import { projectDisplayName } from '../../lib/projectFamilyApi';
import type { MergeMode } from '../../../../shared/project-family';

const nameOf = projectDisplayName;

/**
 * The entries of the project's context menu. Drawn only once the project row is
 * known: offering «Accorpa» on a project that already is would do nothing.
 */
export function ProjectFamilyMenu({ projectPath, onDone }: { projectPath: string; onDone: () => void }) {
  const tr = useT();
  const { loaded, own, parent, hasChildren, mergedChildren, choices, busy, apply } = useProjectFamily({ path: projectPath });
  const [picking, setPicking] = useState(false);

  if (!loaded || !own) return null;
  const done = (change: { parentId?: string | null; mergeMode?: MergeMode }, targetId?: string) => { void apply(change, targetId); onDone(); };

  // A parent: its merged children have no row in the sidebar, so this is where they are separated.
  if (hasChildren) {
    return (
      <>
        {mergedChildren.map((kid) => (
          <button key={kid.id} disabled={busy} data-testid="project-family-separate-child" onClick={() => done({ mergeMode: 'separa' }, kid.id)} className={POPOVER_ITEM}>
            <Unlink size={14} />
            <span>{tr('family.separateChild', { child: nameOf(kid) })}</span>
          </button>
        ))}
      </>
    );
  }

  if (parent) {
    const merged = (own.mergeMode ?? 'accorpa') === 'accorpa';
    return (
      <>
        <button disabled={busy} data-testid="project-family-toggle" onClick={() => done({ mergeMode: merged ? 'separa' : 'accorpa' })} className={POPOVER_ITEM}>
          <Link2 size={14} />
          <span>{tr(merged ? 'family.separate' : 'family.remerge', { parent: nameOf(parent) })}</span>
        </button>
        <button disabled={busy} data-testid="project-family-detach" onClick={() => done({ parentId: null })} className={POPOVER_ITEM}>
          <Unlink size={14} />
          <span>{tr('family.detach', { parent: nameOf(parent) })}</span>
        </button>
      </>
    );
  }

  const options = [...choices.suggested.map((r) => ({ r, suggested: true })), ...choices.others.map((r) => ({ r, suggested: false }))];
  if (options.length === 0) return null;
  return (
    <>
      <button data-testid="project-family-merge" onClick={() => setPicking((v) => !v)} aria-expanded={picking} className={POPOVER_ITEM}>
        <FolderTree size={14} />
        <span>{tr('family.merge')}</span>
      </button>
      {picking && (
        <div className="flex max-h-56 flex-col overflow-y-auto" data-testid="project-family-choices">
          {options.map(({ r, suggested }) => (
            <button key={r.id} disabled={busy} onClick={() => done({ parentId: r.id, mergeMode: 'accorpa' })} className={`${POPOVER_ITEM} pl-7`}>
              <span className="min-w-0 truncate">{nameOf(r)}</span>
              {suggested && <span className="ml-auto shrink-0 text-mini text-app-text-tertiary">{tr('family.suggested')}</span>}
            </button>
          ))}
          <div className={POPOVER_DIVIDER} />
        </div>
      )}
    </>
  );
}
