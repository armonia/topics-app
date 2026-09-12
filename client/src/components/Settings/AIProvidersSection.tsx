import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { X, Cpu, Check, ChevronDown, ChevronRight, RefreshCw, Copy, AlertCircle } from 'lucide-react';
import type { ProviderSnapshotEntry } from '../../types';
import { providersApi, appSettingsApi, type AppBehaviorSettings } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { enabledToSelect, selectToEnabled } from './behaviorDefaults';
import { EFFORT_TIERS, CODEX_REASONING_EFFORTS } from '../../../../shared/effort';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { AGENT_RUNTIMES, DEFAULT_AGENT_RUNTIME } from '../../../../shared/types';
import { SettingSelect } from './SettingSelect';
import { AgentRuntimeChoice } from './AgentRuntimeChoice';
import { ApiKeyForm, ApiProviderSetup } from './ApiProviderSetup';
import { TurnCheckpointsChoice } from './TurnCheckpointsChoice';
import { CliAgentsPanel } from './CliAgentsPanel';
import {
  API_PROVIDERS,
  isApiProvider,
  STATUS_COLORS,
  relativeTime,
  PROVIDER_MODEL_FIELD,
} from './providerFormat';

interface TestResult {
  ok: boolean;
  message: string;
  at: number;
}

