/**
 * One run of a flow (n11): the flow itself, drawn by the one canvas of a flow
 * with the run laid on it (the steps it went through, the case it took, the
 * step it is at), and when it stopped for an error, what the robot saw, what was tried and what to do about it.
 * The stopped run is `P.flowRun('pec', 'e-0412')`: the robot cannot enter
 * Halley after the change of the password. Riprova works once the password (allow-italian: quotes the Italian interface)
 * in the vault is new.
 */
import { ChevronLeft, ChevronRight, Hand, KeyRound, LifeBuoy, RotateCw, Bell, FolderOpen, SlidersHorizontal, Sparkles } from 'lucide-react';
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { STUCK_NOTICED, STUCK_PAGE } from '../../../../ui/fixtures/flowrun';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { FlowHeader, StepLayout } from '../../../../ui/flowrun/common';
import { FlowCanvas, StepDetail } from '../../../../ui/flows/FlowCanvas';
import { canvasOf, canvasSteps, originalStepId } from '../../../../ui/flows/canvasOf';
import { RunBanner, RunSide, type RunAction, type RunSideView } from '../../../../ui/flowrun/RunPanel';
import type { ScreenCtx } from '../../kit';
import { P } from '../../paths';
import { caseSeed } from '../../store/cases';
import {
  addMinutes, configOf, findRun, clockTime, liveRunsOf, stepTime, waitingWith, type RunOverride,
} from './data';
import { dressRun, originalsOf } from './run-canvas';
import { useFlowsSlice } from '../flow-build/actions';
import { findFlow, flowModelOf } from '../flow-build/model';
import { PasswordHost } from './password';
import { usePasswordDialog } from './password-state';
import { VIEWS, credentialOf, toJobView, useFlowSlice, useRunOverrides, viewPath } from './shared';
import { HALLEY_VAULT, vaultSlice } from '../../store/vault';
import { personDue, runDuration, statusText } from './runs-text';
import { resumeStopped } from './resume';

const heading = { error: 'red', blocked: 'red', running: 'blue', person: 'amber', done: 'green', archived: 'neutral' } as const;
const tagKind = { error: 'error', blocked: 'error', running: 'info', person: 'wait', done: 'ok', archived: 'info' } as const;

