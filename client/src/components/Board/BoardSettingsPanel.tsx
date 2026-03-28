import { useState, useEffect } from 'react';
import { Settings, X } from 'lucide-react';
import { boardsApi, type BoardSettings } from '../../lib/api';

interface BoardSettingsPanelProps {
  projectId: string;
  onClose: () => void;
}

export function BoardSettingsPanel({ projectId, onClose }: BoardSettingsPanelProps) {
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    boardsApi.getSettings(projectId)
      .then(setSettings)
      .catch(err => { console.error('Failed to load settings:', err); setLoadError('Failed to load settings'); });
  }, [projectId]);

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setSaveError(null);
    try {
      await boardsApi.updateSettings(projectId, settings);
      onClose();
    } catch (err) {
      console.error('Failed to save settings:', err);
      setSaveError('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    if (loadError) {
      return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
          <div className="bg-surface border border-app-border rounded-lg shadow-xl w-[360px] p-4 text-center" onClick={e => e.stopPropagation()}>
            <p className="text-[12px] text-red-400 mb-2">{loadError}</p>
            <button onClick={onClose} className="text-[11px] text-app-text-muted px-3 py-1.5">Close</button>
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <div data-testid="board-settings-panel" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-surface border border-app-border rounded-lg shadow-xl w-[360px]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
          <Settings size={14} className="text-app-text-muted" />
          <span className="text-[13px] font-semibold text-app-text flex-1">Board Settings</span>
          <button onClick={onClose} className="text-app-text-muted hover:text-app-text">
            <X size={14} />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <ToggleSetting
            label="Require approval to mark as Done"
            checked={settings.requireApprovalForDone}
            onChange={v => setSettings(s => s ? { ...s, requireApprovalForDone: v } : s)}
          />
          <ToggleSetting
            label="Require Review before Done"
            checked={settings.requireReviewBeforeDone}
            onChange={v => setSettings(s => s ? { ...s, requireReviewBeforeDone: v } : s)}
          />
          <ToggleSetting
            label="Block status change with pending approval"
            checked={settings.blockStatusWithPending}
            onChange={v => setSettings(s => s ? { ...s, blockStatusWithPending: v } : s)}
          />
          <ToggleSetting
            label="Only lead can change status"
            checked={settings.onlyLeadCanChangeStatus}
            onChange={v => setSettings(s => s ? { ...s, onlyLeadCanChangeStatus: v } : s)}
          />

          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-app-text-muted flex-1">Max agents</span>
            <input
              type="number"
              min={1}
              max={20}
              value={settings.maxAgents}
              onChange={e => setSettings(s => s ? { ...s, maxAgents: parseInt(e.target.value) || 5 } : s)}
              className="w-16 bg-surface border border-app-border rounded px-2 py-0.5 text-[11px] text-app-text focus:outline-none focus:border-primary text-center"
            />
          </div>

          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-app-text-muted flex-1">Auto-expire hours</span>
            <input
              type="number"
              min={1}
              max={168}
              value={settings.autoExpireHours}
              onChange={e => setSettings(s => s ? { ...s, autoExpireHours: parseInt(e.target.value) || 24 } : s)}
              className="w-16 bg-surface border border-app-border rounded px-2 py-0.5 text-[11px] text-app-text focus:outline-none focus:border-primary text-center"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-app-border">
          {saveError && <span className="text-[10px] text-red-400 flex-1">{saveError}</span>}
          <div className="flex-1" />
          <button onClick={onClose} className="text-[11px] text-app-text-muted px-3 py-1.5">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-[11px] bg-primary text-white px-3 py-1.5 rounded hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToggleSetting({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-[11px] cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="rounded border-app-border text-primary focus:ring-primary"
      />
      <span className="text-app-text">{label}</span>
    </label>
  );
}
