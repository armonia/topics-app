/**
 * IL TASTINO DELLA CRONOLOGIA, accanto a «Topics».
 *
 * Tre cose in un posto solo, ed è il posto giusto perché è dove la colonna
 * dichiara la sua identità (in alto a sinistra vive Topics; questo gli sta a
 * fianco, come deciso per la chrome mobile):
 *   1. il NUMERO delle notifiche non viste, dal vivo — arriva dal fronte
 *      `notification:new`, non da un poll;
 *   2. la LISTA, e ogni riga porta alla cosa che l'ha generata (un task apre il
 *      suo task, un messaggio apre la sua chat). Senza questo la cronologia è
 *      un elenco di rimpianti: ti dice che è successo qualcosa e ti lascia a
 *      cercarlo;
 *   3. il tasto delle IMPOSTAZIONI, che porta dove si decide cosa arriva e come.
 *
 * La lista comincia VUOTA il giorno in cui si accende, e lo dice: il registro
 * (migration 102) è un dato NUOVO, non una vista su qualcosa che c'era già:
 * prima di lui nessuno registrava cosa fosse stato mandato. Fingere una
 * cronologia piena ricostruendola a posteriori sarebbe una lista inventata.
 */
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Settings, Inbox } from 'lucide-react';
import type { WSMessage } from '../../types';
import { useNotificationHistory } from '../../hooks/useNotificationHistory';
import { formatNotificationAge } from '../../lib/notify/history';
import { useDismissable } from '../../hooks/useDismissable';
import { POPOVER_MARGIN, POPOVER_PANEL, Z_POPOVER } from '../../lib/popoverStyles';
import { RAISED_CONTROL } from '../../lib/selectionStyles';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { useT } from '../../hooks/useT';

const PANEL_W = 320;