export function RunScreen({ ctx, flow, runId }: { ctx: ScreenCtx; flow: FlowSeed; runId: string }) {
  const copy = ctx.copy;
  const c = copy.flowRun.run;
  const [st] = useFlowSlice(ctx, flow);
  const [ov, setOv] = useRunOverrides(ctx);
  const [vault] = vaultSlice(ctx);
  const [, setPasswordOpen] = usePasswordDialog(ctx);
  const [flowsSlice] = useFlowsSlice(ctx);
  // The step shown in the right column in place of the run's own: kept by run, no address of its own.
  const [selectedStep, setSelectedStep] = ctx.ui<string | null>(`flowRun.${runId}.step`, null);
  const run = findRun(flow.id, runId, ov);
  const all = liveRunsOf(flow.id, ov);

  if (!run) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <FlowHeader copy={copy} flowName={flow.name} here={c.notFound} views={VIEWS} view="runs" onView={(v) => ctx.go(viewPath(flow.id, v))} onBack={() => ctx.go(P.flow(flow.id))} phone={ctx.phone} />
        <EmptyState title={c.notFound} action={<Button variant="primary" onClick={() => ctx.go(P.flowRuns(flow.id))}>{c.toRuns}</Button>}>{c.notFoundBody(runId)}</EmptyState>
      </div>
    );
  }

  const runCase = caseSeed(run.caseId);
  const stopStep = flow.steps.find((s) => s.id === run.stepId);
  const program = stopStep?.program ?? '';
  const robotCfg = stopStep ? configOf(flow, stopStep, [st.activeOv]) : undefined;
  const vaultRef = robotCfg?.type === 'robot' && robotCfg.program !== 'Halley' ? robotCfg.vault : HALLEY_VAULT;
  const credential = credentialOf(vault, vaultRef);
  const waiting = waitingWith(run, all);
  // The stopped run this one waits behind; none once someone took it over by hand (the robot is still to be fixed).
  const blocker = all.find((r) => r.status === 'error' && r.stepId === run.stepId);
  const stopped = run.status === 'error' || run.status === 'blocked';
  const canAct = ctx.can('edit:data');
  const actDenied = ctx.deniedTitle('edit:data');

  const patchRun = (id: string, fn: (o: RunOverride) => RunOverride) => setOv((prev) => ({ ...prev, [id]: fn(prev[id] ?? {}) }));
  const stamp = ctx.now.slice(0, 16).replace('T', ' ');

  /* ---------- times and attempts ---------- */
  // After a restart the run moved on: the stop, its attempts and who was told keep the robot's step and the time it stopped.
  const stopId = run.live.restartedStep ?? run.stepId;
  const stopIdx = Math.max(0, run.path.indexOf(stopId));
  const stopCfg = stopId === run.stepId ? robotCfg : (() => { const s = flow.steps.find((x) => x.id === stopId); return s ? configOf(flow, s, [st.activeOv]) : undefined; })();
  const everyMin = stopCfg?.type === 'robot' ? stopCfg.everyMin : 2;
  const { restartedAt: _restarted, ...beforeRestart } = run.live;
  const stopTime = stepTime({ ...run, live: beforeRestart }, flow, stopIdx);
  const attemptTimes = [
    ...Array.from({ length: Math.min(run.attempts, 3) }, (_, i) => clockTime(addMinutes(stopTime, i * everyMin))),
    ...(run.live.extraAttempts ?? []),
  ];
  const detectedAt = attemptTimes[Math.min(2, attemptTimes.length - 1)] ?? clockTime(stopTime);

  /* ---------- actions ---------- */
  const retry = (assumeValid: boolean) => {
    const ok = assumeValid || credential.state === 'valid';
    const targets = [run, ...waiting];
    ctx.startJob({
      id: `retry:${run.id}`,
      title: c.retryJob,
      steps: [
        { label: c.retrySteps[0], ms: 550 },
        { label: c.retrySteps[1], ms: 750, fails: !ok },
        { label: c.retrySteps[2], ms: 650 },
        { label: c.retrySteps[3], ms: 450 },
      ],
      onDone: (passed) => {
        const now = ctx.now;
        if (!passed) {
          patchRun(run.id, (o) => ({
            ...o,
            extraAttempts: [...(o.extraAttempts ?? []), clockTime(now)],
            events: [...(o.events ?? []), { at: clockTime(now), text: c.eventRetryFail(run.attempts + 1) }],
          }));
          ctx.log(c.logRetried(run.id, false), 'case', P.flowRun(flow.id, run.id));
          ctx.toast({ tone: 'error', title: c.retryFailedToast, body: c.retryFailedBody });
          return;
        }
        resumeStopped(ctx, flow.id, run.id, { run: c.eventRetryOk, freed: c.eventResumed(program) }, program);
        ctx.log(c.logRetried(run.id, true), 'case', P.flowRun(flow.id, run.id));
        ctx.notify({ title: c.retryDone, body: c.retryDoneBody(targets.length - 1), path: P.flowRun(flow.id, run.id), tone: 'ok' });
        ctx.toast({ tone: 'ok', title: c.retryDone, body: c.retryDoneBody(targets.length - 1), action: { label: c.openCase, path: runCase ? P.record(runCase.id) : P.flowRuns(flow.id) } });
      },
    });
  };

  const byHand = () => {
    patchRun(run.id, (o) => ({
      ...o,
      status: 'person',
      handedOver: true,
      events: [...(o.events ?? []), { at: clockTime(ctx.now), text: c.eventByHand }],
    }));
    ctx.log(c.logByHand(run.id), 'case', runCase ? P.record(runCase.id) : P.flowRun(flow.id, run.id));
    if (runCase) {
      ctx.updateCase(runCase.id, (live) => ({ ...live, events: [...(live.events ?? []), { at: stamp, who: ctx.persona.name, what: c.handOverBody(run.id) }] }));
      ctx.toast({ tone: 'info', title: c.handOver, body: c.handOverBody(run.id) });
      ctx.go(P.record(runCase.id));
    } else {
      ctx.toast({ tone: 'info', title: c.handOver, body: c.noCase });
    }
  };

  const notifyArmonia = () => {
    const when = clockTime(ctx.now);
    const already = (run.live.notified ?? []).some((n) => n.who === c.notifyWho);
    if (already) {
      ctx.toast({ tone: 'info', title: c.alreadyNotified(when) });
      return;
    }
    patchRun(run.id, (o) => ({
      ...o,
      notified: [...(o.notified ?? []), { who: c.notifyWho, when }],
      events: [...(o.events ?? []), { at: when, text: c.eventNotified }],
    }));
    ctx.log(c.logNotified(run.id), 'case', P.flowRun(flow.id, run.id));
    ctx.notify({ title: c.notifyTitle(run.id), body: c.notifyBody(flow.name), path: P.flowRun(flow.id, run.id), tone: 'warn' });
    ctx.toast({ tone: 'ok', title: c.notifiedToast, body: c.notifiedBody });
  };

  const support = () => ctx.confirm({
    title: c.supportConfirmTitle(program),
    body: c.supportConfirmBody(program),
    confirmLabel: c.supportSend,
    onConfirm: () => ctx.startJob({
      id: `support:${run.id}`,
      title: c.supportJob,
      steps: c.supportSteps.map((label, i) => ({ label, ms: 600 + i * 300 })),
      onDone: (ok) => {
        if (!ok) return;
        const when = clockTime(ctx.now);
        patchRun(run.id, (o) => ({
          ...o,
          notified: [...(o.notified ?? []), { who: c.supportWho(program), when }],
          events: [...(o.events ?? []), { at: when, text: c.eventSupport(program) }],
        }));
        ctx.log(c.logSupport(run.id, program), 'case', P.flowRun(flow.id, run.id));
        ctx.toast({ tone: 'ok', title: c.supportReceipt(program, when) });
      },
    }),
  });

  /* ---------- the steps ---------- */
  const finished = run.status === 'done' || run.status === 'archived';
  // The flow as its page draws it (all the cases side by side), with the run laid on it.
  const flowModel = flowModelOf(findFlow(flowsSlice, flow.id) ?? flow, flowsSlice.edits[flow.id] ?? [], copy);
  const base = canvasOf(flowModel, copy);
  const arrived = `${copy.flowRun.run.factsArrived} ${run.arrived.slice(8, 10)}/${run.arrived.slice(5, 7)} ${clockTime(run.arrived)}`;
  const canvas = dressRun({
    model: { ...base, trigger: { ...base.trigger, note: arrived } },
    flow,
    run,
    copy,
    originals: runCase ? originalsOf(runCase.documents, () => ctx.go(P.record(runCase.id))) : [],
  });
  const shown = selectedStep ? canvasSteps(canvas).find((s) => s.id === selectedStep) : undefined;

  /* ---------- the column on the right ---------- */
  const retryJob = toJobView(ctx.job(`retry:${run.id}`));
  const retrying = retryJob?.status === 'running';
  const act = (fn: () => void) => (retrying ? false : canAct ? fn : false) as (() => void) | false;
  const status = run.status;
  const actions: RunAction[] = [];
  if (status === 'error') {
    actions.push(
      { id: 'update', label: c.updateAndRetry, variant: 'primary', icon: KeyRound, onClick: ctx.can('edit:structure') && !retrying ? () => setPasswordOpen(true) : false, title: ctx.deniedTitle('edit:structure') },
      { id: 'retry', label: c.retry, variant: 'secondary', icon: RotateCw, onClick: act(() => retry(false)), title: actDenied },
      { id: 'hand', label: c.byHand, variant: 'secondary', icon: Hand, onClick: act(byHand), title: actDenied },
      { id: 'notify', label: c.notifyArmonia, variant: 'ghost', icon: Bell, onClick: act(notifyArmonia), title: actDenied },
      { id: 'support', label: c.writeSupport(program), variant: 'ghost', icon: LifeBuoy, onClick: act(support), title: actDenied },
    );
  } else if (status === 'blocked') {
    if (blocker) actions.push({ id: 'blocker', label: c.openBlocker(blocker.id), variant: 'primary', icon: Sparkles, onClick: () => ctx.go(P.flowRun(flow.id, blocker.id)) });
    actions.push({ id: 'hand', label: c.byHand, variant: 'secondary', icon: Hand, onClick: act(byHand), title: actDenied });
  }
  if (runCase) actions.push({ id: 'case', label: c.openCase, variant: status === 'person' || finished || status === 'running' ? 'primary' : 'ghost', icon: FolderOpen, onClick: () => ctx.go(P.record(runCase.id)) });
  if (flow.steps.some((s) => s.kind === 'ai' || s.kind === 'classify') && finished) {
    actions.push({ id: 'why', label: c.whyDecided, variant: 'ghost', icon: Sparkles, onClick: () => ctx.go(P.flowDecides(flow.id)) });
  }

  const duration = runDuration(ctx, run);
  const facts: NonNullable<RunSideView['facts']> = [
    { label: c.factsCase, value: runCase ? `${run.caseId} · ${runCase.title}` : run.caseId, onOpen: runCase ? () => ctx.go(P.record(runCase.id)) : undefined },
    { label: c.factsArrived, value: `${run.arrived.slice(8, 10)}/${run.arrived.slice(5, 7)} ${clockTime(run.arrived)}` },
    // Same time the runs list shows for a run that waited on a person overnight.
    ...(run.resumedAt ? [{ label: c.factsResumed, value: `${run.resumedAt.slice(8, 10)}/${run.resumedAt.slice(5, 7)} ${clockTime(run.resumedAt)}` }] : []),
    ...(run.type ? [{ label: c.factsType, value: run.type }] : []),
    { label: c.factsConfidence, value: `${run.confidence}%` },
    ...(run.protocol ? [{ label: c.factsProtocol, value: run.protocol }] : []),
    { label: c.factsDuration, value: duration.text },
  ];

  const stuckPage = stopped && status === 'error'
    ? {
      program: STUCK_PAGE.program, title: STUCK_PAGE.title, time: attemptTimes[0] ?? clockTime(stopTime),
      userLabel: copy.flowRun.robot.user, user: STUCK_PAGE.user, passwordLabel: copy.flowRun.robot.password, warning: STUCK_PAGE.warning, button: STUCK_PAGE.button,
    }
    : undefined;

  const initialNotified = status === 'error' || (run.baseStatus === 'error')
    ? STUCK_NOTICED.map((n) => ({ who: n.who, when: n.how === 'subito' ? detectedAt : `${detectedAt}, ${n.how}` }))
    : [];

  // The title and the chip already say it waits for a person: the body says who, and by when.
  const personBody = (office: string, due: { time: string; day?: string; late: boolean }) => (due.late ? c.body.personLate : c.body.person)(office, due.time, due.day);
  const side: RunSideView = {
    tag: { label: c.tag[status], tone: heading[status], kind: tagKind[status] },
    title: status === 'error' ? c.title.error(program) : status === 'blocked' ? c.title.blocked(program) : c.title[status],
    body: status === 'error'
      ? c.body.error(attemptTimes[0] ?? clockTime(stopTime))
      : status === 'blocked'
        ? blocker ? c.body.blocked(program, blocker.id) : c.body.blockedAlone(program)
        : status === 'person'
          ? personBody(OFFICE_LABEL[stopStep?.office ?? flow.office], personDue(ctx, flow, run, st.activeOv))
          : status === 'done'
            ? c.body.done(duration.text)
            : status === 'running' ? c.body.running : c.body.archived,
    page: stuckPage,
    attempts: status === 'error' ? { label: c.attempts, times: attemptTimes.join(' · '), same: c.attemptsSame, causeLabel: c.probableCause, cause: c.cause } : undefined,
    facts,
    actions,
    notified: [...initialNotified, ...(run.live.notified ?? [])],
    job: retryJob,
    log: (run.live.events ?? []).map((e) => ({ at: e.at, text: e.text })),
  };

  /* ---------- neighbours in the list ---------- */
  const at = all.findIndex((r) => r.id === run.id);
  const newer = at > 0 ? all[at - 1] : undefined;
  const older = at >= 0 && at < all.length - 1 ? all[at + 1] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FlowHeader
        copy={copy}
        flowName={flow.name}
        here={c.crumb(run.caseId)}
        status={stopped ? <Chip tone="red" strong>{status === 'error' ? c.stateStopped(program) : c.stateWaiting(program)}</Chip> : <Chip tone={heading[status]}>{statusText(ctx, flow, run, st.activeOv)}</Chip>}
        detail={stopped ? c.stateAt(detectedAt) : undefined}
        views={VIEWS}
        view="runs"
        onView={(v) => ctx.go(viewPath(flow.id, v))}
        onBack={() => ctx.go(P.flowRuns(flow.id))}
        phone={ctx.phone}
      >
        <Button icon={ChevronLeft} onClick={older ? () => ctx.go(P.flowRun(flow.id, older.id)) : false} title={older ? undefined : c.noOlder}>{older ? c.prev(older.caseId) : c.prev('-')}</Button>
        <Button onClick={newer ? () => ctx.go(P.flowRun(flow.id, newer.id)) : false} title={newer ? undefined : c.noNewer}>
          {newer ? c.next(newer.caseId) : c.next('-')}<ChevronRight size={14} aria-hidden="true" />
        </Button>
      </FlowHeader>
      <StepLayout
        fill
        asideWidth={400}
        aside={(
          <>
            {/* The step pressed comes first; what to do about the run stays under it, never replaced. */}
            {shown && (
              <div className="border-b border-app-border">
                <StepDetail step={shown} copy={copy} onClose={() => setSelectedStep(null)}>
                  <Button icon={SlidersHorizontal} onClick={() => ctx.go(P.flowStep(flow.id, originalStepId(flowModel, shown.id)))} className="w-full">{copy.flowBuild.toast.openStep}</Button>
                </StepDetail>
              </div>
            )}
            <RunSide copy={copy} view={side} />
          </>
        )}
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {status === 'error' && waiting.length > 0 && (
            <RunBanner
              strong={c.bannerStrong(waiting.length)}
              rest={c.bannerRest(program)}
              actionLabel={c.retryAll}
              onAction={act(() => retry(false))}
            />
          )}
          {status === 'blocked' && (
            <RunBanner
              tone="red"
              strong={blocker ? c.waitsStrong : c.title.blocked(program)}
              rest={blocker ? c.waitsRest(blocker.id) : c.waitsAlone(program)}
              actionLabel={blocker ? c.openStopped : undefined}
              onAction={blocker ? () => ctx.go(P.flowRun(flow.id, blocker.id)) : undefined}
            />
          )}
          <FlowCanvas
            model={canvas}
            mode="run"
            copy={copy}
            phone={ctx.phone}
            selectedId={shown?.id}
            onStep={(id) => setSelectedStep(id === selectedStep ? null : id)}
          />
        </div>
      </StepLayout>
      {stopStep?.program && (
        <PasswordHost ctx={ctx} program={program} user={STUCK_PAGE.user} vault={vaultRef} onSaved={() => retry(true)} />
      )}
    </div>
  );
}
