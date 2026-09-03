import { useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { boardApi, isAgentWorking, type BoardTask } from '../../lib/board';
import { useConfirm } from '../../hooks/useConfirm';
import { useT } from '../../hooks/useT';
import { Menu } from '../Shared/Menu';
import { Spinner } from '../Shared/Spinner';
// Import RELATIVO e non `@/lib/...`: l'alias lo risolve Vite, `bun test` no, e
// questo file è già nel mirino di una spec unitaria (`taskChoices.test.ts`).
import { POPOVER_ITEM, POPOVER_ITEM_DANGER } from '../../lib/popoverStyles';
import { sendBackComment, taskChoices, type TaskChoice, type TaskChoiceId } from './taskChoices';
import { TASK_ACTION_ICON, TASK_ACTION_ICON_TONE } from './taskActionIcons';

/**
 * Le SCELTE di una card che non è chiusa, in due forme.
 *
 * Cosa mostrare lo decide `taskChoices` (puro, testato); qui c'è solo
 * l'esecuzione, e ogni voce è una chiamata che la board fa già da un'altra
 * parte: land, review, stop, PATCH, archive. Nessuna azione nuova sul server.
 *
 * ── Due forme, e a sceglierle è il PESO della decisione ──────────────────────
 * · `TaskChoiceRow` — bottoni in fila. È la superficie su cui si DECIDE: una
 *   card in review chiede «e adesso?», e la risposta va letta senza aprire
 *   niente.
 * · `TaskChoiceMenu` — un solo tasto compatto che apre le stesse voci. È per la
 *   card che sta soltanto LAVORANDO: «Fermati» e «Consegna quello che hai» sono
 *   azioni rare, e disegnate come due bottoni pieni pesavano su ogni card in
 *   corso della board come se ci fosse qualcosa da decidere. Nel drawer restano
 *   bottoni: lì la card la stai già guardando apposta.
 *   A BLOCKED card uses the menu too, and for a second reason on top of the
 *   first one: its row was the LAST thing on the card, so on a short card it
 *   sat exactly under the pointer that meant to open the drawer, and the click
 *   changed the dispatch gate instead. The row could not move lower, so the
 *   target got smaller. See the comment on the chip row in `Card.tsx`.
 *
 * Le due forme condividono l'esecuzione (`useTaskChoiceRunner`), non una copia:
 * la conferma prima di archiviare un turno vivo, l'ordine delle voci e le
 * parole sono gli stessi da qualunque parte si clicchi.
 *
 * Il commento libero NON sta qui: resta sotto, come ultima opzione.
 */

const TONE_CLS: Record<TaskChoice['tone'], string> = {
  primary: 'bg-emerald-500/80 text-white hover:bg-emerald-500',
  neutral: 'bg-white/10 text-app-text hover:bg-white/20',
  danger: 'bg-white/10 text-rose-300 hover:bg-rose-500/20',
};

/**
 * Il glifo di una voce, dalla tabella unica (`taskActionIcons.ts`).
 *
 * Prima ce n'erano DUE, scritte qui a mano (`stop`, `deliver-now`), e solo per
 * la forma a menu: la riga di bottoni — la superficie su cui si decide — era
 * fatta di sole parole tutte uguali. Segnalato: «ci sono una serie di tasti,
 * forse standard, che non capisco effettivamente». Adesso ogni azione ha la
 * sua, identica in riga, a menu e nel drawer.
 */
function ChoiceIcon({ id, className }: { id: TaskChoiceId; className: string }) {
  const Glyph = TASK_ACTION_ICON[id];
  if (!Glyph) return null;
  return <Glyph className={`shrink-0 ${className} ${TASK_ACTION_ICON_TONE[id] ?? ''}`} aria-hidden />;
}

interface RunnerOpts {
  exclude?: TaskChoiceId[];
  onDone: () => void;
  onError: (message: string) => void;
  onNeedText?: () => void;
  /**
   * IL TESTO GIÀ SCRITTO NEL CAMPO LIBERO DELLA SUPERFICIE, se ce n'è uno.
   *
   * «Rimanda indietro» e il bottone d'invio del campo libero chiamano lo STESSO
   * `POST …/review` con la stessa decisione: la sola differenza era che il
   * primo mandava `comment: undefined`. Quindi chi scriveva l'indicazione e poi
   * premeva il bottone grande — che è quello che il pollice trova per primo, e
   * il cui tooltip dice proprio «scrivi nel campo qui sotto» — rimandava la
   * card all'agente MUTA, con la sua frase ancora nella casella.
   *
   * È una funzione e non una stringa perché la riga si ridisegna a ogni tasto
   * premuto nel campo: leggerlo al click costa un render in meno per carattere.
   */
  pendingText?: () => string;
}

/** Le scelte di questa card e come si eseguono. Una sola copia per le due forme. */
function useTaskChoiceRunner(task: BoardTask, { exclude, onDone, onError, onNeedText, pendingText }: RunnerOpts) {
  const confirm = useConfirm();
  const tr = useT();
  const [running, setRunning] = useState<TaskChoiceId | null>(null);
  const choices = taskChoices(task, { exclude, t: tr });

  const run = async (choice: TaskChoice) => {
    if (running) return;
    if (choice.needsText) { onNeedText?.(); return; }
    if (choice.id === 'drop' && isAgentWorking(task.dispatchState)) {
      // Archiviare un task con l'agent al lavoro gli taglia il turno, e il turno
      // non torna indietro: si chiede. Su una card ferma la domanda sarebbe rumore.
      const ok = await confirm({
        title: 'Archiviare un task in corso?',
        confirmLabel: 'Archivia e ferma',
        body: <p>Su questo task c&apos;è un agent al lavoro: archiviandolo il suo turno viene interrotto e non riprende.</p>,
      });
      if (!ok) return;
    }
    setRunning(choice.id);
    const { projectId, id } = task;
    try {
      switch (choice.id) {
        case 'land': await boardApi.land(projectId, id); break;
        // Rispondere a un task in review = `reject`: il server rimette il task
        // in corso e fa ripartire LO STESSO tab dell'agente. E se nel campo
        // libero c'è già un'indicazione, PARTE CON QUELLA: è la stessa chiamata
        // che faceva il bottone d'invio del campo, quindi lasciarla indietro
        // non era una scelta di disegno, era perderla.
        case 'send-back': await boardApi.review(projectId, id, 'reject', sendBackComment(pendingText?.())); break;
        case 'accept': await boardApi.review(projectId, id, 'approve'); break;
        // Esce dal giro dell'agente: in corso, con un nome sopra. `in_progress`
        // non è auto-dispatchabile (parte da `todo`) e `dispatch_state` resta di
        // una persona, quindi il reconciler non lo riprende.
        case 'take-over': await boardApi.update(projectId, id, { status: 'in_progress', assignee: 'io' }); break;
        case 'drop': await boardApi.archive(projectId, id); break;
        case 'stop': await boardApi.stop(projectId, id); break;
        // Steer: un commento su un task in corso lo bufferizza il dispatcher e
        // lo consegna all'agente al turno dopo (come Claude Code).
        case 'deliver-now':
          await boardApi.comment(projectId, id, 'Consegna adesso quello che hai: chiudi con quello che è già fatto, scrivi un commento di sintesi e metti il task in review.');
          break;
        case 'unblock': await boardApi.update(projectId, id, { blockedByTaskId: null, status: 'todo' }); break;
        case 'unlink': await boardApi.update(projectId, id, { blockedByTaskId: null }); break;
        // The same PATCH the drag to Todo makes: a human putting a card back in
        // Todo is a fresh mandate, and the server resets the attempts on it.
        case 'requeue': await boardApi.update(projectId, id, { status: 'todo' }); break;
      }
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : `${choice.label} non è riuscito`);
    } finally {
      setRunning(null);
    }
  };

  return { choices, running, run };
}

