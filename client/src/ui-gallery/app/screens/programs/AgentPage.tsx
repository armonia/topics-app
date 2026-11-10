import { PcAgentScreen } from '../../../../ui/programs/PcAgentScreen';
import type { AgentStepModel, FrameModel, PcAgentModel } from '../../../../ui/programs/model';
import { AGENT_STEPS, AGENT_TASK, INVOICES, programSeed } from '../../../../ui/fixtures/programs';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { INITIAL_PROGRAMS, type AgentRun } from './state';
import { clock, withDefaults } from './derive';
import { accountingMask, invoiceAt } from './masks';
import { jobView } from './util';

const STEP_JOB = 'programs.agent.step';
const ALL_JOB = 'programs.agent.all';
const TOTAL = AGENT_STEPS.length;

/** p02: the agent on the accounting PC, live, run by hand a step at a time or all at once. */
export function PcAgentPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.programs;
  const a = c.agent;
  const [slice, update] = ctx.slice('programs', INITIAL_PROGRAMS);
  const st = withDefaults(slice);
  const run = st.agent;
  const [view, setView] = ctx.ui<number | null>('programs.agent.view', null);
  const setRun = (fn: (r: AgentRun) => AgentRun) => update((prev) => {
    const s = withDefaults(prev);
    return { ...s, agent: fn(s.agent) };
  });
  const program = programSeed(AGENT_TASK.program);
  const invoice = invoiceAt(run.invoice);
  const shown = view ?? run.cursor;
  const now = clock(ctx.now);
  const pc = AGENT_TASK.pc;

  const finish = (r: AgentRun): AgentRun => ({ ...r, cursor: TOTAL, status: 'done', registered: r.registered + 1 });
  const stepJob = ctx.job(STEP_JOB);
  const allJob = ctx.job(ALL_JOB);
  const job = jobView(stepJob?.status === 'running' ? stepJob : allJob?.status === 'running' ? allJob : stepJob ?? allJob);

  const runStep = () => {
    const step = AGENT_STEPS[run.cursor];
    if (!step) return;
    setView(null);
    ctx.startJob({
      id: STEP_JOB,
      title: a.jobStep(step.label),
      steps: a.jobSteps.map((label) => ({ label, ms: 500 })),
      onDone: () => {
        setRun((r) => {
          const next = { ...r, cursor: r.cursor + 1, times: [...r.times, now] };
          return next.cursor >= TOTAL ? finish(next) : next;
        });
        ctx.log(a.log.step(pc, step.label), 'structure', P.pcAgent());
        if (run.cursor + 1 >= TOTAL) {
          ctx.toast({ tone: 'ok', title: a.toastDone, body: a.banner.done(invoice.vatProtocol) });
          ctx.log(a.log.done(pc, invoice.vatProtocol), 'structure', P.pcAgent());
        }
      },
    });
  };

  const runAll = () => {
    const todo = AGENT_STEPS.slice(run.cursor);
    if (!todo.length) return;
    setView(null);
    ctx.startJob({
      id: ALL_JOB,
      title: a.jobAll,
      steps: todo.map((s) => ({ label: s.label, ms: 600 })),
      onDone: () => {
        setRun((r) => finish({ ...r, times: [...r.times, ...Array(Math.max(0, TOTAL - r.cursor)).fill(now)] }));
        ctx.toast({ tone: 'ok', title: a.toastDone, body: a.banner.done(invoice.vatProtocol) });
        ctx.log(a.log.done(pc, invoice.vatProtocol), 'structure', P.pcAgent());
      },
    });
  };

  const pause = (why: AgentRun['why']) => {
    setRun((r) => ({ ...r, status: 'paused', why }));
    ctx.log(a.log.paused(pc, why === 'person' ? a.whyPerson : why === 'control' ? a.whyControl : a.whyManual), 'structure', P.pcAgent());
  };
  const resume = () => {
    setRun((r) => ({ ...r, status: 'live', why: undefined, personAtPc: false }));
    ctx.log(a.log.resumed(pc), 'structure', P.pcAgent());
    ctx.toast({ tone: 'ok', title: a.toastResumed });
  };

  const steps: AgentStepModel[] = AGENT_STEPS.map((s, i) => ({
    id: s.id,
    label: s.label,
    state: i < run.cursor ? 'done' : i === run.cursor ? 'current' : 'todo',
    at: run.times[i],
  }));

  const frames: FrameModel[] = AGENT_STEPS.map((s, i) => ({
    id: `f${i + 1}`,
    fields: Math.min(4, 1 + i),
    label: i < run.cursor ? a.frameLabel(run.times[i] ?? now, s.short) : a.frameFuture(s.short),
    future: i >= run.cursor,
  })).filter((_, i) => i < run.cursor || i <= run.cursor + 1);

  const status = run.status;
  const liveTone = status === 'live' ? 'red' : status === 'paused' ? 'amber' : status === 'done' ? 'green' : 'neutral';
  const banner: PcAgentModel['banner'] = status === 'paused'
    ? { tone: 'amber', text: run.why === 'person' ? a.banner.pausedPerson : run.why === 'control' ? a.banner.pausedControl : a.banner.paused }
    : status === 'stopped'
      ? { tone: 'neutral', text: a.banner.stopped }
      : status === 'done'
        ? { tone: 'green', text: a.banner.done(invoice.vatProtocol) }
        : undefined;

  const model: PcAgentModel = {
    crumbs: [{ label: a.crumb(pc) }],
    live: { tone: liveTone, text: a.live[status] },
    mask: accountingMask(shown, invoice, shown >= TOTAL ? a.registered(invoice.vatProtocol) : undefined),
    task: { title: invoice.title, description: AGENT_TASK.description },
    steps,
    checks: [
      { label: AGENT_TASK.checks[0].label, value: invoice.total, ok: true },
      { label: a.ruleStop, value: a.ruleStopValue },
      { label: a.rulePause, value: a.rulePauseValue },
    ],
    queue: [
      { label: AGENT_TASK.queue.label, value: String(AGENT_TASK.queue.total - run.registered) },
      { label: a.avgTime, value: AGENT_TASK.queue.avgTime },
    ],
    frames,
    banner,
  };

  const reviewing = view !== null && view !== run.cursor ? (run.times[view - 1] ?? now) : undefined;
  const edit = (fn: () => void) => ctx.allow('edit:structure', fn);
  return (
    <PcAgentScreen
      copy={ctx.copy}
      model={model}
      status={status}
      reviewing={reviewing}
      backLabel={program?.name ?? ''}
      onBack={() => ctx.go(P.program(AGENT_TASK.program))}
      onTakeOver={edit(() => {
        setRun((r) => ({ ...r, status: r.status === 'stopped' ? r.status : 'paused', why: 'control' }));
        update((prev) => {
          const s = withDefaults(prev);
          return s.remote.status === 'live' ? s : { ...s, remote: { ...s.remote, status: 'idle', pc, reason: 'ts-agent', password: '' } };
        });
        ctx.log(a.log.paused(pc, a.whyControl), 'access', P.pcAgent());
        ctx.go(P.remoteControl());
      })}
      onStop={edit(() => ctx.confirm({
        title: a.stopConfirmTitle(pc),
        body: a.stopConfirmBody,
        confirmLabel: a.stopConfirm,
        tone: 'danger',
        onConfirm: () => {
          setRun((r) => ({ ...r, status: 'stopped' }));
          ctx.log(a.log.stopped(pc), 'structure', P.pcAgent());
          ctx.toast({ tone: 'warn', title: a.toastStopped(pc) });
        },
      }))}
      onRunStep={edit(runStep)}
      onRunAll={edit(runAll)}
      onPause={edit(() => {
        pause('manual');
        ctx.toast({ tone: 'info', title: a.toastPaused });
      })}
      onResume={edit(resume)}
      onRestart={edit(() => {
        setRun((r) => ({ ...r, status: 'live', why: undefined }));
        ctx.log(a.log.restarted(pc), 'structure', P.pcAgent());
        ctx.toast({ tone: 'ok', title: a.toastResumed });
      })}
      onNext={edit(() => {
        setView(null);
        setRun((r) => ({ ...r, cursor: 0, times: [], invoice: (r.invoice + 1) % INVOICES.length, status: 'live', why: undefined }));
      })}
      personAtPc={run.personAtPc}
      onPersonAtPc={(v) => {
        setRun((r) => ({ ...r, personAtPc: v, ...(v ? { status: r.status === 'live' ? 'paused' as const : r.status, why: r.status === 'live' ? 'person' as const : r.why } : { status: r.status === 'paused' && r.why === 'person' ? 'live' as const : r.status, why: r.why === 'person' ? undefined : r.why }) }));
        ctx.log(v ? a.log.paused(pc, a.whyPerson) : a.log.resumed(pc), 'structure', P.pcAgent());
      }}
      job={job}
      onFrame={(id) => setView(Number(id.slice(1)))}
      viewingId={view === null ? undefined : `f${view}`}
      onLive={() => setView(null)}
      deniedTitle={ctx.deniedTitle('edit:structure')}
      phone={ctx.phone}
    />
  );
}
