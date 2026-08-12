/**
 * La riga di ritorno: da DOVE SI LAVORA a DOVE SI DECIDE.
 *
 * Il legame fra un task e la sessione che lo lavora era a senso unico. Dalla
 * board si arrivava alla chat dell'agente (`assignedTopicId`, sulla card); da
 * dentro la chat non si tornava — e la scheda è la superficie che porta la
 * descrizione, la checklist, la consegna e il thread, cioè tutto ciò che serve
 * per decidere. Chi legge la chat per capire se approvare doveva ritrovare la
 * card a mano sulla board.
 *
 * Compare SOLO nelle chat che sono la sessione di un task (`state/taskSessions`,
 * riempito una volta sola dall'indice di board): in una chat qualsiasi non c'è
 * niente da mostrare e la riga non esiste. Il titolo del task è lì perché una
 * sessione di board si chiama come il task solo nei primi 60 caratteri — e
 * perché senza il titolo il bottone chiederebbe di fidarsi.
 */
import { ClipboardList } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { openTaskInApp } from '../../lib/openTaskLink';
import { useTopicTask } from '../../state/taskSessions';

export function TaskCardStrip({ topicId }: { topicId: string }) {
  const tr = useT();
  const task = useTopicTask(topicId);
  if (!task) return null;

  return (
    <div
      data-testid="chat-task-card-strip"
      className="chat-measure flex flex-shrink-0 items-center gap-2 border-b border-app-border px-3 py-1.5"
    >
      <ClipboardList size={13} className="flex-shrink-0 text-app-text-secondary" />
      <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-app-text-muted">
        {tr('chat.session.taskLabel')}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-app-text" title={task.text}>
        {task.text}
      </span>
      {/* Stesso imbuto del click su una notifica e di un link `/task/<id>`
          incollato in un commento: attiva la board e apre il drawer.
          `stopPropagation` non è cautela: il click bolla fino al riquadro della
          pane, che a quel punto rimette il fuoco SULLA CHAT — cioè disfa, un
          gradino più in su, il gesto appena fatto, e la board resta dietro
          (`display:none`) col drawer aperto e invisibile. */}
      <button
        type="button"
        data-testid="chat-open-task-card"
        onClick={(e) => { e.stopPropagation(); openTaskInApp({ taskId: task.taskId }); }}
        title={tr('chat.session.openTaskCardTitle')}
        className="flex-shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-app-text-heading hover:bg-white/10"
      >{tr('chat.session.openTaskCard')}</button>
    </div>
  );
}
