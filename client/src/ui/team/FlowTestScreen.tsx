import { CircleCheck, ClipboardCheck, FlaskConical, Play, Plus, ShieldCheck } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { SegmentedControl } from '../../components/Shared/Segmented';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { KeyValue, PanelHeading, PanelSection, SidePanel } from '../primitives/Panel';
import { Stepper } from '../primitives/Stepper';
import { PaneHeader } from '../shell/PaneHeader';
import type { FlowTestActions, FlowTestModel } from './model';
import { CasesTable, CriteriaTable, DiffTable, HistoryList } from './TestTables';
import { JobCard } from './parts';

type ViewOption = 'steps' | 'runs' | 'tests' | 'versions';
const VIEWS: ViewOption[] = ['steps', 'runs', 'tests', 'versions'];

/**
 * The test of one flow (c01): where the version stands, the criteria it has to
 * pass, the fixed cases it was played on, the ones where it and the people
 * disagree, the tests it had; on the right how the test works and the gate to
 * activation. On a phone the panel stacks below.
 */
export function FlowTestScreen({ model, actions, copy, phone }: {
  model: FlowTestModel;
  actions: FlowTestActions;
  copy: UiCopy;
  phone?: boolean;
}) {
  const t = copy.team.test;
  const f = copy.flows;
  const stages = [t.stages.draft, t.stages.cases, t.stages.test, t.stages.approval, t.stages.live];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={phone ? model.crumbs.slice(-1) : model.crumbs} status={phone ? undefined : <Chip tone={model.status.tone} icon={ClipboardCheck}>{model.status.text}</Chip>}>
        {!phone && (
          <SegmentedControl<ViewOption>
            value="tests"
            onChange={actions.onViewChange}
            ariaLabel={t.viewsLabel}
            options={VIEWS.map((v) => ({ value: v, label: f.views[v] }))}
          />
        )}
        <Button variant="primary" icon={Play} onClick={actions.onRun}>{model.history.length > 0 ? t.runAgain : t.run}</Button>
      </PaneHeader>
      <div className={phone ? 'min-h-0 flex-1 overflow-y-auto' : 'flex min-h-0 flex-1'}>
        <div className={phone ? 'flex flex-col gap-5 px-3 py-4' : 'flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4'}>
          {phone && (
            <div><Chip tone={model.status.tone} icon={ClipboardCheck}>{model.status.text}</Chip></div>
          )}
          {phone && (
            <SegmentedControl<ViewOption>
              value="tests"
              onChange={actions.onViewChange}
              ariaLabel={t.viewsLabel}
              options={VIEWS.map((v) => ({ value: v, label: f.views[v] }))}
            />
          )}
          <Stepper
            orientation="horizontal"
            ariaLabel={t.stagesLabel}
            copy={copy}
            steps={stages.map((label, i) => ({ id: String(i), label, state: i < model.stage ? 'done' : i === model.stage ? 'current' : 'todo' }))}
          />
          {model.job && <JobCard job={model.job} />}
          <CriteriaTable criteria={model.criteria} copy={copy} />
          <CasesTable cases={model.cases} copy={copy} onFilter={actions.onFilter} onBackToLast={actions.onBackToLast} />
          <DiffTable diffs={model.diffs} copy={copy} onSelect={actions.onDiffItem} />
          <HistoryList rows={model.history} copy={copy} />
        </div>
        <TestAside model={model} actions={actions} copy={copy} phone={phone} />
      </div>
    </div>
  );
}

/** How the test works, the fixed cases, the unstable one, and the gate to activation. */
function TestAside({ model, actions, copy, phone }: { model: FlowTestModel; actions: FlowTestActions; copy: UiCopy; phone?: boolean }) {
  const a = copy.team.test.aside;
  const g = copy.team.test.gate;
  const gate = model.gate;
  const gateLabel = gate.stage >= 4 ? undefined : gate.stage === 3 ? g.approve : g.request;
  const body = (
    <>
      <PanelHeading tag={a.tag} tagIcon={FlaskConical} title={a.title}>{a.body}</PanelHeading>
      <PanelSection label={g.title}>
        {gate.stage >= 4 ? (
          <p className="flex items-start gap-2 text-prose text-app-text-secondary">
            <CircleCheck size={14} className="mt-1 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            {g.liveLine(gate.liveVersion ?? 0)}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <KeyValue label={g.days(gate.day, gate.of)} value={gate.day >= gate.of ? g.daysDone : `${gate.day}/${gate.of}`} />
            <p className="text-prose leading-5 text-app-text-secondary">{gate.ready ? g.ready : gate.missing}</p>
            {gate.requestedBy && <p className="text-prose leading-5 text-app-text-secondary">{g.requested(gate.requestedBy)}</p>}
            {gateLabel && <Button variant="primary" icon={gate.stage === 3 ? ShieldCheck : ClipboardCheck} onClick={actions.onGate}>{gateLabel}</Button>}
          </div>
        )}
      </PanelSection>
      <PanelSection label={a.fixedTitle}>
        <KeyValue label={a.fixedAll} value={model.aside.fixed.all} />
        <KeyValue label={a.fixedFromCorrections} value={model.aside.fixed.corrections} />
        <KeyValue label={a.fixedWritten} value={model.aside.fixed.written} />
        <p className="mt-1.5 text-prose leading-5 text-app-text-secondary">{a.fixedNote}</p>
      </PanelSection>
      <PanelSection label={a.unstableTitle}>
        {model.aside.unstable ? (
          <>
            <p className="text-prose leading-5 text-app-text-secondary">{a.unstableBody(model.aside.unstable.kind, model.aside.unstable.office)}</p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {model.aside.unstable.ruleAdded ? (
                <Chip tone="green" icon={CircleCheck}>{a.ruleAdded}</Chip>
              ) : (
                <Button icon={Plus} onClick={actions.onAddRule}>{a.addRule}</Button>
              )}
              {actions.onOpenUnstable && <Button variant="ghost" onClick={actions.onOpenUnstable}>{a.openCase}</Button>}
            </div>
          </>
        ) : (
          <p className="text-prose leading-5 text-app-text-secondary">{a.unstableNone}</p>
        )}
      </PanelSection>
      <PanelSection label={a.afterTitle} className="border-b-0">
        <KeyValue label={a.approves} value={model.aside.approver} />
        <KeyValue label={a.nightly} value={a.nightlyValue(model.aside.nightly)} />
        <KeyValue label={a.ifChanges} value={a.ifChangesValue} />
      </PanelSection>
    </>
  );
  if (phone) return <div className="border-t border-app-border">{body}</div>;
  return <SidePanel width={370}>{body}</SidePanel>;
}
