/**
 * The page of one step of a flow (w02, n05, n06, n07 and the generic page):
 * the steps on the left, the configuration in the middle, «Prova questo (allow-italian: quotes the Italian interface)
 * passo» on a real case, «Salva» as a new draft version. (allow-italian: quotes the Italian interface)
 */
import { Play, Save, Video } from 'lucide-react';
import type { FlowSeed, FlowStepSeed } from '../../../../ui/fixtures/org/types';
import { CASES } from '../../../../ui/fixtures/org/cases';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { KNOWLEDGE_POOL, runsOf } from '../../../../ui/fixtures/flowrun';
import { belowPercent, ruleHolds, type StepChange, type StepConfig, type StepOverride } from '../../../../ui/flowrun/config';
import type { Condition, FieldDef, RailItem } from '../../../../ui/flowrun/model';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { StepLayout, StepRail, FlowHeader } from '../../../../ui/flowrun/common';
import { ClassifyPanel } from '../../../../ui/flowrun/ClassifyPanel';
import { AiPanel } from '../../../../ui/flowrun/AiPanel';
import { RulePanel, type RuleSampleRow } from '../../../../ui/flowrun/RulePanel';
import { RobotPanel } from '../../../../ui/flowrun/RobotPanel';
import { GenericPanel } from '../../../../ui/flowrun/GenericPanel';
import { TryPanel } from '../../../../ui/flowrun/TryPanel';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import {
  capitalize, configOf, currentConfig, markerOf, finishedYesterday, versionsOf, workingChanges,
} from './data';
import { PasswordHost } from './password';
import { usePasswordDialog } from './password-state';
import { buildTry, casesFor, type StoredTry } from './try';
import { VIEWS, credentialOf, toJobView, useFlowSlice, viewPath } from './shared';
import { HALLEY_VAULT, vaultSlice } from '../../store/vault';
import { summarize } from './labels';

const OPS = ['lt', 'gt', 'gte', 'eq', 'in'] as const;

