import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Type, AlignJustify, Rows3, Sun, Moon, Monitor, Bell, Cpu, Check, ChevronDown, ChevronRight, RefreshCw, Copy, AlertCircle, Palette, Keyboard, Sparkles, MessageSquarePlus, LayoutGrid } from 'lucide-react';
import type { AppSettings, ProviderSnapshotEntry, ProviderStatus, ThemeMode } from '../../types';
import { saveSettings } from '../../lib/settings';
import { MODAL_OVERLAY, MODAL_PANEL } from '../../lib/modalStyles';
import { providersApi } from '../../lib/api';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { isDesktop, isTauri } from '../../lib/shell';

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  themeMode?: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
  /** Desktop (Electron) build — gates desktop-only options (e.g. floating splits). */
  isElectron?: boolean;
}

type SectionId = 'appearance' | 'notifications' | 'features' | 'providers' | 'shortcuts';

const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof Palette }> = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'features', label: 'Features', icon: Sparkles },
  { id: 'providers', label: 'AI Providers', icon: Cpu },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
];

export function GlobalSettings({ isOpen, onClose, settings, onSettingsChange, themeMode = 'system', onThemeChange }: GlobalSettingsProps) {
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings);
  const [section, setSection] = useState<SectionId>('appearance');

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const newSettings = { ...localSettings, [key]: value };
    setLocalSettings(newSettings);
    onSettingsChange(newSettings);
    saveSettings(newSettings);
  };

  if (!isOpen) return null;

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        data-testid="settings-panel"
        className={`w-full max-w-[760px] mx-4 h-[80vh] max-h-[640px] flex flex-col ${MODAL_PANEL}`}
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
            {section === 'notifications' && (
              <NotificationsSection settings={localSettings} onChange={handleChange} />
            )}
            {section === 'features' && (
              <FeaturesSection settings={localSettings} onChange={handleChange} />
            )}
            {section === 'providers' && <AIProvidersSection />}
            {section === 'shortcuts' && <ShortcutsSection settings={localSettings} />}
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
  onChange: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void;
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
        <div className="flex justify-between text-[11px] text-app-text-muted mt-1">
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

      {/* Floating splits — desktop only (relies on native macOS window
          vibrancy to reveal the backdrop through the gaps). Hidden entirely
          on web/PWA, where there's no vibrancy to show underneath. Shown on
          BOTH desktop shells (Electron + Tauri), hence isDesktop not isElectron. */}
      {isDesktop && (
        <div>
          <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
            <LayoutGrid size={14} />
            Floating splits
            <span className="ml-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/15 text-primary">
              Beta
            </span>
          </label>
          <p className="text-[12px] text-app-text-muted mb-3">
            Detach every window split and the sidebar into rounded floating
            cards with a small gap between them, revealing the desktop
            vibrancy underneath — making the split layout easier to read.
          </p>

          <ToggleRow
            label="Floating splits"
            description="Render splits and the sidebar as separate floating panels."
            value={settings.floatingSplits}
            onChange={(v) => onChange('floatingSplits', v)}
          />

          <ToggleRow
            label="Overlay sidebar"
            description="Slide the sidebar over the content instead of pushing it — no frame drop on open/close, but it covers the left edge of the content while open."
            value={settings.overlaySidebar}
            onChange={(v) => onChange('overlaySidebar', v)}
          />

          {isTauri && (
            <ToggleRow
              label="Browser pilotabile dall'agente"
              description="Usa il browser in streaming (headless lato server) invece del pannello nativo, così l'agente può pilotarlo end-to-end. Più pesante del pannello nativo."
              value={settings.tauriBrowserStreaming}
              onChange={(v) => onChange('tauriBrowserStreaming', v)}
            />
          )}
        </div>
      )}

      {/* Split-tree engine — shell-neutral (no native dependency), so it's not
          desktop-gated. Experimental: renders the standalone grid through the
          unified layoutTree/<SplitTree> renderer. Geometry is identical and all
          gestures route through the existing handlers; flip to dogfood. */}
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
          <LayoutGrid size={14} />
          Split-tree engine
          <span className="ml-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/15 text-primary">
            Experimental
          </span>
        </label>
        <p className="text-[12px] text-app-text-muted mb-3">
          Render the split grid through the new unified split-tree engine.
          Same layout and gestures — arbitrary-depth splits, snappier dividers.
          Flip it off if anything looks off.
        </p>

        <ToggleRow
          label="Split-tree engine"
          description="Drive the standalone grid with the new layout engine."
          value={settings.splitTreeEngine}
          onChange={(v) => onChange('splitTreeEngine', v)}
        />
      </div>

    </div>
  );
}

