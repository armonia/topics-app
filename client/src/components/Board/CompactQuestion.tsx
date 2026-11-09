import { stripMarkdown } from '../../lib/stripMarkdown';

/**
 * COMPACT CARD, A QUESTION WAITING FOR AN ANSWER: the sentence is always
 * there, because it is what the card is waiting on. Quick replies, when the
 * agent offered usable ones, come with it: buttons with no sentence to answer
 * would be worse than none. A question whose only options are the card's own
 * review choices (e.g. «land on main», which the full card draws as a choice
 * row) has no reply buttons here, but the sentence still says what is asked;
 * the choices themselves are one tap away in the drawer. Two lines of
 * question at most.
 */
export function CompactQuestion({ question, options, busy, onAnswer }: {
  question: string;
  options: readonly string[];
  busy: boolean;
  onAnswer: (option: string) => void;
}) {
  const text = stripMarkdown(question);
  return (
    <div className="mt-1 space-y-1" data-testid="card-compact-question">
      <p className="line-clamp-2 break-words text-compact leading-snug text-app-text" title={text}>{text}</p>
      {options.length > 0 && <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
        {options.map((opt, i) => (
          <button
            key={i} type="button" disabled={busy}
            data-testid="card-compact-reply"
            onClick={() => onAnswer(opt)}
            className="rounded-md bg-black/10 dark:bg-white/10 px-2 py-1 text-compact leading-4 text-app-text hover:bg-black/20 dark:hover:bg-white/20 disabled:opacity-50 coarse:min-h-11"
          >{opt}</button>
        ))}
      </div>}
    </div>
  );
}
