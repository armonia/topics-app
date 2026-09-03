/**
 * The "Piano" tab of a task: it renders the PLAN, not the wire envelope the
 * plan travelled in.
 *
 * A plan comment written by an agent carries a ```question fence: the plan
 * itself, plus the two options that ask for a verdict. The other two surfaces
 * that show the same comment already strip it (the thread and the card, both
 * through `parseQuestionBlock`); this tab was the only one rendering it raw,
 * which markdown turns into a `<pre>` that does not wrap. The plan could only
 * be read by scrolling sideways, and a word cut by the visible window (the
 * first half of a long word) looked like a content bug rather than a layout one.
 *
 * So: same treatment as the other two. The body is markdown, the options are a
 * list, and nothing in here has a horizontal scrollbar.
 *
 * It lives in its OWN file, and that is load bearing: `TaskDetail.tsx` pulls in
 * the API client, the pane layout and a dozen stores behind the `@/` alias, so
 * it cannot be mounted in a unit test (`planSurface.test.ts` renders THIS, and
 * that is the only reason it can assert on the real tree).
 */
import { parseQuestionBlock } from '../../lib/board';
import { useT } from '../../hooks/useT';
import { ChatMarkdown } from '../ChatMarkdown';
import { PLAN_MD_CLS } from './constants';

/**
 * The plan comment, split into what is READ and what is CHOSEN.
 *
 * Anything written outside the fence stays (an agent often introduces the plan
 * before opening the block); the question line inside it is prose too, and it
 * joins the body. The options come back already filtered by the parser, which
 * is where "Landa e pubblica" is dropped: publishing is a human-only board
 * action, and this tab must never be the surface that offers it.
 */
function splitPlan(content: string): { body: string; options: string[] } {
  const q = parseQuestionBlock(content);
  if (!q) return { body: content, options: [] };
  const outside = content.replace(/```question[\s\S]*?```/, '').trim();
  return { body: [outside, q.question].filter(Boolean).join('\n\n'), options: q.options };
}

export function PlanSurface({ content }: { content: string }) {
  const tr = useT();
  const { body, options } = splitPlan(content);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="min-w-0 rounded-lg border border-violet-500/25 bg-violet-500/5 px-4 py-3.5">
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-violet-300">{tr('board.task.proposedPlan')}</p>
        <div className={`min-w-0 break-words text-sm text-app-text ${PLAN_MD_CLS}`} data-testid="plan-surface-body">
          <ChatMarkdown components={{}}>{body}</ChatMarkdown>
        </div>
        {options.length > 0 && (
          <ul className="mt-3 space-y-1 border-t border-violet-500/20 pt-3" data-testid="plan-surface-options">
            {options.map((opt, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-app-text">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-violet-300/70" />
                <span className="min-w-0 break-words">{opt}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
