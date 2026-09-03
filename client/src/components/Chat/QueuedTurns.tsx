/**
 * QUELLO CHE HAI SCRITTO E NON È ANCORA PARTITO — in UN posto solo.
 *
 * La coda del turno (`state/chatQueue.ts`) si vedeva DUE volte: come bolle in
 * fondo al trascritto (mute: si leggevano e basta) e come badge a scomparsa
 * sopra il composer, che era l'unico posto da cui si potesse correggere una
 * riga, buttarla, svuotare tutto o non aspettare la fine del turno. Due
 * rappresentazioni della stessa coda, a due centimetri l'una dall'altra, con la
 * stessa parola scritta sopra: chi guardava la chat vedeva il messaggio due
 * volte e non sapeva quale delle due fosse quello vero.
 *
 * Ne resta UNA, ed è quella che dice la verità sul posto: il messaggio dove
 * finirà quando partirà. Tutto quello che il badge sapeva fare vive qui, sulla
 * bolla che riguarda:
 *
 *   - **correggere** — click sul testo, si edita in loco (`Invio` salva,
 *     `Esc` annulla). Il pannello faceva scrivere in una textarea staccata dal
 *     posto in cui il messaggio sarebbe apparso;
 *   - **buttare** — la X sulla riga;
 *   - **send now**: stops the turn in flight and fires the queue now. Shown
 *     with the turn IDLE too: a queue that no `stream:end` ever released
 *     (reload, relaunch, socket lost for a second) used to sit in the
 *     transcript with no control that could fire it;
 *   - **svuotare** — solo quando le righe sono più d'una: con una riga sola la
 *     X di quella riga È lo svuota, e due bottoni per la stessa azione sono un
 *     bivio finto.
 *
 * Si distinguono per SOTTRAZIONE, non per colore: stessa scocca e stessa tinta
 * della bolla utente, inchiostro più tenue, bordo tratteggiato. Il tratteggio è
 * la differenza che si legge senza leggere — un contorno interrotto è una cosa
 * non ancora chiusa. La tinta resta `bg-app-user-bubble` e NON l'accento: in
 * quest'app il blu è il colore delle azioni, e un messaggio non è un'azione
 * (stessa regola della bolla utente, `MessageBubble`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import type { QueuedTurn } from '../../state/chatQueue';

export interface QueuedTurnsProps {
  turns: QueuedTurn[];
  isMobile: boolean;
  /** Correggi una riga in attesa. Per ID: la testa può partire mentre scrivi. */
  onUpdate?: (id: string, content: string) => void;
  onRemove?: (id: string) => void;
  onClear?: () => void;
  /** Stops the turn in flight (if any) and fires the queue now. See ChatPane. */
  onSendNow?: () => void;
  /** A turn is still in flight: only changes what the button promises (stop it or not). */
  busy?: boolean;
}

