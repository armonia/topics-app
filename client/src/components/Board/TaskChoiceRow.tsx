import { useState } from 'react';
import { boardApi, isAgentWorking, type BoardTask } from '../../lib/board';
import { useConfirm } from '../../hooks/useConfirm';
import { useT } from '../../hooks/useT';
import { Spinner } from '../Shared/Spinner';
import { taskChoices, type TaskChoice, type TaskChoiceId } from './taskChoices';

/**
 * La riga di SCELTE di una card che non è chiusa — card e drawer, un componente
 * solo.
 *
 * Cosa mostrare lo decide `taskChoices` (puro, testato); qui c'è solo
 * l'esecuzione, e ogni voce è una chiamata che la board fa già da un'altra
 * parte: land, review, stop, PATCH, archive. Nessuna azione nuova sul server.
 *
 * Il commento libero NON sta qui: resta sotto, come ultima opzione.
 */

const TONE_CLS: Record<TaskChoice['tone'], string> = {
  primary: 'bg-emerald-500/80 text-white hover:bg-emerald-500',
  neutral: 'bg-white/10 text-app-text hover:bg-white/20',
  danger: 'bg-white/10 text-rose-300 hover:bg-rose-500/20',
};

export function TaskChoiceRow({ task, exclude, disabled, onDone, onError, onNeedText, className }: {
  task: BoardTask;
  /** Voci che il chiamante ha già come bottoni suoi (il drawer). */
  exclude?: TaskChoiceId[];
  disabled?: boolean;
  /** Ricarica dopo un'azione andata a buon fine. */
  onDone: () => void;
  onError: (message: string) => void;
  /** «Rifai così…»: porta il cursore nel commento libero invece di agire. */
  onNeedText?: () => void;
  className?: string;
}) {
  const confirm = useConfirm();
  const tr = useT();
  const [running, setRunning] = useState<TaskChoiceId | null>(null);
  const choices = taskChoices(task, { exclude, t: tr });
  if (choices.length === 0) return null;

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
        // in corso e fa ripartire LO STESSO tab dell'agente.
        case 'send-back': await boardApi.review(projectId, id, 'reject'); break;
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
      }
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : `${choice.label} non è riuscito`);
    } finally {
      setRunning(null);
    }
  };

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
          {running === c.id && <Spinner size="sm" tone="current" />}
          {c.label}
        </button>
      ))}
    </div>
  );
}
