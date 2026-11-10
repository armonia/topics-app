import { useRef, useState, type DragEvent, type HTMLAttributes } from 'react';
import { ArrowRight, GripVertical, MoveRight, UserCheck, Workflow } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { MenuButton } from '../primitives/Menu';
import { useMeasuredRef } from '../primitives/scrollEdges';
import { PAGE_GUTTER } from '../shell/layout';
import { FOCUS_RING, pressable } from '../shell/pressable';
import { TONE_CHIP } from '../tone';
import type { KanbanCardModel, KanbanColumnModel, TagModel } from './model';
import { FlowLabel, StageIcon, StoppedTag, Tag, WorkerBadge } from './parts';

/** A quarter of the board minus its gutters and the three gaps, never under 264 px (the least a card reads in) nor over 26rem. */
const COLUMN_WIDTH = 'clamp(16.5rem, calc((100cqw - 2rem - 2.25rem) / 4), 26rem)';

/** What makes a column a place to drop a card on. */
type DropProps = Pick<HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;

/**
 * One card of the kanban, the look of the Board's card: the id and the flow
 * on the first line with the «Sposta in…» menu, the title, where it is, the (allow-italian: quotes the Italian interface)
 * step of the flow, the date, priority and states in one wrapping row (as the
 * Board's chips under the title), and at the foot who has it in hand
 * and who must check it. Nothing on the card is cut: a long title, flow, step,
 * task or name runs on to the next line. A blocked card wears a red edge, a stopped one an
 * amber edge. The whole card opens it; on a pointer it can be dragged.
 */
export function KanbanCard({ card, copy, canDrag, dragging, onOpen, onMove, onDragStart, onDragEnd }: {
  card: KanbanCardModel;
  copy: UiCopy;
  /** Whether this pointer can drag cards (never on a phone); a card the person may not move stays put either way. */
  canDrag: boolean;
  dragging?: boolean;
  onOpen: () => void;
  onMove: (to: string) => void;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
}) {
  const k = copy.kanban;
  const moveDisabledTitle = card.moveDisabledTitle;
  const stopped: TagModel | undefined = card.blocked ? { text: card.blocked.text, tone: 'red', title: card.blocked.title } : card.stuck;
  const edge = card.blocked ? 'bg-rose-500' : card.stuck ? 'bg-amber-500' : undefined;
  return (
    <div
      {...pressable(onOpen)}
      role="button"
      aria-label={k.card.openNamed(card.id, card.title)}
      data-card={card.id}
      data-kanban-card={card.id}
      draggable={canDrag && !moveDisabledTitle}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={clsx(
        'group relative cursor-pointer rounded-lg border bg-surface px-3 py-2.5 text-left transition-[background-color,border-color,opacity]',
        card.blocked ? 'border-rose-500/40' : card.stuck ? 'border-amber-500/45' : 'border-app-border',
        'hover:border-app-border-light hover:bg-black/[0.02] dark:hover:bg-white/[0.04]',
        FOCUS_RING,
        dragging && 'opacity-40',
      )}
    >
      {edge && <span aria-hidden="true" className={clsx('absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full', edge)} />}
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 font-mono text-mini font-medium tabular-nums text-app-text-secondary">{card.id}</span>
        <FlowLabel flow={card.flow} wrap className="flex-1" />
        <span className="-mr-1 shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <MenuButton
            label={k.board.moveTo}
            icon={MoveRight}
            iconOnly
            variant="ghost"
            size="sm"
            align="right"
            disabled={Boolean(moveDisabledTitle)}
            title={moveDisabledTitle ?? k.board.moveTo}
            items={card.moveTo.map((o) => ({ id: o.id, label: o.label, disabled: o.disabled, title: o.title }))}
            onSelect={onMove}
            className="opacity-60 transition-opacity group-hover:opacity-100 coarse:opacity-100"
          />
        </span>
      </div>
      <div className="mt-1 text-body-lg font-semibold leading-[21px] text-app-text [overflow-wrap:break-word]">{card.title}</div>
      <p className="mt-0.5 text-compact leading-[18px] text-app-text-secondary [overflow-wrap:break-word]">{card.detail}</p>
      {card.step && (
        <p className="mt-1.5 flex items-start gap-1.5 text-mini leading-4 text-app-text-tertiary" data-tip={`${k.card.step}: ${card.step}`}>
          <Workflow size={12} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:break-word]">{card.step}</span>
        </p>
      )}
      {(card.due || card.priority || card.blocked || card.stuck) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {card.due && <Tag tag={card.due} />}
          {card.priority && <Tag tag={card.priority} />}
          {/* One token for «Ferma da…»: red when the card is blocked on something outside it (the reason is written under), amber when it only waited too long. (allow-italian: quotes the Italian interface) */}
          {stopped && <StoppedTag tag={stopped} />}
        </div>
      )}
      {card.blocked && <p className="mt-1 text-mini leading-4 text-rose-700 [overflow-wrap:break-word] dark:text-rose-300">{card.blocked.reason}</p>}
      <div className="mt-2 border-t border-app-border-light pt-2">
        <WorkerBadge worker={card.worker} sinceBelow wrap atWorkLabel={k.card.agentAtWork} />
        {card.reviewer && (
          <p className="mt-1 flex min-w-0 items-start gap-1.5 text-mini leading-4 text-app-text-tertiary">
            <UserCheck size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 [overflow-wrap:break-word]">{card.reviewer}</span>
          </p>
        )}
      </div>
    </div>
  );
}

