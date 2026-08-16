import type { Topic } from '../../types';
import { useT } from '../../hooks/useT';
import { contextBits } from './emptyStateContext';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { resolveEffectiveProvider } from '../../lib/effortTiers';

/**
 * Il vuoto di una chat: il nome, l'invito, quattro spunte da cui partire.
 *
 * Stava dentro `MessageList`, in cima al contenitore che scorre, e il composer
 * stava incollato in fondo alla pane: due blocchi lontani che parlavano della
 * stessa cosa — «questa chat non è ancora cominciata» — separati da mezzo
 * schermo di niente. Adesso vive nel blocco del composer (`ChatPane`), sopra la
 * riga di testo, e i due si centrano INSIEME: un gruppo solo, che al primo
 * messaggio scivola in fondo.
 *
 * Perché qui e non lì: il blocco di fondo è già misurato da un ResizeObserver
 * (`inputAreaHeight`), quindi mettendoci dentro anche questo la centratura è la
 * stessa aritmetica di prima — nessuna seconda misura, nessuna altezza da
 * indovinare.
 */

const PROJECT_STARTERS = [
  { label: '📋 Describe this project', msg: 'Give me a brief overview of this project: what it does, the tech stack, and the main files.' },
  { label: '🔄 Recent changes', msg: 'Show me the recent git changes in this project and summarize what was modified.' },
  { label: '🐛 Find issues', msg: 'Review this project for potential bugs, code smells, or improvements.' },
];

const PLAIN_STARTERS = [
  { label: '💡 Brainstorm ideas', msg: 'Help me brainstorm some ideas.' },
  { label: '📝 Write something', msg: 'Help me write ' },
  { label: '🔍 Research a topic', msg: 'Research ' },
];

/**
 * Soglie in pixel dell'ALTEZZA della pane. Il blocco non sta più in un
 * contenitore che scorre: se non ci sta, viene tagliato in cima invece di
 * scorrere. Quindi in una pane bassa si accorcia da sé, dal basso verso
 * l'alto — prima spariscono i promemoria dei tasti, poi le spunte. Il nome e
 * l'invito restano sempre: sono il minimo che dice di che chat si tratta.
 */
const H_WITH_STARTERS = 340;
const H_WITH_HINTS = 470;

export function ChatEmptyState({
  topic,
  paneHeight,
  onPick,
  fading,
}: {
  topic: Topic;
  /** Altezza della pane, per decidere quanto blocco ci sta. */
  paneHeight: number;
  /** Riempie il composer con la spunta scelta e ci mette il fuoco. */
  onPick: (msg: string) => void;
  /**
   * La chat ha appena smesso di essere vuota. Il blocco esce dal flusso e
   * sfuma: fuori dal flusso perché altrimenti la sua altezza resterebbe nel
   * conto del ResizeObserver per tutta la dissolvenza, e la lista dei messaggi
   * si vedrebbe spingere in su di 200px per poi tornare giù.
   */
  fading: boolean;
}) {
  const t = useT();
  const starters = topic.projectPath ? PROJECT_STARTERS : PLAIN_STARTERS;
  const showStarters = paneHeight >= H_WITH_STARTERS;
  const showHints = paneHeight >= H_WITH_HINTS;
  // L'ABBONAMENTO ALLO SNAPSHOT STA QUI, e non in `ChatPane`, di proposito.
  //
  // ChatPane evita di abbonarsi apposta: si ridisegnerebbe a ogni push, e la
  // fast mode ne manda uno a ogni inizio e fine turno. Questo componente pero'
  // esiste SOLO quando la chat e' vuota, cioe' quando di turni non ce n'e'
  // nessuno: lo stesso abbonamento, qui, non paga quel prezzo.
  //
  // Serve perche' `topic.model` e' l'override e resta vuoto se non lo tocchi,
  // mentre la barra sotto al composer mostrava gia' `claude-opus-5`: due
  // superfici a un centimetro l'una dall'altra che dicevano due cose diverse
  // sulla stessa chat, e quella muta era quella che si legge PRIMA di scrivere.
  const { snapshot } = useProvidersSnapshot();
  const effettivo = resolveEffectiveProvider(
    snapshot?.providers ?? [],
    topic.provider && topic.model ? { provider: topic.provider, model: topic.model } : null,
    topic.provider ?? undefined,
  );
  const bits = contextBits(topic, t, effettivo?.model ?? null);

  return (
    <div
      data-testid="chat-empty-state"
      aria-hidden={fading || undefined}
      className={`text-center px-3 pb-3 transition-opacity duration-200 ${
        fading ? 'absolute bottom-full left-0 right-0 opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <p className="text-[14px] font-medium text-app-text-secondary">{topic.name}</p>
      {topic.systemPrompt && (
        <p className="text-[11px] text-purple-400 mt-1 flex items-center justify-center gap-1">
          <span>✨</span> Custom system prompt active
        </p>
      )}
      {!topic.projectPath && (
        <p className="text-[12px] text-app-text-muted mt-2">Start a conversation</p>
      )}
      {/* Sopra le spunte e sotto il nome: e' il posto in cui si guarda per
          capire DOVE si sta scrivendo, prima di decidere cosa scrivere. Sparisce
          per prima quando la pane e' bassa? No: sta sotto la stessa soglia delle
          spunte, perche' sapere che una chat agisce senza chiedere vale piu' di
          un suggerimento su cosa domandare. */}
      {bits.length > 0 && showStarters && (
        <p
          data-testid="chat-empty-context"
          title={t('chat.empty.contextTitle')}
          className="mt-2 text-[11px] text-app-text-faint break-words"
        >
          {bits.join(' · ')}
        </p>
      )}
      {showStarters && (
        <div className="flex flex-wrap gap-2 justify-center mt-4">
          {starters.map(q => (
            <button
              key={q.label}
              type="button"
              onClick={() => onPick(q.msg)}
              className="px-3 py-1.5 text-[12px] rounded-full border border-app-border-light text-app-text-secondary hover:bg-app-hover hover:border-primary hover:text-primary transition-all hover-lift"
            >
              {q.label}
            </button>
          ))}
        </div>
      )}
      {showHints && (
        <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 justify-center text-[11px] text-app-text-faint">
          <span className="flex items-center gap-1.5"><kbd className="kbd">⌘K</kbd> commands</span>
          <span className="flex items-center gap-1.5"><kbd className="kbd">/</kbd> slash commands</span>
          {topic.projectPath && <span className="flex items-center gap-1.5"><kbd className="kbd">@</kbd> mention file</span>}
          {/* ⌘/ e non ⌘?: la scorciatoia ne accetta due (`useKeyboardShortcuts`
              ascolta sia `/` sia `?`) e questa è l'unica delle due che si
              scrive uguale su tastiere diverse. Su una tastiera italiana il `?`
              è Shift+', cioè un tasto che il promemoria non nominava: «vedo
              command punto interrogativo, ma io non ce l'ho da tastiera». */}
          <span className="flex items-center gap-1.5"><kbd className="kbd">⌘/</kbd> all shortcuts</span>
        </div>
      )}
    </div>
  );
}
