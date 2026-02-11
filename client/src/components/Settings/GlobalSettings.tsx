import { useState, useEffect } from 'react';
import { X, Type, AlignJustify, Rows3 } from 'lucide-react';
import type { AppSettings } from '../../types';
import { saveSettings } from '../../lib/settings';

// Re-export for backward compatibility
export { loadSettings, saveSettings } from '../../lib/settings';

interface GlobalSettingsProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}

export function GlobalSettings({ isOpen, onClose, settings, onSettingsChange }: GlobalSettingsProps) {
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
        className="w-full max-w-[400px] mx-4 max-h-[90vh] sm:max-h-[80vh] bg-white dark:bg-[#1e1e1e] rounded-xl shadow-xl border border-[#e0e0e0] dark:border-[#333] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#e8e8e8] dark:border-[#2a2a2a]">
          <h2 className="text-[15px] font-semibold text-[#1a1a1a] dark:text-[#e5e5e5]">Settings</h2>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-[#8b8b8b] hover:text-[#555] dark:hover:text-[#ccc] transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-5 overflow-y-auto max-h-[60vh]">
          {/* Font Size */}
          <div>
            <label className="flex items-center gap-2 text-[13px] font-medium text-[#333] dark:text-[#ccc] mb-2">
              <Type size={14} />
              Font Size
              <span className="ml-auto text-[12px] text-[#888] font-normal">{localSettings.fontSize}px</span>
            </label>
            <input
              type="range"
              min={12}
              max={18}
              step={1}
              value={localSettings.fontSize}
              onChange={(e) => handleChange('fontSize', parseInt(e.target.value))}
              className="w-full h-1.5 bg-[#e0e0e0] dark:bg-[#333] rounded-lg appearance-none cursor-pointer accent-[var(--primary)]"
            />
            <div className="flex justify-between text-[10px] text-[#aaa] dark:text-[#666] mt-1">
              <span>12px</span>
              <span>15px</span>
              <span>18px</span>
            </div>
          </div>

          {/* Message Density */}
          <div>
            <label className="flex items-center gap-2 text-[13px] font-medium text-[#333] dark:text-[#ccc] mb-2">
              {localSettings.messageDensity === 'compact' ? <Rows3 size={14} /> : <AlignJustify size={14} />}
              Message Density
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => handleChange('messageDensity', 'compact')}
                className={`flex-1 py-2 px-3 rounded-lg text-[12px] font-medium transition-all border ${
                  localSettings.messageDensity === 'compact'
                    ? 'bg-[var(--primary)]/10 border-[var(--primary)]/30 text-[var(--primary)]'
                    : 'bg-[#f5f5f5] dark:bg-[#222] border-[#e0e0e0] dark:border-[#333] text-[#666] dark:text-[#999] hover:bg-[#eee] dark:hover:bg-[#2a2a2a]'
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
                    ? 'bg-[var(--primary)]/10 border-[var(--primary)]/30 text-[var(--primary)]'
                    : 'bg-[#f5f5f5] dark:bg-[#222] border-[#e0e0e0] dark:border-[#333] text-[#666] dark:text-[#999] hover:bg-[#eee] dark:hover:bg-[#2a2a2a]'
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
            <label className="text-[13px] font-medium text-[#333] dark:text-[#ccc] mb-2 block">Preview</label>
            <div className="bg-[#f5f5f5] dark:bg-[#222] rounded-lg p-3 border border-[#e0e0e0] dark:border-[#333]">
              <div className={`${localSettings.messageDensity === 'compact' ? 'space-y-1' : 'space-y-2.5'}`}>
                <div className="flex justify-end">
                  <div
                    className="bg-[var(--primary)] text-white rounded-lg px-2.5 py-1.5"
                    style={{ fontSize: `${localSettings.fontSize}px` }}
                  >
                    Hello! How are you?
                  </div>
                </div>
                <div className="flex justify-start">
                  <div
                    className="bg-white dark:bg-[#2a2a2a] text-[#1a1a1a] dark:text-[#e5e5e5] rounded-lg px-2.5 py-1.5"
                    style={{ fontSize: `${localSettings.fontSize}px` }}
                  >
                    I'm doing well, thanks for asking!
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Keyboard Shortcuts Reference */}
          <div>
            <label className="text-[13px] font-medium text-[#333] dark:text-[#ccc] mb-2 block">Keyboard Shortcuts</label>
            <div className="space-y-1.5 text-[12px]">
              {[
                ['⌘K', 'Search'],
                ['⌘N', 'New topic'],
                ['⌘W', 'Close panel'],
                ['⌘B', 'Toggle sidebar'],
                ['⌘1-9', 'Switch panels'],
              ].map(([key, desc]) => (
                <div key={key} className="flex items-center justify-between">
                  <span className="text-[#666] dark:text-[#999]">{desc}</span>
                  <kbd className="px-1.5 py-0.5 bg-[#e8e8e8] dark:bg-[#333] rounded text-[11px] font-mono text-[#555] dark:text-[#aaa]">
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
