// Relative imports, not `@/`: `bun test` does not resolve the alias, and
// `EntryIncognito.test.ts` mounts this component.
import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { projectsApi } from '../../lib/api';
import { POPOVER_ITEM } from '../../lib/popoverStyles';
import { useT } from '../../hooks/useT';
import { useToast } from '../Shared/Toast';

// ── «Incognito» on the project ────────────────────────────────────────────────
/**
 * The only human lever of migration 092: a project belongs to the organisation
 * unless somebody says no.
 *
 * It loads itself because the sidebar knows projects by PATH (the board index),
 * not as rows of `projects`: the record carrying the switch is asked for when
 * the menu opens, not a moment earlier. A fetch per drawn project row would be
 * an idle request on every app start.
 *
 * Until it is known, the entry is NOT drawn. Drawing it on a guessed state
 * would offer «Make incognito» on a project that already is, a gesture that
 * does not do what it says.
 *
 * A failed toggle says so in a toast: the menu closes on click, and a swallowed
 * error left the project visible to the group while the person believed it
 * hidden.
 */
export function EntryIncognito({ projectPath, onDone }: { projectPath: string; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [project, setProject] = useState<{ id: string; incognito: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    projectsApi
      .byPath(projectPath)
      .then(p => { if (alive && p) setProject({ id: p.id, incognito: p.incognito === true }); })
      .catch(() => {});
    return () => { alive = false; };
  }, [projectPath]);

  if (!project) return null;
  return (
    <button
      onClick={() => {
        projectsApi.update(project.id, { incognito: !project.incognito }).catch(() => {
          toast.error(t(project.incognito ? 'sidebar.incognito.showFailed' : 'sidebar.incognito.hideFailed'));
        });
        onDone();
      }}
      className={POPOVER_ITEM}
    >
      {project.incognito ? <Eye size={14} /> : <EyeOff size={14} />}
      <span>{t(project.incognito ? 'sidebar.incognito.show' : 'sidebar.incognito.hide')}</span>
    </button>
  );
}