export function NotificationHistoryButton({
  onWSMessage,
  onOpenSettings,
  isMobile = false,
  className = '',
}: {
  onWSMessage: (handler: (msg: WSMessage) => void) => () => void;
  /** Porta alle preferenze delle notifiche (per dispositivo). */
  onOpenSettings: () => void;
  isMobile?: boolean;
  className?: string;
}) {
  const tr = useT();
  // Il rettangolo del trigger si CATTURA al click, non si legge in render: un
  // ref letto durante il render non fa ri-disegnare niente quando cambia, ed è
  // anche ciò che `react-hooks/refs` vieta. Al click il bottone è già a
  // schermo, quindi la misura è quella vera.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { rows, unseen, loading, openAndMarkSeen, openRow } = useNotificationHistory(onWSMessage);

  useDismissable({ open, onClose: () => setOpen(false), refs: [triggerRef, panelRef] });

  const toggle = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (open) { setOpen(false); return; }
    setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
    // Aprendo si rilegge (il fronte può essersi perso una riconnessione) e si
    // segna visto: guardare la lista È l'atto che azzera il contatore, e quello
    // che si segna sono le righe che si stanno guardando.
    //
    // UNA chiamata, non due: la rilettura e il «visto» sono in sequenza dentro
    // l'hook. Lanciarli da qui come due cose parallele è ciò che lasciava il
    // contatore acceso per sempre — il perché è scritto su `openAndMarkSeen`.
    openAndMarkSeen();
    setOpen(true);
  }, [open, openAndMarkSeen]);

  const rect = anchor;
  const left = rect
    ? Math.min(Math.max(POPOVER_MARGIN, rect.left), Math.max(POPOVER_MARGIN, window.innerWidth - PANEL_W - POPOVER_MARGIN))
    : POPOVER_MARGIN;

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        // Stessa scatola dei suoi vicini di riga (Cerca e «+»): 44 col dito, 28
        // col mouse. Tre elementi affiancati con tre forme diverse non sono tre
        // stili, sono un difetto.
        className={`edge-lit relative ${isMobile ? 'h-11 w-11' : 'h-7 w-7'} flex items-center justify-center rounded-lg ${RAISED_CONTROL} text-app-text transition-colors flex-shrink-0 cursor-pointer app-no-drag ${className}`}
        // La classe da sola non basta: sotto Tauri e' l'ATTRIBUTO a rinunciare al
        // trascinamento, e senza di lui questo tasto e' una maniglia della
        // finestra che si apre solo per sbaglio. E' l'unico elemento del tree che
        // aveva la classe e non l'attributo, ed e' il difetto che
        // tests/e2e/drag-regions.spec.ts esiste per prendere.
        {...NO_DRAG_REGION}
        style={{ pointerEvents: 'auto' }}
        title={tr('notifications.historyTitle')}
        aria-label={unseen > 0 ? tr('notifications.historyUnseen', { n: unseen }) : tr('notifications.historyTitle')}
        aria-expanded={open}
        data-testid="notification-history-button"
      >
        <Bell size={isMobile ? 18 : 14} aria-hidden="true" />
        {/* Il numero sta SOPRA il glifo, non accanto: la riga del titolo è
            contesa e un contatore in linea allargherebbe il tasto ogni volta
            che il numero cresce. */}
        <NotificationBadge
          count={unseen}
          className="absolute -top-1 -right-1"
          ariaLabel={tr('notifications.badgeUnseen', { n: unseen })}
        />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={tr('notifications.historyTitle')}
          className={`${POPOVER_PANEL} flex flex-col`}
          style={{
            position: 'fixed',
            top: rect ? rect.bottom + 6 : POPOVER_MARGIN,
            left,
            width: PANEL_W,
            maxHeight: Math.min(420, window.innerHeight - (rect ? rect.bottom + 6 : 0) - POPOVER_MARGIN),
            zIndex: Z_POPOVER,
          }}
          data-testid="notification-history-panel"
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-app-border flex-shrink-0">
            <span className="text-[12px] font-semibold text-app-text">{tr('notifications.panelTitle')}</span>
            <button
              onClick={() => { setOpen(false); onOpenSettings(); }}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary hover:text-app-text transition-colors cursor-pointer"
              title={tr('notifications.settings')}
              aria-label={tr('notifications.settings')}
              data-testid="notification-settings-button"
            >
              <Settings size={13} />
            </button>
          </div>

          <div className="overflow-y-auto min-h-0">
            {rows.length === 0 ? (
              <div className="px-3 py-6 text-center" data-testid="notification-history-empty">
                <Inbox size={18} className="mx-auto mb-2 text-app-text-muted" aria-hidden="true" />
                <div className="text-[12px] text-app-text-secondary">
                  {loading ? tr('common.loading') : tr('notifications.empty')}
                </div>
                {!loading && (
                  // La verità, non un riempitivo: il registro parte da qui.
                  <div className="text-[11px] text-app-text-muted mt-1">
                    {tr('notifications.logStartsHere')}
                  </div>
                )}
              </div>
            ) : (
              <ul className="py-1">
                {rows.map((row) => {
                  const clickable = !!row.targetUrl;
                  return (
                    <li key={row.id}>
                      <button
                        onClick={() => { if (openRow(row)) setOpen(false); }}
                        disabled={!clickable}
                        className={`w-full text-left px-3 py-2 flex gap-2 items-start transition-colors ${
                          clickable ? 'hover:bg-app-hover cursor-pointer' : 'cursor-default'
                        }`}
                        data-testid="notification-history-row"
                        data-target={row.targetUrl ?? ''}
                      >
                        {/* Il pallino delle non viste: sparisce quando la riga
                            è stata guardata, e col «visto» di gruppo sparisce
                            anche per i suoi compagni. */}
                        <span
                          className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${row.seenAt ? 'bg-transparent' : 'bg-primary'}`}
                          aria-hidden="true"
                          data-unseen={row.seenAt ? 'false' : 'true'}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="text-[12px] font-medium text-app-text truncate">{row.title}</span>
                            <span className="text-[10px] text-app-text-muted tabular-nums flex-shrink-0 ml-auto">
                              {formatNotificationAge(row.createdAt)}
                            </span>
                          </span>
                          {row.body && (
                            <span className="block text-[11px] text-app-text-secondary line-clamp-2">{row.body}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
