import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Cpu, Check, ChevronDown, ChevronRight, RefreshCw, Copy, AlertCircle } from 'lucide-react';
import type { ProviderSnapshotEntry } from '../../types';
import { providersApi, appSettingsApi, type AppBehaviorSettings } from '../../lib/api';
import { enabledToSelect, selectToEnabled } from './behaviorDefaults';
import { EFFORT_TIERS, CODEX_REASONING_EFFORTS } from '../../../../shared/effort';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { AUTO, STATUS_COLORS, STATUS_LABELS, relativeTime } from './providerFormat';

interface TestResult {
  ok: boolean;
  message: string;
  at: number;
}

export function AIProvidersSection() {
  // Single subscription point — replaces the per-component fetches the section
  // used to do. Snapshot updates arrive via WS, so opening Settings in two
  // windows shows identical state without either window polling.
  const { snapshot, loading, error, refresh, retry } = useProvidersSnapshot();
  const entries: ProviderSnapshotEntry[] = useMemo(
    () => snapshot?.providers ?? [],
    [snapshot],
  );

  const [expanded, setExpanded] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});

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
    const message = ok
      ? `Connected${entry.models.length ? ` · ${entry.models.length} models` : ''}${entry.version ? ` · v${entry.version}` : ''}`
      : entry.lastError ?? STATUS_LABELS[entry.status];
    if (testWatchdog.current) { clearTimeout(testWatchdog.current); testWatchdog.current = null; }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- converging external-store sync: derives the test result from a freshly-arrived WS snapshot and clears `testing`, which guards against re-runs (no cascade)
    setResults((prev) => ({ ...prev, [testing]: { ok, message, at: Date.now() } }));
    testTriggeredAt.current.delete(testing);
    setTesting(null);
  }, [entries, testing]);

  const setDefault = async (name: string) => {
    try {
      await providersApi.setDefault(name);
      await refresh();
    } catch {
      // ignore — UI still reflects the last good snapshot.
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
      setResults((prev) => ({ ...prev, [name]: { ok: false, message: 'Test timed out', at: Date.now() } }));
      setTesting(null);
    }, 15000);
    try {
      await refresh(name);
    } catch (err) {
      if (testWatchdog.current) { clearTimeout(testWatchdog.current); testWatchdog.current = null; }
      const message = err instanceof Error ? err.message : 'Test failed';
      setResults((prev) => ({ ...prev, [name]: { ok: false, message, at: Date.now() } }));
      testTriggeredAt.current.delete(name);
      setTesting(null);
    }
  };

  if (error && entries.length === 0) {
    return (
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-3">
          <Cpu size={14} />
          AI Providers
        </label>
        <div className="flex items-center gap-2 text-[12px] text-red-500">
          <AlertCircle size={12} className="flex-shrink-0" />
          <span className="break-words flex-1">{error.message || 'Failed to load providers.'}</span>
          <button
            onClick={() => { void retry(); }}
            className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-surface border border-app-border hover:bg-app-hover"
          >
            <RefreshCw size={11} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (loading && entries.length === 0) {
    return (
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-3">
          <Cpu size={14} />
          AI Providers
        </label>
        <div className="text-[12px] text-app-text-muted">Loading…</div>
      </div>
    );
  }

  return (
    <div>
      <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-3">
        <Cpu size={14} />
        AI Providers
      </label>

      <BehaviorDefaults />

      <div className="space-y-1.5">
        {entries.map((entry) => (
          <ProviderCard
            key={entry.name}
            entry={entry}
            expanded={expanded === entry.name}
            testing={testing === entry.name}
            result={results[entry.name]}
            onToggle={() => setExpanded(expanded === entry.name ? null : entry.name)}
            onSetDefault={() => setDefault(entry.name)}
            onTest={() => test(entry.name)}
            onAfterConfigure={() => { void refresh(entry.name); }}
          />
        ))}
        {entries.length === 0 && (
          <div className="text-[12px] text-app-text-muted">No providers registered.</div>
        )}
      </div>
    </div>
  );
}

// Behaviour defaults promoted out of env vars (env-var audit, Phase B). Each
// control persists to /api/app-settings; "Auto" clears the override so the env
// var (or built-in default) wins again. NON-secret only.

function SettingSelect({
  label, hint, value, options, onChange, disabled,
}: {
  label: string;
  hint?: string;
  value: string | null;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5">
      <span className="flex flex-col">
        <span className="text-[12px] text-app-text">{label}</span>
        {hint && <span className="text-[11px] text-app-text-muted">{hint}</span>}
      </span>
      <select
        aria-label={label}
        disabled={disabled}
        value={value ?? AUTO}
        onChange={(e) => onChange(e.target.value === AUTO ? null : e.target.value)}
        className="text-[12px] bg-surface border border-app-border rounded-md px-2 py-1 min-w-[140px]"
      >
        <option value={AUTO}>Auto (env/default)</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function BehaviorDefaults() {
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

  const save = async (patch: Partial<AppBehaviorSettings>) => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    // Optimistic: reflect the change immediately, reconcile with the server echo.
    setSettings({ ...settings, ...patch });
    try {
      const next = await appSettingsApi.update(patch);
      setSettings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
      // Re-fetch to drop the optimistic value on failure.
      try { setSettings(await appSettingsApi.get()); } catch { /* keep last */ }
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <div className="mb-4 text-[12px] text-app-text-muted">
        {error ? <span className="text-red-500">{error}</span> : 'Loading defaults…'}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-app-border bg-surface/40 px-3 py-2">
      <div className="text-[12px] font-medium text-app-text mb-1">Behaviour defaults</div>
      <div className="text-[11px] text-app-text-muted mb-2">
        App-wide defaults. “Auto” keeps the current env/built-in behaviour.
      </div>

      <SettingSelect
        label="Default provider"
        value={settings.aiProvider}
        disabled={saving}
        onChange={(v) => save({ aiProvider: v })}
        options={[
          { value: 'claude', label: 'Claude (API)' },
          { value: 'claude-code', label: 'Claude Code' },
          { value: 'openai', label: 'OpenAI' },
          { value: 'codex', label: 'Codex' },
          { value: 'openclaw', label: 'OpenClaw' },
        ]}
      />
      <SettingSelect
        label="Claude effort"
        value={settings.claudeEffort}
        disabled={saving}
        onChange={(v) => save({ claudeEffort: v })}
        options={EFFORT_TIERS.map((v) => ({ value: v, label: v }))}
      />
      <SettingSelect
        label="Codex reasoning effort"
        value={settings.codexReasoningEffort}
        disabled={saving}
        onChange={(v) => save({ codexReasoningEffort: v })}
        options={CODEX_REASONING_EFFORTS.map((v) => ({ value: v, label: v }))}
      />
      <SettingSelect
        label="Codex approval mode"
        value={settings.codexApprovalMode}
        disabled={saving}
        onChange={(v) => save({ codexApprovalMode: v })}
        options={[
          { value: 'auto', label: 'auto' },
          { value: 'full-access', label: 'full-access' },
        ]}
      />
      <SettingSelect
        label="Claude Code enabled"
        hint="Force on/off; Auto detects the CLI"
        value={enabledToSelect(settings.claudeCodeEnabled)}
        disabled={saving}
        onChange={(v) => save({ claudeCodeEnabled: selectToEnabled(v) })}
        options={[
          { value: 'on', label: 'Enabled' },
          { value: 'off', label: 'Disabled' },
        ]}
      />

      {error && <div className="mt-1 text-[11px] text-red-500">{error}</div>}
    </div>
  );
}

interface ProviderCardProps {
  entry: ProviderSnapshotEntry;
  expanded: boolean;
  testing: boolean;
  result?: TestResult;
  onToggle: () => void;
  onSetDefault: () => void;
  onTest: () => void;
  onAfterConfigure: () => void;
}

function ProviderCard({ entry, expanded, testing, result, onToggle, onSetDefault, onTest, onAfterConfigure }: ProviderCardProps) {
  // `label` arriva SEMPRE dallo snapshot (server/providers/snapshot-manager.ts):
  // una tabella di nomi qui sarebbe la terza copia, e le due precedenti erano
  // già divergenti fra loro.
  const label = entry.label ?? entry.name;
  const modelsCount = entry.models.length;
  // Test connection only makes sense once requirements are met. When the
  // provider is "not set up" (unavailable), there's nothing to test — the user
  // first needs to satisfy the requirements below.
  const canTest = entry.status !== 'unavailable';

  return (
    <div className={`rounded-lg border ${entry.isDefault ? 'border-primary/40 bg-primary/5' : 'border-app-border bg-app-hover/40'}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {expanded ? <ChevronDown size={13} className="text-app-text-muted flex-shrink-0" /> : <ChevronRight size={13} className="text-app-text-muted flex-shrink-0" />}
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[entry.status]}`} />
        <span className="text-[12px] font-semibold text-app-text">{label}</span>
        <span className="text-[11px] text-app-text-muted">{STATUS_LABELS[entry.status]}</span>
        {entry.version && <span className="text-[11px] text-app-text-muted">· v{entry.version}</span>}
        {modelsCount > 0 && (
          <span className="text-[11px] text-app-text-muted">· {modelsCount} models</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {entry.isDefault && (
            <span className="text-[11px] bg-primary/20 text-primary px-1.5 py-0.5 rounded">Default</span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-app-border space-y-2">
          {/* Action row */}
          {(canTest || (!entry.isDefault && entry.status === 'ready')) && (
            <div className="flex items-center gap-2 flex-wrap">
              {canTest && (
                <button
                  onClick={(e) => { e.stopPropagation(); onTest(); }}
                  disabled={testing}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-surface border border-app-border hover:bg-app-hover disabled:opacity-50"
                >
                  <RefreshCw size={11} className={testing ? 'animate-spin' : ''} />
                  Test connection
                </button>
              )}
              {!entry.isDefault && entry.status === 'ready' && (
                <button
                  onClick={(e) => { e.stopPropagation(); onSetDefault(); }}
                  className="px-2 py-1 rounded-md text-[11px] bg-surface border border-app-border hover:bg-app-hover"
                >
                  Set as default
                </button>
              )}
              {result && (
                <span className={`text-[11px] flex items-center gap-1 ${result.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                  {result.ok ? <Check size={11} /> : <AlertCircle size={11} />}
                  {result.message}
                </span>
              )}
            </div>
          )}

          {/* Binary path */}
          {entry.binaryPath && (
            <div className="text-[11px] text-app-text-muted font-mono break-all">
              {entry.binaryPath}
            </div>
          )}

          {/* Last error (only when no fresh test result has overridden) */}
          {entry.lastError && !result && (
            <div className="flex items-start gap-1.5 text-[11px] text-red-500">
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

          {/* Inline configure forms */}
          {entry.name === 'claude' && entry.requirements.some((r) => r.key === 'ANTHROPIC_API_KEY' && !r.present) && (
            <ApiKeyForm provider="claude" placeholder="sk-ant-..." onSaved={onAfterConfigure} />
          )}
          {entry.name === 'openai' && entry.requirements.some((r) => r.key === 'OPENAI_API_KEY' && !r.present) && (
            <ApiKeyForm provider="openai" placeholder="sk-..." onSaved={onAfterConfigure} />
          )}
          {entry.name === 'claude-code' && entry.status === 'ready' && entry.models.length > 0 && (
            <ClaudeCodeModelPicker
              models={entry.models}
              currentModel={entry.models[0]}
              onSaved={onAfterConfigure}
            />
          )}

          {/* Freshness footer */}
          {entry.fetchedAt && (
            <div className="text-[11px] text-app-text-muted pt-1">
              Updated {relativeTime(entry.fetchedAt)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RequirementRow({ req }: { req: { key: string; label: string; present: boolean; hint?: string } }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!req.hint) return;
    const cmd = req.hint.match(/Run [^:]*:\s*(.+)/)?.[1]
      ?? req.hint.match(/→\s*(.+)/)?.[1]
      ?? req.hint;
    navigator.clipboard.writeText(cmd.trim()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // Clipboard write can be rejected (no permission / insecure context) —
      // swallow it so it doesn't surface as an unhandled rejection.
    });
  };

  return (
    <div className="text-[11px]">
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
            className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface border border-app-border hover:bg-app-hover text-[11px]"
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

function ClaudeCodeModelPicker({ models, currentModel, onSaved }: { models: string[]; currentModel: string; onSaved: () => void }) {
  // The picker reflects the model the next spawned `claude` CLI will use.
  // The currently-selected value is the snapshot's models[0] (server reorders
  // listModels so the configured model leads), so we don't keep a separate
  // local source of truth — local optimistic state only spans the in-flight
  // POST so the dropdown doesn't flash back to the old value while the
  // snapshot WS push catches up.
  const [pending, setPending] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = pending ?? currentModel;

  const submit = async (next: string) => {
    if (next === currentModel) return;
    setPending(next);
    setSaving(true);
    setError(null);
    try {
      await providersApi.configureClaudeCode(next);
      onSaved();
      // Persist alongside other Claude prefs so a fresh server restart can
      // re-apply the choice (server falls back to env `CLAUDE_CODE_MODEL` —
      // the client re-applies on init via the snapshot subscriber).
      try { localStorage.setItem('claude-code-model', next); } catch {}
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set model');
      setPending(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pt-1">
      <label className="text-[11px] text-app-text-muted block mb-1">Model</label>
      <div className="flex items-center gap-1.5">
        <select
          value={value}
          disabled={saving}
          onChange={(e) => { void submit(e.target.value); }}
          className="flex-1 min-w-0 px-2 py-1 rounded-md text-[11px] bg-surface border border-app-border text-app-text focus:outline-none focus:border-primary/50 disabled:opacity-50"
        >
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        {saving && <RefreshCw size={11} className="animate-spin text-app-text-muted" />}
      </div>
      {error && (
        <div className="mt-1 text-[11px] text-red-500">{error}</div>
      )}
    </div>
  );
}

function ApiKeyForm({ provider, placeholder, onSaved }: { provider: 'claude' | 'openai'; placeholder: string; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (provider === 'claude') await providersApi.configureClaude(apiKey.trim());
      else await providersApi.configureOpenAI(apiKey.trim());
      setApiKey('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pt-1">
      <div className="flex gap-1.5">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={placeholder}
          className="flex-1 min-w-0 px-2 py-1 rounded-md text-[11px] bg-surface border border-app-border text-app-text placeholder:text-app-text-muted focus:outline-none focus:border-primary/50"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button
          onClick={submit}
          disabled={saving || !apiKey.trim()}
          className="px-2 py-1 rounded-md text-[11px] font-medium bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? '…' : 'Save'}
        </button>
      </div>
      {error && (
        <div className="mt-1 text-[11px] text-red-500">{error}</div>
      )}
    </div>
  );
}
