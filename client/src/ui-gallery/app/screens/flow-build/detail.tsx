/** w01 and w03: a flow as steps, and the same flow by who does what. */
import { useState } from 'react';
import { ArrowDown, ArrowUp, Trash2, Workflow } from 'lucide-react';
import { Button } from '../../../../ui/primitives/Button';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Select, TextField } from '../../../../ui/primitives/Field';
import type { MenuItemModel } from '../../../../ui/primitives/Menu';
import { FlowsScreen } from '../../../../ui/flows/FlowsScreen';
import { RowMenu } from '../../../../ui/flows/RowMenu';
import { OfficeMatrix } from '../../../../ui/flows/OfficeMatrix';
import { MAIN_CONTAINER, type StepEditing } from '../../../../ui/flows/model';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import type { FlowStepKind, Office } from '../../../../ui/fixtures/org/types';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { useFlowsSlice } from './actions';
import {
  caseOfFlow, detailsOf, editedContainers, findFlow, flowModelOf, nextStepId, officeMatrixOf, type FlowOp,
} from './model';

export type FlowTab = 'steps' | 'byOffice' | 'runs' | 'tests' | 'versions' | 'decides';

const KINDS: FlowStepKind[] = ['classify', 'ai', 'rule', 'robot', 'person', 'program', 'view', 'send'];
const PROGRAMS = ['Halley', 'Prunes', 'TeamSystem', 'Publisys', 'Traspare'];
const OFFICES = Object.keys(OFFICE_LABEL) as Office[];

/** The page of one flow: its steps (w01) or the by-office view (w03). */
export function FlowPage({ ctx, flowId, view }: { ctx: ScreenCtx; flowId: string; view: 'steps' | 'byOffice' }) {
  const t = ctx.copy.flowBuild;
  const [slice, setSlice] = useFlowsSlice(ctx);
  const flow = findFlow(slice, flowId);
  const [adding, setAdding] = useState<{ container: string; after: string | null } | null>(null);

  if (!flow) {
    return (
      <EmptyState icon={Workflow} title={t.flow.notFound} action={<Button variant="primary" onClick={() => ctx.go(P.flows())}>{t.flow.backToList}</Button>}>
        {t.flow.notFoundBody}
      </EmptyState>
    );
  }

  const ops = slice.edits[flow.id] ?? [];
  const canEdit = ctx.can('edit:structure');
  const model = flowModelOf(flow, ops, ctx.copy);
  const containers = editedContainers(flow, ops);
  const details = detailsOf(flow);
  const record = caseOfFlow(flow.id)?.id ?? '2418';

  const push = (op: FlowOp, log: string) => {
    setSlice((s) => ({ ...s, edits: { ...s.edits, [flow.id]: [...(s.edits[flow.id] ?? []), op] } }));
    ctx.log(log, 'structure', P.flow(flow.id));
  };
  const labelOf = (id: string) => Object.values(containers).flat().find((s) => s.id === id)?.label ?? id;

  const stepMenu = (container: string, id: string) => {
    const list = containers[container] ?? [];
    const at = list.findIndex((s) => s.id === id);
    const title = canEdit ? undefined : ctx.deniedTitle('edit:structure');
    const items: MenuItemModel[] = [
      { id: 'up', label: t.flow.moveUp, icon: ArrowUp, disabled: !canEdit || at <= 0, title: title ?? (at <= 0 ? t.flow.alreadyFirst : undefined) },
      { id: 'down', label: t.flow.moveDown, icon: ArrowDown, disabled: !canEdit || at >= list.length - 1, title: title ?? (at >= list.length - 1 ? t.flow.alreadyLast : undefined) },
      { id: 'sep', label: '', separator: true },
      { id: 'remove', label: t.flow.remove, icon: Trash2, danger: true, disabled: !canEdit, title },
    ];
    return (
      <RowMenu
        label={t.flow.stepMenu(labelOf(id))}
        items={items}
        onSelect={(item) => {
          if (item === 'up') push({ op: 'move', id, dir: -1 }, t.log.moved(labelOf(id), flow.name));
          else if (item === 'down') push({ op: 'move', id, dir: 1 }, t.log.moved(labelOf(id), flow.name));
          else if (item === 'remove') {
            const name = labelOf(id);
            ctx.confirm({
              title: t.flow.removeTitle(name),
              body: t.flow.removeBody,
              confirmLabel: t.flow.remove,
              tone: 'danger',
              onConfirm: () => {
                push({ op: 'remove', id }, t.log.removed(name, flow.name));
                ctx.toast({ tone: 'warn', title: t.toast.stepRemoved(name) });
              },
            });
          }
        }}
      />
    );
  };

  const editing: StepEditing = {
    addLabel: t.flow.addStep,
    disabledTitle: canEdit ? undefined : ctx.deniedTitle('edit:structure'),
    onOpen: (id) => ctx.go(P.flowStep(flow.id, id)),
    onAdd: (container, after) => setAdding({ container, after }),
    menu: stepMenu,
  };

  const openView = (stepId: string) => {
    const to = details[stepId]?.opensTo;
    if (to === 'parcel') ctx.go(P.parcel(record));
    else if (to === 'presentation') ctx.go(P.presentation(record));
    else ctx.go(P.inbox(record));
  };

  const tabs: Array<{ id: FlowTab; label: string }> = [
    { id: 'steps', label: ctx.copy.flows.views.steps },
    { id: 'byOffice', label: ctx.copy.flows.views.byOffice },
    { id: 'runs', label: ctx.copy.flows.views.runs },
    { id: 'tests', label: ctx.copy.flows.views.tests },
    { id: 'versions', label: ctx.copy.flows.views.versions },
    { id: 'decides', label: t.tabs.decides },
  ];
  const go: Record<FlowTab, string> = {
    steps: P.flow(flow.id), byOffice: P.flowOffices(flow.id), runs: P.flowRuns(flow.id),
    tests: P.flowTest(flow.id), versions: P.flowVersions(flow.id), decides: P.flowDecides(flow.id),
  };

  const matrix = view === 'byOffice' ? officeMatrixOf(flow, ops, ctx.copy) : undefined;

  return (
    <>
      <FlowsScreen<FlowTab>
        flow={model}
        copy={ctx.copy}
        view={view}
        tabs={tabs}
        onViewChange={(v) => ctx.go(go[v])}
        onTry={ctx.allow('run:tests', () => ctx.go(P.flowTest(flow.id)))}
        tryTitle={ctx.deniedTitle('run:tests')}
        onBack={() => ctx.go(P.flows())}
        onOpenView={openView}
        editing={view === 'steps' ? editing : undefined}
        phone={ctx.phone}
      >
        {matrix && (
          <OfficeMatrix
            model={matrix}
            copy={ctx.copy}
            onOpenStep={(id) => (id === 'trigger' ? ctx.go(P.flow(flow.id)) : ctx.go(P.flowStep(flow.id, id)))}
            onOpenView={openView}
            phone={ctx.phone}
          />
        )}
      </FlowsScreen>
      {adding && (
        <AddStepDialog
          ctx={ctx}
          defaultOffice={flow.office}
          afterLabel={adding.after ? labelOf(adding.after) : undefined}
          onClose={() => setAdding(null)}
          onAdd={(input) => {
            const id = nextStepId(ops);
            push({ op: 'add', id, container: adding.container || MAIN_CONTAINER, after: adding.after, ...input }, t.log.added(input.label, flow.name));
            ctx.toast({ tone: 'ok', title: t.toast.stepAdded(input.label), action: { label: t.toast.openStep, path: P.flowStep(flow.id, id) } });
            setAdding(null);
          }}
        />
      )}
    </>
  );
}

