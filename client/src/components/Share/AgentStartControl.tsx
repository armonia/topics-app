import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Clock3, Monitor, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import {
  grantAgentStartRequest,
  liveAgentStartCapabilities,
  preferredAgentStartModel,
  revokeAgentStartRequest,
} from './agentStartPolicy';
import { Select } from '../Shared/Select';
import { friendlyModelLabel } from '../../lib/modelLabel';
import { subscribeFrames } from '../../lib/wsFrameBus';
import {
  createDelegatedRequest,
  createCatalogRequest,
  delegatedRequests,
  delegatedRequestStatus,
  getDelegatedRequest,
  listDelegatedRequests,
  reissueDelegatedRequest,
  revokeDelegatedRequest,
  type DelegatedMachineRequest,
} from '../Settings/delegatedMachineAccess';
import type {
  AgentStartCapabilityContract,
  AgentStartSubjectType,
} from '../../../../shared/agent-start-capability';

export interface AgentStartSubject {
  subjectType: AgentStartSubjectType;
  subjectId: string;
  name: string;
}

export type AgentStartCapabilityView = Pick<AgentStartCapabilityContract,
  | 'id'
  | 'subjectType'
  | 'subjectId'
  | 'machineId'
  | 'machineName'
  | 'repositoryKey'
  | 'model'
  | 'effort'
  | 'maxDurationMinutes'
  | 'revokedAt'
  | 'expiresAt'
> & {
  subjectName?: string;
  computerId?: string;
  computerName?: string | null;
  repositoryName?: string;
  modelAvailability?: 'available' | 'unavailable' | 'unverified';
};

interface AgentStartChoice {
  id: string;
  name: string;
  repositoryName: string;
  repositoryKey?: string;
  available?: boolean;
  modelSupport?: 'verified' | 'unverified';
  remote?: boolean;
  models?: Array<{ id: string; label?: string }>;
}

interface AgentStartInventory {
  capabilities?: AgentStartCapabilityView[];
  computers?: AgentStartChoice[];
  models?: Array<{ id: string; label?: string }>;
  recommendedModel?: string | null;
  efforts?: string[];
  durationsMinutes?: number[];
}

const EMPTY_MODEL_CHOICES: Array<{ id: string; label?: string }> = [];

const subjectKey = (subject: Pick<AgentStartSubject, 'subjectType' | 'subjectId'>) =>
  `${subject.subjectType}:${subject.subjectId}`;

