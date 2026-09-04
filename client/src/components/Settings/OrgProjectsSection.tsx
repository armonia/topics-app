import { useEffect, useState } from 'react';
import { Folder } from 'lucide-react';
import { useT } from '../../hooks/useT';

/**
 * THE PROJECTS OF THE ORGANISATION: what is there, and nothing else.
 *
 * It used to also propose a curated list of workspaces. The list was six names
 * from ONE installation, two of them badged «suggested», shipped to every
 * install: whoever opened this panel read the name of a company that is not
 * theirs and somebody else's personal projects presented as advice. A
 * recommendation nobody can derive from the machine in front of them is not a
 * guide, it is a leak. Next to each missing one sat a `FolderPlus` icon with no
 * handler - it looked like «add this space» and did nothing.
 *
 * So the panel now shows what the installation actually has, and the one line
 * that says how to add more. When there is something real to derive a proposal
 * from, it can come back with a working command attached.
 */

interface Project {
  id: string;
  name: string;
  path: string;
  incognito?: boolean;
}

export function OrgProjectsSection() {
  const t = useT();
  const [progetti, setProgetti] = useState<Project[]>([]);
  const [caricamento, setCaricamento] = useState(true);

  useEffect(() => {
    let vivo = true;
    fetch('/api/projects', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { projects?: Project[] } | null) => {
        if (vivo && b?.projects) setProgetti(b.projects.filter((p) => !p.incognito));
      })
      .catch(() => {})
      .finally(() => { if (vivo) setCaricamento(false); });
    return () => { vivo = false; };
  }, []);

  return (
    <div>
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-app-text-muted">
        {t('settings.org.projects.title')}
      </h3>

      {!caricamento && progetti.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-app-border">
          {progetti.map((p, i) => (
            <div
              key={p.id}
              className={`flex items-center gap-2 px-3 py-2 text-[12px] ${i < progetti.length - 1 ? 'border-b border-app-border' : ''}`}
            >
              <Folder size={13} className="flex-shrink-0 text-app-text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-app-text">{p.name}</span>
              <span className="flex-shrink-0 text-[10px] text-app-text-muted truncate max-w-[120px]" title={p.path}>
                {p.path.split('/').slice(-2).join('/')}
              </span>
            </div>
          ))}
        </div>
      )}
      {!caricamento && progetti.length === 0 && (
        <p className="text-[12px] text-app-text-muted">
          {t('settings.org.projects.empty')}
        </p>
      )}

      <p className="mt-2 text-[11px] text-app-text-muted">
        {t('settings.org.projects.hint')}
      </p>
    </div>
  );
}