function ShortcutsSection({ settings }: { settings: AppSettings }) {
  return (
    <div>
      <label className="text-[13px] font-medium text-app-text mb-3 block">Keyboard Shortcuts</label>
      <div className="space-y-1.5 text-[12px]">
        {[
          ['⌘K', 'Search'],
          ['⌘F', 'Find project'],
          ['⌘P', 'Quick-open file'],
          ['⌘N', 'New… (add menu)'],
          // ⌘⇧N is only live when the paid New Chat feature is enabled.
          ...(settings.enableNewChat ? [['⌘⇧N', 'New chat']] : []),
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

interface FeaturesSectionProps {
  settings: AppSettings;
  onChange: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void;
}

/**
 * Features — opt-in capabilities that carry a cost. Right now this is the
 * "New Chat" gate: creating a fresh chat drives a paid provider turn (the
 * subscription only works through an interactive PTY), so it ships OFF and the
 * user enables it deliberately, fully aware it's billable.
 */
function FeaturesSection({ settings, onChange }: FeaturesSectionProps) {
  return (
    <div className="space-y-5">
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
          <MessageSquarePlus size={14} />
          New Chat
          <span className="ml-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
            Paid
          </span>
        </label>
        <p className="text-[12px] text-app-text-muted mb-3">
          Allow creating new chats (the “New Chat” button, ⌘⇧N, and the ⌘K
          palette). Each new chat starts a billable provider turn, so this is
          off by default — enable it only if you have a paid plan.
        </p>

        <ToggleRow
          label="Enable New Chat"
          description="Show the New Chat entry points and activate ⌘⇧N."
          value={settings.enableNewChat}
          onChange={(v) => onChange('enableNewChat', v)}
        />
      </div>
    </div>
  );
}

const STATUS_COLORS: Record<ProviderStatus, string> = {
  ready: 'bg-green-500',
  loading: 'bg-yellow-500',
  error: 'bg-red-500',
  unavailable: 'bg-gray-400',
};

const STATUS_LABELS: Record<ProviderStatus, string> = {
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

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  if (ms < 1500) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function ProviderCard({ entry, expanded, testing, result, onToggle, onSetDefault, onTest, onAfterConfigure }: ProviderCardProps) {
  const label = entry.label ?? PROVIDER_LABELS[entry.name] ?? entry.name;
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

interface NotificationsSectionProps {
  settings: AppSettings;
  onChange: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void;
}

/**
 * Notifications settings — covers the in-window toast + native Electron
 * desktop notification pair. Web Push (other devices) is intentionally NOT
 * exposed: per product decision, completion alerts are scoped to the
 * Electron client only.
 */
function NotificationsSection({ settings, onChange }: NotificationsSectionProps) {
  const masterOn = settings.notificationsEnabled;
  return (
    <div className="space-y-5">
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
          <Bell size={14} />
          Topic completion notifications
        </label>
        <p className="text-[12px] text-app-text-muted mb-3">
          Toast in-window + native macOS notification when an agent
          finishes (or errors) on any topic.
        </p>

        <ToggleRow
          label="Enable notifications"
          description="Master switch for both toast and desktop notifications."
          value={masterOn}
          onChange={(v) => onChange('notificationsEnabled', v)}
        />

        <div className={masterOn ? '' : 'opacity-50 pointer-events-none'}>
          <ToggleRow
            label="Play sound"
            description="Short tone when an agent completes."
            value={settings.notificationsSound}
            onChange={(v) => onChange('notificationsSound', v)}
          />
          <ToggleRow
            label="Notify even when topic is focused"
            description="Useful when you keep multiple topics open in parallel."
            value={settings.notifyEvenWhenFocused}
            onChange={(v) => onChange('notifyEvenWhenFocused', v)}
          />
        </div>
      </div>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

function ToggleRow({ label, description, value, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-app-border last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-app-text">{label}</div>
        {description && (
          <div className="text-[11px] text-app-text-muted mt-0.5">{description}</div>
        )}
      </div>
      <button
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${
          value ? 'bg-primary' : 'bg-app-border'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
            value ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

// Web Push notifications were intentionally removed from the UI: per
// product decision, completion alerts are scoped to the local Electron
// client (toast + native macOS notification). The push subscription
// infrastructure (`usePushNotifications`, `/api/push/*`) is left in place
// so a future "notify me on other devices" toggle can wire back into it
// without redoing the server side.