function FoldedColumn({ column, copy, phone, over, dropProps, onUnfold }: {
  column: KanbanColumnModel;
  copy: UiCopy;
  phone?: boolean;
  over: boolean;
  dropProps: DropProps;
  onUnfold: () => void;
}) {
  return (
    <section
      aria-label={column.label}
      data-stage={column.id}
      {...dropProps}
      className={clsx('flex shrink-0 flex-col rounded-xl border bg-app-inset', phone ? 'w-12' : 'w-11', over ? 'border-primary bg-primary/[0.04]' : 'border-app-border')}
    >
      <button
        type="button"
        onClick={onUnfold}
        aria-label={copy.kanban.board.open(column.label, column.cards.length)}
        data-tip={copy.kanban.board.open(column.label, column.cards.length)}
        className={clsx('flex h-full w-full flex-col items-center gap-2 rounded-xl py-3 text-app-text-secondary transition-colors hover:bg-app-hover hover:text-app-text', FOCUS_RING)}
      >
        <StageIcon glyph={column.glyph} />
        <span className="text-compact tabular-nums text-app-text-tertiary">{column.cards.length}</span>
        <span className="rotate-180 whitespace-nowrap text-compact font-semibold uppercase tracking-wide [writing-mode:vertical-rl]">{column.label}</span>
      </button>
    </section>
  );
}

/**
 * The kanban of «Da fare» (allow-italian: quotes the Italian interface): one column per stage, with
 * its glyph, its count and the line that says what being there means. A card
 * moves by dragging it to another column (pointer, not on a phone) or from its
 * menu (everywhere); the caller decides what a move is allowed to do. In the
 * view of one stage the other columns fold to a narrow strip that opens them.
 * The columns are as wide as the Board's (a floor of 19.5rem that they never
 * shrink under, growing to 26rem when there is room): when they do not all fit
 * the row scrolls sideways, its edges fading where more columns continue, and
 * each column keeps its head in place while only its cards scroll. On a phone
 * the columns are a sideways strip that snaps, each most of the width, and the
 * page itself never scrolls sideways.
 */
