import { X } from 'lucide-react';
import { MODAL_BACKDROP } from '../../lib/modalStyles';

interface Shortcut {
  keys: string;
  description: string;
  desktopOnly?: boolean;
}

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: '⌘K', description: 'Command palette' },
      { keys: '⌘F', description: 'Find project' },
      { keys: '⌘P', description: 'Quick-open file' },
      { keys: '⌘⇧F', description: 'Quick-open file (alias)' },
      { keys: '⌘N', description: 'New… (add menu)' },
      { keys: '⌘B', description: 'Toggle sidebar' },
      { keys: '⌘?', description: 'Keyboard shortcuts' },
      { keys: '⌘⇧N', description: 'New chat (with template)', desktopOnly: true },
      { keys: '⌘W', description: 'Close panel', desktopOnly: true },
      { keys: '⇧⌘T', description: 'Reopen closed tab (alias ⌘⇧U)' },
      { keys: '⌘1-9', description: 'Switch panel', desktopOnly: true },
    ],
  },
  {
    title: 'Chat',
    shortcuts: [
      { keys: 'Enter', description: 'Send message' },
      { keys: '⇧Enter', description: 'New line' },
      { keys: '/', description: 'Slash commands' },
      { keys: '@', description: 'Mention file (in project)' },
      { keys: '⌘U', description: 'Attach file' },
    ],
  },
  {
    title: 'Voice',
    shortcuts: [
      { keys: '⌘⇧R', description: 'Record voice' },
      { keys: '⌘⇧C', description: 'Voice call' },
      { keys: '⌘⇧D', description: 'Dictation' },
      { keys: '⌘⇧S', description: 'Auto TTS' },
    ],
  },
];

interface KeyboardShortcutsProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcuts({ isOpen, onClose }: KeyboardShortcutsProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
      <div className={MODAL_BACKDROP} />
      <div
        className="relative w-full max-w-md mx-4 bg-surface rounded-xl shadow-2xl border border-app-border overflow-hidden command-palette-enter"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <h3 className="text-[14px] font-semibold text-app-text">Keyboard Shortcuts</h3>
          <button onClick={onClose} className="text-app-text-muted hover:text-app-text-secondary">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 max-h-[60vh] overflow-y-auto space-y-5">
          {SHORTCUT_GROUPS.map(group => {
            const shortcuts = group.shortcuts.filter(s => !s.desktopOnly);
            if (shortcuts.length === 0) return null;
            return (
              <div key={group.title}>
                <h4 className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-2">{group.title}</h4>
                <div className="space-y-1.5">
                  {shortcuts.map(s => (
                    <div key={s.keys} className="flex items-center justify-between">
                      <span className="text-[12px] text-app-text-secondary">{s.description}</span>
                      <div className="flex items-center gap-0.5">
                        {s.keys.split('').filter(k => k !== '+').map((k, i) => {
                          return <kbd key={i} className="kbd">{k}</kbd>;
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Inline shortcut hint (small badge)
export function ShortcutHint({ keys, className = '' }: { keys: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`}>
      {keys.split(' ').map((k, i) => (
        <kbd key={i} className="kbd">{k}</kbd>
      ))}
    </span>
  );
}
