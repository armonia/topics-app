import { useState, useEffect } from 'react';
import { X, Type, AlignJustify, Rows3, Sun, Moon, Monitor, Bell, BellOff } from 'lucide-react';
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
