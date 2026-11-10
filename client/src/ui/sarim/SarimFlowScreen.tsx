import { CheckCircle2, Play } from 'lucide-react';
import { SegmentedControl } from '../../components/Shared/Segmented';
import type { UiCopy } from '../copy/types';
import type { Action } from '../types';
import { Button } from '../primitives/Button';
import { Chip } from '../primitives/Chip';
import { PaneHeader } from '../shell/PaneHeader';
import { CollectedDataPanel } from '../flows/FlowsScreen';
import { FlowCanvas } from '../flows/FlowCanvas';
import { canvasOf, originalStepId } from '../flows/canvasOf';
import type { CollectedDataModel, FlowModel, FlowView } from '../flows/model';

const VIEWS: FlowView[] = ['steps', 'byOffice', 'runs', 'tests', 'versions', 'log'];

/**
 * A SARIM flow (w07), drawn by the one canvas of a flow: what starts it, the
 * steps every report takes, then one lane per type of report side by side with
 * all its steps, and a last step that runs whatever the type. A flow without a
 * branch (`branch` has no paths) is the same column of steps. The side panel
 * lists what the flow collects. The other views and the panel belong to the
 * container.
 */
export function SarimFlowScreen({ flow, after, collected, copy, view = 'steps', onViewChange, onTry, tryTitle, onOpenView, phone }: {
  flow: FlowModel;
  /** The step after the branch, for every type: `marker` and its words. */
  after?: { marker: string; title: string };
  collected: CollectedDataModel;
  copy: UiCopy;
  view?: FlowView;
  onViewChange: (view: FlowView) => void;
  onTry?: Action;
  tryTitle?: string;
  /** Called with the step id for steps that open a place (the call center). */
  onOpenView: (stepId: string) => void;
  phone?: boolean;
}) {
  const f = copy.flows;
  const controls = (
    <>
      <SegmentedControl value={view} onChange={onViewChange} ariaLabel={f.viewsLabel} options={VIEWS.map((v) => ({ value: v, label: f.views[v] }))} />
      <Button icon={Play} onClick={onTry} title={tryTitle}>{f.tryIt}</Button>
    </>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader crumbs={flow.crumbs} status={<Chip tone={flow.status.tone} icon={CheckCircle2}>{flow.status.text}</Chip>}>
        {!phone && controls}
      </PaneHeader>
      {phone && <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-app-border px-4 py-2">{controls}</div>}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <div className="min-w-0 flex-1 py-4 pl-3 pr-4 md:overflow-y-auto">
          <FlowCanvas
            model={canvasOf(flow, copy, { after: after && { ...after, badge: copy.orgs.sarim.always } })}
            mode="edit"
            copy={copy}
            phone={phone}
            onOpenView={(id) => onOpenView(originalStepId(flow, id))}
          />
        </div>
        <div className="max-md:[&>aside]:!w-full max-md:[&>aside]:border-l-0 max-md:[&>aside]:border-t md:flex md:h-full">
          <CollectedDataPanel data={collected} />
        </div>
      </div>
    </div>
  );
}
