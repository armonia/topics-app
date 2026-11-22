/**
 * ONE ROW PER INHERITED CONCEPT (AGENTS-04, feedback: no repetition).
 *
 * Configure > Identity lists what the agent gets from the system (soul,
 * user rules, tools, memory) as a single row each, not the
 * whole inherited text repeated: "See" expands it in place, the second
 * action (Override, Exclude or Filter) jumps to where it is actually
 * edited — this row never edits it itself.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useT } from '../../hooks/useT';

export function InheritedRow({
  title, badge, detail, actionLabel, onAction,
}: {
  title: string;
  /** What the value is today: the UI status label (inherited from the system base, own, or any short status). */
  badge: string;
  /** Rendered under the row when «Vedi» is open — the inherited content itself. */
  detail?: React.ReactNode;
  actionLabel: string;
  onAction: () => void;
}) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  return (
    <li data-testid="agent-inherited-row" className="rounded px-1 py-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button" data-testid="agent-inherited-view" onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-prose text-app-text hover:text-app-text"
        >
          {open ? <ChevronDown size={12} className="flex-shrink-0 text-app-text-muted" aria-hidden="true" /> : <ChevronRight size={12} className="flex-shrink-0 text-app-text-muted" aria-hidden="true" />}
          <span className="truncate">{title}</span>
          <span data-testid="agent-inherited-badge" className="truncate text-mini text-app-text-muted">{badge}</span>
        </button>
        <button type="button" data-testid="agent-inherited-action" onClick={onAction} className="rounded px-2 py-1 text-mini text-app-text-secondary hover:bg-app-hover">{actionLabel}</button>
      </div>
      {open && (
        <div data-testid="agent-inherited-detail" className="ml-5 mt-1 rounded border border-app-border-light bg-surface p-2 text-mini text-app-text-secondary">
          {detail ?? tr('agentConfig.inherited.soulEmpty')}
        </div>
      )}
    </li>
  );
}
