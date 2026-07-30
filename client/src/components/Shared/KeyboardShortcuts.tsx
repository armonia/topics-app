import { useRef } from 'react';
import { X } from 'lucide-react';
import { MODAL_BACKDROP, MODAL_PANEL } from '../../lib/modalStyles';
import { isDesktop } from '../../lib/shell';
import { useModalDialog } from '../../hooks/useModalDialog';

interface Shortcut {
  /** I tasti come TOKEN, non come stringa da spezzare.
   *  Prima era una stringa e il render faceva `keys.split('')`: un `<kbd>` per
   *  CARATTERE. "Enter" usciva come E · n · t · e · r, "⌘1-9" come ⌘ · 1 · - · 9.
   *  Un elenco esplicito non si può sbagliare. */
  keys: string[];
  description: string;
  /** Esiste solo nella shell desktop (Tauri/Electron), non su web/PWA. */
  desktopOnly?: boolean;
}

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

/**
 * La verità su cosa fa la tastiera. Il file da tenere allineato quando si tocca
 * `hooks/useKeyboardShortcuts` (globali), `ChatInput` (voce) o il menu nativo in
 * `desktop-tauri/src-tauri/src/lib.rs` (finestra).
 *
 * Cosa mancava, e perché conta: il pannello elencava 20 scorciatoie su ~35 e ne
 * NASCONDEVA altre. Fuori c'erano famiglie intere — annullare/ripeti, il giro
 * fra le tab, zoom e ricarica, Escape che interrompe il turno — cioè proprio le
 * cose che uno cerca qui perché non le indovina da solo.
 */
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'General',
    shortcuts: [
      { keys: ['⌘', 'K'], description: 'Command palette' },
      { keys: ['⌘', 'F'], description: 'Find project' },
      { keys: ['⌘', 'P'], description: 'Quick-open file' },
      { keys: ['⌘', '⇧', 'F'], description: 'Quick-open file (alias)' },
      { keys: ['⌘', 'N'], description: 'New… (add menu)' },
      { keys: ['⌘', '⇧', 'N'], description: 'New chat (with template)' },
      { keys: ['⌘', 'B'], description: 'Toggle sidebar' },
      { keys: ['⌘', 'Z'], description: 'Undo (layout, tabs)' },
      { keys: ['⌘', '⇧', 'Z'], description: 'Redo' },
      { keys: ['⌘', ','], description: 'Settings' },
      { keys: ['⌘', '?'], description: 'Keyboard shortcuts' },
    ],
  },
  {
    title: 'Panels & tabs',
    shortcuts: [
      { keys: ['⌘', '1-9'], description: 'Switch panel', desktopOnly: true },
      { keys: ['⌘', 'W'], description: 'Close focused panel', desktopOnly: true },
      { keys: ['⌘', '⇧', 'T'], description: 'Reopen closed tab (alias ⌘⇧U)' },
      { keys: ['⌃', 'Tab'], description: 'Next panel' },
      { keys: ['⌃', '⇧', 'Tab'], description: 'Previous panel (alias ⌘⇧Tab)' },
    ],
  },
  {
    title: 'Chat',
    shortcuts: [
      { keys: ['Enter'], description: 'Send message' },
      { keys: ['⇧', 'Enter'], description: 'New line' },
      { keys: ['/'], description: 'Slash commands' },
      { keys: ['@'], description: 'Mention file (in project)' },
      { keys: ['⌘', 'U'], description: 'Attach file' },
      { keys: ['Esc'], description: 'Interrupt the running turn' },
    ],
  },
  {
    title: 'Voice',
    shortcuts: [
      { keys: ['⌘', '⇧', 'R'], description: 'Record voice' },
      { keys: ['⌘', '⇧', 'C'], description: 'Voice call' },
      { keys: ['⌘', '⇧', 'D'], description: 'Dictation' },
      { keys: ['⌘', '⇧', 'S'], description: 'Auto TTS' },
    ],
  },
  {
    title: 'Board',
    shortcuts: [
      { keys: ['⌘', 'tap'], description: 'Right ⌘, tapped alone: focus the task composer' },
    ],
  },
  {
    title: 'Window',
    shortcuts: [
      { keys: ['⌘', 'R'], description: 'Reload', desktopOnly: true },
      { keys: ['⌘', '='], description: 'Zoom in', desktopOnly: true },
      { keys: ['⌘', '-'], description: 'Zoom out', desktopOnly: true },
      { keys: ['⌘', '0'], description: 'Actual size', desktopOnly: true },
      { keys: ['⌘', '⌥', 'T'], description: 'Always on top (works unfocused)', desktopOnly: true },
      { keys: ['⌘', 'Q'], description: 'Quit Topics', desktopOnly: true },
    ],
  },
];

interface KeyboardShortcutsProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcuts({ isOpen, onClose }: KeyboardShortcutsProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Escape lo chiudeva già (useKeyboardShortcuts lo conosce per nome); qui si
  // aggiungono la trappola del focus e il ritorno del focus a chi l'ha aperto.
  useModalDialog({ open: isOpen, onClose, panelRef });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose} role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts">
      <div className={MODAL_BACKDROP} />
      <div
        ref={panelRef}
        className={`relative w-full max-w-md mx-4 ${MODAL_PANEL}`}
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
            // `desktopOnly` voleva dire "solo nella shell desktop", ma il filtro
            // le toglieva SEMPRE: ⌘W, ⌘1-9 e ⌘⇧N non comparivano nemmeno
            // sull'app desktop, cioè l'unico posto in cui funzionano.
            const shortcuts = group.shortcuts.filter(s => !s.desktopOnly || isDesktop);
            if (shortcuts.length === 0) return null;
            return (
              <div key={group.title}>
                <h4 className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-2">{group.title}</h4>
                <div className="space-y-1.5">
                  {shortcuts.map(s => (
                    <div key={s.description} className="flex items-center justify-between gap-3">
                      <span className="text-[12px] text-app-text-secondary">{s.description}</span>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {s.keys.map((k, i) => <kbd key={i} className="kbd">{k}</kbd>)}
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
