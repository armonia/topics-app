import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ExternalLink, FolderTree, Globe2, KeyRound, Monitor, UserRound, WandSparkles } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { appSettingsApi, peopleApi, providersApi, systemApi, type AppBehaviorSettings, type CliAgentPresence } from '@/lib/api';
import { openUserMenu } from '@/lib/openUserMenu';
import { OPEN_FIRST_RUN_EVENT } from '@/lib/openFirstRun';
import type { ApiProviderName } from '@/components/Settings/providerFormat';
import { ApiKeyForm } from '@/components/Settings/ApiProviderSetup';
import { MODAL_OVERLAY, MODAL_PANEL } from '@/lib/modalStyles';
import { useExitGhost } from '@/lib/exitGhost';
import { agentSetupRows } from './agentSetupRows';
import { firstRunProviderView, OWNER_PLACEHOLDER_NAME, shouldShowFirstRun } from './firstRunModel';

interface FirstRunData {
  settings: AppBehaviorSettings;
  owner: { id: string; name: string } | null;
  agents: CliAgentPresence[];
  providers: Awaited<ReturnType<typeof providersApi.snapshot>>['providers'];
}

export function FirstRunHost() {
  const t = useT();
  const translateRef = useRef(t);
  translateRef.current = t;
  const overlayRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState<FirstRunData | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The welcome plays before the setup, every time the screen opens.
  const [intro, setIntro] = useState(true);

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
    if (force || shouldShowFirstRun(settings.firstRunDoneAt, owner?.displayName ?? null)) { setIntro(true); setVisible(true); }
  }, []);

  useEffect(() => {
    let live = true;
    void load().catch(() => { if (live) setError(translateRef.current('firstRun.loadError')); });
    const reopen = () => {
      setIntro(true);
      setVisible(true);
      setError(null);
      void load(true).catch(() => { if (live) setError(translateRef.current('firstRun.loadError')); });
    };
    window.addEventListener(OPEN_FIRST_RUN_EVENT, reopen);
    return () => { live = false; window.removeEventListener(OPEN_FIRST_RUN_EVENT, reopen); };
  }, [load]);

  useEffect(() => {
    if (!visible) return;
    void appSettingsApi.update({ firstRunDoneAt: new Date().toISOString() }).then((settings) => {
      setData((current) => current ? { ...current, settings } : current);
    }).catch(() => setError(translateRef.current('firstRun.loadError')));
  }, [visible]);

  const close = async () => {
    setBusy(true);
    setError(null);
    try {
      if (data?.owner && name.trim() !== data.owner.name.trim()) {
        await peopleApi.rename(data.owner.id, name.trim());
        setData((current) => current?.owner ? { ...current, owner: { ...current.owner, name: name.trim() } } : current);
        window.dispatchEvent(new Event('topics:identity-changed'));
      }
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

  useExitGhost(overlayRef, visible, 'modal');
  if (!visible) return null;
  const agentRows = agentSetupRows(data?.agents ?? []);
  const providerView = firstRunProviderView(data?.providers ?? [], data?.settings.aiProvider ?? null);
  const defaultProvider = providerView.provider;
  const keyProvider: ApiProviderName = 'claude';
  const declaredModel = defaultProvider?.defaultModel ?? defaultProvider?.models[0] ?? null;

  const installedCount = agentRows.filter((agent) => agent.installed).length;
  const highlights = [
    { icon: FolderTree, title: t('firstRun.intro.topics'), body: t('firstRun.intro.topicsBody') },
    { icon: Globe2, title: t('firstRun.intro.browser'), body: t('firstRun.intro.browserBody') },
    { icon: KeyRound, title: t('firstRun.intro.keys'), body: t('firstRun.intro.keysBody') },
  ];
  const step = (i: number) => ({ '--i': i }) as React.CSSProperties;

  if (intro) {
    return (
      <div ref={overlayRef} className={`${MODAL_OVERLAY} items-start overflow-auto p-4 sm:p-8`} data-testid="first-run-backdrop">
        <section role="dialog" aria-modal="true" aria-labelledby="first-run-title" data-testid="first-run" data-step="intro" className={`${MODAL_PANEL} relative my-auto w-full max-w-3xl overflow-hidden p-6 text-app-text sm:p-10`}>
          <div aria-hidden="true" className="first-run-glow pointer-events-none absolute -top-24 left-1/2 h-64 w-[28rem] -translate-x-1/2 rounded-full bg-primary/30 blur-3xl" />
          <div className="relative">
            <p className="first-run-rise mb-2 text-mini font-medium uppercase tracking-widest text-primary" style={step(0)}>{t('firstRun.intro.kicker')}</p>
            <h1 id="first-run-title" className="first-run-rise text-display-sm font-semibold sm:text-4xl" style={step(1)}>{t('firstRun.intro.title')}</h1>
            <p className="first-run-rise mt-3 max-w-xl text-prose text-app-text-muted" style={step(2)}>{t('firstRun.intro.lead')}</p>
            <ul className="mt-8 grid gap-3 sm:grid-cols-3">
              {highlights.map(({ icon: Icon, title, body }, index) => (
                <li key={title} className="first-run-rise rounded-xl border border-app-border bg-app-bg/40 p-4" style={step(3 + index)}>
                  <Icon size={20} className="mb-2 text-primary" />
                  <h2 className="text-compact font-semibold">{title}</h2>
                  <p className="mt-1 text-mini text-app-text-muted">{body}</p>
                </li>
              ))}
            </ul>
            <p className="first-run-rise mt-6 text-mini text-app-text-muted" style={step(6)}>{t('firstRun.intro.versus')}</p>
            <footer className="first-run-rise mt-8 flex items-center justify-end gap-3" style={step(7)}>
              <button type="button" data-testid="first-run-skip" onClick={() => void close()} disabled={busy} className="rounded-md px-4 py-2 text-compact text-app-text-muted hover:bg-app-hover">{t('firstRun.skip')}</button>
              <button type="button" data-testid="first-run-start" onClick={() => setIntro(false)} className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-compact font-medium text-white">
                {t('firstRun.intro.start')}<ArrowRight size={16} />
              </button>
            </footer>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div ref={overlayRef} className={`${MODAL_OVERLAY} items-start overflow-auto p-4 sm:p-8`} data-testid="first-run-backdrop">
      <section role="dialog" aria-modal="true" aria-labelledby="first-run-title" data-testid="first-run" data-step="setup" className={`${MODAL_PANEL} my-auto w-full max-w-4xl p-5 text-app-text sm:p-8`}>
        <header className="mb-6">
          <h1 id="first-run-title" className="text-display-sm font-semibold">{t('firstRun.title')}</h1>
          <p className="mt-2 text-prose text-app-text-muted">{t('firstRun.subtitle')}</p>
          <p data-testid="first-run-summary" className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-app-hover px-3 py-1 text-mini text-app-text-muted">
            <Check size={12} className={installedCount > 0 ? 'text-green-600' : 'text-app-text-muted'} />
            {t('firstRun.summary', { n: installedCount })}
          </p>
        </header>
        <div className="grid gap-4 md:grid-cols-2">
          <article className="rounded-xl border border-app-border p-4">
            <h2 className="mb-3 flex items-center gap-2 font-semibold"><UserRound size={18} />{t('firstRun.identity')}</h2>
            <label className="mb-1 block text-mini text-app-text-muted" htmlFor="first-run-name">{t('firstRun.name')}</label>
            <div className="flex gap-2">
              <input id="first-run-name" data-testid="first-run-name" value={name} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1 rounded-md border border-app-border bg-app-bg px-3 py-2 text-compact" maxLength={80} />
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
            {providerView.providerName && <p className="mb-2 text-mini text-app-text-muted">{t('firstRun.provider', { provider: defaultProvider?.label ?? providerView.providerName })}</p>}
            {declaredModel && <p data-testid="first-run-model" className="mb-3 text-mini text-app-text-muted">{t('firstRun.model', { model: declaredModel })}</p>}
            {!providerView.ready && <div className="mb-3 space-y-1 text-mini text-app-text-muted">
              <p>{t('firstRun.providerNotReady', { provider: providerView.providerName ?? t('firstRun.noProvider'), status: t(`firstRun.status.${providerView.status}`) })}</p>
              {providerView.requirements.length > 0 ? providerView.requirements.map((requirement) => <p key={requirement.key}>{t('firstRun.requirementMissing', { requirement: requirement.label })}{requirement.hint ? `: ${requirement.hint}` : ''}</p>) : <p>{t('firstRun.providerNextStep')}</p>}
            </div>}
            {providerView.showAnthropicKey ? <><p className="mb-3 text-mini text-app-text-muted">{t('firstRun.keyMissing')}</p><ApiKeyForm provider={keyProvider} replacing={false} onSaved={async () => {
              const snapshot = await providersApi.snapshot();
              setData((current) => current ? { ...current, providers: snapshot.providers } : current);
            }} /></> : providerView.ready ? <p className="text-mini text-app-text-muted">{t('firstRun.keyPresent')}</p> : null}
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
