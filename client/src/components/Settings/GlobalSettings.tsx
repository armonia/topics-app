import { useState, useEffect, useMemo, useRef } from 'react';
import { X, Type, AlignJustify, Rows3, Sun, Moon, Monitor, Bell, Cpu, Check, ChevronDown, ChevronRight, RefreshCw, Copy, AlertCircle, Palette, Keyboard, Sparkles, LayoutGrid, Smartphone, ShieldCheck } from 'lucide-react';
import type { AppSettings, ProviderSnapshotEntry, ProviderStatus, ThemeMode } from '../../types';
import { saveSettings } from '../../lib/settings';
import { notificationStatus, type NativeNotificationStatus } from '../../lib/shell/app';
import { describeNativeNotifications } from '../../lib/notificationStatus';
import { MODAL_OVERLAY, MODAL_PANEL } from '../../lib/modalStyles';
import { providersApi, appSettingsApi, type AppBehaviorSettings } from '../../lib/api';
import { enabledToSelect, selectToEnabled } from './behaviorDefaults';
import { DevicesSection } from './DevicesSection';
import { PermissionsSection } from './PermissionsSection';
import { EFFORT_TIERS, CODEX_REASONING_EFFORTS } from '../../../../shared/effort';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { useModalDialog } from '../../hooks/useModalDialog';
import { isDesktop } from '../../lib/shell';
import { focusGateState, FULL_DISK_ACCESS_URL, type FocusGateState } from '../../lib/shell/focus';
import { openExternalOnce } from '../../lib/openExternal';

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  themeMode?: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
}

// «Features» è stata rimossa (2026-08-06): conteneva UN solo interruttore,
// `enableNewChat`, e quell'interruttore poteva solo rompere — spento una volta,
// faceva sparire "New Chat" da tutti e sei gli host del menu "+" senza dirlo, e
// il valore salvato scavalcava per sempre il default acceso. Il gate è stato
// tolto dal codice, non nascosto: qui resta la scheda vuota da non riaprire.
type SectionId = 'appearance' | 'notifications' | 'providers' | 'shortcuts' | 'devices' | 'permissions';

const SECTIONS: Array<{ id: SectionId; label: string; icon: typeof Palette }> = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'providers', label: 'AI Providers', icon: Cpu },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
  { id: 'devices', label: 'Dispositivi', icon: Smartphone },
  // Un «Consenti sempre» premuto di corsa dentro una chat deve poter essere
  // ritrovato e ritirato: senza questa scheda sarebbe una decisione
  // permanente presa in un posto e visibile in nessuno.
  { id: 'permissions', label: 'Permessi', icon: ShieldCheck },
];

