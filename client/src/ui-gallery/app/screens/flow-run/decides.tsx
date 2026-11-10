/**
 * How an AI step decides (g03): temperature 0, what it had in front of it,
 * how it is fixed, the same answer on every replay, the thresholds. For a
 * flow, for one run and one step; the thresholds are the same ones the step
 * pages edit, so a change here is a change of the working copy there.
 */
import type { FlowSeed, FlowStepSeed } from '../../../../ui/fixtures/org/types';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { belowPercent } from '../../../../ui/flowrun/config';
import type { ContextRow } from '../../../../ui/flowrun/model';
import { FlowHeader } from '../../../../ui/flowrun/common';
import { DecidesPanel } from '../../../../ui/flowrun/DecidesPanel';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { Button } from '../../../../ui/primitives/Button';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { caseSeed } from '../../store/cases';
import { configOf, currentConfig, liveRunsOf, markerOf } from './data';
import { VIEWS, toJobView, useFlowSlice, useRunOverrides, viewPath } from './shared';

const DEFAULT_REPLAYS = 5;

export function DecidesScreen({ ctx, flow }: { ctx: ScreenCtx; flow: FlowSeed }) {
  const copy = ctx.copy;
  const c = copy.flowRun.decides;
  const [st, setSt] = useFlowSlice(ctx, flow);
  const [ov] = useRunOverrides(ctx);
  const editable = ctx.can('edit:structure');
  const aiSteps = flow.steps.filter((s) => s.kind === 'classify' || s.kind === 'ai');
  const runs = liveRunsOf(flow.id, ov).filter((r) => r.path.some((id) => aiSteps.some((s) => s.id === id)));
  const [runUi, setRun] = ctx.ui<string | null>(`flowRun.decides.${flow.id}.run`, null);
  const [stepUi, setStep] = ctx.ui<string | null>(`flowRun.decides.${flow.id}.step`, null);
  const [missing, setMissing] = ctx.ui<'stop' | 'person'>(`flowRun.decides.${flow.id}.missing`, 'person');
  const [replays, setReplays] = ctx.ui<Record<string, number>>(`flowRun.decides.${flow.id}.replays`, {});

  const header = (here: string) => (
    <FlowHeader copy={copy} flowName={flow.name} here={here} views={VIEWS} view="steps" onView={(v) => ctx.go(viewPath(flow.id, v))} onBack={() => ctx.go(P.flow(flow.id))} phone={ctx.phone} />
  );

  if (!aiSteps.length || !runs.length) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header(c.tabTitle)}
        <EmptyState
          title={aiSteps.length ? c.noRuns : c.noAi}
          action={<Button variant="primary" onClick={() => ctx.go(aiSteps.length ? P.flowRuns(flow.id) : P.flow(flow.id))}>{aiSteps.length ? copy.flowRun.runs.crumb : copy.flowRun.screen.backToFlow}</Button>}
        >
          {aiSteps.length ? c.noRunsBody : c.noAiBody}
        </EmptyState>
      </div>
    );
  }

  const run = runs.find((r) => r.id === runUi) ?? runs.find((r) => r.caseId === '2418') ?? runs[0];
  const step: FlowStepSeed = aiSteps.find((s) => s.id === stepUi && run.path.includes(s.id)) ?? aiSteps.find((s) => run.path.includes(s.id)) ?? aiSteps[0];
  const cfg = currentConfig(flow, step, st);
  const baseCfg = configOf(flow, step, [st.activeOv]);
  const runCase = caseSeed(run.caseId);
  const th = cfg.type === 'classify' || cfg.type === 'ai' ? cfg.threshold : 90;
  const baseTh = baseCfg.type === 'classify' || baseCfg.type === 'ai' ? baseCfg.threshold : 90;
  const calibration = cfg.type === 'classify' || cfg.type === 'ai' ? cfg.calibration : [];
  const knowledge = cfg.type === 'classify' || cfg.type === 'ai' ? cfg.knowledge : [];

  /* ---------- the context the step had ---------- */
  const pages = runCase ? runCase.documents.reduce((n, d) => n + d.pages.length, 0) : 6;
  const docs = runCase ? runCase.documents.length : 2;
  const corrections = cfg.type === 'classify' ? cfg.corrections.reduce((n, k) => n + k.n, 0) : cfg.type === 'ai' ? cfg.corrections : 0;
  const k = (n: number) => c.weight(n);
  const unreadable = run.unreadable > 0;
  const cx = flow.id === 'pec' ? c.contextPec : c.contextGeneric;
  const context: ContextRow[] = [
    { id: 'input', source: cx.source.input, kind: 'mail', what: cx.what.input, weight: k(0.2), state: 'present' },
    { id: 'attachments', source: cx.source.attachments, kind: 'file', what: unreadable ? c.unreadableWhat : cx.what.attachments(docs, pages), weight: unreadable ? '-' : k(pages * 0.7), state: unreadable ? 'missing' : 'present' },
    { id: 'knowledge', source: cx.source.knowledge, kind: 'file', what: cx.what.knowledge(knowledge), weight: k(0.7 * Math.max(1, knowledge.length)), state: 'present' },
    { id: 'examples', source: cx.source.examples, kind: 'folder', what: cx.what.examples(Math.min(8, corrections)), weight: k(2.1), state: 'present' },
    { id: 'robot', source: cx.source.robot, kind: 'record', what: cx.what.robot, weight: '-', state: 'not-needed' },
  ];
  const totalK = context.reduce((n, r) => n + (r.weight === '-' ? 0 : Number(r.weight.replace(/[^0-9,.]/g, '').replace(',', '.'))), 0);

  /* ---------- the answer ---------- */
  const type = cfg.type === 'classify' ? cfg.types.find((t) => t.letter === run.type) ?? cfg.types[0] : undefined;
  const office = OFFICE_LABEL[runCase?.office ?? step.office ?? flow.office];
  const answerTitle = type ? c.answerTitle(`${type.letter} · ${type.name}`, office, run.confidence) : c.answerTitleGeneric(step.label, run.confidence);
  const replayTimes = replays[run.id] ?? DEFAULT_REPLAYS;
  const stepIndex = flow.steps.findIndex((s) => s.id === step.id);

  const counts = { fixed: 0, ai: 0, person: 0 };
  for (const s of flow.steps) {
    if (s.kind === 'ai' || s.kind === 'classify') counts.ai += 1;
    else if (s.kind === 'person') counts.person += 1;
    else counts.fixed += 1;
  }
  const pct = (n: number) => `${Math.round((n / Math.max(1, flow.steps.length)) * 100)}%`;

  const replayJob = toJobView(ctx.job(`replay:${flow.id}:${run.id}`));
  const replay = () => ctx.startJob({
    id: `replay:${flow.id}:${run.id}`,
    title: c.replayJob(replayTimes + 1),
    steps: c.replaySteps.map((label, i) => ({ label, ms: 450 + i * 200 })),
    onDone: (ok) => {
      if (!ok) return;
      setReplays((prev) => ({ ...prev, [run.id]: (prev[run.id] ?? DEFAULT_REPLAYS) + 1 }));
      ctx.log(c.logReplay(run.caseId), 'test', P.flowDecides(flow.id));
      ctx.toast({ tone: 'ok', title: c.replayDone, body: c.replayDoneBody(replayTimes + 1) });
    },
  });

  const edit = (n: number) => setSt((s) => ({ ...s, working: { ...s.working, [step.id]: { ...s.working[step.id], threshold: n } } }));

  return (
    <div className="flex h-full min-h-0 flex-col" data-step-kind={step.kind}>
      {header(c.crumb(run.caseId, step.label))}
      <DecidesPanel
        copy={copy}
        editable={editable}
        deniedTitle={ctx.deniedTitle('edit:structure')}
        job={replayJob}
        view={{
          // The run on show is always in the list, even when it is older than the 40 most recent (2418 arrived yesterday).
          runOptions: (runs.slice(0, 40).includes(run) ? runs.slice(0, 40) : [run, ...runs.slice(0, 40)]).map((r) => ({ value: r.id, label: `${r.caseId} · ${caseSeed(r.caseId)?.title ?? r.title}` })),
          runId: run.id,
          stepOptions: aiSteps.filter((s) => run.path.includes(s.id)).map((s) => ({ value: s.id, label: `${markerOf(flow, flow.steps.findIndex((x) => x.id === s.id))} · ${s.label}` })),
          stepId: step.id,
          context,
          complete: !unreadable,
          totalTokens: k(totalK),
          fixed: [
            { label: c.fixed.flowVersion, value: String(st.activeN || 1) },
            { label: c.fixed.model, value: c.fixed.modelValue },
            { label: c.fixed.temperature, value: c.fixed.temperatureValue },
            { label: c.fixed.instructions, value: c.fixed.instructionsValue(7 + stepIndex) },
            { label: c.fixed.answer, value: c.fixed.answerValue(cfg.type === 'classify' ? cfg.gives.length : cfg.type === 'ai' ? cfg.fields.length : 3) },
            { label: c.fixed.checkAfter, value: c.fixed.checkValue(cfg.type === 'classify' ? cfg.types.length : 0) },
          ],
          answer: { title: answerTitle, reason: type ? c.reasonText(type.name, run.confidence) : c.reasonGeneric(step.label) },
          replay: {
            times: replayTimes,
            type: type ? type.letter : step.label,
            typeOk: replayTimes,
            office,
            officeOk: replayTimes,
            confidence: `${Math.max(0, run.confidence - 1)}-${Math.min(100, run.confidence + 1)}%`,
          },
          share: [
            { label: c.shareFixed, value: pct(counts.fixed) },
            { label: c.shareAi, value: pct(counts.ai) },
            { label: c.sharePerson, value: pct(counts.person) },
          ],
          threshold: th,
          belowPct: belowPercent(calibration, th),
          thresholdChanged: th !== baseTh,
          onMissing: missing,
        }}
        handlers={{
          onRun: (id) => setRun(id),
          onStep: (id) => setStep(id),
          onReplay: replay,
          onThreshold: edit,
          onMissing: (v) => {
            setMissing(v);
            ctx.log(c.logMissing(flow.name), 'structure', P.flowDecides(flow.id));
          },
          onOpenRun: () => ctx.go(P.flowRun(flow.id, run.id)),
          onOpenStep: () => ctx.go(P.flowStep(flow.id, step.id)),
        }}
      />
    </div>
  );
}
