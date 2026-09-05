/**
 * THE BOARD'S ENVELOPE TALKS, IT DOES NOT IMPERSONATE.
 *
 * The kickoff, the resume and the nudge are `user` rows because that is the
 * only role a provider answers, and drawn as bubbles they put three hundred
 * lines of instructions in the person's mouth, with an "edit" button on them.
 * One service line instead, openable, because the resume envelope carries the
 * human's own message inside it: collapsed, never hidden.
 *
 * It lives in a file of its own because TWO surfaces draw it now: the topic
 * chat (`MessageBubble`) and the card's conversation (`TaskDetail`). One
 * definition, so the two can never disagree about what an envelope looks like
 * or about which of them lets you open it.
 *
 * See `dispatchedEnvelope.ts` for the rule that decides a row IS one.
 */
import { useState } from 'react';
import { Bot } from 'lucide-react';
import { useT } from '../../hooks/useT';

export function DispatchEnvelopeRow({ messageId, content }: {
  /** The row's id, so an E2E locator can point at THIS envelope. */
  messageId?: string;
  /** The generated text, shown only once the reader asks for it. */
  content: string;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="dispatch-envelope-row"
      data-message-id={messageId}
      data-open={open || undefined}
      className="my-1 px-2 text-[11px] text-app-text-muted"
    >
      <div className="flex items-center justify-center gap-1.5">
        <Bot size={11} className="flex-shrink-0" />
        <span className="truncate" title={tr('chat.dispatchEnvelope.title')}>{tr('chat.dispatchEnvelope.line')}</span>
        <button
          type="button"
          data-testid="dispatch-envelope-toggle"
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 underline-offset-2 hover:text-app-text hover:underline"
        >
          {open ? tr('chat.dispatchEnvelope.hide') : tr('chat.dispatchEnvelope.show')}
        </button>
      </div>
      {open && (
        <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-app-inset p-2 text-[11px] leading-relaxed text-app-text-secondary">
          {content}
        </pre>
      )}
    </div>
  );
}
