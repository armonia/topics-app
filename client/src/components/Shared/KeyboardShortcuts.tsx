import { X } from 'lucide-react';

interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string; description: string }[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: '⌘K', description: 'Command palette' },
      { keys: '⌘N', description: 'New chat' },
      { keys: '⌘⇧N', description: 'New chat (with template)' },
      { keys: '⌘B', description: 'Toggle sidebar' },
      { keys: '⌘W', description: 'Close panel' },
      { keys: '⌘1-9', description: 'Switch panel' },
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
      { keys: '⌘⇧T', description: 'Auto TTS' },
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
      <div className="fixed inset-0 bg-black/30 dark:bg-black/50" />
      <div
        className="relative w-full max-w-md mx-4 bg-white dark:bg-[#1e1e1e] rounded-xl shadow-2xl border border-[#e0e0e0] dark:border-[#333] overflow-hidden command-palette-enter"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#e8e8e8] dark:border-[#2a2a2a]">
          <h3 className="text-[14px] font-semibold text-[#1a1a1a] dark:text-[#e5e5e5]">Keyboard Shortcuts</h3>
          <button onClick={onClose} className="text-[#888] hover:text-[#555] dark:hover:text-[#ccc]">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 max-h-[60vh] overflow-y-auto space-y-5">
          {SHORTCUT_GROUPS.map(group => (
            <div key={group.title}>
              <h4 className="text-[11px] font-semibold text-[#999] dark:text-[#666] uppercase tracking-wider mb-2">{group.title}</h4>
              <div className="space-y-1.5">
                {group.shortcuts.map(s => (
                  <div key={s.keys} className="flex items-center justify-between">
                    <span className="text-[12px] text-[#555] dark:text-[#aaa]">{s.description}</span>
                    <div className="flex items-center gap-0.5">
                      {s.keys.split('').filter(k => k !== '+').map((k, i) => {
                        // Group multi-char keys
                        return <kbd key={i} className="kbd">{k}</kbd>;
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
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
