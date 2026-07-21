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
import { ListChecks, ChevronRight } from 'lucide-react';
import type { TodoSnapshot } from './selectLatestTodo';

export function TodoStrip({ snapshot }: { snapshot: TodoSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const { items, done, total, active } = snapshot;
  const allDone = done === total;

  return (
    <div data-testid="todo-strip" className="mx-2 mb-1 rounded-lg border border-app-border/60 bg-app-hover/40 text-app-text">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
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
          {active ? (active.activeForm ?? active.content) : allDone ? 'Tutto completato' : 'In coda'}
        </span>
      </button>

      {expanded && (
        <ul className="space-y-0.5 border-t border-app-border/50 px-2.5 py-1.5">
          {items.map((t, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              <span className="mt-0.5 flex-shrink-0">
                {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}
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
