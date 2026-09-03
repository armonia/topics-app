/**
 * IL BOTTONE DEL MICROFONO, uno solo per tutte le superfici che scrivono.
 *
 * Segnalato: «tutti quanti gli input AI devono essere consistenti in termini di
 * funzionalità, dal microfono al caricamento di file».
 *
 * Misurato prima di scrivere: il microfono c'era sul composer della chat e su
 * quello della board, NON sul thread di un task — che ha graffetta e incolla,
 * quindi non è «un campo minore», è un campo pieno a cui manca una cosa sola.
 * Chi detta un task e poi vuole rispondere all'agente trova il gesto sparito.
 *
 * ESTRATTO E NON RICOPIATO, ed è il punto: il bottone porta con sé quattro
 * comportamenti che una seconda stesura perde uno alla volta — il gesto
 * tieni-premuto, lo stato «sto trascrivendo» separato da «sto ascoltando»,
 * `touch-none` (senza, tenere premuto su un telefono fa partire lo scroll e il
 * gesto muore a metà) e la scomparsa totale quando non c'è un motore di
 * trascrizione, perché un tasto che non può funzionare è peggio di uno assente.
 */
import { Loader2, Mic } from 'lucide-react';
import { useCallback } from 'react';
import { useDictation } from '../../hooks/useDictation';
import { useTalkGesture } from '../../hooks/useTalkGesture';
import { useT } from '../../hooks/useT';

export function DictationButton({
  onText,
  onError,
  onNotice,
  testId,
  className = '',
}: {
  /** Il testo trascritto, da inserire dove sta il cursore. */
  onText: (text: string) => void;
  onError: (message: string) => void;
  /** The text arrived but from the fallback engine: here is why (optional). */
  onNotice?: (message: string) => void;
  testId: string;
  className?: string;
}) {
  const tr = useT();
  const err = useCallback((m: string) => onError(m), [onError]);
  const dictation = useDictation({ onText, onError: err, onNotice });
  const talk = useTalkGesture({
    start: dictation.start,
    stop: dictation.stop,
    enabled: dictation.isSupported && !dictation.isTranscribing,
  });

  // Niente motore, niente bottone: un tasto che non può funzionare è peggio di
  // uno assente — chi lo preme non impara che manca il motore, impara che
  // l'app non risponde.
  if (!dictation.isSupported) return null;

  return (
    <button
      type="button"
      {...talk.handlers}
      data-testid={testId}
      data-listening={dictation.isListening ? 'true' : 'false'}
      disabled={dictation.isTranscribing}
      title={dictation.isTranscribing
        ? tr('board.composer.dictationTranscribing')
        : dictation.isListening
          ? tr('board.composer.dictationStop')
          : tr('board.composer.dictateTitle', { model: dictation.modelLabel ? ` · ${dictation.modelLabel}` : '' })}
      aria-label={tr(dictation.isListening ? 'board.composer.dictationStop' : 'board.composer.dictate')}
      // `touch-none` toglie il gesto al browser: senza, tenere premuto su un
      // telefono fa partire lo scroll e il gesto muore a metà.
      className={`shrink-0 touch-none select-none rounded-lg p-1.5 transition-colors disabled:opacity-40 ${
        dictation.isListening
          ? 'bg-red-500 text-white animate-pulse'
          : talk.pressing
            ? 'bg-app-hover text-app-text'
            : 'text-app-text-tertiary hover:bg-app-hover hover:text-app-text'
      } ${className}`}
    >
      {dictation.isTranscribing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
    </button>
  );
}
