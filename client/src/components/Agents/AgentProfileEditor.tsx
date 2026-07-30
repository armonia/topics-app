import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { MODAL_OVERLAY, MODAL_PANEL } from '../../lib/modalStyles';
import { agentProfilesApi, type AgentProfile } from '../../lib/api';
import { useModalDialog } from '../../hooks/useModalDialog';

interface AgentProfileEditorProps {
  profile?: AgentProfile | null;
  onSave: (profile: AgentProfile) => void;
  onClose: () => void;
}

const ROLE_OPTIONS = [
  { value: 'lead', label: 'Lead' },
  { value: 'worker', label: 'Worker' },
  { value: 'specialist', label: 'Specialist' },
] as const;

const EMOJI_OPTIONS = ['\uD83E\uDD16', '\uD83E\uDDD1\u200D\uD83D\uDCBB', '\uD83D\uDC7E', '\uD83E\uDDE0', '\u2699\uFE0F', '\uD83D\uDD2C', '\uD83D\uDCE1', '\uD83D\uDEE0\uFE0F'];

export function AgentProfileEditor({ profile, onSave, onClose }: AgentProfileEditorProps) {
  const [name, setName] = useState(profile?.name || '');
  const [role, setRole] = useState<AgentProfile['role']>(profile?.role || 'worker');
  const [avatarEmoji, setAvatarEmoji] = useState(profile?.avatarEmoji || '\uD83E\uDD16');
  const [modelPreference, setModelPreference] = useState(profile?.modelPreference || '');
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(profile?.maxConcurrentTasks ?? 1);
  const [capabilitiesText, setCapabilitiesText] = useState((profile?.capabilities || []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = !!profile;
  const panelRef = useRef<HTMLDivElement>(null);

  // Prima si usciva SOLO dalla X: né Escape né il click sul velo chiudevano.
  useModalDialog({ onClose, panelRef });

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);

    const capabilities = capabilitiesText
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const body = {
      name: name.trim(),
      role,
      avatarEmoji,
      modelPreference: modelPreference.trim() || null,
      maxConcurrentTasks,
      capabilities,
    };

    try {
      const result = isEdit
        ? await agentProfilesApi.update(profile!.id, body)
        : await agentProfilesApi.create(body);
      onSave(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={MODAL_OVERLAY} onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit Agent Profile' : 'Create Agent Profile'}
        onClick={(e) => e.stopPropagation()}
        className={`w-[380px] max-h-[80vh] flex flex-col ${MODAL_PANEL}`}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-app-border">
          <span className="text-[13px] font-semibold text-app-text flex-1">
            {isEdit ? 'Edit Agent Profile' : 'Create Agent Profile'}
          </span>
          <button onClick={onClose} className="text-app-text-muted hover:text-app-text">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3 overflow-y-auto">
          {error && (
            <div className="text-[11px] text-red-500 bg-red-500/10 rounded px-2 py-1.5">
              {error}
            </div>
          )}

          {/* Avatar + Name */}
          <div className="flex items-start gap-3">
            <div>
              <div className="text-[11px] text-app-text-muted mb-1">Avatar</div>
              <div className="flex flex-wrap gap-1 w-[72px]">
                {EMOJI_OPTIONS.map(e => (
                  <button
                    key={e}
                    onClick={() => setAvatarEmoji(e)}
                    className={`w-8 h-8 rounded flex items-center justify-center text-lg transition-colors ${
                      avatarEmoji === e
                        ? 'bg-primary/20 ring-1 ring-primary'
                        : 'bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10'
                    }`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1">
              <div className="text-[11px] text-app-text-muted mb-1">Name</div>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Agent name..."
                className="w-full text-[11px] bg-surface border border-app-border rounded px-2 py-1.5 focus:outline-none focus:border-primary text-app-text placeholder-app-text-muted"
              />
            </div>
          </div>

          {/* Role */}
          <div>
            <div className="text-[11px] text-app-text-muted mb-1">Role</div>
            <div className="flex gap-1.5">
              {ROLE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setRole(opt.value)}
                  className={`text-[11px] px-3 py-1 rounded font-medium transition-colors ${
                    role === opt.value
                      ? 'bg-primary/20 text-primary'
                      : 'bg-black/5 dark:bg-white/5 text-app-text-muted hover:text-app-text'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Model Preference */}
          <div>
            <div className="text-[11px] text-app-text-muted mb-1">Model Preference</div>
            <input
              type="text"
              value={modelPreference}
              onChange={e => setModelPreference(e.target.value)}
              placeholder="e.g., claude-sonnet-4-20250514"
              className="w-full text-[11px] bg-surface border border-app-border rounded px-2 py-1.5 focus:outline-none focus:border-primary text-app-text placeholder-app-text-muted"
            />
          </div>

          {/* Max Concurrent Tasks */}
          <div className="flex items-center gap-2">
            <div className="text-[11px] text-app-text-muted flex-1">Max Concurrent Tasks</div>
            <input
              type="number"
              min={1}
              max={10}
              value={maxConcurrentTasks}
              onChange={e => setMaxConcurrentTasks(parseInt(e.target.value) || 1)}
              className="w-16 text-[11px] bg-surface border border-app-border rounded px-2 py-1 focus:outline-none focus:border-primary text-app-text text-center"
            />
          </div>

          {/* Capabilities */}
          <div>
            <div className="text-[11px] text-app-text-muted mb-1">Capabilities (comma-separated)</div>
            <input
              type="text"
              value={capabilitiesText}
              onChange={e => setCapabilitiesText(e.target.value)}
              placeholder="coding, testing, research..."
              className="w-full text-[11px] bg-surface border border-app-border rounded px-2 py-1.5 focus:outline-none focus:border-primary text-app-text placeholder-app-text-muted"
            />
          </div>

        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-app-border">
          <button onClick={onClose} className="text-[11px] text-app-text-muted px-3 py-1.5">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !name.trim()}
            className="text-[11px] bg-primary text-white px-3 py-1.5 rounded hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving...' : isEdit ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
