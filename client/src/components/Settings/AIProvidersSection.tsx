/**
 * «PROVIDER E CHIAVI», THE LEVELS (model selector revision 2026-10-04, §5).
 *
 * The list of accounts (`ProvidersView`) and the detail of one
 * (`ProviderDetail`), plus the three «+» forms (an API key, an endpoint, a
 * program). Drawn inside the model selector, in place of the models, in the
 * same panel (Ribaltamento 2): ‹ and Escape go back one level, the detail to
 * the list and the list to the models. Drawn in the centred sheet when no chip
 * is on screen, the list has no ‹ and a close instead.
 *
 * One state for every level: the providers snapshot (pushed over the WS), the
 * app settings, the programs and the endpoints the server knows, and the test
 * of a provider with its 15 s watchdog.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderSnapshotEntry } from '../../types';
import { providersApi, appSettingsApi, type AppBehaviorSettings, type CliAgentPresence } from '../../lib/api';
import type { DirectEndpointView } from '../../../../shared/direct-endpoints';
import { providerNameForEndpoint } from '../../../../shared/direct-endpoints';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { usePlanUsage } from '../../state/planUsage';
import { useT } from '../../hooks/useT';
import { focusableWithin } from '../../hooks/useModalDialog';
import { isTypingSurface } from '../../hooks/useMenuKeyboard';
import { stepFocus } from '../Sidebar/stepFocus';
import { claudePlanWarning, claudeSubscription, providersCountTail, subscriptionLabel } from '../Sidebar/formLevelTails';
import { signInCommand } from '../Shared/ModelSelector/useModelCatalog';
import { endpointHost, providerCards, type ProviderCard } from './providersModel';
import { API_PROVIDERS, PROVIDER_MODEL_FIELD, type ApiProviderName } from './providerFormat';
import { LevelBack, ProvidersView } from './ProvidersView';
import { ProviderDetail, type TestResult } from './ProviderDetail';
import { ApiKeyForm } from './ApiProviderSetup';
import { EndpointForm } from './DirectEndpointsPanel';
import { CliAgentRow } from './CliAgentsPanel';

/** Where a door asks the levels to open: an account, and the field to focus. */
export interface ProvidersTarget {
  account?: string;
  focus?: 'key' | 'path';
}

type View =
  | { kind: 'list' }
  | { kind: 'account'; name: string; focus?: 'key' | 'path' }
  | { kind: 'add'; what: 'key' | 'endpoint' | 'program' };

/** How long a test waits for a fresh snapshot before it reports a timeout. */
const TEST_WATCHDOG_MS = 15_000;

/** One settings copy shared by every level. Saves reconcile with the server;
 *  `apply` mirrors changes made through the separate provider-default endpoint. */
function useBehaviorSettings() {
  const [settings, setSettings] = useState<AppBehaviorSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tr = useT();

  useEffect(() => {
    let live = true;
    appSettingsApi.get()
      .then((s) => { if (live) setSettings(s); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : tr('ai.providers.saveError')); });
    return () => { live = false; };
  }, [tr]);

  const apply = useCallback((patch: Partial<AppBehaviorSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const save = useCallback(async (patch: Partial<AppBehaviorSettings>) => {
    setSaving(true);
    setError(null);
    apply(patch);
    try {
      setSettings(await appSettingsApi.update(patch));
    } catch (e) {
      setError(e instanceof Error ? e.message : tr('ai.providers.saveError'));
      // Re-fetch to drop the optimistic value on failure.
      try { setSettings(await appSettingsApi.get()); } catch { /* keep the last one */ }
      throw e;
    } finally {
      setSaving(false);
    }
  }, [apply, tr]);

  return { settings, saving, error, save, apply };
}

/**
 * «Prova» and «Riprova»: ask the server for a fresh probe of one provider and
 * read the answer from the snapshot it pushes, so every window sees the same
 * state. A watchdog stops the spinner if no fresh entry arrives in time.
 */
function useProviderTest(entries: ProviderSnapshotEntry[], refresh: (name?: string) => Promise<void>) {
  const tr = useT();
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const triggeredAt = useRef(new Map<string, string>());
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (watchdog.current) clearTimeout(watchdog.current); }, []);

  useEffect(() => {
    if (!testing) return;
    const entry = entries.find((e) => e.name === testing);
    const previous = triggeredAt.current.get(testing);
    if (!entry || !previous || entry.fetchedAt === previous) return;
    const ok = entry.status === 'ready';
    const message = ok
      ? [tr('ai.selector.status.ready'), entry.models.length ? tr('ai.test.models', { count: entry.models.length }) : '', entry.version ? `v${entry.version}` : '']
        .filter(Boolean).join(' · ')
      : entry.lastError ?? tr(`ai.selector.status.${entry.status}`);
    if (watchdog.current) { clearTimeout(watchdog.current); watchdog.current = null; }
    setResults((prev) => ({ ...prev, [testing]: { ok, message, at: Date.now() } }));
    triggeredAt.current.delete(testing);
    setTesting(null);
  }, [entries, testing, tr]);

  const test = useCallback(async (name: string) => {
    triggeredAt.current.set(name, entries.find((e) => e.name === name)?.fetchedAt ?? '');
    setTesting(name);
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = setTimeout(() => {
      watchdog.current = null;
      triggeredAt.current.delete(name);
      setResults((prev) => ({ ...prev, [name]: { ok: false, message: tr('ai.test.timedOut'), at: Date.now() } }));
      setTesting(null);
    }, TEST_WATCHDOG_MS);
    try {
      await refresh(name);
    } catch (err) {
      if (watchdog.current) { clearTimeout(watchdog.current); watchdog.current = null; }
      triggeredAt.current.delete(name);
      setResults((prev) => ({ ...prev, [name]: { ok: false, message: err instanceof Error ? err.message : tr('ai.test.failed'), at: Date.now() } }));
      setTesting(null);
    }
  }, [entries, refresh, tr]);

  return { testing, results, test };
}

