import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, CircleAlert, Clock, Eye, Forward, Plus, Split, X, Zap } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import { FIELD_ICON, FIELD_TONE } from '../icons';
import { TONE_TEXT } from '../tone';
import { Chip, FieldChip } from '../primitives/Chip';
import { IconButton } from '../primitives/Button';
import { FOCUS_RING } from '../shell/pressable';
import { ActorBadge } from '../sarim/WorkParts';
import type { CanvasLane, CanvasMode, CanvasNode, CanvasStep, CanvasStepState, FlowCanvasModel, StepEditing } from './model';
import { MAIN_CONTAINER } from './model';

/*
 * Geometry of the rail. Every row starts with a 28px column whose middle (14px)
 * is the rail: the markers sit on it, the connectors of a split leave from it.
 * A lane repeats the same column, so the first lane continues the rail of the
 * flow and the others branch off to its right.
 */
const RAIL = 'left-[13.5px]';
/** One lane is this wide on a screen; on a phone a lane fills the strip but for a peek of the next. */
const LANE_WIDTH = 'w-[17.5rem]';
const LANE_WIDTH_PHONE = 'w-[calc(100%-2.75rem)]';
/** The gap between two lanes: the fork and the join bars run across it. */
const LANE_GAP = 'gap-3';
const BAR_ACROSS_GAP = '-right-3';
/** How far the faded edge of the strip reaches. */
const FADE_PX = 32;

type Edges = { start: boolean; end: boolean };

function fadeMask({ start, end }: Edges): string | undefined {
  if (start && end) return `linear-gradient(to right, transparent, #000 ${FADE_PX}px, #000 calc(100% - ${FADE_PX}px), transparent)`;
  if (start) return `linear-gradient(to right, transparent, #000 ${FADE_PX}px)`;
  if (end) return `linear-gradient(to left, transparent, #000 ${FADE_PX}px)`;
  return undefined;
}

/** The circle on the rail: the number of the step, or the glyph of where it stands for the case on show. */
function Marker({ state, children, size = 24 }: { state?: CanvasStepState; children?: ReactNode; size?: number }) {
  const glyph = state === 'done' ? <Check size={13} aria-hidden="true" /> : state === 'error' ? <CircleAlert size={13} aria-hidden="true" /> : state === 'waiting' ? <Clock size={13} aria-hidden="true" /> : children;
  return (
    <span
      style={{ width: size, height: size }}
      className={clsx(
        'relative z-10 inline-flex shrink-0 items-center justify-center rounded-full border text-mini font-medium tabular-nums',
        state === 'done' && 'border-emerald-600 bg-emerald-600 text-white',
        state === 'current' && 'border-primary bg-primary text-white shadow-[0_0_0_3px_rgba(0,102,255,0.18)]',
        state === 'error' && 'border-rose-600 bg-rose-600 text-white shadow-[0_0_0_3px_rgba(225,29,72,0.18)]',
        state === 'waiting' && 'border-amber-500 bg-amber-500 text-white',
        (!state || state === 'next') && 'border-app-border-light bg-surface text-app-text-secondary',
      )}
    >
      {glyph}
    </span>
  );
}

function Fields({ label, fields }: { label: string; fields?: CanvasStep['uses'] }) {
  if (!fields?.length) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-mini text-app-text-tertiary">{label}</span>
      {fields.map((f) => <FieldChip key={`${f.kind}-${f.name}`} field={f} className="max-w-full" />)}
    </div>
  );
}

/**
 * One step, the same card in the column of the flow and inside a lane: who
 * does it (and, read or run, the words of where the case stands), the title on
 * its own line, the rule of thumb, what it reads and writes, then who did it
 * and when, who has it now, the original it came with and the cases at it.
 * The card never cuts a word: in a narrow lane everything wraps.
 */
