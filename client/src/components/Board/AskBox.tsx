import { CircleAlert } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { SEGNALE_ATTESA } from '../Sidebar/chromeSignals';
import type { ForYou } from '../../../../shared/for-you';

/**
 * «Ti chiede»: the one question a card in Review waits on, with its choices as
 * buttons (the recommended one first). Amber frame; renders
 * nothing when there is no open question, so «needs you» is never claimed
 * without one.
 */
export function AskBox({ question, forYou, options, busy, onAnswer }: {
  question: string | null;
  /** The system-written plain-words summary; when present it replaces the raw question. */
  forYou?: ForYou | null;
  options: readonly string[];
  busy: boolean;
  onAnswer: (option: string) => void;
}) {
  const tr = useT();
  if (!question && !forYou) return null;
  const choices = options.length > 0 ? options : (forYou?.options ?? []);
  return (
    <div data-testid="task-ask-box" className="flex flex-col gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
      <span className={`flex items-center gap-1 text-mini font-medium ${SEGNALE_ATTESA}`}>
        <CircleAlert className="h-3 w-3 shrink-0" aria-hidden />{tr('board.task.asksYou')}
      </span>
      {forYou ? (
        <div data-testid="task-for-you" className="space-y-1 text-compact leading-5 text-app-text">
          <p className="break-words text-body-lg font-medium leading-5">{forYou.asked}</p>
          <p className="break-words"><span className="text-app-text-muted">{tr('board.task.forYou.happened')} </span>{forYou.happened}</p>
          <p className="break-words"><span className="text-app-text-muted">{tr('board.task.forYou.done')} </span>{forYou.done}</p>
          <p className="break-words"><span className="text-app-text-muted">{tr('board.task.forYou.remains')} </span>{forYou.remains}</p>
        </div>
      ) : (
        <p className="break-words text-body-lg leading-5 text-app-text">{question}</p>
      )}
      {choices.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {choices.map((opt, i) => (
            <button key={opt} type="button" disabled={busy} data-testid="task-ask-option" onClick={() => onAnswer(opt)}
              className={`rounded border px-2.5 py-1.5 text-left text-compact leading-4 text-app-text disabled:opacity-50 coarse:min-h-11 ${i === 0 ? 'border-amber-500/60 bg-amber-500/20 hover:bg-amber-500/30' : 'border-app-border bg-white/5 hover:bg-white/10'}`}>
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