/** The programs the server looks for, and the endpoints it keeps. */
function useLocalSources() {
  const [agents, setAgents] = useState<CliAgentPresence[]>([]);
  const [endpoints, setEndpoints] = useState<DirectEndpointView[]>([]);
  const loadEndpoints = useCallback(async () => {
    try {
      setEndpoints((await providersApi.listEndpoints()).endpoints);
    } catch {
      // A failed list is an empty list: the cards still come from the snapshot.
      setEndpoints([]);
    }
  }, []);
  useEffect(() => {
    let live = true;
    providersApi.cliAgents().then((res) => { if (live) setAgents(res.agents); }, () => { /* no programs to show */ });
    providersApi.listEndpoints().then((res) => { if (live) setEndpoints(res.endpoints); }, () => { /* the snapshot still lists them */ });
    return () => { live = false; };
  }, []);
  return { agents, setAgents, endpoints, loadEndpoints };
}

/** A press of Escape that belongs to something opened inside the level (a
 *  list of a `Select`), not to the level. */
function escapeBelongsToChild(root: HTMLElement): boolean {
  const active = document.activeElement as HTMLElement | null;
  const popover = active?.closest('[data-popover]');
  if (popover && !popover.contains(root)) return true;
  return !!root.querySelector('[aria-expanded="true"][aria-haspopup="listbox"]');
}

export interface ProvidersLevelsProps {
  target?: ProvidersTarget;
  /** In the selector: ‹ and Escape on the list go back to the models. */
  onBackToModels?: () => void;
  /** Closes the surface: «Accedi» opens a terminal and the panel goes away. */
  onClose: () => void;
  /** The sheet only: a close button in the list's heading. */
  closeTestId?: string;
}

