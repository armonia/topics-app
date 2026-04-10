import { useState, useEffect } from 'react';
import { X, Type, AlignJustify, Rows3, Sun, Moon, Monitor, Bell, BellOff, Cpu, Check } from 'lucide-react';
import type { AppSettings, ThemeMode } from '../../types';
import { saveSettings } from '../../lib/settings';
import { usePushNotifications } from '../../hooks/usePushNotifications';

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  themeMode?: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
}

export function GlobalSettings({ isOpen, onClose, settings, onSettingsChange, themeMode = 'system', onThemeChange }: GlobalSettingsProps) {
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings);

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
        className="w-full max-w-[400px] mx-4 max-h-[90vh] sm:max-h-[80vh] bg-surface rounded-xl shadow-xl border border-app-border overflow-hidden"
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

        {/* Content */}
        <div className="px-5 py-4 space-y-5 overflow-y-auto max-h-[60vh]">
          {/* Font Size */}
          <div>
            <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
              <Type size={14} />
              Font Size
              <span className="ml-auto text-[12px] text-app-text-muted font-normal">{localSettings.fontSize}px</span>
            </label>
            <input
              type="range"
              min={12}
              max={18}
              step={1}
              value={localSettings.fontSize}
              onChange={(e) => handleChange('fontSize', parseInt(e.target.value))}
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
              {localSettings.messageDensity === 'compact' ? <Rows3 size={14} /> : <AlignJustify size={14} />}
              Message Density
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => handleChange('messageDensity', 'compact')}
                className={`flex-1 py-2 px-3 rounded-lg text-[12px] font-medium transition-all border ${
                  localSettings.messageDensity === 'compact'
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
                onClick={() => handleChange('messageDensity', 'comfortable')}
                className={`flex-1 py-2 px-3 rounded-lg text-[12px] font-medium transition-all border ${
                  localSettings.messageDensity === 'comfortable'
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
              <div className={`${localSettings.messageDensity === 'compact' ? 'space-y-1' : 'space-y-2.5'}`}>
                <div className="flex justify-end">
                  <div
                    className="bg-primary text-white rounded-lg px-2.5 py-1.5"
                    style={{ fontSize: `${localSettings.fontSize}px` }}
                  >
                    Hello! How are you?
                  </div>
                </div>
                <div className="flex justify-start">
                  <div
                    className="bg-surface text-app-text rounded-lg px-2.5 py-1.5"
                    style={{ fontSize: `${localSettings.fontSize}px` }}
                  >
                    I'm doing well, thanks for asking!
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Push Notifications */}
          <PushNotificationsToggle />

          {/* AI Providers */}
          <AIProvidersSection />

          {/* Keyboard Shortcuts Reference */}
          <div>
            <label className="text-[13px] font-medium text-app-text mb-2 block">Keyboard Shortcuts</label>
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
        </div>
      </div>
    </div>
  );
}

interface Provider {
  name: string;
  connected: boolean;
  capabilities: string[];
  isDefault: boolean;
}

function AIProvidersSection() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [showReconfigure, setShowReconfigure] = useState(false);

  const fetchProviders = async () => {
    try {
      const res = await fetch('/api/providers');
      const data = await res.json();
      setProviders(data.providers ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProviders();
  }, []);

  const setDefault = async (name: string) => {
    await fetch('/api/providers/default', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: name }),
    });
    await fetchProviders();
  };

  const configureClaude = async () => {
    if (!apiKey.trim()) return;
    setConfiguring(true);
    try {
      await fetch('/api/providers/claude/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      setApiKey('');
      setShowReconfigure(false);
      await fetchProviders();
    } finally {
      setConfiguring(false);
    }
  };

  const claudeProvider = providers.find((p) => p.name === 'claude');
  const claudeConnected = claudeProvider?.connected ?? false;

  if (loading) {
    return (
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
          <Cpu size={14} />
          AI Providers
        </label>
        <div className="text-[12px] text-app-text-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div>
      <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
        <Cpu size={14} />
        AI Providers
      </label>

      {/* Provider list */}
      <div className="space-y-1.5 mb-3">
        {providers.map((provider) => (
          <button
            key={provider.name}
            onClick={() => setDefault(provider.name)}
            className={`w-full flex items-center gap-2.5 py-2 px-3 rounded-lg text-[12px] font-medium transition-all border ${
              provider.isDefault
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'bg-app-hover border-app-border text-app-text-secondary hover:bg-app-hover'
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${
                provider.connected ? 'bg-green-500' : 'bg-gray-400'
              }`}
            />
            <span className="font-semibold capitalize">{provider.name}</span>
            {provider.isDefault && (
              <span className="ml-auto text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded">
                Default
              </span>
            )}
          </button>
        ))}
        {providers.length === 0 && (
          <div className="text-[12px] text-app-text-muted">No providers registered.</div>
        )}
      </div>

      {/* Claude API Key configuration */}
      <div className="bg-app-hover rounded-lg p-3 border border-app-border">
        {claudeConnected && !showReconfigure ? (
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[12px] text-green-600 dark:text-green-400 font-medium">
                <Check size={13} />
                Claude configured
              </span>
              <button
                onClick={() => setShowReconfigure(true)}
                className="text-[11px] text-app-text-muted hover:text-app-text-secondary transition-colors"
              >
                Reconfigure
              </button>
            </div>
          ) : (
            <div>
              <label className="text-[12px] text-app-text-secondary mb-1.5 block">
                Claude API Key
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-..."
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-[12px] bg-surface border border-app-border text-app-text placeholder:text-app-text-muted focus:outline-none focus:border-primary/50"
                  onKeyDown={(e) => e.key === 'Enter' && configureClaude()}
                />
                <button
                  onClick={configureClaude}
                  disabled={configuring || !apiKey.trim()}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {configuring ? '...' : 'Configure'}
                </button>
              </div>
              {showReconfigure && (
                <button
                  onClick={() => setShowReconfigure(false)}
                  className="text-[11px] text-app-text-muted hover:text-app-text-secondary mt-1.5 transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>
          )}
        </div>
    </div>
  );
}

function PushNotificationsToggle() {
  const { state, loading, subscribe, unsubscribe } = usePushNotifications();

  if (state === "unsupported") return null;

  const isSubscribed = state === "subscribed";
  const isDenied = state === "denied";

  return (
    <div>
      <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-2">
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