export function CanvasStepCard({ step, copy, selected, quiet, onPress, menu, onOpenView }: {
  step: CanvasStep;
  copy: UiCopy;
  selected?: boolean;
  /** A step after the one on show, or in a lane the case does not take: drawn quieter, still readable. */
  quiet?: boolean;
  onPress?: () => void;
  menu?: ReactNode;
  /** Makes the «apre» chip a link of its own. (allow-italian: quotes the Italian interface) */
  onOpenView?: () => void;
}) {
  const state = step.state;
  const hasData = Boolean(step.uses?.length || step.produces?.length);
  return (
    <div
      onClick={onPress}
      className={clsx(
        'relative min-w-0 flex-1 rounded-lg border px-3 py-2',
        state === 'current' ? 'border-primary/60 bg-primary/[0.05]' : state === 'error' ? 'border-rose-500/60 bg-rose-500/[0.05]' : state === 'waiting' ? 'border-amber-500/50 bg-amber-500/[0.05]' : 'border-app-border bg-surface',
        selected && 'ring-2 ring-primary/60 ring-offset-1 ring-offset-surface',
        onPress && 'cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-primary/60',
        onPress && !selected && 'hover:border-primary/50',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {step.actors.map((a, i) => <ActorBadge key={i} actor={a} />)}
        {step.flag && <Chip tone={state === 'error' ? 'red' : state === 'waiting' ? 'amber' : 'blue'} strong>{step.flag}</Chip>}
        {step.badges?.map((b) => <Chip key={b.label} tone={b.tone}>{b.label}</Chip>)}
        {step.stage && <span className="text-mini text-app-text-tertiary">{step.stage}</span>}
        {step.due && <span className="text-mini text-app-text-tertiary">{step.due}</span>}
        {menu && <span className="relative z-10 -my-0.5 ml-auto shrink-0">{menu}</span>}
      </div>
      <p className={clsx('mt-1 min-w-0 text-prose font-semibold leading-5 [overflow-wrap:break-word]', quiet ? 'text-app-text-secondary' : 'text-app-text')}>
        {onPress ? (
          // The title is the one button of the card; its ::after stretches over the whole card so a click anywhere presses it without nesting buttons.
          <button type="button" onClick={(e: MouseEvent) => { e.stopPropagation(); onPress(); }} aria-pressed={selected !== undefined ? selected : undefined} className="text-left font-semibold after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none">{step.title}</button>
        ) : step.title}
      </p>
      {step.note && <p className="mt-0.5 text-compact leading-5 text-app-text-tertiary [overflow-wrap:break-word]">{step.note}</p>}
      {step.opens && (
        <span className="relative z-10 mt-1.5 flex">
          {onOpenView ? (
            <button
              type="button"
              onClick={(e: MouseEvent) => { e.stopPropagation(); onOpenView(); }}
              className={clsx('inline-flex min-h-5 max-w-full items-center gap-1 rounded-full bg-black/[0.05] px-2 py-0.5 text-left text-mini leading-4 text-primary hover:underline dark:bg-white/10 dark:text-primary-dark', FOCUS_RING)}
            >
              <Eye size={12} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0">{copy.common.opens(step.opens)}</span>
            </button>
          ) : (
            <span className="inline-flex min-h-5 max-w-full items-center gap-1 rounded-full bg-black/[0.05] px-2 py-0.5 text-mini leading-4 text-app-text-secondary dark:bg-white/10">
              <Eye size={12} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0">{copy.common.opens(step.opens)}</span>
            </span>
          )}
        </span>
      )}
      {hasData && (
        <div className="mt-1.5 flex min-w-0 flex-col gap-1">
          <Fields label={copy.common.uses} fields={step.uses} />
          <Fields label={copy.common.produces} fields={step.produces} />
        </div>
      )}
      {step.done && <p className="mt-1.5 text-compact leading-4 text-app-text-secondary">{step.done}</p>}
      {step.here && <div className="relative z-10 mt-2 flex min-w-0 flex-wrap items-center gap-2">{step.here}</div>}
      {step.originals && step.originals.length > 0 && (
        <div className="relative z-10 mt-2 flex min-w-0 flex-col gap-1">
          <span className="text-mini text-app-text-tertiary">{copy.flows.canvas.detail.originals}</span>
          {step.originals.map((o) => {
            const Icon = o.icon;
            return (
              <button
                key={o.id}
                type="button"
                onClick={(e: MouseEvent) => { e.stopPropagation(); o.onOpen(); }}
                data-flow-original={o.id}
                className={clsx('flex min-w-0 items-center gap-2 rounded-md border border-app-border bg-surface px-2 py-1.5 text-left transition-colors hover:border-primary/50 hover:bg-primary/[0.06]', FOCUS_RING)}
              >
                <Icon size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-compact font-medium text-primary dark:text-primary-dark">{o.name}</span>
                  <span className="block truncate text-mini text-app-text-tertiary">{o.meta}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {step.cards && <div className="relative z-10 mt-2 flex min-w-0 flex-wrap items-center gap-1.5">{step.cards}</div>}
    </div>
  );
}

/** The thin place between two steps where a new one goes: a small plus on the rail, quiet until the pointer or the keyboard is on it. */
function Insert({ editing, container, afterId }: { editing: StepEditing; container: string; afterId: string | null }) {
  return (
    <li className="group relative -my-0.5 flex h-5 items-center gap-2.5" data-flow-insert="">
      <span aria-hidden="true" className={clsx('absolute bottom-0 top-0 w-px bg-app-border-light', RAIL)} />
      <span className="relative z-10 flex w-7 shrink-0 justify-center">
        <button
          type="button"
          aria-label={editing.addLabel}
          data-tip={editing.disabledTitle ?? editing.addLabel}
          disabled={Boolean(editing.disabledTitle)}
          onClick={() => editing.onAdd(container, afterId)}
          className={clsx(
            'inline-flex h-4 w-4 items-center justify-center rounded-full border border-app-border-light bg-surface text-app-text-tertiary transition-all',
            'opacity-30 group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100',
            'hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
            'disabled:cursor-default disabled:opacity-20 disabled:hover:border-app-border-light disabled:hover:text-app-text-tertiary',
          )}
        >
          <Plus size={10} aria-hidden="true" />
        </button>
      </span>
      <span aria-hidden="true" className="text-mini text-app-text-tertiary opacity-0 transition-opacity group-hover:opacity-100 coarse:opacity-100">{editing.addLabel}</span>
    </li>
  );
}

interface RowProps {
  copy: UiCopy;
  mode: CanvasMode;
  selectedId?: string;
  onStep?: (stepId: string, laneId?: string) => void;
  onOpenView?: (stepId: string) => void;
  editing?: StepEditing;
}

/**
 * A step as a row of a column: its marker on the rail, its card beside it.
 * The row draws its own piece of rail, from the top to the bottom of the row
 * (`railTo` stops it at the marker on the last row), so a split in the middle
 * of the column can leave the room its lanes take.
 */
function StepRow({ step, laneId, off, railTo = 'bottom', row }: {
  step: CanvasStep;
  laneId?: string;
  /** In a lane the case does not take. */
  off?: boolean;
  railTo?: 'bottom' | 'marker';
  row: RowProps;
}) {
  const { copy, mode, selectedId, onStep, onOpenView, editing } = row;
  const container = laneId ?? MAIN_CONTAINER;
  const press = mode === 'edit' ? (editing ? () => editing.onOpen(step.id) : onStep ? () => onStep(step.id, laneId) : undefined) : onStep ? () => onStep(step.id, laneId) : undefined;
  const quiet = off || (mode !== 'edit' && step.state === 'next');
  return (
    <li
      data-flow-step={step.id}
      data-flow-step-state={step.state}
      data-flow-step-current={step.state === 'current' || step.state === 'error' || step.state === 'waiting' ? '' : undefined}
      data-flow-step-done={step.state === 'done' ? '' : undefined}
      data-flow-step-off={off ? '' : undefined}
      data-flow-step-selected={selectedId === step.id ? '' : undefined}
      aria-current={step.state === 'current' || step.state === 'error' || step.state === 'waiting' ? 'step' : undefined}
      className="relative flex items-start gap-2.5 pb-2"
    >
      <span aria-hidden="true" className={clsx('absolute top-0 w-px bg-app-border-light', RAIL, railTo === 'marker' ? 'h-4' : 'bottom-0')} />
      <span className="flex w-7 shrink-0 justify-center pt-2"><Marker state={step.state}>{step.marker}</Marker></span>
      <CanvasStepCard
        step={step}
        copy={copy}
        quiet={quiet}
        selected={mode === 'edit' || !onStep ? undefined : selectedId === step.id}
        onPress={press}
        onOpenView={onOpenView && step.opens ? () => onOpenView(step.id) : undefined}
        menu={mode === 'edit' ? editing?.menu(container, step.id) : undefined}
      />
    </li>
  );
}

/** The letter of a lane with the glyph of the input it handles. */
function LaneLetter({ lane }: { lane: CanvasLane }) {
  const Icon = FIELD_ICON[lane.kind];
  return (
    <span className={clsx('inline-flex h-5 shrink-0 items-center gap-1 rounded bg-black/[0.05] px-1.5 text-mini font-semibold dark:bg-white/10', TONE_TEXT[FIELD_TONE[lane.kind]])}>
      <Icon size={12} aria-hidden="true" />
      {lane.letter}
    </span>
  );
}

/**
 * One case of a split, as a column: the head says which case it is (letter,
 * title, what tells it apart, how many a month), then its own steps on the
 * same rail. The bars along its top and bottom join it to the lane on its
 * right, so the lanes read as one fork under the step that splits and one
 * join above the step where they meet again.
 */
function Lane({ lane, first, last, joins, off, phone, row }: {
  lane: CanvasLane;
  first: boolean;
  last: boolean;
  /** The flow goes on under the split: the lanes meet again. */
  joins: boolean;
  off: boolean;
  phone?: boolean;
  row: RowProps;
}) {
  const c = row.copy.flows.canvas;
  const only = first && last;
  const bar = only ? undefined : first ? clsx(RAIL, BAR_ACROSS_GAP) : last ? 'left-0 w-[14px]' : clsx('left-0', BAR_ACROSS_GAP);
  const tail = !joins && lane.steps.length === 0 && !lane.handoff;
  return (
    <section
      data-flow-lane={lane.id}
      data-flow-lane-taken={lane.taken ? '' : undefined}
      data-flow-lane-off={off ? '' : undefined}
      aria-label={`${lane.letter} · ${lane.title}`}
      className={clsx('relative flex shrink-0 flex-col', phone ? clsx(LANE_WIDTH_PHONE, 'snap-start') : LANE_WIDTH, off && 'grayscale')}
    >
      {bar && <span aria-hidden="true" className={clsx('absolute top-0 h-px bg-app-border', bar)} />}
      <ol className="relative flex flex-1 flex-col">
        <li className="relative flex items-start gap-2.5 pb-2 pt-3">
          <span aria-hidden="true" className={clsx('absolute top-0 w-px bg-app-border-light', RAIL, tail ? 'h-5' : 'bottom-0')} />
          <span className="flex w-7 shrink-0 justify-center pt-1.5"><span aria-hidden="true" className={clsx('relative z-10 h-2.5 w-2.5 rounded-full border-2 bg-surface', lane.taken ? 'border-primary' : 'border-app-border')} /></span>
          <div style={{ minHeight: 'var(--lane-head-h, 0px)' }} className={clsx('min-w-0 flex-1 rounded-lg border px-3 py-2', lane.taken ? 'border-primary/60 bg-primary/[0.04]' : 'border-app-border bg-app-inset')}>
            <div data-flow-lane-head-body="">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <LaneLetter lane={lane} />
                {lane.badge && <Chip tone={lane.badge.tone}>{lane.badge.text}</Chip>}
                {lane.taken && <Chip tone="blue" strong>{c.taken}</Chip>}
              </div>
              <p className="mt-1 text-prose font-semibold leading-5 text-app-text [overflow-wrap:break-word]">{lane.title}</p>
              {lane.hint && <p className="text-compact leading-5 text-app-text-secondary [overflow-wrap:break-word]">{lane.hint}</p>}
              {lane.meta && <p className="mt-0.5 text-mini leading-4 text-app-text-tertiary [overflow-wrap:break-word]">{lane.meta}</p>}
            </div>
          </div>
        </li>
        {row.editing && <Insert editing={row.editing} container={lane.id} afterId={null} />}
        {lane.steps.map((s, i) => (
          <StepFragment key={s.id} step={s} laneId={lane.id} off={off} last={!joins && i === lane.steps.length - 1 && !lane.handoff} row={row} />
        ))}
        {lane.handoff && (
          <li className="relative flex items-start gap-2.5 pb-2">
            <span aria-hidden="true" className={clsx('absolute top-0 w-px bg-app-border-light', RAIL, joins ? 'bottom-0' : 'h-4')} />
            <span className="flex w-7 shrink-0 justify-center pt-1"><Marker><Forward size={12} aria-hidden="true" /></Marker></span>
            <span className="min-w-0 flex-1 pt-1 text-compact leading-5 text-app-text-secondary [overflow-wrap:break-word]">{lane.handoff}</span>
          </li>
        )}
        {lane.steps.length === 0 && !lane.handoff && (
          <li className="relative flex items-start gap-2.5 pb-2">
            {joins && <span aria-hidden="true" className={clsx('absolute bottom-0 top-0 w-px bg-app-border-light', RAIL)} />}
            <span className="w-7 shrink-0" />
            <span className="min-w-0 flex-1 text-compact leading-5 text-app-text-tertiary">{c.noSteps}</span>
          </li>
        )}
        {/* The lanes stand as tall as the maxHead: the rail of a shorter one runs on to the join. */}
        {joins && <li aria-hidden="true" className="relative min-h-2 flex-1"><span className={clsx('absolute bottom-0 top-0 w-px bg-app-border-light', RAIL)} /></li>}
      </ol>
      {joins && bar && <span aria-hidden="true" className={clsx('absolute bottom-0 h-px bg-app-border', bar)} />}
    </section>
  );
}

function StepFragment({ step, laneId, off, last, row }: { step: CanvasStep; laneId?: string; off?: boolean; /** The last row of its column, with nothing under it: the rail stops at its marker. */ last?: boolean; row: RowProps }) {
  return (
    <>
      <StepRow step={step} laneId={laneId} off={off} railTo={last && !row.editing ? 'marker' : 'bottom'} row={row} />
      {row.editing && <Insert editing={row.editing} container={laneId ?? MAIN_CONTAINER} afterId={step.id} />}
    </>
  );
}

/**
 * The cases of a split side by side, in a strip that scrolls sideways when
 * they do not fit: the edge that hides a case fades and carries an arrow, the
 * strip follows a drag of the mouse and Shift with the wheel, and the arrow
 * keys move it one case at a time once it has the focus. On a phone each case
 * fills the strip and the strip stops on a case. Read or run, the case on
 * show is brought into view when the strip appears.
 */
function Lanes({ split, joins, phone, row }: { split: Extract<CanvasNode, { kind: 'split' }>; joins: boolean; phone?: boolean; row: RowProps }) {
  const c = row.copy.flows.canvas;
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });
  const [dragging, setDragging] = useState(false);
  const strip = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; left: number; id: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [inView, setInView] = useState<{ first: number; last: number }>({ first: 0, last: 0 });
  const read = useCallback((el: HTMLElement) => {
    const next = { start: el.scrollLeft > 1, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    const lanes = Array.from(el.children) as HTMLElement[];
    // A case is on show when its middle is inside the strip.
    let first = -1;
    let last = -1;
    lanes.forEach((l, i) => {
      const mid = l.offsetLeft + l.offsetWidth / 2;
      if (mid > el.scrollLeft && mid < el.scrollLeft + el.clientWidth) {
        if (first < 0) first = i;
        last = i;
      }
    });
    if (first < 0) { first = 0; last = 0; }
    setInView((prev) => (prev.first === first && prev.last === last ? prev : { first, last }));
    // The heads stand as tall as the maxHead, so the first step starts level in every case.
    const heads = Array.from(el.querySelectorAll<HTMLElement>('[data-flow-lane-head-body]'));
    const maxHead = Math.max(0, ...heads.map((h) => h.offsetHeight));
    if (maxHead) el.style.setProperty('--lane-head-h', `${maxHead + 16}px`);
    // On a phone the strip is as tall as the case on show, not as the maxHead one: the short cases leave no empty column.
    if (phone) {
      const shown = lanes[first];
      if (shown) el.style.height = `${shown.offsetHeight + 4}px`;
    }
  }, [phone]);
  const taken = split.lanes.findIndex((l) => l.taken);
  const attach = useCallback((el: HTMLDivElement | null) => {
    strip.current = el;
    if (!el) return undefined;
    if (taken > 0) {
      const lane = el.children[taken] as HTMLElement | undefined;
      if (lane) el.scrollLeft = Math.max(0, lane.offsetLeft - 8);
    }
    read(el);
    // Shift with the wheel moves the strip sideways where the browser does not already do it; a listener that may cancel the scroll of the page.
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => read(el));
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    // React 19 runs the function a ref callback returns when the element goes away: nothing stays behind.
    return () => {
      el.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [read, taken]);

  const laneStep = () => {
    const el = strip.current;
    const lane = el?.children[0] as HTMLElement | undefined;
    return lane ? lane.offsetWidth + 12 : 292;
  };
  const scrollByLanes = (n: number) => strip.current?.scrollBy({ left: n * laneStep(), behavior: 'smooth' });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const el = e.currentTarget;
    if (e.key === 'ArrowRight') { e.preventDefault(); scrollByLanes(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); scrollByLanes(-1); }
    else if (e.key === 'Home') { e.preventDefault(); el.scrollTo({ left: 0, behavior: 'smooth' }); }
    else if (e.key === 'End') { e.preventDefault(); el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' }); }
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || e.currentTarget.scrollWidth <= e.currentTarget.clientWidth) return;
    drag.current = { x: e.clientX, left: e.currentTarget.scrollLeft, id: e.pointerId, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(dx) < 5) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(d.id);
      setDragging(true);
    }
    e.currentTarget.scrollLeft = d.left - dx;
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    swallowClick.current = true;
    if (e.currentTarget.hasPointerCapture(d.id)) e.currentTarget.releasePointerCapture(d.id);
    setDragging(false);
  };
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.stopPropagation();
    e.preventDefault();
  };
  const overflow = edges.start || edges.end;
  const mask = fadeMask(edges);
  // Read or run, once the case has reached the split: the lanes it does not take are quieter (all of them for a case that is none of these).
  const quietOthers = row.mode !== 'edit' && Boolean(split.reached);
  return (
    <div className="relative min-w-0">
      {split.lanes.length > 1 && (
        <div aria-hidden="true" data-flow-lane-index="" className="mb-1 flex items-center gap-1 pl-9">
          {split.lanes.map((l, i) => (
            <span
              key={l.id}
              data-flow-lane-index-letter={l.letter}
              data-in-view={i >= inView.first && i <= inView.last ? '' : undefined}
              className={clsx('inline-flex h-5 min-w-5 items-center justify-center rounded px-1 text-mini font-semibold', i >= inView.first && i <= inView.last ? 'bg-primary/10 text-primary dark:text-primary-dark' : 'text-app-text-tertiary')}
            >
              {l.letter}
            </span>
          ))}
        </div>
      )}
      <div
        ref={attach}
        data-flow-lanes=""
        role="group"
        aria-label={c.lanes(split.lanes.length)}
        tabIndex={overflow ? 0 : undefined}
        onScroll={(e) => read(e.currentTarget)}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={onClickCapture}
        style={mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined}
        className={clsx(
          'relative flex min-w-0 overflow-x-auto overscroll-x-contain pb-1',
          phone ? 'items-start overflow-y-hidden' : 'items-stretch',
          LANE_GAP,
          phone && 'snap-x snap-mandatory scroll-px-0',
          overflow && !phone && (dragging ? 'cursor-grabbing select-none' : 'cursor-grab'),
          FOCUS_RING,
          'rounded-sm [scrollbar-width:thin]',
        )}
      >
        {split.lanes.map((lane, i) => (
          <Lane
            key={lane.id}
            lane={lane}
            first={i === 0}
            last={i === split.lanes.length - 1}
            joins={joins}
            off={quietOthers && !lane.taken}
            phone={phone}
            row={row}
          />
        ))}
      </div>
      {/* The arrows sit in the row of the split's head, over its right end: in the middle of the strip they covered a card. */}
      {!phone && overflow && (
        <span className="absolute -top-9 right-0 z-20 flex items-center gap-1">
          {edges.start && <IconButton icon={ChevronLeft} label={c.prev} onClick={() => scrollByLanes(-1)} className="border border-app-border bg-surface shadow-sm" />}
          {edges.end && <IconButton icon={ChevronRight} label={c.next} onClick={() => scrollByLanes(1)} className="border border-app-border bg-surface shadow-sm" />}
        </span>
      )}
    </div>
  );
}

/**
 * The one drawing of a flow, the same wherever a flow is shown (its page, the
 * card that reads it, one run of it): what starts it, then its steps in one
 * column from the top down; where the flow splits into cases, the cases stand
 * side by side, each with its own steps, and meet again under them. Nothing
 * folds and nothing hides behind a tab: when the cases do not fit, the strip
 * of cases scrolls sideways and its edges say there is more.
 *
 * `mode` decides what a step does. `edit`: it opens its own page (`editing`),
 * a plus between two steps adds one, each carries its menu. `read` and `run`:
 * the steps carry where the case stands (done, current, stopped, to come), the
 * lane it takes is marked and the others are quieter, and pressing a step
 * calls `onStep` so the container shows its detail beside the flow; the step
 * on show is `selectedId`. `onOpenView` makes the «apre …» chip of a step a (allow-italian: quotes the Italian interface)
 * link. Everything else is the model's.
 */
export function FlowCanvas({ model, mode, copy, phone, selectedId, onStep, onOpenView, editing, className }: {
  model: FlowCanvasModel;
  mode: CanvasMode;
  copy: UiCopy;
  phone?: boolean;
  selectedId?: string;
  onStep?: (stepId: string, laneId?: string) => void;
  onOpenView?: (stepId: string) => void;
  editing?: StepEditing;
  className?: string;
}) {
  const c = copy.flows.canvas;
  const row: RowProps = { copy, mode, selectedId, onStep, onOpenView, editing: mode === 'edit' ? editing : undefined };
  const nodes = model.nodes;
  const lastIndex = nodes.length - 1;
  return (
    <div
      data-testid="flow-canvas"
      data-flow-canvas=""
      data-flow-mode={mode}
      data-flow-readonly={mode === 'read' ? '' : undefined}
      aria-label={c.label}
      role="region"
      className={clsx('min-w-0', className)}
    >
      <ol className="flex min-w-0 flex-col">
        <li className="relative flex items-start gap-2.5 pb-2" data-flow-trigger="">
          {nodes.length > 0 && <span aria-hidden="true" className={clsx('absolute bottom-0 top-4 w-px bg-app-border-light', RAIL)} />}
          <span className="flex w-7 shrink-0 justify-center pt-2"><Marker><Zap size={12} aria-hidden="true" /></Marker></span>
          <div className="min-w-0 flex-1 rounded-lg border border-app-border bg-surface px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5"><Chip icon={Zap} strong>{copy.flows.trigger}</Chip></div>
            <p className="mt-1 text-prose font-semibold leading-5 text-app-text [overflow-wrap:break-word]">{model.trigger.title}</p>
            {model.trigger.note && <p className="mt-0.5 text-compact leading-5 text-app-text-tertiary">{model.trigger.note}</p>}
            {model.trigger.produces && model.trigger.produces.length > 0 && <div className="mt-1.5"><Fields label={copy.common.produces} fields={model.trigger.produces} /></div>}
          </div>
        </li>
        {row.editing && <Insert editing={row.editing} container={MAIN_CONTAINER} afterId={null} />}
        {nodes.map((node, i) => {
          if (node.kind === 'step') {
            return <StepFragment key={node.step.id} step={node.step} last={i === lastIndex} row={row} />;
          }
          const joins = i < lastIndex;
          return (
            <li key={node.id} data-flow-split={node.id} className="relative flex min-w-0 flex-col pb-2">
              <div className="relative flex items-center gap-2.5 pb-0">
                <span aria-hidden="true" className={clsx('absolute bottom-0 top-0 w-px bg-app-border-light', RAIL)} />
                <span className="flex w-7 shrink-0 justify-center py-1"><Marker>{node.marker ?? <Split size={12} aria-hidden="true" />}</Marker></span>
                <p className={clsx('flex min-h-8 min-w-0 flex-1 items-center gap-1.5 text-prose font-semibold leading-5 text-app-text-secondary', !phone && 'pr-20')}>
                  <Split size={14} aria-hidden="true" className="shrink-0 text-app-text-tertiary" />
                  <span className="min-w-0 [overflow-wrap:break-word]">{c.split(node.lanes.length, node.by)}</span>
                </p>
              </div>
              {node.cards && (
                <div className="relative flex items-start gap-2.5 pb-2">
                  <span aria-hidden="true" className={clsx('absolute bottom-0 top-0 w-px bg-app-border-light', RAIL)} />
                  <span className="w-7 shrink-0" />
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{node.cards}</div>
                </div>
              )}
              <Lanes split={node} joins={joins} phone={phone} row={row} />
              {joins && (
                <div className="relative flex items-center gap-2.5">
                  <span aria-hidden="true" className={clsx('absolute bottom-0 top-0 w-px bg-app-border-light', RAIL)} />
                  <span className="w-7 shrink-0" />
                  <span className="py-1.5 text-mini text-app-text-tertiary">{c.rejoin}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The detail of one step beside the flow, in the side panel the screen
 * already has: where the step stands for the case, who does it, the data it
 * takes in and gives out, and the original beside it. `onClose` brings the
 * panel back to what it showed before.
 */
export function StepDetail({ step, copy, onClose, besideCard, children }: { step: CanvasStep; copy: UiCopy; onClose?: () => void; /** The card of the step is on show beside this panel: say only what the card does not (not its chips, data and originals again). */ besideCard?: boolean; /** More rows of the container (the attempts of a run, the cases at the step). */ children?: ReactNode }) {
  const d = copy.flows.canvas.detail;
  return (
    <section data-flow-step-detail={step.id} aria-label={`${d.title} ${step.marker ?? ''} · ${step.title}`} className="flex min-w-0 flex-col">
      <header className="flex items-start gap-2 border-b border-app-border-light px-4 pb-3 pt-3.5">
        <span className="pt-0.5"><Marker state={step.state}>{step.marker}</Marker></span>
        <div className="min-w-0 flex-1">
          {step.state && <span className="text-mini font-medium uppercase tracking-wide text-app-text-tertiary">{d.state[step.state]}</span>}
          <h3 className="text-body-lg font-semibold leading-5 text-app-text [overflow-wrap:break-word]">{step.title}</h3>
          {!besideCard && step.note && <p className="mt-1 text-compact leading-5 text-app-text-secondary">{step.note}</p>}
        </div>
        {onClose && <IconButton icon={X} label={d.close} onClick={onClose} className="-mr-1 shrink-0" />}
      </header>
      <div className="flex flex-col gap-3 px-4 py-3">
        {!besideCard && <>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-mini text-app-text-tertiary">{d.who}</span>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {step.actors.map((a, i) => <ActorBadge key={i} actor={a} />)}
            {step.stage && <span className="text-mini text-app-text-tertiary">{step.stage}</span>}
          </div>
          {step.done && <p className="text-compact leading-5 text-app-text-secondary">{step.done}</p>}
          {step.here && <div className="flex min-w-0 flex-wrap items-center gap-2">{step.here}</div>}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-mini text-app-text-tertiary">{d.uses}</span>
          {step.uses?.length ? <div className="flex flex-wrap gap-1.5">{step.uses.map((f) => <FieldChip key={`${f.kind}-${f.name}`} field={f} />)}</div> : <span className="text-compact text-app-text-tertiary">{d.none}</span>}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-mini text-app-text-tertiary">{d.produces}</span>
          {step.produces?.length ? <div className="flex flex-wrap gap-1.5">{step.produces.map((f) => <FieldChip key={`${f.kind}-${f.name}`} field={f} />)}</div> : <span className="text-compact text-app-text-tertiary">{d.none}</span>}
        </div>
        {step.originals && step.originals.length > 0 && (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-mini text-app-text-tertiary">{d.originals}</span>
            {step.originals.map((o) => {
              const Icon = o.icon;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={o.onOpen}
                  data-flow-detail-original={o.id}
                  className={clsx('flex min-w-0 items-center gap-2 rounded-md border border-app-border bg-surface px-2 py-1.5 text-left transition-colors hover:border-primary/50 hover:bg-primary/[0.06]', FOCUS_RING)}
                >
                  <Icon size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-compact font-medium text-primary dark:text-primary-dark">{o.name}</span>
                    <span className="block truncate text-mini text-app-text-tertiary">{o.meta}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        </>}
        {children}
      </div>
    </section>
  );
}
