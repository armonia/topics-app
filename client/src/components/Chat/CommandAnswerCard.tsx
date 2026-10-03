import { X } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { Spinner } from '../Shared/Spinner';
import type { CommandAnswer } from '../../lib/commandAnswer';

/**
 * THE CARD OF A COMMAND'S ANSWER (CMDUI-04), at the end of the conversation,
 * right above the composer that typed it. A state of this screen: see
 * `lib/commandAnswer.ts` for why it is never saved.
 *
 * `role="status"` while the answer is awaited, so a screen reader hears it
 * change; a named `region` once it is there. The X is a 44 px target on the
 * phone. `data-testid="chat-command-result"` and `data-result-type` are the
 * names the strip it replaces had: the specs that read the answer of a command
 * read it here.
 */
export function CommandAnswerCard({ answer, isMobile, onDismiss }: {
  answer: CommandAnswer;
  isMobile: boolean;
  onDismiss: () => void;
}) {
  const tr = useT();
  const tone = answer.kind === 'error'
    ? 'border-red-500/30 bg-red-500/5'
    : 'border-app-border bg-app-surface';
  return (
    <div
      data-testid="chat-command-result"
      data-result-type={answer.kind === 'error' ? 'error' : 'success'}
      data-kind={answer.kind}
      role={answer.kind === 'running' ? 'status' : 'region'}
      aria-label={answer.kind === 'running' ? undefined : answer.title}
      className={`mx-3 mb-1.5 rounded-lg border ${tone} px-3 py-2 flex items-start gap-2`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-mini font-medium text-app-text-secondary">
          {answer.kind === 'running' && <Spinner size="sm" />}
          {answer.title && <span className="font-mono truncate">{answer.title}</span>}
        </div>
        {answer.rows && answer.rows.length > 0 && (
          <dl data-testid="chat-command-rows" className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-compact">
            {answer.rows.map((r, i) => (
              r.label
                ? <div key={i} className="contents"><dt className="text-app-text-muted whitespace-nowrap">{r.label}</dt><dd className="text-app-text min-w-0 break-words">{r.value}</dd></div>
                : <dd key={i} className="col-span-2 text-app-text break-words">{r.value}</dd>
            ))}
          </dl>
        )}
        {answer.body && (
          <div
            data-testid="chat-command-body"
            className={`mt-1 text-compact whitespace-pre-wrap break-words max-h-64 overflow-y-auto ${
              answer.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-app-text'
            }`}
          >
            {answer.body}
          </div>
        )}
        {answer.action && (
          <button
            type="button"
            data-testid="chat-command-action"
            onClick={() => answer.action?.run()}
            className="mt-1.5 text-compact font-medium text-primary hover:underline underline-offset-2"
          >
            {answer.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={tr('chat.command.dismiss')}
        onClick={onDismiss}
        className={`${isMobile ? 'w-11 h-11 -m-2' : 'w-6 h-6'} flex-shrink-0 inline-flex items-center justify-center rounded text-app-text-muted hover:text-app-text hover:bg-app-hover`}
      >
        <X size={12} />
      </button>
    </div>
  );
}
