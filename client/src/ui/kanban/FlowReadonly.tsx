import { ArrowRight, Workflow, X, type LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { IconButton } from '../primitives/Button';
import { focusOnMount } from '../primitives/overlay';
import { FlowCanvas, StepDetail } from '../flows/FlowCanvas';
import type { CanvasStep, FlowCanvasModel } from '../flows/model';
import { FOCUS_RING } from '../shell/pressable';

export interface FlowPanelProps {
  name: string;
  icon: LucideIcon;
  /** The flow as the one drawing reads it, dressed with where the card stands. */
  model: FlowCanvasModel;
  onOpenFull: () => void;
  /** The step on show in the detail at the bottom of the panel, when one is pressed. */
  selected?: CanvasStep;
  /** A step was pressed: the container opens its detail, or clears it when it was already the one on show. */
  onStep: (stepId: string) => void;
  onCloseStep: () => void;
  copy: UiCopy;
  onClose: () => void;
  phone?: boolean;
}

/**
 * The frame that holds the flow beside an open card: a column on the right
 * that the detail makes room for (it never covers it), with a header of its
 * own that carries the name of the flow and the close button, and the focus on
 * it when it opens. The flow is the one drawing (`FlowCanvas`, read): the
 * steps in a column, the cases side by side, the lane the card takes marked.
 * Pressing a step shows its detail in a section at the bottom of the same
 * panel, with its own scroll. The key that closes the panel (Escape) is heard
 * by the screen that owns the address, since this layer holds no listener. On
 * a phone it takes the whole width, over the card.
 */
export function FlowPanel({ name, icon: Icon, model, onOpenFull, selected, onStep, onCloseStep, copy, onClose, phone }: FlowPanelProps) {
  const p = copy.kanban.detail.flowPanel;
  return (
    <aside
      ref={focusOnMount}
      tabIndex={-1}
      aria-label={p.label(name)}
      data-flow-panel=""
      className={clsx(
        'z-20 flex flex-col border-l border-app-border bg-surface focus:outline-none',
        phone ? 'absolute inset-x-0 bottom-0 top-11' : 'relative w-[480px] max-w-[50%] shrink-0',
      )}
    >
      <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-app-border-light px-4">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-body-lg font-semibold leading-6 text-app-text">
          <Icon size={16} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:break-word]">{name}</span>
        </h2>
        <IconButton icon={X} label={p.close} onClick={onClose} className="shrink-0" />
      </header>
      {/* On a phone the bar at the bottom of the screen would cover a detail drawn last: it goes first, under the header. */}
      {selected && phone && (
        <div className="max-h-[45%] shrink-0 overflow-y-auto border-b border-app-border bg-surface">
          <StepDetail step={selected} copy={copy} onClose={onCloseStep} />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4 pt-3.5">
        <FlowCanvas model={model} mode="read" copy={copy} phone={phone} selectedId={selected?.id} onStep={(id) => onStep(id)} />
        <button
          type="button"
          onClick={onOpenFull}
          data-flow-open-full=""
          className={clsx('mt-4 inline-flex h-7 shrink-0 items-center gap-1.5 self-start rounded-lg bg-black/[0.05] px-2.5 text-prose font-medium text-app-text transition-colors hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]', FOCUS_RING)}
        >
          <Workflow size={14} className="shrink-0" aria-hidden="true" />
          {p.openFull}
          <ArrowRight size={14} className="shrink-0" aria-hidden="true" />
        </button>
      </div>
      {selected && !phone && (
        <div className="max-h-[50%] shrink-0 overflow-y-auto border-t border-app-border bg-surface">
          <StepDetail step={selected} copy={copy} onClose={onCloseStep} besideCard />
        </div>
      )}
    </aside>
  );
}