export function AgentStartControl({ projectId, subjects }: {
  projectId: string;
  subjects: readonly AgentStartSubject[];
}) {
  const t = useT();
  const [inventory, setInventory] = useState<AgentStartInventory>({});
  const [remoteRequests, setRemoteRequests] = useState<DelegatedMachineRequest[]>([]);
  const [editing, setEditing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [computer, setComputer] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [duration, setDuration] = useState('');

  const load = useCallback(async () => {
    try {
      const [response, delegatedResponse] = await Promise.all([
        fetch(`/api/auth/agent-start-capabilities?projectId=${encodeURIComponent(projectId)}`, { credentials: 'same-origin' }),
        fetch(...listDelegatedRequests()),
      ]);
      if (!response.ok) throw new Error(String(response.status));
      setInventory(await response.json() as AgentStartInventory);
      if (delegatedResponse.ok) {
        const listed = delegatedRequests(await delegatedResponse.json());
        const refreshed = await Promise.all(listed.map(async (request) => {
          if (request.state !== 'pending' && request.state !== 'approved') return request;
          const statusResponse = await fetch(...getDelegatedRequest(request.id));
          return statusResponse.ok ? delegatedRequestStatus(await statusResponse.json(), request) : request;
        }));
        setRemoteRequests(refreshed);
        // The status GET is the server-side claim/ack seam. When a catalog
        // becomes active, the inventory fetched in parallel just before it is
        // necessarily stale; read it once more so the verified node models
        // replace the verification step immediately.
        if (refreshed.some((request, index) => request.purpose === 'catalog'
          && request.state === 'active' && listed[index]?.state !== 'active')) {
          const updated = await fetch(`/api/auth/agent-start-capabilities?projectId=${encodeURIComponent(projectId)}`, { credentials: 'same-origin' });
          if (updated.ok) setInventory(await updated.json() as AgentStartInventory);
        }
      }
      setError(null);
    } catch {
      setError(t('share.agentStart.loadFailed'));
    }
  }, [projectId, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeFrames(() => { void load(); }, {
    types: ['providers:snapshot', 'machine:upserted', 'machine:updated', 'machine:deleted'],
  }), [load]);
  useEffect(() => {
    if (!remoteRequests.some((request) => request.state === 'pending' || request.state === 'approved')) return;
    const timer = setTimeout(() => { void load(); }, 2500);
    return () => clearTimeout(timer);
  }, [load, remoteRequests]);

  const liveCapabilities = liveAgentStartCapabilities(inventory.capabilities ?? []);
  const grantedSubjects = useMemo(() => new Set(liveCapabilities.map(subjectKey)), [liveCapabilities]);
  const availableSubjects = subjects.filter((item) => !grantedSubjects.has(subjectKey(item)));
  // A remote computer without a repository consent is precisely the computer
  // that must remain selectable to START the consent handshake. Filtering it
  // out here made the protocol circular.
  const computers = (inventory.computers ?? []).filter((item) => item.available !== false || item.modelSupport === 'unverified');
  const efforts = useMemo(() => inventory.efforts ?? [], [inventory.efforts]);
  const durations = useMemo(() => inventory.durationsMinutes ?? [], [inventory.durationsMinutes]);
  const selectedComputer = computers.find((item) => item.id === computer);
  const modelChoices = selectedComputer?.models ?? EMPTY_MODEL_CHOICES;
  const catalogRequest = remoteRequests.find((request) => request.purpose === 'catalog'
    && request.machineId === computer
    && (!selectedComputer?.repositoryKey || !request.repositoryKey || request.repositoryKey === selectedComputer.repositoryKey));

  useEffect(() => {
    if (!editing) return;
    setSubject((current) => current || (availableSubjects[0] ? subjectKey(availableSubjects[0]) : ''));
    setComputer((current) => current || computers[0]?.id || '');
    setModel((current) => current && modelChoices.some((item) => item.id === current)
      ? current
      : preferredAgentStartModel(modelChoices, inventory.recommendedModel));
    setEffort((current) => current || efforts[0] || '');
    setDuration((current) => current || (durations[0] ? String(durations[0]) : ''));
  }, [availableSubjects, computers, durations, editing, efforts, inventory.recommendedModel, modelChoices]);

  const resetForm = () => {
    setEditing(false);
    setConfirmed(false);
    setSubject('');
    setComputer('');
    setModel('');
    setEffort('');
    setDuration('');
  };

  const grant = async () => {
    const chosenSubject = subjects.find((item) => subjectKey(item) === subject);
    const minutes = Number(duration);
    if (!chosenSubject || !computer || !model || !effort || !Number.isFinite(minutes) || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(...grantAgentStartRequest({
        projectId, subjectType: chosenSubject.subjectType, subjectId: chosenSubject.subjectId,
        machineId: computer, model, effort, maxDurationMinutes: minutes,
      }));
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json().catch(() => null) as { capability?: AgentStartCapabilityView } | null;
      // Local capabilities are ready immediately. Remote ones enter the
      // purpose-specific owner approval flow; the browser receives a code and
      // status, never the confined credential exchanged by the servers.
      if ((selectedComputer?.remote || selectedComputer?.modelSupport === 'unverified') && body?.capability?.id) {
        const requestResponse = await fetch(...createDelegatedRequest(computer, body.capability.id));
        if (!requestResponse.ok) throw new Error(String(requestResponse.status));
      }
      resetForm();
      await load();
    } catch {
      setError(t('share.agentStart.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (capabilityId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(...revokeAgentStartRequest(projectId, capabilityId));
      if (!response.ok) throw new Error(String(response.status));
      await load();
    } catch {
      setError(t('share.agentStart.revokeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const recoverRemote = async (requestId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(...reissueDelegatedRequest(requestId));
      if (!response.ok) throw new Error(String(response.status));
      await load();
    } catch {
      setError(t('share.agentStart.remoteRequestFailed'));
    } finally {
      setBusy(false);
    }
  };

  const revokeRemote = async (requestId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(...revokeDelegatedRequest(requestId));
      if (!response.ok) throw new Error(String(response.status));
      await load();
    } catch {
      setError(t('share.agentStart.remoteRevokeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const verifyComputer = async () => {
    if (!selectedComputer?.remote || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(...createCatalogRequest(selectedComputer.id, projectId));
      if (!response.ok) throw new Error(String(response.status));
      await load();
    } catch {
      setError(t('share.agentStart.catalogFailed'));
    } finally {
      setBusy(false);
    }
  };

  const ready = !!subject && !!computer && !!model && !!effort && !!duration && confirmed;

  return (
    <section className="mx-2.5 my-2 border-y border-app-border py-2" data-testid="agent-start-control">
      <div className="flex items-center gap-2 px-1.5">
        <Bot size={12} className="shrink-0 text-violet-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-compact font-medium text-app-text">{t('share.agentStart.title')}</h3>
          <p className="text-micro leading-snug text-app-text-muted">{t('share.agentStart.blurb')}</p>
        </div>
        {!editing && availableSubjects.length > 0 && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(true)}
            className="shrink-0 rounded-md border border-app-border px-2 py-1 text-mini text-app-text hover:bg-app-hover disabled:opacity-50"
          >
            {t('share.agentStart.add')}
          </button>
        )}
      </div>

      {liveCapabilities.length > 0 && (
        <ul className="mt-2 space-y-1.5" data-testid="agent-start-capabilities">
          {liveCapabilities.map((capability) => (
            <li key={capability.id} className="rounded-md bg-app-bg-secondary px-2 py-1.5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-compact text-app-text">{capability.subjectName ?? subjects.find((item) => subjectKey(item) === subjectKey(capability))?.name ?? capability.subjectId}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-micro text-app-text-muted">
                    <span className="inline-flex items-center gap-1"><Monitor size={10} />{capability.computerName ?? capability.machineName ?? capability.machineId}</span>
                    <span>{capability.repositoryName ?? capability.repositoryKey}</span>
                    <span>{friendlyModelLabel(capability.model)}</span>
                    <span>{capability.effort}</span>
                    <span className="inline-flex items-center gap-1"><Clock3 size={10} />{t('share.agentStart.minutes', { n: capability.maxDurationMinutes })}</span>
                    {capability.modelAvailability && capability.modelAvailability !== 'available' && (
                      <span className={capability.modelAvailability === 'unavailable' ? 'text-red-400' : 'text-amber-400'}>
                        {t(capability.modelAvailability === 'unavailable'
                          ? 'share.agentStart.modelUnavailable'
                          : 'share.agentStart.modelUnverified')}
                      </span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revoke(capability.id)}
                  aria-label={t('share.agentStart.revokeFor', { name: capability.subjectName ?? subjects.find((item) => subjectKey(item) === subjectKey(capability))?.name ?? capability.subjectId })}
                  className="shrink-0 rounded p-1 text-app-text-tertiary hover:bg-app-hover hover:text-red-500 disabled:opacity-50"
                >
                  <X size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {remoteRequests.filter((request) => request.purpose !== 'catalog' && liveCapabilities.some((capability) => capability.id === request.capabilityId)).length > 0 && (
        <ul className="mt-2 space-y-1.5" data-testid="agent-start-remote-requests">
          {remoteRequests.filter((request) => request.purpose !== 'catalog' && liveCapabilities.some((capability) => capability.id === request.capabilityId)).map((request) => (
            <li key={request.id} className="flex items-start gap-2 rounded-md border border-violet-500/20 bg-violet-500/5 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="text-mini text-app-text-secondary">{t(`share.agentStart.remoteState.${request.state}`)}</p>
                {request.code && request.state === 'pending' && <p className="mt-0.5 font-mono text-prose tracking-[0.18em] text-app-text">{request.code}</p>}
                <p className="mt-0.5 text-micro leading-snug text-app-text-muted">{t('share.agentStart.remoteStatusNote')}</p>
              </div>
              {(request.state === 'expired' || request.state === 'failed' || request.state === 'denied') && (
                <button type="button" disabled={busy} onClick={() => void recoverRemote(request.id)} aria-label={t('share.agentStart.remoteReissue')} title={t('share.agentStart.remoteReissue')} className="rounded p-1 text-app-text-tertiary hover:bg-app-hover hover:text-app-text disabled:opacity-50"><RefreshCw size={12} /></button>
              )}
              {request.state !== 'revoked' && (
                <button type="button" disabled={busy} onClick={() => void revokeRemote(request.id)} aria-label={t('share.agentStart.remoteRequestRevoke')} title={t('share.agentStart.remoteRequestRevoke')} className="rounded p-1 text-app-text-tertiary hover:bg-app-hover hover:text-red-500 disabled:opacity-50"><X size={12} /></button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="mt-2 space-y-2 rounded-md border border-violet-500/25 bg-violet-500/5 p-2" data-testid="agent-start-form">
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            <div className="text-micro text-app-text-muted">
              <span>{t('share.agentStart.subject')}</span>
              <Select value={subject} options={availableSubjects.map((item) => ({ value: subjectKey(item), label: item.name }))} onChange={setSubject} ariaLabel={t('share.agentStart.subject')} className="mt-0.5 w-full" />
            </div>
            <div className="text-micro text-app-text-muted">
              <span>{t('share.agentStart.computer')}</span>
              <Select
                value={computer}
                options={computers.map((item) => ({ value: item.id, label: item.name, hint: item.repositoryName }))}
                onChange={(nextId) => {
                  const nextModels = computers.find((item) => item.id === nextId)?.models ?? EMPTY_MODEL_CHOICES;
                  setComputer(nextId);
                  setModel(preferredAgentStartModel(nextModels, inventory.recommendedModel));
                }}
                ariaLabel={t('share.agentStart.computer')}
                className="mt-0.5 w-full"
              />
            </div>
            {selectedComputer?.modelSupport !== 'unverified' && (
              <>
                <div className="text-micro text-app-text-muted">
                  <span>{t('share.agentStart.model')}</span>
                  <Select value={model} onChange={setModel} ariaLabel={t('share.agentStart.model')} placeholder={t('share.agentStart.chooseModel')} className="mt-0.5 w-full" options={modelChoices.map((item) => ({ value: item.id, label: item.label ?? friendlyModelLabel(item.id) }))} />
                </div>
                <div className="text-micro text-app-text-muted">
                  <span>{t('share.agentStart.effort')}</span>
                  <Select value={effort} options={efforts.map((item) => ({ value: item, label: item }))} onChange={setEffort} ariaLabel={t('share.agentStart.effort')} className="mt-0.5 w-full" />
                </div>
                <div className="text-micro text-app-text-muted sm:col-span-2">
                  <span>{t('share.agentStart.duration')}</span>
                  <Select value={duration} options={durations.map((item) => ({ value: String(item), label: t('share.agentStart.minutes', { n: item }) }))} onChange={setDuration} ariaLabel={t('share.agentStart.duration')} className="mt-0.5 w-full" />
                </div>
              </>
            )}
          </div>
          {selectedComputer && (
            <div className="space-y-1 text-micro leading-snug text-app-text-muted">
              <p>{t('share.agentStart.repository', { repository: selectedComputer.repositoryName })}</p>
              {selectedComputer.modelSupport === 'unverified' && (
                <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2">
                  <p className="text-amber-400">{t('share.agentStart.remoteModelsUnverified')}</p>
                  <p className="mt-1 text-app-text-muted">{t('share.agentStart.catalogNote')}</p>
                  {catalogRequest ? (
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className="flex-1 text-mini text-app-text-secondary">{t(`share.agentStart.catalogState.${catalogRequest.state}`)}</span>
                      {catalogRequest.code && catalogRequest.state === 'pending' && <span className="font-mono text-prose tracking-[0.18em] text-app-text">{catalogRequest.code}</span>}
                      {(catalogRequest.state === 'expired' || catalogRequest.state === 'failed' || catalogRequest.state === 'denied' || catalogRequest.state === 'active') && (
                        <button type="button" disabled={busy} onClick={() => void recoverRemote(catalogRequest.id)} className="rounded border border-app-border px-2 py-1 text-mini text-app-text hover:bg-app-hover disabled:opacity-50">{t('share.agentStart.verifyComputer')}</button>
                      )}
                    </div>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => void verifyComputer()} className="mt-1.5 rounded border border-app-border px-2 py-1 text-mini text-app-text hover:bg-app-hover disabled:opacity-50">{t('share.agentStart.verifyComputer')}</button>
                  )}
                </div>
              )}
            </div>
          )}
          {selectedComputer?.modelSupport !== 'unverified' && (
            <>
              <label className="flex cursor-pointer items-start gap-2 text-mini leading-snug text-app-text-secondary">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" />
                <span><ShieldCheck size={11} className="mr-1 inline" />{t('share.agentStart.confirm')}</span>
              </label>
              <p className="text-micro leading-snug text-app-text-muted">{t('share.agentStart.policyNote')}</p>
            </>
          )}
          <div className="flex justify-end gap-1.5">
            <button type="button" disabled={busy} onClick={resetForm} className="rounded px-2 py-1 text-mini text-app-text-secondary hover:bg-app-hover disabled:opacity-50">{t('common.cancel')}</button>
            {selectedComputer?.modelSupport !== 'unverified' && (
              <button type="button" disabled={!ready || busy} onClick={() => void grant()} className="rounded bg-violet-600 px-2 py-1 text-mini text-white disabled:opacity-40">{t('share.agentStart.confirmAction')}</button>
            )}
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-1.5 px-1.5 text-mini text-red-500">{error}</p>}
    </section>
  );
}
