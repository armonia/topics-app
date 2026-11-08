import { stripMarkdown } from '../../lib/stripMarkdown';

/**
 * COMPACT CARD, A QUESTION WAITING FOR AN ANSWER: the question and its quick
 * replies come as a pair. Answers without the question are buttons with no
 * sentence to answer, and the question alone is a card that asks something it
 * cannot be answered from. Two lines of question at most; the full thread
 * stays behind the drawer.
 *
 * Renders nothing without options: a question with no quick reply is already
 * carried by the full card's flow, and the compact card keeps its two lines.
 */
export function CompactQuestion({ question, options, busy, onAnswer }: {
  question: string;
  options: readonly string[];
  busy: boolean;
  onAnswer: (option: string) => void;
}) {
  if (options.length === 0) return null;
  const text = stripMarkdown(question);
  return (
    <div className="mt-1 space-y-1" data-testid="card-compact-question">
      <p className="line-clamp-2 break-words text-compact leading-snug text-app-text" title={text}>{text}</p>
      <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
        {options.map((opt, i) => (
          <button
            key={i} type="button" disabled={busy}
            data-testid="card-compact-reply"
            onClick={() => onAnswer(opt)}
            className="rounded-md bg-white/10 px-2 py-1 text-compact leading-4 text-app-text hover:bg-white/20 disabled:opacity-50 coarse:min-h-11"
          >{opt}</button>
        ))}
      </div>
    </div>
  );
}
