import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { Tone } from '../types';
import type { UiCopy } from '../copy/types';
import { Chip } from '../primitives/Chip';
import { PaneHeader } from '../shell/PaneHeader';
import { Tabs } from '../primitives/Tabs';
import { Slider as RangeSlider } from '../primitives/Slider';
import { SegmentedControl } from '../../components/Shared/Segmented';
import { FOCUS_RING } from '../shell/pressable';
import { FlowCanvas } from '../flows/FlowCanvas';
import type { CanvasActor, CanvasStepState, FlowCanvasModel } from '../flows/model';
import type { FlowViewId, RailItem, StepKind } from './model';
import { KIND_ICON, KIND_TONE } from './kinds';

/** The chip that says who does a step, in the colour of its kind. */
export function KindChip({ kind, program, copy }: { kind: StepKind | 'trigger'; program?: string; copy: UiCopy }) {
  const label = (kind === 'robot' || kind === 'program') && program ? program : copy.flowRun.kinds[kind];
  return <Chip tone={KIND_TONE[kind]} icon={KIND_ICON[kind]} strong>{label}</Chip>;
}

const RAIL_STATE: Record<NonNullable<RailItem['state']>, CanvasStepState | undefined> = { done: 'done', error: 'error', waiting: 'waiting', todo: undefined };

function railActor(it: RailItem, copy: UiCopy): CanvasActor {
  const label = copy.flowRun.kinds[it.kind];
  switch (it.kind) {
    case 'rule': return { kind: 'rule', label };
    case 'robot':
    case 'program': return { kind: 'program', name: it.program ?? label };
    case 'person': return { kind: 'person', name: label };
    case 'ai':
    case 'classify': return { kind: 'agent', name: label };
    default: return { kind: 'action', name: label };
  }
}

/**
 * The steps of a flow in order: the left column of every page of a step, the
 * comparison of two versions and one run. It is the one drawing of a flow
 * (`FlowCanvas`) in read mode; a step with `onSelect` is pressable and the
 * selected one is marked.
 */
export function StepRail({ items, label, copy, className }: { items: RailItem[]; label: string; copy: UiCopy; className?: string }) {
  const trigger = items.find((it) => it.kind === 'trigger');
  const steps = items.filter((it) => it.kind !== 'trigger');
  const byId = new Map(steps.map((it) => [it.id, it]));
  const model: FlowCanvasModel = {
    trigger: { title: trigger?.title ?? label, note: trigger?.note },
    nodes: steps.map((it) => ({
      kind: 'step' as const,
      step: {
        id: it.id, marker: it.marker, actors: [railActor(it, copy)], title: it.title, note: it.note, badges: it.badges,
        state: it.state ? RAIL_STATE[it.state] : undefined,
      },
    })),
  };
  const selected = steps.find((it) => it.selected);
  const pressable = steps.some((it) => it.onSelect);
  return (
    <FlowCanvas
      model={model}
      mode="read"
      copy={copy}
      className={className}
      selectedId={selected?.id ?? (pressable ? '' : undefined)}
      onStep={pressable ? (id) => byId.get(id)?.onSelect?.() : undefined}
    />
  );
}

/**
 * The header of every page of a flow at work: where you are, the views of the
 * flow as a switcher, and the actions of the page. On a phone the switcher
 * moves to a scrolling strip under the bar.
 */