export function GlobalSettings({ isOpen, onClose, settings, onSettingsChange, themeMode = 'system', onThemeChange, initialSection }: GlobalSettingsProps & { initialSection?: SectionId }) {
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings);
  const [section, setSection] = useState<SectionId>(initialSection ?? 'appearance');
  // Chi apre il pannello da un punto preciso ci vuole arrivare, non ripartire da
  // «Aspetto». Si riallinea a ogni APERTURA, non solo al montaggio: il pannello
  // resta montato fra un'apertura e l'altra, quindi un `useState` iniziale
  // servirebbe una volta sola.
  useEffect(() => {
    if (isOpen && initialSection) setSection(initialSection);
  }, [isOpen, initialSection]);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape chiude + Tab resta dentro + il focus torna al bottone che ha aperto.
  // Prima: si usciva SOLO dalla X (o dal velo), e Escape arrivava fino a
  // interrompere il turno dell'AI nella chat sotto.
  useModalDialog({ open: isOpen, onClose, panelRef });

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
        ref={panelRef}
        data-testid="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className={`w-full max-w-[760px] mx-4 h-[80vh] max-h-[640px] flex flex-col ${MODAL_PANEL}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-app-border">
          <h2 id="settings-title" className="text-[15px] font-semibold text-app-text">Settings</h2>
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
            {section === 'providers' && <AIProvidersSection />}
            {section === 'shortcuts' && <ShortcutsSection />}
            {section === 'devices' && <DevicesSection />}
            {section === 'permissions' && <PermissionsSection />}
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
        {/* `aria-label` esplicita: la <label> qui sopra NON avvolge l'input e non
            lo lega per `for`, quindi questo cursore non aveva NESSUN nome
            accessibile — e da quando "Larghezza chat" (27ccc796) ha portato un
            secondo `type="range"` nel pannello, i due erano indistinguibili sia
            per uno screen reader sia per chi li cerca per ruolo. Il nome è
            fisso e non include i "13px" del contatore: un nome che cambia col
            valore non è un'ancora. */}
        <input
          type="range"
          min={12}
          max={18}
          step={1}
          value={settings.fontSize}
          onChange={(e) => onChange('fontSize', parseInt(e.target.value))}
          className="w-full h-1.5 bg-app-border rounded-lg appearance-none cursor-pointer accent-primary"
          aria-label="Font Size"
        />
        <div className="flex justify-between text-[11px] text-app-text-muted mt-1">
          <span>12px</span>
          <span>15px</span>
          <span>18px</span>
        </div>
      </div>

      {/* Misura di lettura della chat — il tetto oltre il quale la colonna non
          si allarga più. Una riga lunga quanto una pane larga si legge male:
          tornando a capo l'occhio perde il rigo. Il fondo scala (600) è la
          soglia sotto cui il tetto smette di avere senso e diventa «piena
          larghezza». */}
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
          <Type size={14} />
          Larghezza chat
          <span className="ml-auto text-[12px] text-app-text-muted font-normal">
            {settings.chatMaxWidth > 0 ? `${settings.chatMaxWidth}px` : 'Piena larghezza'}
          </span>
        </label>
        <input
          type="range"
          min={580}
          max={1300}
          step={20}
          // 580 = il gradino sotto il minimo utile: lì il tetto si spegne.
          value={settings.chatMaxWidth > 0 ? settings.chatMaxWidth : 580}
          onChange={(e) => {
            const v = parseInt(e.target.value);
            onChange('chatMaxWidth', v <= 580 ? 0 : v);
          }}
          className="w-full h-1.5 bg-app-border rounded-lg appearance-none cursor-pointer accent-primary"
          aria-label="Larghezza massima della colonna di chat"
        />
        <div className="flex justify-between text-[11px] text-app-text-muted mt-1">
          <span>Piena</span>
          <span>820px</span>
          <span>1300px</span>
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
        </div>
      )}

      {/* Animated glow on working chats — shown everywhere (no vibrancy
          dependency, unlike floating splits). Subtle by design; the toggle is
          for users who want zero motion around active panes. */}
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
          <Sparkles size={14} />
          Working glow
        </label>
        <p className="text-[12px] text-app-text-muted mb-3">
          Wrap a chat in a soft, slowly-rotating glow while its session is
          actively working — a subtle at-a-glance cue that never touches
          readability.
        </p>

        <ToggleRow
          label="Working glow"
          description="Animate a thin glow ring around chats that are streaming."
          value={settings.workingGlow}
          onChange={(v) => onChange('workingGlow', v)}
        />
      </div>

      {/* Lingua. La migrazione delle stringhe è PER SUPERFICIE (vedi
          `lib/i18n.ts`): cambiare lingua sposta le superfici già convertite e
          lascia le altre com'erano. È detto qui sotto invece di lasciarlo
          scoprire — un selettore che sembra non fare niente è peggio di un
          selettore che dice cosa fa. */}
      <div className="mt-6">
        <h3 className="text-[13px] font-medium text-app-text mb-1">Lingua · Language</h3>
        <p className="text-[12px] text-app-text-muted mb-3">
          Le superfici già tradotte seguono questa scelta; le altre restano come sono
          finché non vengono convertite. · Translated surfaces follow this setting;
          the rest stay as they are until converted.
        </p>
        <select
          value={settings.language ?? 'auto'}
          onChange={(e) => onChange('language', e.target.value as 'auto' | 'it' | 'en')}
          className="rounded bg-white/5 px-2 py-1 text-[12px] text-app-text outline-none"
          data-testid="settings-language"
        >
          <option value="auto">Automatica · Automatic</option>
          <option value="it">Italiano</option>
          <option value="en">English</option>
        </select>
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
          ['⌘F', 'Find project'],
          ['⌘P', 'Quick-open file'],
          ['⌘N', 'New… (add menu)'],
          ['⌘⇧N', 'New chat'],
          ['Right ⌘ (tap)', 'Focus task composer'],
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
const AUTO = '__auto__';

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
/**
 * Lo stato VERO della catena dei banner nativi.
 *
 * Il testo qui sopra prometteva "native macOS notification" a prescindere.
 * Su una build non firmata da Apple quella promessa è falsa e non c'era modo di
 * accorgersene: la catena cade in silenzio in tre punti diversi. Questa riga
 * legge lo stato dal guscio (`notification_status`, sola lettura) e dice cosa
 * succede davvero — inclusa la riga di log da guardare quando non arriva nulla.
 */