export function TaskChoiceRow({ task, exclude, disabled, onDone, onError, onNeedText, pendingText, className }: {
  task: BoardTask;
  /** Voci che il chiamante ha già come bottoni suoi (il drawer). */
  exclude?: TaskChoiceId[];
  disabled?: boolean;
  /** Ricarica dopo un'azione andata a buon fine. */
  onDone: () => void;
  onError: (message: string) => void;
  /** «Rifai così…»: porta il cursore nel commento libero invece di agire. */
  onNeedText?: () => void;
  /** Il testo già battuto nel campo libero: «Rimanda indietro» lo porta con sé. */
  pendingText?: () => string;
  className?: string;
}) {
  const { choices, running, run } = useTaskChoiceRunner(task, { exclude, onDone, onError, onNeedText, pendingText });
  if (choices.length === 0) return null;

  return (
    <div className={`flex flex-wrap gap-1 ${className ?? ''}`} data-testid="task-choices">
      {choices.map((c) => (
        <button
          key={c.id}
          data-testid={`task-choice-${c.id}`}
          disabled={disabled || running !== null}
          title={c.title}
          onClick={(e) => { e.stopPropagation(); void run(c); }}
          className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs disabled:opacity-50 ${TONE_CLS[c.tone]}`}
        >
          {/* La rotella PRENDE IL POSTO dell'icona mentre l'azione gira: se si
              aggiungesse accanto, il bottone si allargherebbe di 14px al click
              e la riga andrebbe a capo sotto il dito che l'ha premuta. */}
          {running === c.id ? <Spinner size="sm" tone="current" /> : <ChoiceIcon id={c.id} className="h-3 w-3" />}
          {c.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Le stesse scelte, dietro un tasto solo.
 *
 * Il menu si CHIUDE al click e poi l'azione parte, come il menu al tasto destro
 * della card: tenerlo aperto con una rotella dentro vorrebbe dire che una
 * risposta lenta del server lascia sullo schermo un pannello a cui non si può
 * più chiedere niente.
 */
export function TaskChoiceMenu({ task, disabled, onDone, onError, ariaLabel, className }: {
  task: BoardTask;
  disabled?: boolean;
  onDone: () => void;
  onError: (message: string) => void;
  /** Cosa apre questo tasto, detto a chi non vede l'icona. */
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const { choices, run } = useTaskChoiceRunner(task, { onDone, onError });
  if (choices.length === 0) return null;

  return (
    <>
      <button
        ref={anchorRef}
        data-testid="task-choices-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={ariaLabel}
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className={`flex shrink-0 items-center rounded-md px-1.5 py-1.5 text-app-text-secondary hover:bg-white/10 hover:text-app-text disabled:opacity-50 ${className ?? ''}`}
      ><MoreHorizontal className="h-3.5 w-3.5" /></button>
      {/* `task-choices-panel`, non `task-choices`: quello è la RIGA di bottoni,
          che vive nel drawer sopra il composer, e il drawer si apre SOPRA la
          board. Due superfici diverse non possono rispondere allo stesso
          locator. */}
      <Menu open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} align="right" ariaLabel={ariaLabel} testId="task-choices-panel">
        {choices.map((c) => (
          <button
            key={c.id}
            role="menuitem"
            data-testid={`task-choice-${c.id}`}
            title={c.title}
            onClick={(e) => { e.stopPropagation(); setOpen(false); void run(c); }}
            className={c.tone === 'danger' ? POPOVER_ITEM_DANGER : POPOVER_ITEM}
          ><ChoiceIcon id={c.id} className="h-3.5 w-3.5" /> {c.label}</button>
        ))}
      </Menu>
    </>
  );
}
