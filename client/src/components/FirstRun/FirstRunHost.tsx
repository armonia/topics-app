import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Monitor, UserRound, WandSparkles } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { appSettingsApi, peopleApi, providersApi, systemApi, type AppBehaviorSettings, type CliAgentPresence } from '@/lib/api';
import { openUserMenu } from '@/lib/openUserMenu';
import { OPEN_FIRST_RUN_EVENT } from '@/lib/openFirstRun';
import type { ApiProviderName } from '@/components/Settings/providerFormat';
import { ApiKeyForm } from '@/components/Settings/ApiProviderSetup';
import { agentSetupRows } from './agentSetupRows';

interface FirstRunData {
  settings: AppBehaviorSettings;
  owner: { id: string; name: string } | null;
  agents: CliAgentPresence[];
  providers: Awaited<ReturnType<typeof providersApi.snapshot>>['providers'];
}

// The owner is born with this name (migration 084): while it stands, the installation is on its first opening.
const OWNER_PLACEHOLDER_NAME = 'Proprietario';

export function FirstRunHost() {
  const t = useT();
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState<FirstRunData | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    const settings = await appSettingsApi.get();
    if (settings.firstRunDoneAt && !force) {
      setData((current) => current ? { ...current, settings } : current);
      return;
    }
    const people = await peopleApi.list({ stats: false });
    const owner = people.people.find((person) => person.isMe);
    if (!force && owner && owner.displayName !== OWNER_PLACEHOLDER_NAME) {
      // An owner with a real name is past the first opening: record it once, so later starts read one setting.
      const done = await appSettingsApi.update({ firstRunDoneAt: new Date().toISOString() });
      setData((current) => current ? { ...current, settings: done } : current);
      return;
    }
    const [agentResponse, snapshot] = await Promise.all([systemApi.agents(), providersApi.snapshot()]);
    const next = {
      settings,
      owner: owner ? { id: owner.id, name: owner.displayName } : null,
      agents: agentResponse.agents,
      providers: snapshot.providers,
    };
    setData(next);
    setName(owner?.displayName ?? '');
    if (!settings.firstRunDoneAt) setVisible(true);
  }, []);

  useEffect(() => {
    let live = true;
    void load().catch(() => { if (live) setError(t('firstRun.loadError')); });
    const reopen = () => {
      setVisible(true);
      setError(null);
      void load(true).catch(() => { if (live) setError(t('firstRun.loadError')); });
    };
    window.addEventListener(OPEN_FIRST_RUN_EVENT, reopen);
    return () => { live = false; window.removeEventListener(OPEN_FIRST_RUN_EVENT, reopen); };
  }, [load, t]);

  useEffect(() => {
    if (!visible) return;
    void appSettingsApi.update({ firstRunDoneAt: new Date().toISOString() }).then((settings) => {
      setData((current) => current ? { ...current, settings } : current);
    }).catch(() => setError(t('firstRun.loadError')));
  }, [visible, t]);

  const close = async () => {
    setBusy(true);
    setError(null);
    try {
      const settings = await appSettingsApi.update({ firstRunDoneAt: new Date().toISOString() });
      setData((current) => current ? { ...current, settings } : current);
      setVisible(false);
    } catch {
      setError(t('firstRun.loadError'));
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    if (!data?.owner || busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await peopleApi.rename(data.owner.id, name.trim());
      setData((current) => current?.owner ? { ...current, owner: { ...current.owner, name: name.trim() } } : current);
      window.dispatchEvent(new Event('topics:identity-changed'));
    } catch {
      setError(t('firstRun.nameError'));
    } finally {
      setBusy(false);
    }
  };

  if (!visible) return null;
  const agentRows = agentSetupRows(data?.agents ?? []);
  const defaultProvider = data?.providers.find((provider) => provider.isDefault) ?? data?.providers.find((provider) => provider.name === data.settings.aiProvider);
  const apiKeyRequirement = defaultProvider?.requirements.find((requirement) => requirement.key === 'ANTHROPIC_API_KEY' || requirement.key === 'OPENAI_API_KEY');
  const missingKey = apiKeyRequirement && !apiKeyRequirement.present ? apiKeyRequirement : null;
  const keyProvider: ApiProviderName | null = missingKey?.key === 'ANTHROPIC_API_KEY' ? 'claude' : missingKey?.key === 'OPENAI_API_KEY' ? 'openai' : null;
  const declaredModel = defaultProvider?.defaultModel ?? defaultProvider?.models[0] ?? null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-auto bg-black/50 p-4 sm:p-8" data-testid="first-run-backdrop">
      <section role="dialog" aria-modal="true" aria-labelledby="first-run-title" data-testid="first-run" className="my-auto w-full max-w-4xl rounded-2xl border border-app-border bg-surface p-5 text-app-text shadow-2xl sm:p-8">
        <header className="mb-6">
          <h1 id="first-run-title" className="text-display-sm font-semibold">{t('firstRun.title')}</h1>
          <p className="mt-2 text-prose text-app-text-muted">{t('firstRun.subtitle')}</p>
        </header>
        <div className="grid gap-4 md:grid-cols-2">
          <article className="rounded-xl border border-app-border p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold"><UserRound size={18} />{t('firstRun.identity')}</h2>
            <label className="mb-1 block text-mini text-app-text-muted" htmlFor="first-run-name">{t('firstRun.name')}</label>
            <div className="flex gap-2">
              <input id="first-run-name" data-testid="first-run-name" value={name} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1 rounded-md border border-app-border bg-app-bg px-3 py-2 text-compact" maxLength={64} />
              <button type="button" data-testid="first-run-save-name" onClick={() => void saveName()} disabled={busy || !name.trim()} className="rounded-md bg-primary px-3 py-2 text-compact text-white disabled:opacity-50">{t('firstRun.saveName')}</button>
            </div>
          </article>
          <article className="rounded-xl border border-app-border p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold"><Monitor size={18} />{t('firstRun.machine')}</h2>
            <ul className="space-y-2 text-mini">
              {agentRows.map((agent) => <li key={agent.id} data-testid={`first-run-agent-${agent.id}`}>
                <div className="flex items-center justify-between gap-2"><span>{agent.name}</span><span className={agent.installed ? 'text-green-600' : 'text-app-text-muted'}>{t(agent.installed ? 'firstRun.found' : 'firstRun.missing')}</span></div>
                {agent.installed && agent.path && <code className="block break-all text-app-text-muted">{agent.path}</code>}
                {!agent.installed && <><span className="text-app-text-muted">{t('firstRun.installCommand')}</span><code className="block select-all break-all rounded bg-app-bg p-2">{agent.install}</code></>}
              </li>)}
            </ul>
          </article>
          <article className="rounded-xl border border-app-border p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold"><WandSparkles size={18} />{t('firstRun.responds')}</h2>
            {defaultProvider && <p className="mb-2 text-mini text-app-text-muted">{t('firstRun.provider', { provider: defaultProvider.label ?? defaultProvider.name })}</p>}
            {declaredModel && <p data-testid="first-run-model" className="mb-3 text-mini text-app-text-muted">{t('firstRun.model', { model: declaredModel })}</p>}
            {missingKey && keyProvider ? <><p className="mb-3 text-mini text-app-text-muted">{t('firstRun.keyMissing')}</p><ApiKeyForm provider={keyProvider} replacing={false} onSaved={async () => {
              const snapshot = await providersApi.snapshot();
              setData((current) => current ? { ...current, providers: snapshot.providers } : current);
            }} /></> : <p className="text-mini text-app-text-muted">{t(apiKeyRequirement?.present ? 'firstRun.keyPresent' : 'firstRun.noKeyNeeded')}</p>}
          </article>
          <details className="rounded-xl border border-app-border p-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold"><ExternalLink size={18} />{t('firstRun.remote')}</summary>
            <p className="mt-3 text-mini text-app-text-muted">{t('firstRun.remoteHint')}</p>
            <button type="button" onClick={() => { void close().then(() => openUserMenu()); }} className="mt-3 text-compact font-medium text-primary">{t('firstRun.account')}</button>
          </details>
        </div>
        {error && <p role="alert" className="mt-4 text-mini text-red-600">{error}</p>}
        <footer className="mt-6 flex justify-end gap-3">
          <button type="button" data-testid="first-run-skip" onClick={() => void close()} disabled={busy} className="rounded-md px-4 py-2 text-compact text-app-text-muted hover:bg-app-hover">{t('firstRun.skip')}</button>
          <button type="button" data-testid="first-run-done" onClick={() => void close()} disabled={busy} className="rounded-md bg-primary px-4 py-2 text-compact font-medium text-white disabled:opacity-50">{t('firstRun.done')}</button>
        </footer>
      </section>
    </div>
  );
}
