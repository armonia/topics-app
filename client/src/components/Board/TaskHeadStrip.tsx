import { ChevronDown, ChevronRight, FileText, Server, ShieldCheck, ShieldX, Sparkles } from 'lucide-react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { Spinner } from '../Shared/Spinner';
import { STATUS_CHIP } from '@/lib/statusVisual';
import { type BoardTask } from '../../lib/board';
import { machineLabel } from '../../state/machinesStore';
import type { Machine } from '../../types';
import { canDecideReview } from '../../../../shared/board';
import { ReviewDecisionRow } from './TaskDeliveryBand';
import { TaskChoiceRow } from './TaskChoiceRow';

type Tr = (key: string, vars?: Record<string, string | number>) => string;

/** One summary chip of the head strip: same register as the metadata chips. */
const CHIP = 'flex min-w-0 shrink-0 items-center gap-1 rounded bg-black/5 dark:bg-white/10 px-1.5 py-0.5 text-mini text-app-text-secondary';

/** The «more» opener: a chevron and one word, the same register as the old tabs. */
function MoreToggle({ open, onClick, testId, label }: { open: boolean; onClick: () => void; testId: string; label: string; }) {
  return (
    <button type="button" data-testid={testId} aria-expanded={open} onClick={onClick}
      className="ml-auto flex shrink-0 items-center gap-1 rounded px-2 py-1 text-compact leading-4 text-app-text-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-app-text coarse:min-h-11">
      {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      {label}
    </button>
  );
}

/** Checks state as one chip: the full verdict (runs, tail) opens in the delivery panel. */
function ChecksChip({ task, tr }: { task: BoardTask; tr: Tr }) {
  const state = task.checksState;
  if (!state) return null;
  if (state === 'running') {
    return <span data-testid="task-head-checks" className={`${CHIP} ${STATUS_CHIP.working}`}><Spinner size="sm" tone="current" className="shrink-0" />{tr('board.task.checks.running')}</span>;
  }
  if (state === 'pass') {
    return <span data-testid="task-head-checks" className={`${CHIP} ${STATUS_CHIP.ok}`}><ShieldCheck className="h-3 w-3 shrink-0" />{tr('board.task.checks.pass')}</span>;
  }
  const unknown = state === 'unknown';
  return (
    <span data-testid="task-head-checks" className={`${CHIP} ${unknown ? STATUS_CHIP.wait : STATUS_CHIP.danger}`}>
      <ShieldX className="h-3 w-3 shrink-0" />{unknown ? tr('board.task.checks.unknown') : tr('board.task.checks.fail')}
    </span>
  );
}

/**
 * The head of the card, under the title: DETAILS as chips (node, model) and,
 * when the card has a delivery, the compact DELIVERY band with the decisions.
 * Both stay above the conversation; their full sections open in place below
 * (`expandedDetails` / `expandedDelivery`) in a capped region, so the thread
 * never leaves the screen.
 */
export function TaskHeadStrip({ busy, commentRef, decide, deliveryOpen, detailsOpen, doLand, expandedDelivery, expandedDetails, hasDelivery, load, machines, modelLine, onChanged, outcome, scrollRequestedRef, sendBack, sending, setDeliveryOpen, setDetailsOpen, setError, stickRef, task, tr }: {
  busy: boolean;
  commentRef: RefObject<HTMLTextAreaElement | null>;
  decide: (decision: 'approve' | 'reject', opts?: { force?: boolean; }) => Promise<void>;
  deliveryOpen: boolean;
  detailsOpen: boolean;
  doLand: () => Promise<void>;
  expandedDelivery: ReactNode;
  expandedDetails: ReactNode;
  hasDelivery: boolean;
  load: () => Promise<void>;
  machines: Machine[] | null;
  modelLine: string;
  onChanged: () => void;
  outcome: string | null;
  scrollRequestedRef: RefObject<boolean>;
  sendBack: () => Promise<void>;
  sending: boolean;
  setDeliveryOpen: Dispatch<SetStateAction<boolean>>;
  setDetailsOpen: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  stickRef: RefObject<boolean>;
  task: BoardTask;
  tr: Tr;
}) {
  const toggle = (which: 'details' | 'delivery') => {
    scrollRequestedRef.current = false;
    // The workspace is left alone: side by side it shares the screen with this head, and single-column this head is hidden while it is open.
    stickRef.current = false;
    // One region open at a time: two capped panels together would leave the thread no room.
    if (which === 'details') { setDeliveryOpen(false); setDetailsOpen((o) => !o); } else { setDetailsOpen(false); setDeliveryOpen((o) => !o); }
  };
  const files = task.deliveryFilesChanged;
  const decisions = canDecideReview(task);
  const deliveryToggle = <MoreToggle open={deliveryOpen} onClick={() => toggle('delivery')} testId="task-delivery-toggle" label={tr('board.task.deliveryBand')} />;
  return (
    <div className="shrink-0 border-b border-app-border" data-testid="task-head-strip">
      <div className="flex items-center gap-1.5 px-3 py-1.5" data-testid="task-head-details">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-topbar">
          <span data-testid="task-head-node" className={CHIP}>
            <Server className="h-3 w-3 shrink-0 text-app-text-muted" />
            <span className="truncate">{task.machineId ? machineLabel(machines, task.machineId) : tr('board.task.node.chipLocal')}</span>
          </span>
          <span data-testid="task-head-model" className={CHIP}>
            <Sparkles className="h-3 w-3 shrink-0 text-app-text-muted" />
            <span className="truncate">{modelLine}</span>
          </span>
        </div>
        {!hasDelivery && deliveryToggle}
        <MoreToggle open={detailsOpen} onClick={() => toggle('details')} testId="task-details-toggle" label={tr('board.task.moreLabel')} />
      </div>
      {expandedDetails}
      {hasDelivery && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-app-border-subtle px-3 py-1.5" data-testid="task-head-delivery">
          {outcome && <p data-testid="task-head-outcome" className="min-w-0 flex-1 basis-40 truncate text-compact leading-4 text-app-text-heading" title={outcome}>{outcome}</p>}
          <ChecksChip task={task} tr={tr} />
          {files != null && files > 0 && (
            <span data-testid="task-head-files" className={CHIP}><FileText className="h-3 w-3 shrink-0 text-app-text-muted" />{tr('board.task.filesCount', { n: files })}</span>
          )}
          {deliveryToggle}
          {decisions && (
            <div className="flex w-full flex-wrap items-center gap-1.5" data-testid="task-review-actions">
              <ReviewDecisionRow
                task={task} busy={busy || sending}
                onAccept={() => decide('approve', { force: task.checksState === 'fail' })}
                onSendBack={() => void sendBack()}
                onLand={doLand}
              />
              <TaskChoiceRow
                task={task} disabled={busy || sending} exclude={['land', 'send-back', 'accept', 'redo', 'stop']}
                onDone={() => { void load(); onChanged(); }}
                onError={setError} onNeedText={() => commentRef.current?.focus()}
              />
            </div>
          )}
        </div>
      )}
      {expandedDelivery}
    </div>
  );
}
