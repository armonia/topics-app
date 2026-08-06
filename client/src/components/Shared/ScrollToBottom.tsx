import { ArrowDown } from 'lucide-react';

interface ScrollToBottomProps {
  show: boolean;
  newCount: number;
  onClick: () => void;
  bottomOffset?: number;
}

/**
 * CENTRATA sopra il composer, non incollata a destra.
 *
 * Stava `right-3`, cioè al bordo destro dello SCROLLER — che è largo quanto la
 * pane. Da quando la colonna di lettura ha un tetto ed è centrata
 * (`chat-measure`), quel bordo non è più il bordo di niente che si vede: su una
 * finestra larga la freccia finiva a mezzo schermo di distanza dal testo a cui
 * si riferisce, sospesa nel vuoto a destra.
 *
 * Centrata risolve entrambe le cose in una: sta sopra la colonna qualunque
 * larghezza abbia (lo scroller e la colonna condividono il centro), ed è dove
 * la cercano le mani — sopra il punto in cui si sta per scrivere.
 */
export function ScrollToBottom({ show, newCount, onClick, bottomOffset = 0 }: ScrollToBottomProps) {
  if (!show) return null;

  return (
    <button
      onClick={onClick}
      data-testid="scroll-to-bottom"
      // TONDA quando è sola, pillola solo quando ha un numero da portare.
      //
      // `rounded-full` su un rettangolo dà un OVALE, non un cerchio: la forma la
      // decide il rapporto fra i lati, non il raggio. Con un `px-3` fisso la
      // sola freccia misurava 38×32 — abbastanza per accorgersene. Senza
      // conteggio la larghezza si fissa uguale all'altezza (`w-8 h-8`) e torna
      // un cerchio; col conteggio si allarga, ed è l'unico caso in cui deve.
      className={`absolute left-1/2 -translate-x-1/2 z-10 h-8 bg-app-user-bubble hover:bg-app-hover text-app-text border border-app-border-light rounded-full shadow-lg flex items-center justify-center text-[12px] font-medium transition-colors duration-200 ${
        newCount > 0 ? 'px-3 gap-1.5' : 'w-8'
      }`}
      style={{ bottom: bottomOffset + 12 }}
      title="Scroll to bottom"
      aria-label="Scroll to bottom"
    >
      <ArrowDown size={14} className="flex-shrink-0" />
      {/* Il conteggio è una PAROLA, non un pallino rosso appiccicato: il rosso
          è il colore degli errori, e «tre messaggi nuovi» non è un errore.
          Quando c'è, la pillola gli fa spazio. */}
      {newCount > 0 && <span className="tabular-nums">{newCount > 99 ? '99+' : newCount}</span>}
    </button>
  );
}

interface NewMessageBannerProps {
  show: boolean;
  onClick: () => void;
}

export function NewMessageBanner({ show, onClick }: NewMessageBannerProps) {
  if (!show) return null;

  return (
    <button
      onClick={onClick}
      className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-primary text-white text-[11px] font-medium px-3 py-1 rounded-full shadow-md hover:bg-primary-hover transition-all duration-200 animate-bounce-once"
    >
      New messages ↓
    </button>
  );
}