let nextId = 0;
const freshId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`;

interface TryState { caseId: string; result?: StoredTry }

export function StepScreen({ ctx, flow, step }: { ctx: ScreenCtx; flow: FlowSeed; step: FlowStepSeed }) {
  const copy = ctx.copy;
  const c = copy.flowRun;
  const [st, setSt] = useFlowSlice(ctx, flow);
  const [vault] = vaultSlice(ctx);
  const [, setPasswordOpen] = usePasswordDialog(ctx);
  const editable = ctx.can('edit:structure');
  const denied = ctx.deniedTitle('edit:structure');
  const cfg = currentConfig(flow, step, st);
  const baseCfg = configOf(flow, step, [st.activeOv]);

  /* Screen state, declared once and in the same order on every render. */
  const [draftWhen, setDraftWhen] = ctx.ui<string>(`flowRun.preWhen.${flow.id}.${step.id}`, '');
  const [draftThen, setDraftThen] = ctx.ui<string>(`flowRun.preThen.${flow.id}.${step.id}`, '');
  const [itemsOpen, setItemsOpen] = ctx.ui<boolean>(`flowRun.items.${flow.id}.${step.id}`, false);
  const [robotSel, setRobotSel] = ctx.ui<string | null>(`flowRun.robotStep.${flow.id}.${step.id}`, null);
  const [recorded, setRecorded] = ctx.ui<string | null>(`flowRun.recorded.${flow.id}.${step.id}`, null);
  const [, setRunQuery] = ctx.ui<string>(`flowRun.runs.${flow.id}.q`, '');

  /** Lays an edit on the working copy of this step. */
  const edit = (fn: (prev: StepOverride) => StepOverride) =>
    setSt((s) => ({ ...s, working: { ...s.working, [step.id]: fn(s.working[step.id] ?? {}) } }));

  const ask = (title: string, body: string, onConfirm: () => void) =>
    ctx.confirm({ title, body, confirmLabel: c.screen.remove, tone: 'danger', onConfirm });

  /* ---------- try on a case ---------- */
  const cases = casesFor(flow, CASES);
  const [tryOpen, setTryOpen] = ctx.ui<boolean>(`flowRun.tryOpen.${flow.id}.${step.id}`, false);
  const [tryState, setTryState] = ctx.ui<TryState>(`flowRun.try.${flow.id}.${step.id}`, { caseId: cases[0]?.id ?? '' });
  const jobId = `try:${flow.id}:${step.id}`;
  const job = toJobView(ctx.job(jobId));
  const runTry = () => {
    const runCase = cases.find((x) => x.id === tryState.caseId) ?? cases[0];
    if (!runCase) { setTryOpen(true); return; }
    setTryOpen(true);
    const labels = c.tryIt.steps[step.kind];
    const now = ctx.now;
    const snapshot: StepConfig = cfg;
    ctx.startJob({
      id: jobId,
      title: c.tryIt.title,
      steps: labels.map((label, i) => ({ label, ms: 450 + i * 250 })),
      onDone: (ok) => {
        if (!ok) return;
        setTryState((prev) => ({ ...prev, caseId: runCase.id, result: buildTry(copy, step, snapshot, runCase, now) }));
        ctx.log(c.screen.logTried(flow.name, step.label, runCase.title), 'test', P.flowStep(flow.id, step.id));
      },
    });
  };
  const result = tryState.result && {
    ...tryState.result,
    at: tryState.result.at.slice(11, 16),
    input: tryState.result.input.map((r) => ({ ...r, source: r.source && { label: r.source.label, onOpen: r.source.path ? () => ctx.go(r.source!.path!) : undefined } })),
    output: tryState.result.output.map((r) => ({ ...r, source: r.source && { label: r.source.label, onOpen: r.source.path ? () => ctx.go(r.source!.path!) : undefined } })),
  };

  /* ---------- save as a new draft version ---------- */
  const save = () => {
    const changes: StepChange[] = workingChanges(flow, st);
    const last = [...st.saved].sort((a, b) => b.n - a.n)[0];
    if (!changes.length) {
      ctx.toast({ tone: 'info', title: c.screen.nothingToSave, body: c.screen.nothingToSaveBody(st.activeN) });
      return;
    }
    if (last && JSON.stringify(last.overrides) === JSON.stringify(st.working)) {
      ctx.toast({ tone: 'info', title: c.screen.nothingToSave, body: c.screen.nothingToSaveBody(last.n), action: { label: c.screen.savedAction, path: P.flowVersions(flow.id) } });
      return;
    }
    const n = Math.max(0, ...versionsOf(flow, st).map((v) => v.n)) + 1;
    const summary = summarize(copy, flow, changes);
    setSt((s) => ({ ...s, saved: [...s.saved, { n, at: ctx.now, who: ctx.persona.name, summary, overrides: s.working }] }));
    ctx.log(c.screen.logSaved(flow.name, n), 'structure', P.flowVersions(flow.id));
    ctx.toast({ tone: 'ok', title: c.screen.saved(n), body: c.screen.savedBody, action: { label: c.screen.savedAction, path: P.flowVersions(flow.id) } });
  };

  /* ---------- the rail ---------- */
  const railNote = (s: FlowStepSeed) => {
    const sc = configOf(flow, s, [st.activeOv, st.working]);
    const n = c.screen.railNote;
    if (sc.type === 'classify') return n.classify(sc.types.length, sc.threshold);
    if (sc.type === 'ai') return n.ai(sc.threshold);
    if (sc.type === 'rule') return n.rule(sc.conditions.length);
    if (sc.type === 'robot') return n.robot(sc.program);
    if (s.kind === 'person' && sc.type === 'generic') return n.person(sc.hours);
    if (s.kind === 'program') return n.program(s.program ?? '');
    return s.kind === 'view' ? n.view : s.kind === 'send' ? n.send : undefined;
  };
  const rail: RailItem[] = [
    { id: 'trigger', kind: 'trigger', title: c.screen.triggerTitle(capitalize(flow.trigger)), onSelect: () => ctx.go(P.flow(flow.id)) },
    ...flow.steps.map((s, i) => ({
      id: s.id, marker: markerOf(flow, i), kind: s.kind, program: s.program, title: s.label, note: railNote(s),
      badges: st.working[s.id] ? [{ label: c.versions.badgeEdited, tone: 'amber' as const }] : undefined,
      selected: s.id === step.id,
      onSelect: () => ctx.go(P.flowStep(flow.id, s.id)),
    })),
  ];

  /* ---------- the panel of this kind of step ---------- */
  const dirty = Boolean(st.working[step.id]);
  const knowledgeOf = (next: (used: string[]) => string[]) => edit((o) => ({ ...o, knowledge: next((cfg.type === 'ai' || cfg.type === 'classify') ? cfg.knowledge : []) }));
  const knowledgeHandlers = {
    onAddKnowledge: (name: string) => {
      knowledgeOf((u) => (u.includes(name) ? u : [...u, name]));
      ctx.toast({ tone: 'info', title: c.screen.knowledgeAdded(name) });
    },
    onRemoveKnowledge: (name: string) => knowledgeOf((u) => u.filter((x) => x !== name)),
    onOpenKnowledge: (name: string) => ctx.go(P.knowledgeSearch(name)),
  };

  let panel: React.ReactNode;
  let fill = false;
  if (cfg.type === 'classify' && baseCfg.type === 'classify') {
    fill = true;
    panel = (
      <ClassifyPanel
        copy={copy}
        editable={editable}
        deniedTitle={denied}
        draftWhen={draftWhen}
        draftThen={draftThen}
        onDraftWhen={setDraftWhen}
        onDraftThen={setDraftThen}
        view={{
          takes: cfg.takes, gives: cfg.gives, types: cfg.types, preRules: cfg.preRules, corrections: cfg.corrections,
          threshold: cfg.threshold, belowPct: belowPercent(cfg.calibration, cfg.threshold),
          perMonth: flow.perMonth, knowledge: cfg.knowledge, knowledgePool: KNOWLEDGE_POOL,
          changed: cfg.threshold !== baseCfg.threshold,
        }}
        handlers={{
          onThreshold: (n) => edit((o) => ({ ...o, threshold: n })),
          onTypeWhen: (id, text) => edit((o) => ({ ...o, typeWhen: { ...o.typeWhen, [id]: text } })),
          onAddRule: (when, then) => {
            if (!when) {
              ctx.toast({ tone: 'info', title: c.screen.ruleNeedsWhen });
              return;
            }
            edit((o) => ({ ...o, preRules: [...cfg.preRules, { id: freshId('p'), when, then }] }));
            setDraftWhen('');
            setDraftThen('');
          },
          onRemoveRule: (id) => {
            const r = cfg.preRules.find((x) => x.id === id);
            ask(c.screen.askRemoveTitle, c.screen.askRemoveRule(r?.when ?? ''), () => edit((o) => ({ ...o, preRules: cfg.preRules.filter((x) => x.id !== id) })));
          },
          ...knowledgeHandlers,
          onOpenType: (letter) => {
            setRunQuery(`tipo:${letter}`);
            ctx.go(P.flowRuns(flow.id));
          },
        }}
      />
    );
  } else if (cfg.type === 'ai' && baseCfg.type === 'ai') {
    panel = (
      <AiPanel
        copy={copy}
        editable={editable}
        deniedTitle={denied}
        view={{
          prompt: cfg.prompt, knowledge: cfg.knowledge, knowledgePool: cfg.knowledgePool, fields: cfg.fields, threshold: cfg.threshold,
          belowPct: belowPercent(cfg.calibration, cfg.threshold), corrections: cfg.corrections, lastCorrection: cfg.lastCorrection,
          model: cfg.model, personalData: cfg.personalData, cost: cfg.cost, lastTest: cfg.lastTest, changed: cfg.threshold !== baseCfg.threshold,
        }}
        handlers={{
          onPrompt: (v) => edit((o) => ({ ...o, prompt: v })),
          onField: (id, patch: Partial<FieldDef>) => edit((o) => ({ ...o, fields: cfg.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)) })),
          onAddField: () => edit((o) => ({ ...o, fields: [...cfg.fields, { id: freshId('f'), name: c.screen.newField, type: c.screen.newFieldType, required: false }] })),
          onRemoveField: (id) => {
            const f = cfg.fields.find((x) => x.id === id);
            ask(c.screen.askRemoveTitle, c.screen.askRemoveField(f?.name ?? ''), () => edit((o) => ({ ...o, fields: cfg.fields.filter((x) => x.id !== id) })));
          },
          onThreshold: (n) => edit((o) => ({ ...o, threshold: n })),
          ...knowledgeHandlers,
          onOpenCorrections: () => ctx.go(P.settings('registro')),
          onOpenTests: () => ctx.go(P.flowVersions(flow.id)),
        }}
      />
    );
  } else if (cfg.type === 'rule' && baseCfg.type === 'rule') {
    const used = [...new Set(cfg.conditions.map((x) => x.field))];
    const sampleFields = used.length ? used : ['fiducia'];
    const fmt = (id: string, v: number | boolean) => (typeof v === 'boolean' ? (v ? c.rule.yes : c.rule.no) : id === 'fiducia' ? `${v}%` : String(v));
    const samples: RuleSampleRow[] = runsOf(flow.id).filter(finishedYesterday).slice(0, 8).map((r) => {
      const values = { fiducia: r.confidence, allegati: r.unreadable, mittente: r.senderListed, giorni: r.daysLeft, importo: r.amount };
      return {
        id: r.id,
        label: r.title,
        values: Object.fromEntries(sampleFields.map((f) => [f, fmt(f, values[f as keyof typeof values])])),
        result: ruleHolds(cfg.conditions, cfg.fields, values) ? 'then' : 'else',
        onOpen: () => ctx.go(P.flowRun(flow.id, r.id)),
      } satisfies RuleSampleRow;
    });
    panel = (
      <RulePanel
        copy={copy}
        editable={editable}
        deniedTitle={denied}
        view={{
          question: cfg.question, thenLabel: cfg.thenLabel, elseLabel: cfg.elseLabel, conditions: cfg.conditions, fields: cfg.fields,
          ops: OPS.map((id) => ({ id, label: c.rule.ops[id] })),
          table: { name: cfg.table.name, items: cfg.table.items, shown: itemsOpen ? cfg.table.items.length : 4 },
          samples, sampleFields, samplesTitle: c.rule.samplesTitle,
        }}
        handlers={{
          onCondition: (id, patch: Partial<Condition>) => edit((o) => ({ ...o, conditions: cfg.conditions.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),
          onAddCondition: () => edit((o) => ({ ...o, conditions: [...cfg.conditions, { id: freshId('c'), field: cfg.fields[0].id, op: 'lt', value: '90' }] })),
          onRemoveCondition: (id) => ask(c.screen.askRemoveTitle, c.screen.askRemoveCondition, () => edit((o) => ({ ...o, conditions: cfg.conditions.filter((x) => x.id !== id) }))),
          onOpenTable: () => ctx.go(P.data('t-enti')),
          onOpenTableItem: () => ctx.go(P.data('t-enti')),
          onToggleItems: () => setItemsOpen(!itemsOpen),
        }}
      />
    );
  } else if (cfg.type === 'robot' && baseCfg.type === 'robot') {
    fill = true;
    const credential = credentialOf(vault, cfg.program === 'Halley' ? HALLEY_VAULT : cfg.vault);
    panel = (
      <>
        <RobotPanel
          copy={copy}
          editable={editable}
          deniedTitle={denied}
          view={{
            program: cfg.program, title: cfg.title, intro: cfg.intro, steps: cfg.steps, selectedStep: robotSel, checks: cfg.checks, user: cfg.user, vault: cfg.vault,
            credential: credential.state, credentialNote: credential.state === 'expired' ? c.robot.expiredNote : credential.updatedAt ? c.robot.updatedNote(credential.updatedAt.slice(11, 16)) : undefined,
            recordedNote: recorded ? c.robot.updatedNote(recorded.slice(11, 16)) : undefined,
            where: cfg.where, hours: cfg.hours, offHours: cfg.offHours === 'run' ? 'run' : 'wait', oneAtATime: cfg.oneAtATime, retries: cfg.retries,
            everyMin: cfg.everyMin, then: cfg.then, notify: cfg.notify, runs: cfg.runs,
          }}
          handlers={{
            onSelectStep: setRobotSel,
            onHours: (v) => edit((o) => ({ ...o, robot: { ...o.robot, hours: v } })),
            onOffHours: (v) => edit((o) => ({ ...o, robot: { ...o.robot, offHours: v } })),
            onOneAtATime: (v) => edit((o) => ({ ...o, robot: { ...o.robot, oneAtATime: v } })),
            onRetries: (n) => edit((o) => ({ ...o, robot: { ...o.robot, retries: n } })),
            onEvery: (n) => edit((o) => ({ ...o, robot: { ...o.robot, everyMin: n } })),
            onThen: (v) => edit((o) => ({ ...o, robot: { ...o.robot, then: v } })),
            onNotify: (v) => edit((o) => ({ ...o, robot: { ...o.robot, notify: v } })),
            onUpdatePassword: () => setPasswordOpen(true),
            onOpenRuns: () => ctx.go(P.flowRuns(flow.id)),
          }}
        />
        <PasswordHost ctx={ctx} program={cfg.program} user={cfg.user} vault={cfg.program === 'Halley' ? HALLEY_VAULT : cfg.vault} />
      </>
    );
  } else if (cfg.type === 'generic') {
    panel = (
      <GenericPanel
        copy={copy}
        editable={editable}
        deniedTitle={denied}
        view={{
          kind: step.kind, program: step.program, title: step.label, office: cfg.office,
          offices: Object.entries(OFFICE_LABEL).map(([value, label]) => ({ value, label })),
          hours: cfg.hours, note: cfg.note, uses: cfg.uses, produces: cfg.produces, opens: cfg.opens,
        }}
        handlers={{
          onOffice: (v) => edit((o) => ({ ...o, generic: { ...o.generic, office: v } })),
          onHours: (n) => edit((o) => ({ ...o, generic: { ...o.generic, hours: n } })),
          onNote: (v) => edit((o) => ({ ...o, generic: { ...o.generic, note: v } })),
          onOpenView: () => {
            const target = step.kind === 'view' ? P.views() : step.kind === 'send' ? P.channels() : step.kind === 'program' ? P.programs() : P.inbox();
            ctx.toast({ tone: 'info', title: c.screen.openedView(cfg.opens ?? '') });
            ctx.go(target);
          },
        }}
      />
    );
  }

  /* ---------- the robot's «registra di nuovo i passi» ---------- (allow-italian: quotes the Italian interface) */
  const rerecord = () => ctx.confirm({
    title: c.screen.rerecord,
    body: c.screen.rerecordJob,
    confirmLabel: c.screen.rerecord,
    onConfirm: () => ctx.startJob({
      id: `rerecord:${flow.id}:${step.id}`,
      title: c.screen.rerecord,
      steps: c.screen.rerecordSteps.map((label, i) => ({ label, ms: 500 + i * 200 })),
      onDone: (ok) => {
        if (!ok) return;
        setRecorded(ctx.now);
        ctx.log(c.screen.logRerecord(step.program ?? flow.name), 'structure', P.flowStep(flow.id, step.id));
        ctx.toast({ tone: 'ok', title: c.screen.rerecordDone(step.program ?? flow.name) });
      },
    }),
  });
  const rerecordJob = toJobView(ctx.job(`rerecord:${flow.id}:${step.id}`));

  return (
    <div className="flex h-full min-h-0 flex-col" data-step-kind={step.kind}>
      <FlowHeader
        copy={copy}
        flowName={flow.name}
        here={step.label}
        views={VIEWS}
        view="steps"
        onView={(v) => ctx.go(viewPath(flow.id, v))}
        onBack={() => ctx.go(P.flow(flow.id))}
        phone={ctx.phone}
        status={dirty ? <Chip tone="amber">{c.screen.edited}</Chip> : undefined}
      >
        {cfg.type === 'robot' && (
          <Button onClick={ctx.allow('edit:structure', rerecord)} title={ctx.deniedTitle('edit:structure')} icon={Video}>
            {rerecordJob?.status === 'running' ? c.screen.rerecordJob : c.screen.rerecord}
          </Button>
        )}
        <Button icon={Play} onClick={ctx.allow('run:tests', runTry)} title={ctx.deniedTitle('run:tests')}>
          {cfg.type === 'robot' ? c.screen.readOnly : c.screen.tryThisStep}
        </Button>
        <Button variant="primary" icon={Save} onClick={ctx.allow('edit:structure', save)} title={ctx.deniedTitle('edit:structure')}>{c.screen.save}</Button>
      </FlowHeader>
      {tryOpen && (
        <div className="max-h-[48vh] shrink-0 overflow-y-auto border-b border-app-border bg-black/[0.02] p-4 dark:bg-white/[0.02]">
          <TryPanel
            copy={copy}
            cases={cases.map((x) => ({ value: x.id, label: `${x.id} · ${x.title}` }))}
            caseId={tryState.caseId || (cases[0]?.id ?? '')}
            onCase={(id) => setTryState((p) => ({ ...p, caseId: id }))}
            onRun={ctx.allow('run:tests', runTry)}
            runDisabledTitle={ctx.deniedTitle('run:tests')}
            onClose={() => setTryOpen(false)}
            job={job}
            result={result}
            busy={job?.status === 'running'}
            emptyText={c.screen.noCases}
          />
        </div>
      )}
      <StepLayout rail={<StepRail items={rail} label={c.screen.stepsLabel} copy={copy} />} fill={fill}>
        {panel ?? <EmptyState title={c.screen.notFoundStep} />}
      </StepLayout>
    </div>
  );
}
