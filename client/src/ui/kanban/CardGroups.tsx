import { ChevronDown, ChevronRight, CirclePause, UserCheck } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { FOCUS_RING, pressable } from '../shell/pressable';
import { TONE_TEXT } from '../tone';
import type { CardGroupModel, CardRowModel, TagModel } from './model';
import { StageIcon, WorkerBadge } from './parts';

/** The same columns in every group, so the groups line up one under the other. */
const COLUMNS = 'grid-cols-[minmax(0,1fr)_9rem_12rem_6.5rem_8rem]';

/** A date or a wait as plain text in its tone: a stopped card also wears the pause glyph, so colour is not the only sign. */
function Toned({ tag, glyph }: { tag: TagModel; glyph?: boolean }) {
  const loud = tag.tone === 'amber' || tag.tone === 'red';
  return (
    <span data-tip={tag.title} className={clsx('inline-flex min-w-0 items-center gap-1 text-compact tabular-nums', TONE_TEXT[tag.tone], loud && 'font-medium')}>
      {glyph && loud && <CirclePause size={12} className="shrink-0" aria-hidden="true" />}
      <span className="truncate">{tag.text}</span>
    </span>
  );
}

function StageChip({ stage }: { stage: CardRowModel['stage'] }) {
  return (
    <span className="inline-flex h-5 max-w-full items-center gap-1 rounded bg-black/[0.05] px-1.5 text-mini font-medium text-app-text dark:bg-white/10">
      <StageIcon glyph={stage.glyph} size={12} />
      <span className="truncate">{stage.label}</span>
    </span>
  );
}

function Row({ row, copy, phone, onOpen }: { row: CardRowModel; copy: UiCopy; phone?: boolean; onOpen: (id: string) => void }) {
  const l = copy.kanban.list;
  const title = (
    <span className="min-w-0">
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-mono text-mini font-medium text-app-text-secondary">{row.id}</span>
        <span className="line-clamp-2 min-w-0 font-medium leading-5 text-app-text [overflow-wrap:break-word]">{row.title}</span>
      </span>
      {row.place && <span className="mt-0.5 block truncate text-compact text-app-text-tertiary">{row.place}</span>}
    </span>
  );
  const due = row.due ? <Toned tag={row.due} /> : <span className="text-compact text-app-text-tertiary">{l.none}</span>;
  const inStage = row.inStage ? <Toned tag={row.inStage} glyph /> : <span className="text-compact text-app-text-tertiary">{l.none}</span>;
  return (
    <div
      {...pressable(() => onOpen(row.id))}
      role="button"
      data-card-row={row.id}
      aria-label={copy.kanban.card.openNamed(row.id, row.title)}
      className={clsx(
        'w-full cursor-pointer border-t border-app-border px-3 py-2 text-left text-prose transition-colors hover:bg-app-hover',
        phone ? 'flex flex-col gap-1.5' : clsx('grid items-center gap-x-3', COLUMNS),
        FOCUS_RING, 'focus-visible:ring-inset',
      )}
    >
      {title}
      {phone ? (
        <>
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <StageChip stage={row.stage} />
            <span className="inline-flex items-center gap-1 text-compact text-app-text-secondary">{l.columns.due}: {due}</span>
            {row.inStage && <span className="inline-flex items-center gap-1 text-compact text-app-text-secondary">{l.columns.stuckSince}: {inStage}</span>}
          </span>
          <WorkerBadge worker={row.worker} compact hideSince atWorkLabel={copy.kanban.card.agentAtWork} />
        </>
      ) : (
        <>
          <span className="flex min-w-0"><StageChip stage={row.stage} /></span>
          <WorkerBadge worker={row.worker} hideSince atWorkLabel={copy.kanban.card.agentAtWork} />
          <span className="min-w-0">{due}</span>
          <span className="min-w-0">{inStage}</span>
        </>
      )}
    </div>
  );
}

/**
 * The cards of the to-do page, one group per flow (the caller orders the groups by
 * urgency). A group header is a button that folds it (`aria-expanded`,
 * `data-flow`) and says the flow, how many cards, how many are stopped (amber)
 * and how many wait for the person. Under it every card is a row with the same
 * columns in every group: the card (id, title, comune), its stage, who works on
 * it, its due day and how long it has been in its stage. A row opens its card.
 * On a phone the rows take several lines and the groups stack, so the page
 * never scrolls sideways.
 */
export function CardGroups({ groups, onToggle, onOpen, copy, phone }: {
  groups: CardGroupModel[];
  onToggle: (flowId: string) => void;
  onOpen: (cardId: string) => void;
  copy: UiCopy;
  phone?: boolean;
}) {
  const l = copy.kanban.list;
  return (
    <div className="flex min-w-0 flex-col gap-3" aria-label={l.label} role="region">
      {!phone && (
        <div aria-hidden="true" className={clsx('grid gap-x-3 px-[calc(0.75rem+1px)] text-compact font-medium text-app-text-tertiary', COLUMNS)}>
          <span>{l.columns.card}</span>
          <span>{l.columns.stage}</span>
          <span>{l.columns.worker}</span>
          <span>{l.columns.due}</span>
          <span>{l.columns.stuckSince}</span>
        </div>
      )}
      {groups.map((g) => {
        const Chevron = g.open ? ChevronDown : ChevronRight;
        const Icon = g.icon;
        const listId = `flow-group-${g.id}`;
        return (
          <section key={g.id} data-flow-group={g.id} className="min-w-0 overflow-hidden rounded-lg border border-app-border bg-surface">
            <h2 className="m-0">
              <button
                type="button"
                aria-expanded={g.open}
                aria-controls={g.open ? listId : undefined}
                data-flow={g.id}
                onClick={() => onToggle(g.id)}
                className={clsx('flex min-h-9 w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 bg-app-inset px-3 py-1.5 text-left transition-colors hover:bg-app-hover coarse:min-h-11', FOCUS_RING, 'focus-visible:ring-inset')}
              >
                {/* The tip sits on the arrow alone, above it: on the whole header it would open under the pointer, over the first row of the group. */}
                <span data-tip={l.toggle(g.label, g.open)} data-tip-side="above" className="inline-flex shrink-0">
                  <Chevron size={14} className="text-app-text-tertiary" aria-hidden="true" />
                </span>
                <Icon size={14} className="shrink-0 text-app-text-secondary" aria-hidden="true" />
                <span className="min-w-0 truncate text-prose font-semibold text-app-text">{g.label}</span>
                <span className="text-compact tabular-nums text-app-text-secondary">{l.cards(g.total)}</span>
                {g.stuck > 0 && (
                  <span className="inline-flex items-center gap-1 text-compact font-medium tabular-nums text-amber-700 dark:text-amber-400">
                    <CirclePause size={12} aria-hidden="true" />{l.stuck(g.stuck)}
                  </span>
                )}
                {g.waiting > 0 && (
                  <span className="inline-flex items-center gap-1 text-compact font-medium tabular-nums text-primary dark:text-primary-dark">
                    <UserCheck size={12} aria-hidden="true" />{l.waiting(g.waiting)}
                  </span>
                )}
              </button>
            </h2>
            {g.open && (
              <div id={listId} role="list">
                {g.rows.map((r) => (
                  <div key={r.id} role="listitem">
                    <Row row={r} copy={copy} phone={phone} onOpen={onOpen} />
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