/** The form that adds a step: what it does, in words, who does it, and for which office. */
function AddStepDialog({ ctx, defaultOffice, afterLabel, onClose, onAdd }: {
  ctx: ScreenCtx;
  defaultOffice: Office;
  afterLabel?: string;
  onClose: () => void;
  onAdd: (input: { label: string; kind: FlowStepKind; office: Office; program?: string }) => void;
}) {
  const t = ctx.copy.flowBuild.flow;
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<FlowStepKind>('person');
  const [office, setOffice] = useState<Office>(defaultOffice);
  const [program, setProgram] = useState(PROGRAMS[0]);
  const [error, setError] = useState('');
  const submit = () => {
    if (!label.trim()) {
      setError(t.labelRequired);
      return;
    }
    onAdd({ label: label.trim(), kind, office, program: kind === 'robot' || kind === 'program' ? program : undefined });
  };
  return (
    <Dialog
      title={t.addTitle}
      closeLabel={ctx.copy.common.close}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{t.cancel}</Button>
          <Button variant="primary" onClick={submit}>{t.addConfirm}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4 p-4">
        <p className="text-compact text-app-text-tertiary">{afterLabel ? t.addAfter(afterLabel) : t.addFirst}</p>
        <TextField label={t.labelLabel} value={label} onChange={(v) => { setLabel(v); setError(''); }} placeholder={t.labelPlaceholder} error={error || undefined} onEnter={submit} autoFocus />
        <Select label={t.kindLabel} value={kind} onChange={(v) => setKind(v as FlowStepKind)} options={KINDS.map((k) => ({ value: k, label: ctx.copy.flowBuild.kinds[k] }))} />
        {(kind === 'robot' || kind === 'program') && (
          <Select label={t.programLabel} value={program} onChange={setProgram} options={PROGRAMS.map((p) => ({ value: p, label: p }))} />
        )}
        <Select label={t.officeLabel} value={office} onChange={(v) => setOffice(v as Office)} options={OFFICES.map((o) => ({ value: o, label: OFFICE_LABEL[o] }))} />
      </div>
    </Dialog>
  );
}
