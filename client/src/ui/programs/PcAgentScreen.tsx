import { Check, Circle, Eye, Hand, Pause, Play, PlayCircle, RotateCcw, SkipForward, Square } from 'lucide-react';
import clsx from 'clsx';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { TONE_CHIP, TONE_TEXT } from '../tone';
import { Button } from '../primitives/Button';
import { Toggle } from '../primitives/Field';
import { PanelHeading, PanelSection, SidePanel } from '../primitives/Panel';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { FOCUS_RING } from '../shell/pressable';
import { DesktopFrame, MaskWindow } from './DesktopFrame';
import type { AgentStepModel, FrameModel, JobViewModel, PcAgentModel } from './model';
import { JobProgress } from './Shared';

export type AgentRunStatus = 'live' | 'paused' | 'stopped' | 'done';

function StepRow({ step, nowLabel }: { step: AgentStepModel; nowLabel: string }) {
  return (
    <li className="flex min-h-7 items-center gap-2 text-prose leading-5">
      {step.state === 'done' && <Check size={14} className="shrink-0 text-app-text" aria-hidden="true" />}
      {step.state === 'current' && <span className="mx-[3px] h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-fuchsia-600" aria-hidden="true" />}
      {step.state === 'todo' && <Circle size={14} className="shrink-0 text-app-text-faint" aria-hidden="true" />}
      <span className={clsx('min-w-0', step.state === 'current' ? TONE_TEXT.pink : step.state === 'todo' ? 'text-app-text-tertiary' : 'text-app-text')}>{step.label}</span>
      <span className={clsx('ml-auto shrink-0 tabular-nums text-compact', step.state === 'current' ? TONE_TEXT.pink : 'text-app-text-tertiary')}>
        {step.state === 'current' ? nowLabel : step.at}
      </span>
    </li>
  );
}

/** The small picture of what the screen looked like at one step. */
function Thumb({ frame, pressed, onPress, labelText }: { frame: FrameModel; pressed: boolean; onPress?: Action; labelText: string }) {
  const body = (
    <>
      {frame.future ? (
        <span className="flex h-[74px] items-center justify-center rounded-md border border-dashed border-app-border-light px-2 text-center text-mini text-app-text-tertiary">{labelText}</span>
      ) : (
        <span className="block h-[74px] overflow-hidden rounded-md border border-app-border bg-white" aria-hidden="true">
          <span className="block h-3.5 bg-teal-700" />
          <span className="block space-y-1.5 px-2 pt-2">
            {Array.from({ length: frame.fields }, (_, i) => <span key={i} className="block h-2.5 rounded-sm border border-neutral-300 bg-neutral-50" />)}
          </span>
        </span>
      )}
      {!frame.future && <span className="mt-1.5 block truncate text-compact text-app-text-secondary">{labelText}</span>}
    </>
  );
  const cls = 'w-[148px] shrink-0 rounded-lg border border-app-border bg-surface p-1.5 text-left';
  if (frame.future || onPress === undefined) return <div className={clsx(cls, frame.future && 'border-transparent bg-transparent p-0')}>{body}</div>;
  return (
    <button type="button" aria-pressed={pressed} onClick={onPress || undefined} className={clsx(cls, 'transition-colors hover:bg-app-hover', FOCUS_RING, pressed && 'border-primary')}>
      {body}
    </button>
  );
}

/**
 * The agent working on a PC, live (p02): what it sees (a drawn window of the
 * program with the field it is typing in lit), the steps it takes, the
 * checks it keeps and what waits for it. The reader can run it a step at a
 * time or all at once, pause it, stop it or take the PC over. Handlers are
 * the container's; the frames under the screen replay what it did.
 */