export function QueuedTurns({ turns, isMobile, onUpdate, onRemove, onClear, onSendNow, busy }: QueuedTurnsProps) {
  const t = useT();
  if (turns.length === 0) return null;
  return (
    <div data-testid="queued-bubbles" className={isMobile ? 'px-2' : 'px-4'}>
      {turns.map((turn) => (
        <QueuedBubble
          key={turn.id}
          turn={turn}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
      ))}
      {/* La riga delle azioni che valgono per TUTTA la coda, non per una bolla.
          Sta sotto l'ultima e allineata a destra come loro: è il seguito della
          colonna di ciò che sta per partire, non una barra di strumenti. */}
      {(onSendNow || onClear) && (
        <div className="mt-1 flex items-center justify-end gap-3 pr-1">
          {/* Prima dello «svuota» e non dopo: l'azione che costruisce viene
              prima di quella che butta. */}
          {onSendNow && (
            <button
              type="button"
              onClick={onSendNow}
              data-testid="queue-send-now"
              data-queue-busy={busy ? 'true' : 'false'}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:text-primary-hover transition-colors"
              title={t(busy ? 'chat.queue.sendNowTitle' : 'chat.queue.sendNowIdleTitle')}
            >
              <Send size={11} className="flex-shrink-0" />
              {t('chat.queue.sendNow')}
            </button>
          )}
          {/* Con UNA riga sola la sua X è già lo svuota. */}
          {onClear && turns.length > 1 && (
            <button
              type="button"
              onClick={onClear}
              data-testid="queue-clear"
              className="text-[11px] text-app-text-muted hover:text-red-500 transition-colors"
              title={t('chat.queue.clearTitle')}
            >
              {t('chat.queue.clear')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Una riga in attesa. In lettura è una bolla; al click diventa il campo in cui
 * l'hai scritta, nella stessa posizione e con la stessa misura — così correggere
 * non sposta niente sotto gli occhi.
 */
function QueuedBubble({
  turn,
  onUpdate,
  onRemove,
}: {
  turn: QueuedTurn;
  onUpdate?: (id: string, content: string) => void;
  onRemove?: (id: string) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(turn.content);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: una riga lunga si corregge per intero, senza uno scroller dentro
  // una bolla dentro uno scroller.
  const resize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  }, []);

  useEffect(() => {
    if (!editing) return;
    setDraft(turn.content);
    // Il focus va in fondo al testo: si corregge la fine molto più spesso
    // dell'inizio.
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    resize();
    // `turn.content` fuori dalle dipendenze di proposito: mentre stai scrivendo,
    // un aggiornamento della coda da un'altra finestra non deve strapparti via
    // la bozza.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, resize]);

  useEffect(() => { if (editing) resize(); }, [draft, editing, resize]);

  // Fuori edit, il testo di questa riga può cambiare da un'altra finestra.
  useEffect(() => { if (!editing) setDraft(turn.content); }, [turn.content, editing]);

  const commit = useCallback(() => {
    const next = draft.trim();
    setEditing(false);
    if (!next) { onRemove?.(turn.id); return; }
    if (next !== turn.content) onUpdate?.(turn.id, next);
  }, [draft, onRemove, onUpdate, turn.content, turn.id]);

  const cancel = useCallback(() => {
    setDraft(turn.content);
    setEditing(false);
  }, [turn.content]);

  return (
    <div className="group flex justify-end mt-1.5">
      <div
        data-testid="queued-bubble"
        data-queued-id={turn.id}
        className="relative max-w-[85%] min-w-0 px-3 py-2 rounded-2xl border border-dashed border-app-border bg-app-user-bubble/60 text-[13px] leading-relaxed text-app-text-secondary"
        title={editing ? undefined : t('chat.queue.waitingTitle')}
      >
        {editing ? (
          <textarea
            ref={taRef}
            data-testid="queued-bubble-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              // `Invio` salva, `Shift+Invio` va a capo: la stessa grammatica del
              // composer in cui questa riga è stata scritta.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
              else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            }}
            rows={1}
            className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-app-text outline-none"
          />
        ) : (
          <button
            type="button"
            data-testid="queued-bubble-edit"
            onClick={() => onUpdate && setEditing(true)}
            className={`block w-full text-left ${onUpdate ? 'cursor-text' : 'cursor-default'}`}
            title={onUpdate ? t('chat.queue.editTitle') : undefined}
          >
            <span className="block whitespace-pre-wrap break-words">{turn.content}</span>
          </button>
        )}
        {/* «da inviare», non «in coda»: la lista di cose da fare dell'agente
            diceva anche lei «in coda», e due strisce affiancate col nome della
            stessa cosa non si distinguono. Qui l'unica cosa che conta è il
            VERSO: questi messaggi partono da te. */}
        <p className="mt-0.5 text-right text-[11px] text-app-text-muted">{t('chat.queue.waiting')}</p>
        {onRemove && !editing && (
          // Fuori dalla bolla, sul suo fianco: dentro dovrebbe rubare spazio al
          // testo o coprirlo. Appare al passaggio del mouse — e sempre, dove il
          // mouse non c'è (`group-focus-within` copre la tastiera).
          <button
            type="button"
            data-testid="queued-bubble-remove"
            onClick={() => onRemove(turn.id)}
            title={t('chat.queue.removeTitle')}
            aria-label={t('chat.queue.removeTitle')}
            className="absolute -left-6 top-1/2 -translate-y-1/2 p-1 rounded text-app-text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-500 transition-opacity"
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
