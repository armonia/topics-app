import { useState, useEffect } from 'react';
import { X, Type, AlignJustify, Rows3, Sun, Moon, Monitor, Bell, BellOff, Cpu, Check, ChevronDown, ChevronRight, RefreshCw, Copy, AlertCircle, Palette, Keyboard } from 'lucide-react';
import type { AppSettings, ProviderDiagnostic, ThemeMode } from '../../types';
import { saveSettings } from '../../lib/settings';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { providersApi } from '../../lib/api';

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  themeMode?: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
}

type SectionId = 'appearance' | 'notifications' | 'providers' | 'shortcuts';

const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof Palette }> = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'providers', label: 'AI Providers', icon: Cpu },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
];

export function GlobalSettings({ isOpen, onClose, settings, onSettingsChange, themeMode = 'system', onThemeChange }: GlobalSettingsProps) {
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings);
  const [section, setSection] = useState<SectionId>('appearance');

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  const handleChange = (key: keyof AppSettings, value: any) => {
    const newSettings = { ...localSettings, [key]: value };
    setLocalSettings(newSettings);
    onSettingsChange(newSettings);
    saveSettings(newSettings);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        data-testid="settings-panel"
        className="w-full max-w-[760px] mx-4 h-[80vh] max-h-[640px] bg-surface rounded-xl shadow-xl border border-app-border overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-app-border">
          <h2 className="text-[15px] font-semibold text-app-text">Settings</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text-secondary transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <nav className="w-[180px] flex-shrink-0 border-r border-app-border py-3 px-2 space-y-0.5 bg-app-hover/30">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setSection(id)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12.5px] text-left transition-colors ${
                  section === id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-app-text-secondary hover:bg-app-hover hover:text-app-text'
                }`}
              >
                <Icon size={14} className="flex-shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 px-5 py-4 overflow-y-auto">
            {section === 'appearance' && (
              <AppearanceSection
                settings={localSettings}
                themeMode={themeMode}
                onThemeChange={onThemeChange}
                onChange={handleChange}
              />
            )}
            {section === 'notifications' && <PushNotificationsToggle />}
            {section === 'providers' && <AIProvidersSection />}
            {section === 'shortcuts' && <ShortcutsSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

interface AppearanceSectionProps {
  settings: AppSettings;
  themeMode: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
  onChange: (key: keyof AppSettings, value: any) => void;
}

function AppearanceSection({ settings, themeMode, onThemeChange, onChange }: AppearanceSectionProps) {
  return (
    <div className="space-y-5">
      {/* Font Size */}
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
          <Type size={14} />
          Font Size
          <span className="ml-auto text-[12px] text-app-text-muted font-normal">{settings.fontSize}px</span>
        </label>
        <input
          type="range"
          min={12}
          max={18}
          step={1}
          value={settings.fontSize}
          onChange={(e) => onChange('fontSize', parseInt(e.target.value))}
          className="w-full h-1.5 bg-app-border rounded-lg appearance-none cursor-pointer accent-primary"
        />
        <div className="flex justify-between text-[10px] text-app-text-muted mt-1">
          <span>12px</span>
          <span>15px</span>
          <span>18px</span>
        </div>
      </div>

      {/* Theme */}
      {onThemeChange && (
        <div>
          <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
            {themeMode === 'light' ? <Sun size={14} /> : themeMode === 'dark' ? <Moon size={14} /> : <Monitor size={14} />}
            Theme
          </label>
          <div className="flex gap-2">
            {([
              { mode: 'light' as ThemeMode, icon: Sun, label: 'Light' },
              { mode: 'dark' as ThemeMode, icon: Moon, label: 'Dark' },
              { mode: 'system' as ThemeMode, icon: Monitor, label: 'System' },
            ]).map(({ mode, icon: Icon, label }) => (
              <button
                key={mode}
                onClick={() => onThemeChange(mode)}
                className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 px-3 rounded-lg text-[12px] font-medium transition-all border ${
                  themeMode === mode
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'bg-app-hover border-app-border text-app-text-secondary hover:bg-app-hover'
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Message Density */}
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
          {settings.messageDensity === 'compact' ? <Rows3 size={14} /> : <AlignJustify size={14} />}
          Message Density
        </label>
        <div className="flex gap-2">
          <button
            onClick={() => onChange('messageDensity', 'compact')}
            className={`flex-1 py-2 px-3 rounded-lg text-[12px] font-medium transition-all border ${
              settings.messageDensity === 'compact'
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'bg-app-hover border-app-border text-app-text-secondary hover:bg-app-hover'
            }`}
          >
            <div className="space-y-0.5 mb-1.5">
              <div className="h-1 bg-current opacity-30 rounded w-3/4" />
              <div className="h-1 bg-current opacity-30 rounded w-1/2" />
              <div className="h-1 bg-current opacity-30 rounded w-2/3" />
            </div>
            Compact
          </button>
          <button
            onClick={() => onChange('messageDensity', 'comfortable')}
            className={`flex-1 py-2 px-3 rounded-lg text-[12px] font-medium transition-all border ${
              settings.messageDensity === 'comfortable'
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'bg-app-hover border-app-border text-app-text-secondary hover:bg-app-hover'
            }`}
          >
            <div className="space-y-1.5 mb-1.5">
              <div className="h-1 bg-current opacity-30 rounded w-3/4" />
              <div className="h-1 bg-current opacity-30 rounded w-1/2" />
              <div className="h-1 bg-current opacity-30 rounded w-2/3" />
            </div>
            Comfortable
          </button>
        </div>
      </div>

      {/* Preview */}
      <div>
        <label className="text-[13px] font-medium text-app-text mb-2 block">Preview</label>
        <div className="bg-app-hover rounded-lg p-3 border border-app-border">
          <div className={`${settings.messageDensity === 'compact' ? 'space-y-1' : 'space-y-2.5'}`}>
            <div className="flex justify-end">
              <div
                className="bg-primary text-white rounded-lg px-2.5 py-1.5"
                style={{ fontSize: `${settings.fontSize}px` }}
              >
                Hello! How are you?
              </div>
            </div>
            <div className="flex justify-start">
              <div
                className="bg-surface text-app-text rounded-lg px-2.5 py-1.5"
                style={{ fontSize: `${settings.fontSize}px` }}
              >
                I'm doing well, thanks for asking!
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShortcutsSection() {
  return (
    <div>
      <label className="text-[13px] font-medium text-app-text mb-3 block">Keyboard Shortcuts</label>
      <div className="space-y-1.5 text-[12px]">
        {[
          ['⌘K', 'Search'],
          ['⌘N', 'New topic'],
          ['⌘W', 'Close panel'],
          ['⌘B', 'Toggle sidebar'],
          ['⌘1-9', 'Switch panels'],
        ].map(([key, desc]) => (
          <div key={key} className="flex items-center justify-between">
            <span className="text-app-text-secondary">{desc}</span>
            <kbd className="kbd">
              {key}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

const STATUS_COLORS: Record<ProviderDiagnostic['status'], string> = {
  ready: 'bg-green-500',
  loading: 'bg-yellow-500',
  error: 'bg-red-500',
  unavailable: 'bg-gray-400',
};

const STATUS_LABELS: Record<ProviderDiagnostic['status'], string> = {
  ready: 'ready',
  loading: 'loading…',
  error: 'error',
  unavailable: 'not set up',
};

const PROVIDER_LABELS: Record<string, string> = {
  openclaw: 'OpenClaw',
  claude: 'Claude (API)',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  openai: 'OpenAI (ChatGPT)',
};

interface TestResult {
  ok: boolean;
  message: string;
  at: number;
}

function AIProvidersSection() {
  const [diagnostics, setDiagnostics] = useState<ProviderDiagnostic[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});

  const fetchAll = async (force = false) => {
    try {
      const data = await providersApi.diagnoseAll(force);
      setDiagnostics(data.providers ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  const setDefault = async (name: string) => {
    try {
      await providersApi.setDefault(name);
      await fetchAll();
    } catch {}
  };

  const test = async (name: string) => {
    setTesting(name);
    try {
      const result = await providersApi.diagnose(name, true);
      setDiagnostics((prev) => prev.map((p) => (p.name === name ? result : p)));
      const ok = result.status === 'ready';
      const message = ok
        ? `Connected${result.modelsCount ? ` · ${result.modelsCount} models` : ''}${result.version ? ` · v${result.version}` : ''}`
        : result.lastError ?? STATUS_LABELS[result.status];
      setResults((prev) => ({ ...prev, [name]: { ok, message, at: Date.now() } }));
    } catch (err: any) {
      setResults((prev) => ({ ...prev, [name]: { ok: false, message: err?.message ?? 'Test failed', at: Date.now() } }));
    } finally {
      setTesting(null);
    }
  };

  if (loading) {
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

      <div className="space-y-1.5">
        {diagnostics.map((d) => (
          <ProviderCard
            key={d.name}
            diag={d}
            expanded={expanded === d.name}
            testing={testing === d.name}
            result={results[d.name]}
            onToggle={() => setExpanded(expanded === d.name ? null : d.name)}
            onSetDefault={() => setDefault(d.name)}
            onTest={() => test(d.name)}
            onAfterConfigure={() => fetchAll(true)}
          />
        ))}
        {diagnostics.length === 0 && (
          <div className="text-[12px] text-app-text-muted">No providers registered.</div>
        )}
      </div>
    </div>
  );
}

interface ProviderCardProps {
  diag: ProviderDiagnostic;
  expanded: boolean;
  testing: boolean;
  result?: TestResult;
  onToggle: () => void;
  onSetDefault: () => void;
  onTest: () => void;
  onAfterConfigure: () => void;
}

function ProviderCard({ diag, expanded, testing, result, onToggle, onSetDefault, onTest, onAfterConfigure }: ProviderCardProps) {
  const label = PROVIDER_LABELS[diag.name] ?? diag.name;
  // Test connection only makes sense once requirements are met. When the
  // provider is "not set up" (unavailable), there's nothing to test — the user
  // first needs to satisfy the requirements below.
  const canTest = diag.status !== 'unavailable';

  return (
    <div className={`rounded-lg border ${diag.isDefault ? 'border-primary/40 bg-primary/5' : 'border-app-border bg-app-hover/40'}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {expanded ? <ChevronDown size={13} className="text-app-text-muted flex-shrink-0" /> : <ChevronRight size={13} className="text-app-text-muted flex-shrink-0" />}
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[diag.status]}`} />
        <span className="text-[12px] font-semibold text-app-text">{label}</span>
        <span className="text-[10px] text-app-text-muted">{STATUS_LABELS[diag.status]}</span>
        {diag.version && <span className="text-[10px] text-app-text-muted">· v{diag.version}</span>}
        {diag.modelsCount !== undefined && diag.modelsCount > 0 && (
          <span className="text-[10px] text-app-text-muted">· {diag.modelsCount} models</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {diag.isDefault && (
            <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded">Default</span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-app-border space-y-2">
          {/* Action row */}
          {(canTest || (!diag.isDefault && diag.status === 'ready')) && (
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
              {!diag.isDefault && diag.status === 'ready' && (
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
          {diag.binaryPath && (
            <div className="text-[11px] text-app-text-muted font-mono break-all">
              {diag.binaryPath}
            </div>
          )}

          {/* Last error (only when no fresh test result has overridden) */}
          {diag.lastError && !result && (
            <div className="flex items-start gap-1.5 text-[11px] text-red-500">
              <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
              <span className="break-words">{diag.lastError}</span>
            </div>
          )}

          {/* Requirements */}
          {diag.requirements.length > 0 && (
            <div className="space-y-1.5">
              {diag.requirements.map((req) => (
                <RequirementRow key={req.key} req={req} />
              ))}
            </div>
          )}

          {/* Inline configure forms */}
          {diag.name === 'claude' && diag.requirements.some((r) => r.key === 'ANTHROPIC_API_KEY' && !r.present) && (
            <ApiKeyForm provider="claude" placeholder="sk-ant-..." onSaved={onAfterConfigure} />
          )}
          {diag.name === 'openai' && diag.requirements.some((r) => r.key === 'OPENAI_API_KEY' && !r.present) && (
            <ApiKeyForm provider="openai" placeholder="sk-..." onSaved={onAfterConfigure} />
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
            className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface border border-app-border hover:bg-app-hover text-[10px]"
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

function ApiKeyForm({ provider, placeholder, onSaved }: { provider: 'claude' | 'openai'; placeholder: string; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      if (provider === 'claude') await providersApi.configureClaude(apiKey.trim());
      else await providersApi.configureOpenAI(apiKey.trim());
      setApiKey('');
      onSaved();
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
    </div>
  );
}

function PushNotificationsToggle() {
  const { state, loading, subscribe, unsubscribe } = usePushNotifications();

  if (state === "unsupported") {
    return (
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
          <BellOff size={14} />
          Push Notifications
        </label>
        <p className="text-[12px] text-app-text-muted">Not supported in this browser.</p>
      </div>
    );
  }

  const isSubscribed = state === "subscribed";
  const isDenied = state === "denied";

  return (
    <div>
      <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-3">
        {isSubscribed ? <Bell size={14} /> : <BellOff size={14} />}
        Push Notifications
      </label>
      {isDenied ? (
        <p className="text-[12px] text-app-text-muted">
          Notifications blocked by your browser. Enable them in site settings.
        </p>
      ) : (
        <button
          onClick={isSubscribed ? unsubscribe : subscribe}
          disabled={loading}
          className={`w-full py-2 px-3 rounded-lg text-[12px] font-medium transition-all border ${
            isSubscribed
              ? "bg-primary/10 border-primary/30 text-primary"
              : "bg-app-hover border-app-border text-app-text-secondary hover:bg-app-hover"
          } disabled:opacity-50`}
        >
          {loading ? "..." : isSubscribed ? "Disable push notifications" : "Enable push notifications"}
        </button>
      )}
    </div>
  );
}