export function PcAgentScreen({
  copy, model, status, reviewing, backLabel, onBack, onTakeOver, onStop, onRunStep, onRunAll, onPause, onResume, onRestart, onNext,
  personAtPc, onPersonAtPc, job, onFrame, viewingId, onLive, deniedTitle, phone,
}: {
  copy: UiCopy;
  model: PcAgentModel;
  status: AgentRunStatus;
  reviewing?: string;
  backLabel: string;
  onBack: () => void;
  onTakeOver: Action;
  onStop: Action;
  onRunStep: Action;
  onRunAll: Action;
  onPause: Action;
  onResume: Action;
  onRestart: Action;
  onNext: Action;
  personAtPc: boolean;
  onPersonAtPc: (v: boolean) => void;
  job?: JobViewModel;
  onFrame: (id: string) => void;
  viewingId?: string;
  onLive: () => void;
  /** Why the controls are off for this person, when they are. */
  deniedTitle?: string;
  phone?: boolean;
}) {
  const a = copy.programs.agent;
  const busy = job?.status === 'running';
  const running = status === 'live';
  const main = (
    <div className="min-w-0 flex-1 overflow-y-auto p-4">
      <DesktopFrame taskbarLeft={model.mask.taskbarLeft} taskbarRight={model.mask.taskbarRight} minHeight={phone ? 360 : 460}>
        <MaskWindow mask={model.mask} width={phone ? 520 : 720} />
      </DesktopFrame>
      {(reviewing || model.banner) && (
        <div className={clsx('mt-3 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-prose', TONE_CHIP[reviewing ? 'blue' : model.banner?.tone ?? 'neutral'])} role="status">
          {reviewing ? <Eye size={14} aria-hidden="true" /> : <Hand size={14} aria-hidden="true" />}
          <span className="min-w-0 flex-1">{reviewing ? a.reviewing(reviewing) : model.banner?.text}</span>
          {reviewing && <Button size="sm" icon={PlayCircle} onClick={onLive}>{a.backToLive}</Button>}
        </div>
      )}
      <div className="mt-3 flex gap-2.5 overflow-x-auto pb-1" role="group" aria-label={a.frames}>
        {model.frames.map((f) => (
          <Thumb key={f.id} frame={f} pressed={viewingId === f.id} onPress={f.future ? undefined : () => onFrame(f.id)} labelText={f.label} />
        ))}
      </div>
    </div>
  );
  const side = (
    <>
      <PanelHeading tag={a.tag} title={model.task.title}>{model.task.description}</PanelHeading>
      <PanelSection label={a.sections.steps}>
        <ul>{model.steps.map((s) => <StepRow key={s.id} step={s} nowLabel={a.now} />)}</ul>
        <div className="mt-3 flex flex-wrap gap-2">
          {running && !busy && (
            <>
              <Button variant="primary" icon={SkipForward} onClick={onRunStep} title={deniedTitle}>{a.runStep}</Button>
              <Button icon={Play} onClick={onRunAll} title={deniedTitle}>{a.runAll}</Button>
              <Button icon={Pause} onClick={onPause} title={deniedTitle}>{a.pause}</Button>
            </>
          )}
          {status === 'paused' && <Button variant="primary" icon={Play} onClick={onResume} title={deniedTitle}>{a.resume}</Button>}
          {status === 'stopped' && <Button variant="primary" icon={RotateCcw} onClick={onRestart} title={deniedTitle}>{a.restart}</Button>}
          {status === 'done' && <Button variant="primary" icon={SkipForward} onClick={onNext} title={deniedTitle}>{a.nextInQueue}</Button>}
        </div>
        {job && <JobProgress job={job} copy={copy} className="mt-3" />}
      </PanelSection>
      <PanelSection label={a.sections.checks}>
        {model.checks.map((r) => (
          <div key={r.label} className="flex min-h-7 items-center gap-2 py-0.5 text-prose leading-5">
            <span className="min-w-0 text-app-text">{r.label}</span>
            <span className={clsx('ml-auto flex shrink-0 items-center gap-1 text-right', r.ok ? TONE_TEXT.green : 'font-semibold text-app-text')}>
              {r.value}
              {r.ok && <Check size={13} aria-hidden="true" />}
            </span>
          </div>
        ))}
        <div className="mt-2 border-t border-app-border pt-2">
          <Toggle
            checked={personAtPc}
            onChange={onPersonAtPc}
            label={a.personAtPc}
            description={personAtPc ? a.personAtPcOn : a.personAtPcOff}
          />
        </div>
      </PanelSection>
      <PanelSection label={a.sections.queue} className="border-b-0">
        {model.queue.map((r) => (
          <div key={r.label} className="flex min-h-7 items-center gap-2 py-0.5 text-prose leading-5">
            <span className="min-w-0 text-app-text">{r.label}</span>
            <span className="ml-auto shrink-0 font-semibold tabular-nums text-app-text">{r.value}</span>
          </div>
        ))}
      </PanelSection>
    </>
  );
  const actions = (
    <>
      <Button onClick={onTakeOver} icon={Hand} title={deniedTitle}>{a.takeOver}</Button>
      {status !== 'stopped' && <Button variant="danger" icon={Square} onClick={onStop} title={deniedTitle} className="bg-rose-500/10">{a.stop}</Button>}
    </>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader
        leading={<BackButton label={backLabel} onClick={onBack} copy={copy} />}
        crumbs={model.crumbs}
        status={<span className={clsx('inline-flex h-5 items-center gap-1 rounded-full px-2 text-mini', TONE_CHIP[model.live.tone])}>{status === 'live' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}{model.live.text}</span>}
      >
        {!phone && actions}
      </PaneHeader>
      {phone && <div className="flex shrink-0 flex-wrap gap-2 border-b border-app-border px-4 py-2">{actions}</div>}
      {phone ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {main}
          <div className="border-t border-app-border bg-surface">{side}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {main}
          <SidePanel width={360}>{side}</SidePanel>
        </div>
      )}
    </div>
  );
}
