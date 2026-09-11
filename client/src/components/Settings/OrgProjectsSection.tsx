import { useEffect, useState } from 'react';
import { Folder } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { ShareControl } from '../Share/ShareControl';
import { type OrgProjectRow, scopeProjectsToOrg } from './orgProjects';

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
 *
 * ── THE SCOPE FIX ────────────────────────────────────────────────────────
 * Until this change the panel fetched `/api/projects` and showed every
 * non-incognito row, full stop — no `orgId` anywhere. On an installation with
 * one group that is invisible: everything visible IS the one group's
 * projects. The day a SECOND group exists (this card's own case, two live
 * organisations on one installation) it stops being correct: a personal
 * project (`orgId: null`) and the installation's own group's project both
 * showed up on the OTHER group's page too, because nothing told this panel
 * which page was open. `orgId` — the prop, lifted in `IdentityPages.tsx` from
 * the group picker `IdentitySection` already has — is what closes that: a
 * project belongs to this page only if its own `orgId` matches.
 *
 * A project can never carry an `orgId` that is not `null` or the
 * installation's own group (`PROJECT-13`, `server/routes/projects.ts`): one
 * installation names exactly one group as far as OWNERSHIP goes. So a second
 * group's page — Danceroom's, here — correctly lists NO project of its own:
 * that is not a bug to route around, it is what "an installation names one
 * group" means. What lets somebody in a DIFFERENT group collaborate on a
 * project without moving it is the SHARE gesture next to each row: a grant on
 * the project (a person, a device, or the whole other group), which is a
 * different question from who owns it.
 */

export function OrgProjectsSection({ orgId }: { orgId: string | null }) {
  const t = useT();
  const [progetti, setProgetti] = useState<OrgProjectRow[]>([]);
  const [caricamento, setCaricamento] = useState(true);

  useEffect(() => {
    let vivo = true;
    fetch('/api/projects', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { projects?: OrgProjectRow[] } | null) => {
        if (vivo && b?.projects) setProgetti(b.projects);
      })
      .catch(() => {})
      .finally(() => { if (vivo) setCaricamento(false); });
    return () => { vivo = false; };
  }, []);

  const visible = scopeProjectsToOrg(progetti, orgId);

  return (
    <div>
      <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-app-text-muted">
        {t('settings.org.projects.title')}
      </h3>

      {!caricamento && visible.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-app-border">
          {visible.map((p, i) => (
            <div
              key={p.id}
              data-testid="org-project-row"
              className={`flex items-center gap-2 px-3 py-2 text-[12px] ${i < visible.length - 1 ? 'border-b border-app-border' : ''}`}
            >
              <Folder size={13} className="flex-shrink-0 text-app-text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-app-text">{p.name}</span>
              <span className="flex-shrink-0 text-[10px] text-app-text-muted truncate max-w-[120px]" title={p.path}>
                {p.path.split('/').slice(-2).join('/')}
              </span>
              {/* Same control the sidebar already offers on a project: a
                  grant (person, device, or another group) plus, if the relay
                  is up, a remote link. It belongs here too — this IS the page
                  somebody opens to ask "who can get at our work". */}
              <ShareControl resourceType="project" resourceId={p.id} />
            </div>
          ))}
        </div>
      )}
      {!caricamento && visible.length === 0 && (
        <p className="text-[12px] text-app-text-muted">
          {t('settings.org.projects.empty')}
        </p>
      )}

      <p className="mt-2 text-[11px] text-app-text-muted">
        {t('settings.org.projects.hint')}
      </p>

      {/* THE SHORT GUIDE. The two axes this page keeps conflating: who can
          LOOK at a project's work over a link, and whose OWN machine can run
          agents on it. They read the same word ("access") and are not the
          same gesture. */}
      <div
        data-testid="org-collab-guide"
        className="mt-4 rounded-lg border border-app-border bg-app-bg-secondary px-3 py-2.5"
      >
        <h4 className="mb-1.5 text-[11px] font-medium text-app-text">
          {t('settings.org.guide.title')}
        </h4>
        <p className="text-[11px] leading-relaxed text-app-text-secondary">
          {t('settings.org.guide.browser')}
        </p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-app-text-secondary">
          {t('settings.org.guide.machine')}
        </p>
      </div>
    </div>
  );
}
