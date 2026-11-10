/** n02: starting a flow: the first steps, a description in words, the templates of a sector. */
import { useState } from 'react';
import { Button } from '../../../../ui/primitives/Button';
import { Dialog } from '../../../../ui/primitives/Dialog';
import { TextField, Select } from '../../../../ui/primitives/Field';
import { ProgressBar } from '../../../../ui/primitives/Progress';
import { NewFlowScreen, type FirstStepModel, type TemplateCardModel } from '../../../../ui/flows/NewFlow';
import type { ActorKind } from '../../../../ui/flows/model';
import { BLANK_STEPS, FIRST_STEPS, SECTORS, TEMPLATES, type TemplateModel } from '../../../../ui/fixtures/flow-build';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { STEP_DETAIL } from '../../../../ui/fixtures/flows';
import { OFFICE_LABEL, ORGS } from '../../../../ui/fixtures/org/people';
import type { FlowStepSeed, Office } from '../../../../ui/fixtures/org/types';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { createFlow, useFlowsSlice } from './actions';
import { capitalize, flowsOf } from './model';

const OFFICES = Object.keys(OFFICE_LABEL) as Office[];

/** The steps a template makes: its own, or those of the example flow it describes. */
function stepsOfTemplate(tpl: TemplateModel): FlowStepSeed[] {
  if (tpl.seed.steps.length) return tpl.seed.steps;
  return FLOWS.find((f) => f.id === tpl.existing)?.steps ?? [];
}

const ACTOR_OF_KIND: Record<FlowStepSeed['kind'], ActorKind> = {
  classify: 'ai', ai: 'ai', rule: 'rule', person: 'person', view: 'person', robot: 'program', program: 'program', send: 'action',
};