export function FlowHeader({ copy, flowName, here, detail, status, views, view, onView, phone, onBack, children }: {
  copy: UiCopy;
  flowName: string;
  here: string;
  detail?: string;
  status?: ReactNode;
  views: FlowViewId[];
  view: FlowViewId | null;
  onView: (v: FlowViewId) => void;
  phone?: boolean;
  /** Opens the flow itself; the name of the flow in the crumbs is the way back. */
  onBack?: () => void;
  children?: ReactNode;
}) {
  const options = views.map((v) => ({ value: v, label: copy.flows.views[v] }));
  const switcher = view
    ? (phone
      ? <Tabs value={view} options={options} onChange={onView} ariaLabel={copy.flows.viewsLabel} className="px-4" />
      : <SegmentedControl value={view} onChange={onView} ariaLabel={copy.flows.viewsLabel} options={options} />)
    : null;
  return (
    <>
      <PaneHeader
        crumbs={onBack ? [{ label: here, detail }] : [{ label: copy.flows.root }, { label: flowName }, { label: here, detail }]}
        status={status}
        leading={onBack ? (
          <button
            type="button"
            onClick={onBack}
            className={clsx('-ml-1.5 inline-flex h-7 items-center rounded-lg px-1.5 text-prose text-app-text-secondary transition-colors hover:bg-black/[0.05] hover:text-app-text dark:hover:bg-white/[0.08]', FOCUS_RING)}
          >
            {flowName}
          </button>
        ) : undefined}
      >
        {children}
      </PaneHeader>
      {switcher && (phone ? switcher : <div className="flex shrink-0 items-center border-b border-app-border px-4 py-1.5">{switcher}</div>)}
    </>
  );
}

/** A pane body: the rail on the left, the page in the middle, an optional column on the right; stacked on a phone. */
export function StepLayout({ rail, children, aside, asideWidth = 360, fill }: { rail?: ReactNode; children: ReactNode; aside?: ReactNode; asideWidth?: number; fill?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
      {rail && (
        <div className="shrink-0 border-b border-app-border bg-black/[0.02] dark:bg-white/[0.02] p-4 md:w-[300px] md:overflow-y-auto md:border-b-0 md:border-r">{rail}</div>
      )}
      <div className={clsx('min-w-0 flex-1', fill ? 'flex min-h-0 flex-col md:overflow-hidden' : 'md:overflow-y-auto')}>{children}</div>
      {aside && (
        <div style={{ ['--aside' as string]: `${asideWidth}px` }} className="shrink-0 border-t border-app-border md:w-[var(--aside)] md:overflow-y-auto md:border-l md:border-t-0">{aside}</div>
      )}
    </div>
  );
}

/** A range with the number beside it: the threshold of a step. */
export function Slider({ value, min, max, onChange, label, disabled, title }: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-3" data-tip={title}>
      <RangeSlider value={value} min={min} max={max} onChange={onChange} label={label} valueText={`${value}%`} disabled={disabled} />
      <span className="w-12 shrink-0 text-right text-body-lg font-semibold tabular-nums text-app-text">{value}%</span>
    </div>
  );
}

/** A setting as a row: the name on the left, its control on the right. */
export function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 py-1 text-prose leading-5">
      <div className="min-w-0 flex-1 basis-32">
        <div className="text-app-text">{label}</div>
        {hint && <div className="text-mini leading-4 text-app-text-tertiary">{hint}</div>}
      </div>
      <div className="min-w-0 max-w-full shrink-0 basis-[170px] text-right">{children}</div>
    </div>
  );
}

/** A name with a count or a figure, in the list of an inspector column. */
export function FactRow({ label, value, tone, onOpen }: { label: ReactNode; value: ReactNode; tone?: Tone; onOpen?: () => void }) {
  const text = tone === 'green' ? 'text-emerald-700 dark:text-emerald-400' : tone === 'amber' ? 'text-amber-700 dark:text-amber-400' : tone === 'red' ? 'text-rose-600 dark:text-rose-400' : 'text-app-text';
  const body = (
    <>
      <span className="min-w-[40%] flex-1 text-app-text">{label}</span>
      <span className={clsx('ml-auto max-w-full text-right font-medium tabular-nums', text)}>{value}</span>
    </>
  );
  const row = 'flex min-h-7 w-full flex-wrap items-baseline gap-x-3 gap-y-0 py-0.5 text-left text-prose leading-5';
  if (!onOpen) return <div className={row}>{body}</div>;
  return <button type="button" onClick={onOpen} className={clsx(row, 'rounded transition-colors hover:bg-app-hover', FOCUS_RING)}>{body}</button>;
}
