import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Clock3, Link2, ShieldCheck, Trash2, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { friendlyModelLabel } from '../../lib/modelLabel';
import { Select } from '../Shared/Select';
import {
  approveLocalDelegatedRequest,
  delegatedRequests,
  denyLocalDelegatedRequest,
  listLocalDelegatedRequests,
  revokeLocalDelegatedAuthorization,
  type DelegatedMachineRequest,
} from './delegatedMachineAccess';

interface LocalProject { id: string; name: string; path: string; incognito?: boolean }
interface LocalPerson { id: string; name: string; owner: boolean }

/** The receiving computer's half of remote execution authorization. It lives
 * on the existing Devices page: this is a computer trust decision, not a new
 * organisation administrator. */
export function RemoteNodeRequests() {
  const t = useT();
  const [requests, setRequests] = useState<DelegatedMachineRequest[]>([]);
  const [projects, setProjects] = useState<LocalProject[]>([]);
  const [people, setPeople] = useState<LocalPerson[]>([]);
  const [available, setAvailable] = useState(false);
  const [choicesLoaded, setChoicesLoaded] = useState(false);
  const [selection, setSelection] = useState<Record<string, { projectId: string; personId: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    try {
      const pendingResponse = await fetch(...listLocalDelegatedRequests());
      // Guests do not see an empty approval box: the route is owner-only and
      // 403 means this surface simply is not theirs.
      if (pendingResponse.status === 403) { setAvailable(false); return; }
      if (!pendingResponse.ok) throw new Error(String(pendingResponse.status));
      const pendingBody = await pendingResponse.json();
      setAvailable(true);
      setRequests(delegatedRequests(pendingBody));
      setError(null);
    } catch {
      setError(t('settings.machines.remote.loadFailed'));
    }
  }, [t]);

  const loadChoices = useCallback(async () => {
    if (choicesLoaded) return;
    try {
      const [projectsResponse, devicesResponse] = await Promise.all([
        fetch('/api/projects', { credentials: 'same-origin' }),
        fetch('/api/auth/devices', { credentials: 'same-origin' }),
      ]);
      const [projectsBody, devicesBody] = await Promise.all([
        projectsResponse.ok ? projectsResponse.json() : Promise.resolve({ projects: [] }),
        devicesResponse.ok ? devicesResponse.json() : Promise.resolve({ people: [] }),
      ]);
      setProjects(((projectsBody as { projects?: LocalProject[] }).projects ?? []).filter((project) => !project.incognito));
      setPeople(((devicesBody as { people?: LocalPerson[] }).people ?? []).filter((person) => person.owner));
      setChoicesLoaded(true);
    } catch {
      setError(t('settings.machines.remote.loadFailed'));
    }
  }, [choicesLoaded, t]);

  useEffect(() => { void loadRequests(); }, [loadRequests]);

  // The app owns one WebSocket per window and republishes these security
  // frames on its local event bus. Filtering by purpose keeps legacy pairing
  // cards and delegated-node changes separate while allowing an already-open,
  // initially empty Devices page to refresh immediately.
  useEffect(() => {
    const refresh = (event: Event) => {
      const purpose = (event as CustomEvent<{ purpose?: string }>).detail?.purpose;
      if (purpose === 'delegated-node') void loadRequests();
    };
    window.addEventListener('topics:auth-pair-requested', refresh);
    window.addEventListener('topics:auth-pair-resolved', refresh);
    return () => {
      window.removeEventListener('topics:auth-pair-requested', refresh);
      window.removeEventListener('topics:auth-pair-resolved', refresh);
    };
  }, [loadRequests]);

  const pending = useMemo(() => requests.filter((request) => request.state === 'pending'), [requests]);
  const active = useMemo(() => requests.filter((request) => request.purpose === 'authorization'
    && (request.state === 'approved' || request.state === 'active')), [requests]);

  useEffect(() => {
    if (pending.length > 0) void loadChoices();
  }, [loadChoices, pending.length]);

  const ownerOptions = useMemo(() => people.map((person) => ({ value: person.id, label: person.name })), [people]);
  const projectOptions = useMemo(() => projects.map((project) => ({
    value: project.id,
    label: project.name,
    hint: project.path.split('/').slice(-2).join('/'),
  })), [projects]);

  const decide = async (request: DelegatedMachineRequest, approved: boolean) => {
    const chosen = selection[request.id];
    if (approved && (!chosen?.projectId || !chosen.personId)) return;
    setBusy(request.id);
    setError(null);
    try {
      const response = await fetch(...(approved
        ? approveLocalDelegatedRequest(request.id, chosen.projectId, chosen.personId)
        : denyLocalDelegatedRequest(request.id)));
      if (!response.ok) throw new Error(String(response.status));
      await loadRequests();
    } catch {
      setError(t('settings.machines.remote.decisionFailed'));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (request: DelegatedMachineRequest) => {
    setBusy(request.id);
    setError(null);
    try {
      const response = await fetch(...revokeLocalDelegatedAuthorization(request.id));
      if (!response.ok) throw new Error(String(response.status));
      await loadRequests();
    } catch {
      setError(t('settings.machines.remote.revokeFailed'));
    } finally {
      setBusy(null);
    }
  };

  if (!available && requests.length === 0) return null;

  return (
    <section className="border-t border-app-border pt-4" data-testid="remote-node-requests">
      <div className="flex items-start gap-2">
        <Link2 size={13} className="mt-0.5 shrink-0 text-violet-400" />
        <div>
          <h4 className="text-compact font-semibold text-app-text">{t('settings.machines.remote.title')}</h4>
          <p className="mt-0.5 text-mini leading-relaxed text-app-text-muted">{t('settings.machines.remote.blurb')}</p>
        </div>
      </div>

      {pending.length === 0 ? (
        <p className="mt-2 rounded-md bg-app-bg-secondary px-2.5 py-2 text-mini text-app-text-muted">
          {t('settings.machines.remote.none')}
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {pending.map((request) => {
            const chosen = selection[request.id] ?? { projectId: '', personId: '' };
            return (
              <li key={request.id} className="rounded-lg border border-violet-500/25 bg-violet-500/5 p-2.5" data-testid="remote-node-request">
                <p className="mb-1 text-mini font-medium text-app-text">
                  {t(request.purpose === 'catalog'
                    ? 'settings.machines.remote.catalogRequest'
                    : 'settings.machines.remote.authorizationRequest')}
                </p>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-title tracking-[0.18em] text-app-text">{request.code}</span>
                  <span className="text-mini text-app-text-secondary">{request.originName ?? request.requestedBy ?? t('settings.machines.remote.otherComputer')}</span>
                  <span className="inline-flex items-center gap-1 text-micro text-app-text-muted"><Clock3 size={10} />{t('settings.machines.remote.expires')}</span>
                </div>
                <p className="mt-1 text-mini leading-snug text-app-text-secondary">
                  {request.subjectName && `${request.subjectName} · `}
                  {request.repositoryName ?? request.repositoryKey}
                  {request.model && ` · ${friendlyModelLabel(request.model)}`}
                  {request.effort && ` · ${request.effort}`}
                  {request.maxDurationMinutes && ` · ${t('share.agentStart.minutes', { n: request.maxDurationMinutes })}`}
                </p>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div>
                    <span className="text-micro text-app-text-muted">{t('settings.machines.remote.checkout')}</span>
                    <Select value={chosen.projectId} options={projectOptions} onChange={(projectId) => setSelection((current) => ({ ...current, [request.id]: { ...chosen, projectId } }))} ariaLabel={t('settings.machines.remote.checkout')} placeholder={t('settings.machines.remote.chooseCheckout')} className="mt-0.5 w-full" />
                  </div>
                  <div>
                    <span className="text-micro text-app-text-muted">{t('settings.machines.remote.identity')}</span>
                    <Select value={chosen.personId} options={ownerOptions} onChange={(personId) => setSelection((current) => ({ ...current, [request.id]: { ...chosen, personId } }))} ariaLabel={t('settings.machines.remote.identity')} placeholder={t('settings.machines.remote.chooseIdentity')} className="mt-0.5 w-full" />
                  </div>
                </div>
                <p className="mt-2 text-micro leading-snug text-app-text-muted"><ShieldCheck size={10} className="mr-1 inline" />{t(request.purpose === 'catalog' ? 'settings.machines.remote.catalogScope' : 'settings.machines.remote.scope')}</p>
                <div className="mt-2 flex justify-end gap-1.5">
                  <button type="button" disabled={busy === request.id} onClick={() => void decide(request, false)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-mini text-app-text-secondary hover:bg-app-hover disabled:opacity-50"><X size={11} />{t('settings.machines.remote.deny')}</button>
                  <button type="button" disabled={busy === request.id || !chosen.projectId || !chosen.personId} onClick={() => void decide(request, true)} className="inline-flex items-center gap-1 rounded bg-violet-600 px-2 py-1 text-mini text-white disabled:opacity-40"><Check size={11} />{t('settings.machines.remote.approve')}</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {active.length > 0 && (
        <div className="mt-4" data-testid="remote-node-authorizations">
          <h5 className="text-mini font-medium uppercase tracking-wide text-app-text-muted">
            {t('settings.machines.remote.activeHeading')}
          </h5>
          <ul className="mt-1.5 space-y-1.5">
            {active.map((request) => (
              <li key={request.id} className="flex items-center gap-2 rounded-md border border-app-border bg-app-bg-secondary px-2.5 py-2" data-testid="remote-node-authorization">
                <ShieldCheck size={12} className="shrink-0 text-emerald-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-mini font-medium text-app-text">{request.repositoryName ?? request.repositoryKey}</p>
                  <p className="truncate text-micro text-app-text-muted">
                    {request.model && friendlyModelLabel(request.model)}
                    {request.effort && ` · ${request.effort}`}
                    {request.state === 'approved' && ` · ${t('settings.machines.remote.activating')}`}
                  </p>
                </div>
                <button type="button" disabled={busy === request.id} onClick={() => void revoke(request)} className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-mini text-red-500 hover:bg-red-500/10 disabled:opacity-50" aria-label={t('settings.machines.remote.revoke')}>
                  <Trash2 size={11} />{t('settings.machines.remote.revoke')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-mini text-red-500">{error}</p>}
    </section>
  );
}