export function KanbanBoard({ columns, copy, phone, onOpen, onMove, onUnfold }: {
  columns: KanbanColumnModel[];
  copy: UiCopy;
  phone?: boolean;
  onOpen: (cardId: string) => void;
  onMove: (cardId: string, to: string) => void;
  onUnfold: (stageId: string) => void;
}) {
  const k = copy.kanban;
  const [draggingId, setDraggingId] = useState<string>();
  const [overId, setOverId] = useState<string>();
  const drag = !phone;
  /* The first column the scroll hides (cut or out of sight): the pill at the right edge names it and brings it in. */
  const [hidden, setHidden] = useState<{ id: string; label: string; n: number }>();
  const [overflows, setOverflows] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const measure = (el: HTMLDivElement) => {
    scroller.current = el;
    const right = el.getBoundingClientRect().right;
    const next = Array.from(el.querySelectorAll<HTMLElement>('[data-kanban-column]')).find((c) => c.getBoundingClientRect().right > right + 2);
    const found = next ? columns.find((c) => c.id === next.dataset.kanbanColumn) : undefined;
    const value = found ? { id: found.id, label: found.label, n: found.cards.length } : undefined;
    setOverflows(el.scrollWidth > el.clientWidth + 2);
    setHidden((prev) => (prev?.id === value?.id && prev?.n === value?.n && prev?.label === value?.label ? prev : value));
  };
  const attach = useMeasuredRef<HTMLDivElement>(measure);
  const bring = (id: string) => {
    const el = Array.from(scroller.current?.querySelectorAll<HTMLElement>('[data-kanban-column]') ?? []).find((c) => c.dataset.kanbanColumn === id);
    el?.scrollIntoView({ inline: 'end', block: 'nearest' });
  };
  /* In the view of one stage its column takes the room of the others: its cards sit side by side. */
  const focused = columns.some((c) => c.folded);

  const dropProps = (columnId: string): DropProps => (drag ? {
    onDragOver: (e: DragEvent<HTMLElement>) => { e.preventDefault(); setOverId(columnId); },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverId((prev) => (prev === columnId ? undefined : prev));
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      setOverId(undefined);
      setDraggingId(undefined);
      const id = e.dataTransfer.getData('text/plain');
      if (id) onMove(id, columnId);
    },
  } : {});

  return (
    /* The wrapper is the size container: a column is a quarter of its width, so four stand whole and the rest comes by scrolling. */
    <div className="relative flex min-h-0 flex-1 flex-col [container-type:inline-size]">
    {/* The way to the next column has a strip of its own above the columns, so it never sits over a card; the strip keeps its height once the row scrolls, so nothing jumps when the button goes. */}
    {!phone && overflows && (
      <div className={clsx('flex h-8 shrink-0 items-end justify-end pt-1', PAGE_GUTTER)}>
        {hidden && (
          <button
            type="button"
            onClick={() => bring(hidden.id)}
            data-kanban-more=""
            className={clsx('inline-flex h-7 items-center gap-1.5 rounded-md border border-app-border bg-surface px-2.5 text-compact font-medium text-app-text transition-colors hover:bg-app-hover', FOCUS_RING)}
          >
            <span className="whitespace-nowrap">{k.board.more(hidden.label, hidden.n)}</span>
            <ArrowRight size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    )}
    <div
      role="group"
      aria-label={k.board.label}
      ref={attach}
      onScroll={(e) => measure(e.currentTarget)}
      data-kanban-columns=""
      className={clsx('flex min-h-0 flex-1 gap-3 overflow-x-auto py-3', PAGE_GUTTER, phone ? 'snap-x snap-mandatory scroll-px-4' : 'snap-x snap-proximity scroll-px-4')}
    >
      {columns.map((col) => {
        if (col.folded) {
          return <FoldedColumn key={col.id} column={col} copy={copy} phone={phone} over={overId === col.id} dropProps={dropProps(col.id)} onUnfold={() => onUnfold(col.id)} />;
        }
        return (
          <section
            key={col.id}
            aria-label={col.label}
            data-stage={col.id}
            data-kanban-column={col.id}
            {...dropProps(col.id)}
            style={phone || focused ? undefined : { width: COLUMN_WIDTH }}
            className={clsx(
              'flex min-h-0 flex-col rounded-xl border bg-app-inset',
              /* One stage on show: its column takes the room of the others; otherwise a fixed readable width that grows to a ceiling. */
              phone ? 'w-[85%] shrink-0 snap-center' : focused ? 'shrink-0 grow basis-[19.5rem] snap-start' : 'shrink-0 snap-start',
              overId === col.id ? 'border-primary bg-primary/[0.04]' : col.piles ? 'border-amber-500/45' : 'border-app-border',
            )}
          >
            <header className="shrink-0 px-3 pb-2 pt-2.5">
              <div className="flex h-6 items-center gap-2" data-tip={`${col.label}: ${col.hint}`}>
                <StageIcon glyph={col.glyph} />
                <h2 className="min-w-0 truncate text-compact font-semibold uppercase tracking-wide text-app-text">{col.label}</h2>
                <span className="ml-auto shrink-0 text-compact tabular-nums text-app-text-tertiary" data-tip={k.board.cards(col.cards.length)}>{col.cards.length}</span>
              </div>
              {/* The numbers of the column, not a sentence that repeats its name; the «si accumula» note stands on a line of its own above them, so the numbers never wrap. Two lines kept on every column so the cards start level. (allow-italian: quotes the Italian interface) */}
              <div className="mt-0.5 min-h-8 text-mini leading-4 text-app-text-tertiary">
                {col.piles && <span className={clsx('flex h-4 w-fit items-center rounded px-1 font-medium', TONE_CHIP.amber)}>{k.board.piles}</span>}
                <p>{col.facts}</p>
              </div>
            </header>
            <div className={clsx('min-h-0 flex-1 gap-2 overflow-y-auto px-2 pb-2', focused && !phone ? 'grid content-start grid-cols-[repeat(auto-fill,minmax(19rem,1fr))]' : 'flex flex-col')}>
              {col.cards.map((card) => (
                <KanbanCard
                  key={card.id}
                  card={card}
                  copy={copy}
                  canDrag={drag}
                  dragging={draggingId === card.id}
                  onOpen={() => onOpen(card.id)}
                  onMove={(to) => onMove(card.id, to)}
                  onDragStart={(e) => { e.dataTransfer.setData('text/plain', card.id); e.dataTransfer.effectAllowed = 'move'; setDraggingId(card.id); }}
                  onDragEnd={() => { setDraggingId(undefined); setOverId(undefined); }}
                />
              ))}
              {col.cards.length === 0 && (
                <div className="flex flex-1 items-start justify-center px-3 py-6 text-center text-compact text-app-text-tertiary">
                  <span className="flex items-center gap-1.5"><GripVertical size={13} aria-hidden="true" />{drag ? k.board.drop : k.board.empty}</span>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
    </div>
  );
}
