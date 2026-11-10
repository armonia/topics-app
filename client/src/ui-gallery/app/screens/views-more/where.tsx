/**
 * a05: where a view opens, as the settings of that view. Which steps of which
 * flows open it (each switch changes the structure, so it needs the right to),
 * for which roles, on which devices and how; what it lets someone decide and
 * what it writes in the case sits beside it. The steps shown on the list of
 * views are the ones switched on here.
 */
import type { ReactNode } from 'react';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { PlaceholderScreen } from '../../../../ui/shell/PlaceholderScreen';
import { Button } from '../../../../ui/primitives/Button';
import { ViewWhereScreen } from '../../../../ui/views/ViewWhereScreen';
import { ROLES } from '../../../../ui/fixtures/org/people';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { entryOf, openPath, rolesOf, stepKey, stepLabels, stepsOf, viewsSlice, whereOf } from './shared';
import { Eye } from 'lucide-react';

/** The flows whose steps a view can open from: those with a step a person decides or a view shows. */
const OPENING_KINDS = new Set(['person', 'view', 'robot']);

export function renderWhere(params: { view: string }, ctx: ScreenCtx): ReactNode {
  const m = ctx.copy.viewsMore;
  const w = m.where;
  const [vs, setVs] = viewsSlice(ctx);
  const [addFlow, setAddFlow] = ctx.ui('where.addFlow', '');
  const [addStep, setAddStep] = ctx.ui('where.addStep', '');
  const entry = entryOf(vs, params.view);
  if (!entry) {
    return (
      <PlaceholderScreen
        crumbs={[{ label: ctx.copy.views.root }]}
        icon={Eye}
        title={w.missingTitle}
        body={w.missingBody}
        action={<Button variant="primary" onClick={() => ctx.go(P.views())}>{w.missingAction}</Button>}
      />
    );
  }
  const state = whereOf(vs, entry.id);
  const patch = (fn: (cur: ReturnType<typeof whereOf>) => Partial<ReturnType<typeof whereOf>>) =>
    setVs((p) => ({ ...p, where: { ...p.where, [entry.id]: { ...whereOf(p, entry.id), ...fn(whereOf(p, entry.id)) } } }));
  const logChange = (what: string) => ctx.log(what, 'structure', P.viewWhere(entry.id));
  const denied = ctx.deniedTitle('edit:structure');

  const steps = stepsOf(entry, vs).map((s) => {
    const labels = stepLabels(s);
    return {
      id: stepKey(s), flow: labels.flow, step: labels.step, on: s.on,
      onToggle: ctx.allow('edit:structure', () => {
        patch((cur) => ({ off: s.on ? [...cur.off, stepKey(s)] : cur.off.filter((k) => k !== stepKey(s)) }));
        logChange(s.on ? w.logStepOff(entry.name, labels.step) : w.logStepOn(entry.name, labels.step));
      }),
      onOpen: () => ctx.go(P.flowStep(s.flow, s.step)),
    };
  });

  const flows = FLOWS.filter((f) => f.org === 'nocera' && f.steps.some((s) => OPENING_KINDS.has(s.kind)));
  const flowId = addFlow && flows.some((f) => f.id === addFlow) ? addFlow : flows[0]?.id ?? '';
  const stepOptions = (FLOWS.find((f) => f.id === flowId)?.steps ?? [])
    .filter((s) => OPENING_KINDS.has(s.kind) && !stepsOf(entry, vs).some((u) => u.flow === flowId && u.step === s.id));
  const stepId = addStep && stepOptions.some((s) => s.id === addStep) ? addStep : stepOptions[0]?.id ?? '';
  const onAdd = ctx.allow('edit:structure', () => {
    const flow = FLOWS.find((f) => f.id === flowId);
    const step = flow?.steps.find((s) => s.id === stepId);
    if (!flow || !step) {
      ctx.toast({ tone: 'info', title: w.nothingToAdd });
      return;
    }
    patch((cur) => ({ added: [...cur.added, { flow: flow.id, step: step.id, label: `${flow.name}, ${step.label}` }] }));
    logChange(w.logStepAdded(entry.name, step.label));
    ctx.toast({ tone: 'ok', title: w.toastStepAdded(step.label) });
    setAddStep('');
  });

  const roles = ROLES.map((r) => {
    const on = rolesOf(entry, vs, r.id);
    return {
      id: r.id, label: r.label, on,
      onToggle: ctx.allow('edit:structure', () => {
        patch((cur) => ({ roles: { ...cur.roles, [r.id]: !on } }));
        logChange(on ? w.logRoleOff(entry.name, r.label) : w.logRoleOn(entry.name, r.label));
      }),
    };
  });
  const devices = [
    { id: 'desktop', label: w.desktop, on: state.desktop },
    { id: 'phone', label: w.phoneDevice, on: state.phone },
  ].map((dv) => ({
    ...dv,
    onToggle: ctx.allow('edit:structure', () => {
      patch(() => (dv.id === 'desktop' ? { desktop: !dv.on } : { phone: !dv.on }));
      logChange(w.logDevice(entry.name, dv.label, !dv.on));
    }),
  }));

  return (
    <ViewWhereScreen
      copy={ctx.copy}
      name={entry.name}
      description={entry.description}
      facts={{ decision: entry.seed?.decision, originals: entry.seed?.originals, writes: entry.seed?.writes, base: entry.seed?.base }}
      steps={steps}
      roles={roles}
      devices={devices}
      opensAs={{
        value: state.opensAs,
        options: [{ value: 'tab', label: w.asTab }, { value: 'side', label: w.asSide }],
        disabled: !ctx.can('edit:structure'),
      }}
      onOpensAs={(v) => {
        patch(() => ({ opensAs: v === 'side' ? 'side' : 'tab' }));
        logChange(w.logOpensAs(entry.name, v === 'side' ? w.asSide : w.asTab));
      }}
      add={{
        flow: flowId,
        flows: flows.map((f) => ({ value: f.id, label: f.name })),
        onFlow: (v) => {
          setAddFlow(v);
          setAddStep('');
        },
        step: stepId,
        steps: stepOptions.map((s) => ({ value: s.id, label: s.label })),
        onStep: setAddStep,
        onAdd,
      }}
      onOpenView={() => ctx.go(openPath(entry))}
      onBack={() => ctx.go(P.views())}
      backLabel={ctx.copy.views.root}
      deniedTitle={denied}
      phone={ctx.phone}
      inUse={entry.adopted}
    />
  );
}