export function ProvidersLevels({ target, onBackToModels, onClose, closeTestId }: ProvidersLevelsProps) {
  const tr = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const { snapshot, error, refresh, retry } = useProvidersSnapshot();
  const entries = useMemo(() => snapshot?.providers ?? [], [snapshot]);
  const { settings, saving, error: settingsError, save, apply } = useBehaviorSettings();
  const { testing, results, test } = useProviderTest(entries, refresh);
  const { agents, setAgents, endpoints, loadEndpoints } = useLocalSources();
  const usage = usePlanUsage();
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => (target?.account ? { kind: 'account', name: target.account, focus: target.focus } : { kind: 'list' }));
  const lastOpened = useRef<string | null>(null);

  const names = useMemo(() => new Set(entries.map((entry) => entry.name)), [entries]);
  const hosts = useMemo(() => Object.fromEntries(endpoints.flatMap((endpoint) => {
    const host = endpointHost(endpoint.baseUrl);
    return host ? [[providerNameForEndpoint(endpoint), host]] : [];
  })), [endpoints]);
  const unregistered = useMemo(
    () => agents.filter((agent) => agent.installed && !names.has(agent.id)).map((agent) => ({ name: agent.id, label: agent.name })),
    [agents, names],
  );
  const cards = useMemo(() => providerCards(snapshot, unregistered, hosts), [snapshot, unregistered, hosts]);
  const count = providersCountTail(snapshot, tr);
  const plan = subscriptionLabel(claudeSubscription(snapshot));
  const planWarning = claudePlanWarning(usage?.fiveHour ?? null, usage?.sevenDay ?? null, tr);

  const open = useCallback((card: ProviderCard, focus?: 'key' | 'path') => {
    lastOpened.current = card.name;
    setView({ kind: 'account', name: card.name, focus });
  }, []);

  const signIn = useCallback((command: string) => {
    onClose();
    // «Accedi» acts on the first press: a Topics terminal with the command
    // typed, not run (§5.4); without a chat it opens in the home folder.
    window.dispatchEvent(new CustomEvent('topics:open-terminal-with-command', { detail: { command } }));
  }, [onClose]);

  const act = (card: ProviderCard) => {
    if (card.action === 'signIn') {
      const command = signInCommand(card.name);
      if (command) { signIn(command); return; }
    }
    if (card.action === 'retry') { void test(card.name); return; }
    open(card, card.action === 'addKey' ? 'key' : card.action === 'setUp' ? 'path' : undefined);
  };

  const back = useCallback(() => {
    if (view.kind !== 'list') { setView({ kind: 'list' }); return true; }
    if (onBackToModels) { onBackToModels(); return true; }
    return false;
  }, [view.kind, onBackToModels]);

  // ESCAPE GOES BACK ONE LEVEL. The panel listens on the document in the
  // capture phase; this listens on the window, earlier, and lets through what
  // belongs to a list opened inside, and the last Escape of the sheet.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !rootRef.current) return;
      if (escapeBelongsToChild(rootRef.current)) return;
      if (view.kind === 'list' && !onBackToModels) return;
      event.stopPropagation();
      event.preventDefault();
      back();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [back, view.kind, onBackToModels]);

  // The focus follows the level: the card that was opened when back on the
  // list, the field a door asked for, else the level's ‹ (or its first control).
  const viewKey = view.kind === 'account' ? `account:${view.name}:${view.focus ?? ''}` : view.kind === 'add' ? `add:${view.what}` : 'list';
  const kind = view.kind;
  const focusField = view.kind === 'account' ? view.focus ?? null : null;
  useEffect(() => {
    // A field asked for by the door takes the focus itself (`autoFocus`, `focusPath`).
    if (focusField) return;
    const frame = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      const card = kind === 'list' && lastOpened.current
        ? root.querySelector<HTMLElement>(`[data-testid="provider-card-${lastOpened.current}"] [data-testid="provider-card-open"]`)
        : null;
      const first = kind === 'add' ? root.querySelector<HTMLElement>('input') : null;
      (card ?? first ?? root.querySelector<HTMLElement>('[data-testid="level-back"]') ?? focusableWithin(root)[0])?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [viewKey, kind, focusField]);

  // ↓ ↑ walk the controls of the level, and Tab stays in it: the panel is
  // portalled to <body>, and WebKit's own Tab skips buttons.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const root = rootRef.current;
    if (!root) return;
    if (event.key === 'Tab') {
      const items = focusableWithin(root);
      if (items.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const active = document.activeElement as HTMLElement | null;
      stepFocus(items, active && root.contains(active) ? active : null, event.shiftKey).focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || isTypingSurface(event.target)) return;
    const items = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), summary')];
    if (items.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const setDefault = async (name: string) => {
    setDefaultError(null);
    try {
      await providersApi.setDefault(name);
      apply({ aiProvider: name });
      await refresh();
    } catch {
      setDefaultError(tr('ai.providers.default.error'));
    }
  };
  const clearDefault = async () => {
    setDefaultError(null);
    try {
      await save({ aiProvider: null });
      await refresh();
    } catch {
      setDefaultError(tr('ai.providers.default.error'));
    }
  };

  const modelSharedWith = (name: string) => {
    const field = PROVIDER_MODEL_FIELD[name];
    if (!field) return [];
    return entries.filter((e) => e.name !== name && PROVIDER_MODEL_FIELD[e.name] === field).map((e) => e.label ?? e.name);
  };

  let body: React.ReactNode;
  const account = view.kind === 'account' ? cards.find((card) => card.name === view.name) : undefined;
  if (view.kind === 'account' && account) {
    const endpoint = endpoints.find((item) => providerNameForEndpoint(item) === account.name);
    body = (
      <ProviderDetail
        key={account.name}
        card={account}
        entry={entries.find((entry) => entry.name === account.name)}
        snapshot={snapshot}
        agent={agents.find((agent) => agent.id === account.name)}
        endpoint={endpoint}
        settings={settings}
        saving={saving}
        error={defaultError ?? settingsError}
        focus={view.focus}
        testing={testing === account.name}
        result={results[account.name]}
        modelSharedWith={modelSharedWith(account.name)}
        onBack={() => setView({ kind: 'list' })}
        onTest={() => { void test(account.name); }}
        signInCommand={signInCommand(account.name)}
        onSignIn={signIn}
        onSave={save}
        onSetDefault={() => { void setDefault(account.name); }}
        onClearDefault={() => { void clearDefault(); }}
        onKeySaved={() => refresh(account.name)}
        onAgentsChanged={setAgents}
        onRemoveEndpoint={(id) => {
          void providersApi.deleteEndpoint(id).finally(() => {
            void loadEndpoints();
            void refresh();
            setView({ kind: 'list' });
          });
        }}
      />
    );
  } else if (view.kind === 'add') {
    body = (
      <AddLevel
        what={view.what}
        missingKeys={(Object.keys(API_PROVIDERS) as ApiProviderName[]).filter((name) => !names.has(name))}
        missingPrograms={agents.filter((agent) => !agent.installed && !names.has(agent.id))}
        onBack={() => setView({ kind: 'list' })}
        onKeySaved={async (name) => { await refresh(name); lastOpened.current = name; setView({ kind: 'list' }); }}
        onEndpointSaved={async () => { await loadEndpoints(); await refresh(); setView({ kind: 'list' }); }}
        onAgentsChanged={setAgents}
      />
    );
  } else {
    body = (
      <ProvidersView
        cards={cards}
        count={count}
        plan={plan}
        planWarning={planWarning}
        onBack={onBackToModels}
        onClose={onBackToModels ? undefined : onClose}
        closeTestId={closeTestId}
        busy={new Set(testing ? [testing] : [])}
        loadError={error && entries.length === 0 ? error.message : null}
        onRetryLoad={() => { void retry(); }}
        missingDefault={snapshot && settings?.aiProvider && !names.has(settings.aiProvider) ? settings.aiProvider : null}
        onDropMissingDefault={() => { void clearDefault(); }}
        onOpen={(card) => open(card)}
        onAction={act}
        onAdd={(what) => setView({ kind: 'add', what })}
      />
    );
  }

  return (
    <div ref={rootRef} data-testid="ai-providers-settings" data-level={view.kind} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
      {body}
    </div>
  );
}

/** «+ Chiave API», «+ Endpoint», «+ Programma»: the forms of what is not here yet. */
function AddLevel({ what, missingKeys, missingPrograms, onBack, onKeySaved, onEndpointSaved, onAgentsChanged }: {
  what: 'key' | 'endpoint' | 'program';
  missingKeys: ApiProviderName[];
  missingPrograms: CliAgentPresence[];
  onBack: () => void;
  onKeySaved: (name: ApiProviderName) => Promise<void>;
  onEndpointSaved: () => Promise<void>;
  onAgentsChanged: (agents: CliAgentPresence[]) => void;
}) {
  const tr = useT();
  const title = what === 'key' ? tr('ai.providers.add.keyTitle') : what === 'endpoint' ? tr('ai.endpoints.add') : tr('ai.local.title');
  return (
    <div data-testid={`providers-add-${what}-level`} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-app-border px-1 py-1">
        <LevelBack label={tr('ai.providers.backToList')} onBack={onBack} />
        <h2 className="min-w-0 flex-1 truncate px-1 text-compact font-semibold text-app-text">{title}</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-2">
        {what === 'key' && (missingKeys.length === 0
          ? <p className="text-compact text-app-text-secondary">{tr('ai.providers.add.keyNone')}</p>
          : (
            <>
              <p className="text-mini text-app-text-secondary">{tr('ai.api.chat')}</p>
              {missingKeys.map((name) => <ApiKeyForm key={name} provider={name} replacing={false} onSaved={() => onKeySaved(name)} />)}
              <p data-testid="api-billing-note" className="text-mini text-app-text-secondary">{tr('ai.api.billing')}</p>
            </>
          ))}
        {what === 'endpoint' && (
          <>
            <p className="text-mini text-app-text-secondary">{tr('ai.endpoints.hint')}</p>
            <EndpointForm onCancel={onBack} onSaved={onEndpointSaved} />
          </>
        )}
        {what === 'program' && (missingPrograms.length === 0
          ? <p className="text-compact text-app-text-secondary">{tr('ai.providers.add.programNone')}</p>
          : (
            <>
              <p className="text-mini text-app-text-secondary">{tr('ai.local.hint')}</p>
              {missingPrograms.map((agent) => <CliAgentRow key={agent.id} agent={agent} onChanged={onAgentsChanged} />)}
            </>
          ))}
      </div>
    </div>
  );
}
