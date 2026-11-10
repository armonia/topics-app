import { CheckCircle2, Database, Lock, Play } from 'lucide-react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Chip, FieldChip } from '../primitives/Chip';
import { Tabs } from '../primitives/Tabs';
import { KeyValue, PanelHeading, PanelSection, SidePanel } from '../primitives/Panel';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import type { CollectedDataModel, FlowModel, FlowView, StepEditing } from './model';
import { FlowCanvas } from './FlowCanvas';
import { canvasOf, editingOnModel, originalStepId } from './canvasOf';

const VIEWS: FlowView[] = ['steps', 'byOffice', 'runs', 'tests', 'versions', 'log'];

/** What the open path collects, section by section, and who may read it. */
export function CollectedDataPanel({ data, phone }: { data: CollectedDataModel; phone?: boolean }) {
  const body = (
    <>
      <PanelHeading tag={data.tag} tagIcon={Database} title={data.title}>{data.description}</PanelHeading>
      {data.sections.map((s, i) => (
        <PanelSection key={`${s.label}-${i}`} label={s.label}>
          {s.rows.map((r, j) => (
            <KeyValue key={`${s.label}-${i}-${r.label}-${j}`} lead={r.field && <FieldChip field={r.field} />} label={r.label} hint={r.hint} value={r.value} />
          ))}
        </PanelSection>
      ))}
      <div className="flex items-center gap-2 px-4 py-3.5 text-prose">
        <Lock size={14} className="shrink-0 text-app-text-tertiary" aria-hidden="true" />
        <span className="text-app-text-secondary">{data.access.label}</span>
        <span className="ml-auto text-right font-semibold text-app-text">{data.access.value}</span>
      </div>
    </>
  );
  // On a phone the panel is not a column: it is the last block of the page.
  if (phone) return <aside className="border-t border-app-border bg-surface">{body}</aside>;
  return <SidePanel width={360}>{body}</SidePanel>;
}

/** One tab of the flow's header: an id, its words, the place it leads. */
export interface FlowTabModel<V extends string = FlowView> {
  id: V;
  label: string;
}

/**
 * A flow page: the header with the switcher between the views of the flow, and
 * the flow itself drawn by the one canvas (`FlowCanvas`, mode `edit`): what
 * starts it, the steps every input takes, then where it splits into cases the
 * cases side by side, each with all its steps, in a strip that scrolls sideways
 * when they do not fit. The side panel lists what the flow collects. `view` and
 * `onViewChange` drive the switcher; the other views are other screens, which a
 * container draws as `children` in place of the body.
 *
 * With `editing` every step opens its own page, carries a menu, and a plus
 * between two steps adds one; the ids it is called with are the ones of the
 * flow model. `onOpenView` makes the chip of the view a step opens a link. On
 * a phone the header controls move to a row of their own, the cases become
 * columns that snap one per screen, and the side panel falls below the steps.
 */
export function FlowsScreen<V extends string = FlowView>({
  flow, copy, view, onViewChange, tabs, onTry, tryTitle, onBack, backLabel, onOpenView,
  editing, phone, extraActions, children,
}: {
  flow: FlowModel;
  copy: UiCopy;
  view?: V;
  onViewChange?: (view: V) => void;
  /** The tabs of the header; the product's six by default. */
  tabs?: Array<FlowTabModel<V>>;
  onTry?: Action;
  tryTitle?: string;
  onBack?: () => void;
  backLabel?: string;
  onOpenView?: (stepId: string) => void;
  editing?: StepEditing;
  phone?: boolean;
  /** More controls beside the try button. */
  extraActions?: ReactNode;
  children?: ReactNode;
}) {
  const f = copy.flows;
  const options = (tabs ?? (VIEWS.map((v) => ({ id: v, label: f.views[v] })) as unknown as Array<FlowTabModel<V>>));
  const current = (view ?? ('steps' as V));
  const switcher = phone ? (
    <Tabs value={current} onChange={(v) => onViewChange?.(v)} ariaLabel={f.viewsLabel} options={options.map((o) => ({ value: o.id, label: o.label }))} className="px-4" />
  ) : (
    <SegmentedControl
      value={current}
      onChange={(v) => onViewChange?.(v)}
      ariaLabel={f.viewsLabel}
      options={options.map((o) => ({ value: o.id, label: o.label }))}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        crumbs={flow.crumbs}
        leading={onBack ? <BackButton label={backLabel ?? f.root} onClick={onBack} copy={copy} /> : undefined}
        status={phone ? undefined : <Chip tone={flow.status.tone} icon={CheckCircle2}>{flow.status.text}</Chip>}
      >
        {!phone && switcher}
        {extraActions}
        <Button icon={Play} onClick={onTry} title={tryTitle}>{f.tryIt}</Button>
      </PaneHeader>
      {phone && (
        <div className="shrink-0 border-b border-app-border">
          <div className="flex items-center gap-2 px-4 pt-2"><Chip tone={flow.status.tone} icon={CheckCircle2}>{flow.status.text}</Chip></div>
          {switcher}
        </div>
      )}

      {children ?? (
        <div className={clsx('min-h-0 flex-1', phone ? 'overflow-y-auto' : 'flex')}>
          <div className={clsx('min-w-0 flex-1 py-4 pl-3 pr-4', !phone && 'overflow-y-auto')}>
            <FlowCanvas
              model={canvasOf(flow, copy)}
              mode="edit"
              copy={copy}
              phone={phone}
              editing={editing ? editingOnModel(editing, flow) : undefined}
              onOpenView={onOpenView ? (id) => onOpenView(originalStepId(flow, id)) : undefined}
            />
          </div>
          <CollectedDataPanel data={flow.collected} phone={phone} />
        </div>
      )}
    </div>
  );
}