function NativeBannerStatus() {
  const [status, setStatus] = useState<NativeNotificationStatus | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void notificationStatus().then((s) => { if (alive) setStatus(s); });
    return () => { alive = false; };
  }, []);

  // `undefined` = ancora in volo. Non si disegna una diagnosi non ancora letta:
  // un lampo di "NON arrivano" che poi si smentisce è peggio del nulla.
  if (status === undefined) return null;

  const verdict = describeNativeNotifications(status);
  const tone = {
    ok: 'text-app-text-muted',
    degraded: 'text-amber-500',
    broken: 'text-red-400',
    unknown: 'text-app-text-muted',
  }[verdict.health];

  return (
    <div className="flex items-start gap-2 mb-3 text-[11.5px]">
      {verdict.health === 'ok' ? (
        <Check size={13} className={`shrink-0 mt-px ${tone}`} />
      ) : (
        <AlertCircle size={13} className={`shrink-0 mt-px ${tone}`} />
      )}
      <div className="min-w-0">
        <div className={tone}>{verdict.headline}</div>
        {verdict.hint && (
          <div className="text-app-text-muted mt-0.5">{verdict.hint}</div>
        )}
        {status?.logPath && verdict.health !== 'ok' && (
          <div className="text-app-text-muted mt-0.5 font-mono text-[10.5px] break-all">
            {status.logPath}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Il gate Focus/Non disturbare, e cosa fare quando è spento.
 *
 * Su macOS 26 il gate legge lo stato del Focus da `~/Library/DoNotDisturb/DB/`,
 * che è protetto da TCC: senza Full Disk Access la lettura fallisce, il gate
 * resta trasparente (default sicuro — si notifica sempre) e l'utente riceve
 * banner durante un Focus **senza sapere perché**. La funzione sembra
 * semplicemente non esistere.
 *
 * Qui la si nomina e si offre l'unica azione utile. Il bottone apre il pannello
 * di sistema: concedere il permesso è un gesto che deve restare dell'utente,
 * l'app può solo portarcelo davanti.
 *
 * Tre stati, tre risposte diverse: fuori dal guscio nativo non si disegna nulla
 * (non c'è niente da concedere), in attesa nemmeno (una diagnosi che poi si
 * smentisce è peggio del nulla), e solo `blocked` merita l'avviso.
 */
function FocusGateStatus() {
  const [state, setState] = useState<FocusGateState>(() => focusGateState());
  useEffect(() => {
    // La prima lettura è asincrona: si ricontrolla finché non è tornata,
    // invece di fotografare uno stato «in attesa» e lasciarlo lì.
    if (state !== 'pending') return;
    const t = setInterval(() => {
      const next = focusGateState();
      if (next !== 'pending') { setState(next); clearInterval(t); }
    }, 400);
    return () => clearInterval(t);
  }, [state]);

  if (state === 'unavailable' || state === 'pending') return null;

  if (state === 'active') {
    return (
      <div className="flex items-start gap-2 mb-3 text-[11.5px]">
        <Check size={13} className="shrink-0 mt-px text-app-text-muted" />
        <div className="text-app-text-muted">
          Focus / Non disturbare: i banner restano zitti mentre è attivo.
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 mb-3 text-[11.5px]">
      <AlertCircle size={13} className="shrink-0 mt-px text-amber-500" />
      <div className="min-w-0">
        <div className="text-amber-500">Focus / Non disturbare: non lo vediamo</div>
        <div className="text-app-text-muted mt-0.5">
          Topics non riesce a leggere lo stato del Focus, quindi i banner arrivano
          anche mentre è attivo. Su macOS quel dato è protetto e serve concedere
          l'accesso completo al disco.
        </div>
        <button
          onClick={() => openExternalOnce(FULL_DISK_ACCESS_URL)}
          className="mt-1.5 rounded bg-white/10 px-2 py-1 text-[11px] text-app-text hover:bg-white/20"
        >Apri Accesso completo al disco</button>
        <div className="text-app-text-muted mt-1">
          Dopo averlo concesso serve riavviare Topics: il permesso si legge
          all'avvio del processo.
        </div>
      </div>
    </div>
  );
}

function NotificationsSection({ settings, onChange }: NotificationsSectionProps) {
  const masterOn = settings.notificationsEnabled;
  return (
    <div className="space-y-5">
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
          <Bell size={14} />
          Topic completion notifications
        </label>
        <p className="text-[12px] text-app-text-muted mb-2">
          Toast in finestra quando un agente finisce (o va in errore) su un
          topic. Il banner di sistema si aggiunge solo se il sistema operativo
          lo consente — qui sotto c'è lo stato reale.
        </p>

        <NativeBannerStatus />
        <FocusGateStatus />

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
