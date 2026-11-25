import type { ReactNode } from 'react';
import { CirclePause, Inbox, Pause, Play } from 'lucide-react';
import type { UiCopy } from '../copy/types';
import { Button } from '../primitives/Button';
import { ProgressBar } from '../primitives/Progress';
import { BackButton, PaneHeader } from '../shell/PaneHeader';
import { ScrollFade } from '../primitives/ScrollFade';
import type { CrumbModel } from '../types';
import { FlowCanvas } from '../flows/FlowCanvas';
import type { FlowCanvasModel } from '../flows/model';
import { FlowStateChip } from './WorkParts';
import type { FlowControlsModel, FlowJobModel, FlowStatusModel } from './work-model';

/**
 * A ORBIT flow page: the header opens the flow in the list of cards, tries
 * it on yesterday's cases and pauses it; the body is the one drawing of a flow (`FlowCanvas`, edit mode)
 * fed with the live cards at each step, and `side` the facts on the right. Where the flow splits
 * by case the lanes stand side by side inside the drawing, so the page never scrolls sideways.
 */
export function OpsFlowScreen({ name, outcome, status, version, onBack, controls, banner, job, canvas, onStep, side, copy, phone, crumbs }: {
  name: string;
  /** What the flow hands over, a quiet line under the header when the flow has one. */
  outcome?: string;
  status: FlowStatusModel;
  /** Printed in the state chip, `Attivo · v2`, as on the flow pages of Topics. (allow-italian: quotes the Italian interface) */
  version?: number;
  onBack: () => void;
  controls: FlowControlsModel;
  /** Shown over the steps while the flow is paused. */
  banner?: string;
  /** The try on yesterday's cases while it runs. */
  job?: FlowJobModel;
  /** The flow as the canvas draws it: trigger, steps with their cards, lanes. */
  canvas: FlowCanvasModel;
  /** A step of the trunk or of a lane was pressed. */
  onStep: (stepId: string, laneId?: string) => void;
  side: ReactNode;
  copy: UiCopy;
  phone?: boolean;
  /** Replaces the built-in crumbs when given. */
  crumbs?: CrumbModel[];
}) {
  const f = copy.orbitWork.flows;
  const buttons = (
    <>
      <Button icon={Inbox} onClick={controls.onOpenInDaFare}>{f.openInDaFare}</Button>
      <Button icon={Play} onClick={controls.onTry} title={controls.tryTitle}>{f.tryYesterday}</Button>
      <Button icon={controls.paused ? Play : Pause} variant={controls.paused ? 'primary' : 'secondary'} onClick={controls.onPause} title={controls.pauseTitle}>
        {controls.paused ? f.resume : f.pause}
      </Button>
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        leading={<BackButton label={f.back} onClick={onBack} copy={copy} />}
        crumbs={crumbs ?? [{ label: f.org }, { label: f.title }, { label: name }]}
        status={<FlowStateChip status={status} version={version} />}
      >
        {!phone && buttons}
      </PaneHeader>
      {outcome && <p className="shrink-0 border-b border-app-border px-4 py-1.5 text-compact leading-5 text-app-text-tertiary">{outcome}</p>}
      {phone && <ScrollFade className="flex shrink-0 items-center gap-2 border-b border-app-border px-4 py-2">{buttons}</ScrollFade>}
      {banner && (
        <div role="status" className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/[0.08] px-4 py-2 text-prose text-amber-800 dark:text-amber-300">
          <CirclePause size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0">{banner}</span>
        </div>
      )}
      {job && (
        <div className="shrink-0 border-b border-app-border px-4 py-2.5">
          <ProgressBar value={job.value} label={job.label} detail={job.detail} />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <div className="min-w-0 flex-1 py-4 pl-3 pr-4 md:overflow-y-auto">
          <FlowCanvas model={canvas} mode="edit" copy={copy} phone={phone} onStep={onStep} />
        </div>
        <div className="max-md:[&>aside]:!h-auto max-md:[&>aside]:!w-full max-md:[&>aside]:border-l-0 max-md:[&>aside]:border-t md:flex md:h-full">
          {side}
        </div>
      </div>
    </div>
  );
}