export function NewFlowPage({ ctx }: { ctx: ScreenCtx }) {
  const t = ctx.copy.flowBuild.start;
  const [slice, setSlice] = useFlowsSlice(ctx);
  const [sector, setSector] = ctx.ui('start.sector', SECTORS[0].id);
  const [describe, setDescribe] = ctx.ui('start.describe', '');
  const [invited, setInvited] = ctx.ui('start.invited', false);
  const [picked, setPicked] = useState<TemplateModel | null>(null);
  const flows = flowsOf(slice, 'nocera');
  const inviteJob = ctx.job('invite-people');
  const rest = FIRST_STEPS.people.total - FIRST_STEPS.people.invited;
  const running = flows.filter((f) => f.status === 'attivo').length; // allow-italian: state identifier, not shown
  const trial = flows.filter((f) => f.status === 'collaudo').length; // allow-italian: state identifier, not shown
  const chosen = running + trial;

  const invite = ctx.allow('admin', () => {
    ctx.startJob({
      id: 'invite-people',
      title: t.inviteJob,
      steps: [{ label: t.inviteStep1, ms: 900 }, { label: t.inviteStep2, ms: 800 }, { label: t.inviteStep3, ms: 600 }],
      onDone: (ok) => {
        if (!ok) return;
        setInvited(true);
        ctx.log(t.inviteLog(rest), 'access', P.settings('persone'));
        ctx.toast({ tone: 'ok', title: t.inviteDone(rest), action: { label: t.invitePeople, path: P.settings('persone') } });
      },
    });
  });

  const steps: FirstStepModel[] = [
    { id: 'mail', number: 1, state: 'done', title: t.steps.mail, detail: FIRST_STEPS.mail, onOpen: () => ctx.go(P.channels()) },
    { id: 'docs', number: 2, state: 'done', title: t.steps.docs, detail: FIRST_STEPS.docs, onOpen: () => ctx.go(P.knowledge()) },
    {
      id: 'people', number: 3, state: invited ? 'done' : 'current', title: t.steps.people,
      detail: t.peopleDetail(invited ? FIRST_STEPS.people.total : FIRST_STEPS.people.invited, FIRST_STEPS.people.total),
      action: invited || inviteJob?.status === 'running' ? undefined : { label: t.inviteRest(rest), onClick: invite },
      extra: inviteJob?.status === 'running' ? <ProgressBar value={inviteJob.progress} label={inviteJob.current ?? t.inviteJob} /> : undefined,
      onOpen: () => ctx.go(P.settings('persone')),
    },
    { id: 'flows', number: 4, state: invited ? 'current' : 'todo', title: t.steps.flows, detail: t.flowsChosen(chosen, running, trial), onOpen: () => ctx.go(P.flows()) },
  ];

  const templates = TEMPLATES.filter((x) => x.sector === sector);
  const existingOf = (tpl: TemplateModel) => (tpl.existing ? flows.find((f) => f.id === tpl.existing) : undefined);
  const cards: TemplateCardModel[] = templates.map((tpl) => {
    const existing = existingOf(tpl);
    const list = existing ? existing.steps : stepsOfTemplate(tpl);
    const kinds = [...new Set(list.map((s) => ACTOR_OF_KIND[s.kind]))];
    return {
      id: tpl.id,
      title: tpl.seed.name,
      description: tpl.description,
      actors: [{ kind: 'trigger' }, ...kinds.map((k) => (k === 'program' ? { kind: k, name: ctx.copy.flowBuild.robot, tone: 'green' as const } : { kind: k }))],
      blocks: ctx.copy.flowBuild.list.blocks(list.length),
      state: existing ? ctx.copy.flowBuild.status[existing.status] : undefined,
    };
  });

  const pick = (id: string) => {
    const template = TEMPLATES.find((x) => x.id === id)!;
    const existing = existingOf(template);
    if (existing) {
      ctx.go(P.flow(existing.id));
      return;
    }
    if (!ctx.can('edit:structure')) {
      ctx.toast({ tone: 'warn', title: ctx.deniedTitle('edit:structure') ?? '' });
      return;
    }
    setPicked(template);
  };

  const fromDescription = ctx.allow('edit:structure', () => {
    const text = describe.trim();
    if (!text) {
      ctx.toast({ tone: 'info', title: t.describeEmpty });
      return;
    }
    if (/fattur/i.test(text)) {
      ctx.go(P.chat('nuovo-flusso-fatture'));
      return;
    }
    const id = createFlow(ctx, slice, setSlice, {
      name: capitalize(text.length > 60 ? `${text.slice(0, 57)}...` : text),
      trigger: t.blankTrigger,
      office: 'segreteria',
      steps: BLANK_STEPS,
      origin: 'blank',
    });
    setDescribe('');
    ctx.go(P.flow(id));
  });

  return (
    <>
      <NewFlowScreen
        copy={ctx.copy}
        crumbs={[{ label: ctx.copy.flows.root, detail: ORGS.find((o) => o.id === 'nocera')!.name }]}
        steps={steps}
        describe={describe}
        onDescribe={fromDescription}
        onDescribeChange={setDescribe}
        sector={sector}
        sectors={SECTORS.map((x) => ({ value: x.id, label: x.name }))}
        onSector={setSector}
        templates={cards}
        onPick={pick}
        phone={ctx.phone}
      />
      {picked && (
        <NameFlowDialog
          ctx={ctx}
          template={picked}
          onClose={() => setPicked(null)}
          onCreate={(name, office) => {
            const id = createFlow(ctx, slice, setSlice, {
              name, trigger: picked.seed.trigger, office, steps: stepsOfTemplate(picked), origin: 'template', from: picked.existing,
              details: picked.existing ? STEP_DETAIL[picked.existing] : undefined,
            });
            setPicked(null);
            ctx.go(P.flow(id));
          }}
        />
      )}
    </>
  );
}

/** Naming a flow before it is made: what to call it, and which office answers for it. */
function NameFlowDialog({ ctx, template, onClose, onCreate }: {
  ctx: ScreenCtx;
  template: TemplateModel;
  onClose: () => void;
  onCreate: (name: string, office: Office) => void;
}) {
  const t = ctx.copy.flowBuild.start;
  const [name, setName] = useState(template.seed.name);
  const [office, setOffice] = useState<Office>(template.seed.office);
  const [error, setError] = useState('');
  const submit = () => {
    if (!name.trim()) {
      setError(t.nameRequired);
      return;
    }
    onCreate(name.trim(), office);
  };
  return (
    <Dialog
      title={t.dialogTitle}
      closeLabel={ctx.copy.common.close}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{t.cancel}</Button>
          <Button variant="primary" onClick={submit}>{t.createFlow}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4 p-4">
        <p className="text-prose leading-6 text-app-text-secondary">{template.description}</p>
        <TextField label={t.nameLabel} value={name} onChange={(v) => { setName(v); setError(''); }} error={error || undefined} onEnter={submit} autoFocus />
        <Select label={t.officeLabel} value={office} onChange={(v) => setOffice(v as Office)} options={OFFICES.map((o) => ({ value: o, label: OFFICE_LABEL[o] }))} />
        <p className="text-compact text-app-text-tertiary">{t.draftNote}</p>
      </div>
    </Dialog>
  );
}
