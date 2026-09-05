/**
 * Sticky current-todo strip (CHAT-TODO-01).
 *
 * A compact, collapsible mirror of the latest `TodoWrite`, rendered above the
 * composer so the current plan stays visible while typing. Collapsed by
 * default to a progress line ("3/7 · <active item>"); expands in place to the
 * full checklist. Purely presentational — the inline transcript card is
 * unaffected.
 */

import { useState } from 'react';
import { ListChecks, ChevronRight, CircleCheck, CircleDot, Circle } from 'lucide-react';
import type { TodoSnapshot } from './selectLatestTodo';
import { CHAT_STRIP_NEUTRAL, CHAT_STRIP_ROW } from '../../lib/chatStripStyles';

export function TodoStrip({ snapshot }: { snapshot: TodoSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const { items, done, total, active } = snapshot;
  const allDone = done === total;

  return (
    <div data-testid="todo-strip" className={CHAT_STRIP_NEUTRAL}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className={CHAT_STRIP_ROW}
        aria-expanded={expanded}
      >
        <ChevronRight
          size={13}
          className={`flex-shrink-0 text-app-text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <ListChecks size={13} className={`flex-shrink-0 ${allDone ? 'text-green-500' : 'text-app-text-secondary'}`} />
        <span className="flex-shrink-0 text-[11px] font-medium tabular-nums text-app-text-secondary">
          {done}/{total}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-app-text-secondary">
          {active ? (active.activeForm ?? active.content) : allDone ? 'Tutto completato' : 'Da fare'}
        </span>
      </button>

      {expanded && (
        <ul className="space-y-0.5 border-t border-app-border/50 px-2.5 py-1.5">
          {items.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              <span className="mt-0.5 flex-shrink-0">
                {t.status === 'completed' ? (
                  <CircleCheck size={13} className="text-green-500" aria-hidden="true" />
                ) : t.status === 'in_progress' ? (
                  <CircleDot size={13} className="text-app-text" aria-hidden="true" />
                ) : (
                  <Circle size={13} className="text-app-text-muted" aria-hidden="true" />
                )}
              </span>
              <span
                className={
                  t.status === 'completed'
                    ? 'text-app-text-muted line-through'
                    : t.status === 'in_progress'
                      ? 'font-medium text-app-text'
                      : 'text-app-text-secondary'
                }
              >
                {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