/** Provider cards own their model settings and the validated default action. */
export function AIProvidersSection() {
  const tr = useT();
  // Single subscription point — replaces the per-component fetches the section
  // used to do. Snapshot updates arrive via WS, so opening Settings in two
  // windows shows identical state without either window polling.
  const { snapshot, loading, error, refresh, retry } = useProvidersSnapshot();
  // Runtime selection belongs in the advanced execution section.
  const entries: ProviderSnapshotEntry[] = useMemo(
    () => (snapshot?.providers ?? []).filter(
      (p) => !(AGENT_RUNTIMES as readonly string[]).includes(p.name),
    ),
    [snapshot],
  );

  // Fetch shared settings once, rather than once per expanded card.
  const { settings, saving, error: settingsError, save, apply } = useBehaviorSettings();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [defaultError, setDefaultError] = useState<string | null>(null);

  // When a `test()` is in flight we set `testing = name` and remember the
  // entry's `fetchedAt` at trigger time. The snapshot pushes a new entry once
  // the server-side probe finishes; we detect that by comparing `fetchedAt`
  // and synthesize the user-visible result message. This avoids a parallel
  // HTTP path — every consumer sees the same snapshot.
  const testTriggeredAt = useRef<Map<string, string>>(new Map());
  // Watchdog timer for the in-flight test — if no fresh snapshot lands within
  // the timeout we clear `testing` and surface a timeout result so the spinner
  // doesn't stick forever.
  const testWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the watchdog on unmount so a pending timer can't fire after teardown.
  useEffect(() => () => {
    if (testWatchdog.current) clearTimeout(testWatchdog.current);
  }, []);

  useEffect(() => {
    if (!testing) return;
    const entry = entries.find((e) => e.name === testing);
    if (!entry) return;
    const previousAt = testTriggeredAt.current.get(testing);
    if (!previousAt || entry.fetchedAt === previousAt) return;
    // A fresh row landed — derive result from it.
    const ok = entry.status === 'ready';
    // Lo stato a parole viene dal dizionario, come il pallino accanto al nome:
    // era l'unico punto della scheda che rispondeva in italiano fisso (e in
    // inglese fisso, via `STATUS_LABELS`) qualunque lingua avesse scelto chi legge.
    const message = ok
      ? [
        tr('ai.status.ready'),
        entry.models.length ? tr('ai.test.models', { count: entry.models.length }) : '',
        entry.version ? `v${entry.version}` : '',
      ].filter(Boolean).join(' · ')
      : entry.lastError ?? tr(`ai.status.${entry.status}`);
    if (testWatchdog.current) { clearTimeout(testWatchdog.current); testWatchdog.current = null; }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- converging external-store sync: derives the test result from a freshly-arrived WS snapshot and clears `testing`, which guards against re-runs (no cascade)
    setResults((prev) => ({ ...prev, [testing]: { ok, message, at: Date.now() } }));
    testTriggeredAt.current.delete(testing);
    setTesting(null);
  }, [entries, testing, tr]);

  const setDefault = async (name: string) => {
    setDefaultError(null);
    try {
      // This endpoint validates the choice against the live registry.
      await providersApi.setDefault(name);
      // The endpoint also updates app settings; mirror the explicit choice.
      apply({ aiProvider: name });
      await refresh();
    } catch (e) {
      setDefaultError(e instanceof Error ? e.message : 'non è stato possibile impostare il default');
    }
  };

  const clearDefault = async () => {
    setDefaultError(null);
    try {
      // Clearing the override lets the server recompute its fallback.
      await save({ aiProvider: null });
      await refresh();
    } catch (e) {
      setDefaultError(e instanceof Error ? e.message : 'non è stato possibile togliere il default');
    }
  };

  const test = async (name: string) => {
    const entry = entries.find((e) => e.name === name);
    testTriggeredAt.current.set(name, entry?.fetchedAt ?? '');
    setTesting(name);
    // Arm a watchdog: if no fresh snapshot converges in time, stop spinning
    // and report a timeout instead of hanging indefinitely.
    if (testWatchdog.current) clearTimeout(testWatchdog.current);
    testWatchdog.current = setTimeout(() => {
      testWatchdog.current = null;
      testTriggeredAt.current.delete(name);
      setResults((prev) => ({ ...prev, [name]: { ok: false, message: tr('ai.test.timedOut'), at: Date.now() } }));
      setTesting(null);
    }, 15000);
    try {
      await refresh(name);
    } catch (err) {
      if (testWatchdog.current) { clearTimeout(testWatchdog.current); testWatchdog.current = null; }
      const message = err instanceof Error ? err.message : tr('ai.test.failed');
      setResults((prev) => ({ ...prev, [name]: { ok: false, message, at: Date.now() } }));
      testTriggeredAt.current.delete(name);
      setTesting(null);
    }
  };

  // Warn when multiple provider cards write the same model setting.
  const modelFieldSiblings = useMemo(() => {
    const byField = new Map<string, string[]>();
    for (const e of entries) {
      const field = PROVIDER_MODEL_FIELD[e.name];
      if (!field) continue;
      byField.set(field, [...(byField.get(field) ?? []), e.label ?? e.name]);
    }
    return byField;
  }, [entries]);

  // Keep setup reachable when a previously registered provider fails.
  const providersBody = error && entries.length === 0 ? (
    <div className="flex items-center gap-2 text-compact text-red-500">
      <AlertCircle size={12} className="flex-shrink-0" />
      <span className="break-words flex-1">{error.message || 'Failed to load providers.'}</span>
      <button
        onClick={() => { void retry(); }}
        className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-mini bg-surface border border-app-border hover:bg-app-hover"
      >
        <RefreshCw size={11} />
        {tr('common.retry')}
      </button>
    </div>
  ) : loading && entries.length === 0 ? (
    <div className="text-compact text-app-text-muted">Loading…</div>
  ) : null;

  const renderProvider = (entry: ProviderSnapshotEntry) => (
    <ProviderCard
      key={entry.name}
      entry={entry}
      expanded={expanded === entry.name}
      testing={testing === entry.name}
      result={results[entry.name]}
      settings={settings}
      saving={saving}
      modelSharedWith={(modelFieldSiblings.get(PROVIDER_MODEL_FIELD[entry.name] ?? '') ?? [])
        .filter((label) => label !== (entry.label ?? entry.name))}
      onSave={save}
      onToggle={() => setExpanded(expanded === entry.name ? null : entry.name)}
      onSetDefault={() => { void setDefault(entry.name); }}
      onClearDefault={() => { void clearDefault(); }}
      onTest={() => { void test(entry.name); }}
      onAfterConfigure={() => refresh(entry.name)}
    />
  );

  return (
    <div className="space-y-6" data-testid="ai-providers-settings">
      <div className="space-y-3">
        <h3 className="flex items-center gap-2 text-prose font-medium text-app-text">
          <Cpu size={14} />
          {tr('ai.api.title')}
        </h3>
        <p className="text-compact text-app-text-secondary">{tr('ai.api.intro')}</p>
        <p className="text-mini text-app-text-muted" data-testid="api-billing-note">{tr('ai.api.billing')}</p>
        {providersBody}
        {(settingsError || defaultError) && (
          <div role="alert" className="text-mini text-red-500">{defaultError ?? settingsError}</div>
        )}
        {/* A runtime can be the saved default even though it is deliberately
            absent from the provider cards. Validate against the full registry. */}
        {snapshot && settings?.aiProvider && !snapshot.providers.some((entry) => entry.name === settings.aiProvider) && (
          <div data-testid="provider-default-missing" className="flex items-center gap-2 text-mini text-app-text-muted border border-dashed border-app-border rounded-md px-2 py-1.5">
            <AlertCircle size={12} className="flex-shrink-0" />
            <span className="flex-1 break-words">
              {tr('ai.saved.prefix')} <span className="font-mono">{settings.aiProvider}</span>{tr('ai.saved.suffix')}
            </span>
            <button onClick={() => { void clearDefault(); }} disabled={saving} className="flex-shrink-0 px-2 py-1 coarse:min-h-11 rounded-md bg-surface border border-app-border hover:bg-app-hover disabled:opacity-50">
              {tr('ai.saved.remove')}
            </button>
          </div>
        )}
        {/* An absent API gets an onboarding card, never invented ready state. */}
        {snapshot && <div className="space-y-2">
          {(Object.keys(API_PROVIDERS) as Array<keyof typeof API_PROVIDERS>).map((provider) => {
            const entry = entries.find((candidate) => candidate.name === provider);
            return entry ? renderProvider(entry) : (
              <ApiProviderSetup key={provider} provider={provider}
                expanded={expanded === provider}
                onToggle={() => setExpanded(expanded === provider ? null : provider)}
                onSaved={() => refresh(provider)} />
            );
          })}
        </div>}
      </div>

      {entries.some((entry) => !isApiProvider(entry.name)) && <div className="border-t border-app-border pt-3 space-y-2">
        <h3 className="text-prose font-medium text-app-text">{tr('ai.agents.title')}</h3>
        <p className="text-mini text-app-text-secondary">{tr('ai.agents.hint')}</p>
        {entries.filter((entry) => !isApiProvider(entry.name)).map(renderProvider)}
      </div>}

      <div className="border-t border-app-border pt-3">
        <button
          type="button"
          data-testid="ai-providers-advanced-toggle"
          aria-expanded={advanced}
          aria-controls="ai-providers-advanced"
          onClick={() => setAdvanced((value) => !value)}
          className="w-full flex items-center gap-2 py-2 coarse:min-h-11 text-left text-compact font-medium text-app-text"
        >
          {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {tr('ai.advanced.title')}
        </button>
        <p className="text-mini text-app-text-muted">{tr('ai.advanced.hint')}</p>
        {advanced && <div id="ai-providers-advanced" data-testid="ai-providers-advanced" className="mt-3 space-y-4">
          {settings && <div className="space-y-3 rounded-lg border border-app-border px-3 py-3">
            <h3 className="text-prose font-medium text-app-text">{tr('ai.execution.title')}</h3>
            <AgentRuntimeChoice
              settings={settings}
              saving={saving}
              registered={(snapshot?.providers ?? []).some((entry) => entry.name === (settings.agentRuntime ?? DEFAULT_AGENT_RUNTIME))}
              onSave={save}
            />
            <TurnCheckpointsChoice settings={settings} saving={saving} onSave={save} />
          </div>}
          <div className="space-y-1.5">
            {snapshot && settings && !entries.some((entry) => entry.name === 'claude-code') && (
              <UnregisteredClaudeCode settings={settings} saving={saving} onSave={save} />
            )}
          </div>
          <CliAgentsPanel />
        </div>}
      </div>

    </div>
  );
}

/** One settings copy shared by all cards. Saves reconcile with the server;
 * `apply` mirrors changes made through the separate provider-default endpoint. */
function useBehaviorSettings() {
  const [settings, setSettings] = useState<AppBehaviorSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    appSettingsApi.get()
      .then((s) => { if (live) setSettings(s); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Failed to load settings'); });
    return () => { live = false; };
  }, []);

  const apply = useCallback((patch: Partial<AppBehaviorSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const save = useCallback(async (patch: Partial<AppBehaviorSettings>) => {
    setSaving(true);
    setError(null);
    apply(patch);
    try {
      const next = await appSettingsApi.update(patch);
      setSettings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
      // Re-fetch to drop the optimistic value on failure.
      try { setSettings(await appSettingsApi.get()); } catch { /* keep last */ }
      throw e;
    } finally {
      setSaving(false);
    }
  }, [apply]);

  return { settings, saving, error, save, apply };
}

interface ProviderCardProps {
  entry: ProviderSnapshotEntry;
  expanded: boolean;
  testing: boolean;
  result?: TestResult;
  settings: AppBehaviorSettings | null;
  saving: boolean;
  /** Other registered providers sharing the model setting. */
  modelSharedWith: string[];
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
  onToggle: () => void;
  onSetDefault: () => void;
  onClearDefault: () => void;
  onTest: () => void;
  onAfterConfigure: () => Promise<void>;
}

function ProviderCard({
  entry, expanded, testing, result, settings, saving, modelSharedWith,
  onSave, onToggle, onSetDefault, onClearDefault, onTest, onAfterConfigure,
}: ProviderCardProps) {
  const tr = useT();
  // Distinguish an explicit choice from a fallback only after settings load.
  const defaultKnown = settings !== null;
  const explicitDefault = settings?.aiProvider === entry.name;
  // API labels clarify the connection type; other labels come from discovery.
  const apiProvider = isApiProvider(entry.name) ? entry.name : null;
  const label = apiProvider ? API_PROVIDERS[apiProvider].label : entry.label ?? entry.name;
  const modelField = PROVIDER_MODEL_FIELD[entry.name];
  const selectedModel = (modelField ? settings?.[modelField] : null) ?? entry.defaultModel;
  const hasKey = !!apiProvider && entry.requirements.some((req) => req.key === API_PROVIDERS[apiProvider].requirement && req.present);
  // Test connection only makes sense once requirements are met. When the
  // provider is "not set up" (unavailable), there's nothing to test — the user
  // first needs to satisfy the requirements below.
  const canTest = entry.status !== 'unavailable';

  return (
    <div data-testid={`provider-card-${entry.name}`} className={`rounded-lg border ${entry.isDefault ? 'border-primary/40 bg-primary/5' : 'border-app-border bg-app-hover/40'}`}>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex min-h-11 items-center gap-2 px-3 py-2 text-left"
      >
        {expanded ? <ChevronDown size={13} className="text-app-text-muted flex-shrink-0" /> : <ChevronRight size={13} className="text-app-text-muted flex-shrink-0" />}
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[entry.status]}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-compact font-semibold text-app-text">{label}</span>
          {selectedModel && <span className="block truncate text-mini text-app-text-secondary" title={selectedModel}>{selectedModel}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-mini text-app-text-secondary">{tr(`ai.status.${entry.status}`)}</span>
          {entry.isDefault && (
            <span
              className="text-mini bg-primary/20 text-primary px-1.5 py-0.5 rounded"
              title={!defaultKnown
                ? tr('ai.default.unknown')
                : explicitDefault
                  ? tr('ai.default.explicit')
                  : tr('ai.default.fallback')}
            >
              {defaultKnown && !explicitDefault ? 'Default · automatico' : 'Default'}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-app-border space-y-2">
          {isApiProvider(entry.name) && <p className="text-mini text-app-text-secondary">{tr('ai.api.chat')}</p>}
          {/* Action row */}
          <div className="flex items-center gap-2 flex-wrap">
            {canTest && (
              <button
                onClick={(e) => { e.stopPropagation(); onTest(); }}
                disabled={testing}
                className="flex items-center gap-1 px-2 py-1 coarse:min-h-11 rounded-md text-mini bg-surface border border-app-border hover:bg-app-hover disabled:opacity-50"
              >
                <RefreshCw size={11} className={testing ? 'animate-spin' : ''} />
                {tr('ai.testConnection')}
              </button>
            )}
            {!entry.isDefault && entry.status === 'ready' && (
              <button
                onClick={(e) => { e.stopPropagation(); onSetDefault(); }}
                className="px-2 py-1 coarse:min-h-11 rounded-md text-mini bg-surface border border-app-border hover:bg-app-hover"
              >
                {tr('ai.setDefault')}
              </button>
            )}
            {entry.isDefault && explicitDefault && (
              // Return to automatic selection without choosing another provider.
              <button
                onClick={(e) => { e.stopPropagation(); onClearDefault(); }}
                disabled={saving}
                className="px-2 py-1 coarse:min-h-11 rounded-md text-mini bg-surface border border-app-border hover:bg-app-hover disabled:opacity-50"
              >
                {tr('ai.clearDefault')}
              </button>
            )}
            {result && (
              <span className={`text-mini flex items-center gap-1 ${result.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                {result.ok ? <Check size={11} /> : <AlertCircle size={11} />}
                {result.message}
              </span>
            )}
          </div>

          {/* Settings owned by this provider. */}
          {settings && (
            <ProviderSettings
              entry={entry}
              settings={settings}
              saving={saving}
              modelSharedWith={modelSharedWith}
              onSave={onSave}
            />
          )}

          {/* Binary path */}
          {entry.binaryPath && (
            <div className="text-mini text-app-text-muted font-mono break-all">
              {entry.binaryPath}
            </div>
          )}

          {/* Last error (only when no fresh test result has overridden) */}
          {entry.lastError && !result && (
            <div className="flex items-start gap-1.5 text-mini text-red-500">
              <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
              <span className="break-words">{entry.lastError}</span>
            </div>
          )}

          {/* Requirements */}
          {entry.requirements.length > 0 && (
            <div className="space-y-1.5">
              {entry.requirements.map((req) => (
                <RequirementRow key={req.key} req={req} />
              ))}
            </div>
          )}

          {apiProvider && (hasKey && entry.status === 'ready' ? (
            <details className="border-t border-app-border pt-2" data-testid={`provider-key-details-${entry.name}`}>
              <summary className="cursor-pointer py-1 text-compact text-app-text-secondary coarse:min-h-11">{tr('ai.api.replaceKey')}</summary>
              <div className="pt-2"><ApiKeyForm provider={apiProvider} replacing onSaved={onAfterConfigure} /></div>
            </details>
          ) : <ApiKeyForm provider={apiProvider} replacing={hasKey} onSaved={onAfterConfigure} />)}

          {/* Freshness footer */}
          {entry.fetchedAt && (
            <div className="text-mini text-app-text-muted pt-1">
              Updated {relativeTime(entry.fetchedAt)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Persist provider-specific defaults without re-registering running providers. */
function ProviderSettings({
  entry, settings, saving, modelSharedWith, onSave,
}: {
  entry: ProviderSnapshotEntry;
  settings: AppBehaviorSettings;
  saving: boolean;
  modelSharedWith: string[];
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
}) {
  const tr = useT();
  const save = (patch: Partial<AppBehaviorSettings>) => { void onSave(patch).catch(() => { /* The section renders save errors. */ }); };

  const modelField = PROVIDER_MODEL_FIELD[entry.name];
  const modelValue = modelField ? settings[modelField] : null;
  // Preserve a saved model absent from the catalog so it can still be cleared.
  const modelOptions = useMemo(() => {
    const all = [...entry.models];
    if (modelValue && !all.includes(modelValue)) all.unshift(modelValue);
    return all.map((m) => ({ value: m, label: m }));
  }, [entry.models, modelValue]);

  const rows: ReactNode[] = [];

  if (modelField && modelOptions.length > 0) {
    const shared = modelSharedWith.length > 0
      ? ` Lo stesso campo vale anche per ${modelSharedWith.join(', ')}.`
      : '';
    rows.push(
      <SettingSelect
        key="model"
        label="Modello di default"
        // API providers resolve settings on each request; local runtimes may
        // still retain their startup config until the server restarts.
        hint={`${entry.defaultModel ? `In uso ora: ${entry.defaultModel}. ` : ''}${isApiProvider(entry.name) ? tr('ai.api.nextTurn') : 'Vale dal prossimo avvio del server.'}${shared}`}
        value={modelValue}
        disabled={saving}
        onChange={(v) => save({ [modelField]: v } as Partial<AppBehaviorSettings>)}
        options={modelOptions}
        autoLabel="Auto (lo decide il provider)"
      />,
    );
  }

  if (entry.name === 'claude-code') {
    rows.push(
      <SettingSelect
        key="effort"
        label="Effort"
        hint="Vale dalla prossima sessione. Una chat può cambiarlo per sé."
        value={settings.claudeEffort}
        disabled={saving}
        onChange={(v) => save({ claudeEffort: v })}
        options={EFFORT_TIERS.map((v) => ({ value: v, label: v }))}
      />,
      <SettingSelect
        key="enabled"
        label="Attivazione"
        // Disabling forced registration does not hide a discovered CLI binary.
        hint="Auto rileva la CLI. «Attivo» lo registra anche senza CLI; «Disattivo» non lo toglie se la CLI c'è."
        value={enabledToSelect(settings.claudeCodeEnabled)}
        disabled={saving}
        onChange={(v) => save({ claudeCodeEnabled: selectToEnabled(v) })}
        options={[
          { value: 'on', label: 'Attivo' },
          { value: 'off', label: 'Disattivo' },
        ]}
      />,
    );
  }

  if (entry.name === 'codex') {
    rows.push(
      <SettingSelect
        key="reasoning"
        label="Reasoning effort"
        hint="Vale dal prossimo turno."
        value={settings.codexReasoningEffort}
        disabled={saving}
        onChange={(v) => save({ codexReasoningEffort: v })}
        options={CODEX_REASONING_EFFORTS.map((v) => ({ value: v, label: v }))}
      />,
      <SettingSelect
        key="approval"
        label="Modalità di approvazione"
        hint="Vale dal prossimo avvio del server."
        value={settings.codexApprovalMode}
        disabled={saving}
        onChange={(v) => save({ codexApprovalMode: v })}
        options={[
          { value: 'auto', label: 'auto' },
          { value: 'full-access', label: 'full-access' },
        ]}
      />,
    );
  }

  if (rows.length === 0) return null;

  return <div className="rounded-md border border-app-border bg-surface/40 px-2.5 py-1.5">{rows}</div>;
}

/** Keep forced CLI registration reachable when discovery found no binary. */
function UnregisteredClaudeCode({
  settings, saving, onSave,
}: {
  settings: AppBehaviorSettings;
  saving: boolean;
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
}) {
  const tr = useT();
  return (
    <div className="rounded-lg border border-dashed border-app-border px-3 py-2">
      <div className="text-compact font-semibold text-app-text">Claude Code</div>
      <div className="text-mini text-app-text-muted mb-1">
        {tr('ai.claude.missing.prefix')} <span className="font-mono">claude</span> {tr('ai.claude.missing.suffix')}
      </div>
      <SettingSelect
        label="Attivazione"
        hint="Forzarla lo registra al prossimo avvio del server, anche senza CLI rilevata."
        value={enabledToSelect(settings.claudeCodeEnabled)}
        disabled={saving}
        onChange={(v) => { void onSave({ claudeCodeEnabled: selectToEnabled(v) }).catch(() => { /* The section renders save errors. */ }); }}
        options={[
          { value: 'on', label: 'Attivo' },
          { value: 'off', label: 'Disattivo' },
        ]}
      />
    </div>
  );
}

function RequirementRow({ req }: { req: { key: string; label: string; present: boolean; hint?: string } }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!req.hint) return;
    const cmd = req.hint.match(/Run [^:]*:\s*(.+)/)?.[1]
      ?? req.hint.match(/→\s*(.+)/)?.[1]
      ?? req.hint;
    if (!(await copyText(cmd.trim()))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="text-mini">
      <div className="flex items-center gap-1.5">
        {req.present ? (
          <Check size={12} className="text-green-500 flex-shrink-0" />
        ) : (
          <X size={12} className="text-red-500 flex-shrink-0" />
        )}
        <span className={req.present ? 'text-app-text-secondary' : 'text-app-text'}>{req.label}</span>
      </div>
      {!req.present && req.hint && (
        <div className="ml-5 mt-0.5 flex items-start gap-1.5 text-app-text-muted">
          <span className="break-words flex-1">{req.hint}</span>
          <button
            onClick={copy}
            className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface border border-app-border hover:bg-app-hover text-mini"
            title="Copy"
          >
            <Copy size={10} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}
