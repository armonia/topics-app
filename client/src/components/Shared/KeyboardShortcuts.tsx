import { useRef } from 'react';
import { X } from 'lucide-react';
import { MODAL_BACKDROP, MODAL_PANEL, MODAL_LAYER } from '../../lib/modalStyles';
import { isDesktop } from '../../lib/shell';
import { useModalDialog } from '../../hooks/useModalDialog';
import { useT } from '../../hooks/useT';
// The ONE source of truth. The same registry generates the native shell's
// chord-forwarding allowlist (shortcuts_generated.rs) — add a chord once and
// both the window below and the desktop forwarder pick it up. See the file.
import { SHORTCUT_GROUPS } from '../../../../shared/shortcuts';

interface KeyboardShortcutsProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcuts({ isOpen, onClose }: KeyboardShortcutsProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  // Escape lo chiudeva già (useKeyboardShortcuts lo conosce per nome); qui si
  // aggiungono la trappola del focus e il ritorno del focus a chi l'ha aperto.
  useModalDialog({ open: isOpen, onClose, panelRef });

  if (!isOpen) return null;

  return (
    <div className={`fixed inset-0 ${MODAL_LAYER} flex items-center justify-center`} onClick={onClose} role="dialog" aria-modal="true" aria-label="Keyboard Shortcuts">
      <div className={MODAL_BACKDROP} />
      <div
        ref={panelRef}
        className={`relative w-full max-w-md mx-4 ${MODAL_PANEL}`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <h3 className="text-[14px] font-semibold text-app-text">Keyboard Shortcuts</h3>
          <button aria-label={t('shortcuts.close')} onClick={onClose} className="text-app-text-muted hover:text-app-text-secondary">
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
