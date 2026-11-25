import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ROW_CHEVRON, ROW_CHEVRON_SLOT } from '@/lib/selectionStyles';
import { STATUS_INK } from '../../lib/statusVisual';

/** What the chevron of a row that launched sub-agents says and does. */
export interface SubagentsToggleState {
  open: boolean;
  /** The count and how many work: the words the header row used to show. */
  label: string;
  /** Agents at work at any depth under the row (SUBAGENT-30). */
  agents: number;
  /** A child waits on the person: the chevron takes the wait ink (over the
   *  working one, the same order as everywhere else). */
  needsYou: boolean;
  onToggle: () => void;
}

/**
 * The row that launched sub-agents IS their accordion (asked on 25/11: the tab
 * itself, not a row under it): its chevron opens and closes them, in the slot
 * where a project row keeps its own, and there is no header row under it any
 * more. It takes the working ink while one of them works, as the header's dot
 * did. Chat and terminal rows draw the same one.
 */
export function SubagentsToggle({ state }: { state: SubagentsToggleState }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); state.onToggle(); }}
      aria-expanded={state.open}
      aria-label={state.label}
      title={state.label}
      data-testid="subagents-accordion"
      data-agents={state.agents || undefined}
      data-needs-you={state.needsYou || undefined}
      className={cn(ROW_CHEVRON_SLOT, 'tap-expand-y h-full transition-colors', state.needsYou ? STATUS_INK.wait : state.agents > 0 && STATUS_INK.working)}
    >
      <ChevronRight size={ROW_CHEVRON} className={cn('transition-transform duration-fast', state.open && 'rotate-90')} />
    </button>
  );
}
