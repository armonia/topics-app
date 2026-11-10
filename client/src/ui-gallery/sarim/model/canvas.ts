/**
 * A flow of this edition as the one drawing of a flow (`FlowCanvas`) reads
 * it: the trigger, the steps in order, and where the flow splits by case
 * (`world().flowSplits`) the lanes side by side in place of the step each case
 * does its own way. The flow page, the card that reads its flow and any other
 * place build it here, and dress it (states, who and when, live cards) with
 * the callbacks of `OpsCanvasDress`, so the drawing is one and the same.
 */
import type { UiCopy } from '../../../ui/copy/types';
import type { ActorModel, CanvasActor, CanvasLane, CanvasNode, CanvasStep, FlowCanvasModel } from '../../../ui/flows/model';
import type { OpsFlow, OpsFlowStep } from '../../../ui/fixtures/sarim-org/types';
import type { FlowSplitDef, FlowSplitLane } from '../../../ui/fixtures/world-types';
import { agentById, world } from '../world';
import { stepActor } from './who';

/** The split of a flow, when it has one in this world. */
export function splitOf(flowId: string): FlowSplitDef | undefined {
  return world().flowSplits.find((s) => s.flow === flowId);
}

/** The id the canvas gives a lane step: unique across the lanes, whose own ids repeat (`a`, `b`). */
export const laneStepId = (laneId: string, stepId: string) => `${laneId}-${stepId}`;

/** Who does a step of a lane, in the words of this edition: an agent by name, a rule, a program. */
function laneActor(actor: ActorModel, copy: UiCopy, agent?: string): CanvasActor {
  switch (actor.kind) {
    case 'rule': return { kind: 'rule', label: copy.sarimWork.flows.rule };
    case 'ai': return { kind: 'agent', name: actor.name ?? agent ?? copy.common.ai };
    case 'person': return { kind: 'person', name: actor.name ?? copy.flows.person };
    case 'program': return { kind: 'program', name: actor.name ?? '' };
    case 'action': return { kind: 'action', name: actor.name ?? copy.flowBuild.actionActor };
    case 'trigger': return { kind: 'action', name: copy.flows.trigger };
  }
}

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export interface OpsCanvasDress {
  /** The line under the trigger (the volume, on the flow page). */
  triggerNote?: string;
  step?: (step: OpsFlowStep, index: number) => Partial<CanvasStep>;
  laneStep?: (lane: FlowSplitLane, step: CanvasStep, index: number) => Partial<CanvasStep>;
  lane?: (lane: FlowSplitLane) => Partial<CanvasLane>;
  /** Read: the case on show has reached the split. */
  reached?: boolean;
}

/**
 * The canvas of a flow. A step numbered as everywhere else in the edition (its
 * place in `flow.steps`), the split numbered as the step it stands for. A lane
 * step that repeats a step of the flow word for word is that step: it takes
 * its doer, so the same work is not an agent on one side and a rule on the
 * other.
 */
export function opsCanvas(flow: OpsFlow, copy: UiCopy, dress: OpsCanvasDress = {}): FlowCanvasModel {
  const split = splitOf(flow.id);
  const agent = split ? agentById(split.agent)?.name : undefined;
  const stages = world().stages;
  const nodes: CanvasNode[] = flow.steps.map((s, i): CanvasNode => {
    if (split && s.id === split.step) {
      return {
        kind: 'split',
        id: `split-${s.id}`,
        marker: String(i + 1),
        by: split.by,
        reached: dress.reached,
        lanes: split.lanes.map((l): CanvasLane => ({
          id: l.id,
          letter: l.letter,
          kind: l.kind,
          title: l.title,
          hint: l.hint,
          badge: l.badge,
          meta: l.meta,
          handoff: l.handoff,
          steps: (l.steps ?? []).map((ls, j) => {
            const same = flow.steps.find((x) => x.title === ls.title);
            const base: CanvasStep = {
              id: laneStepId(l.id, ls.id),
              marker: ls.marker,
              actors: same ? [stepActor(same.actor, copy)] : ls.actors.map((a) => laneActor(a, copy, agent)),
              title: ls.title,
              note: ls.note,
              uses: ls.uses,
              produces: ls.produces,
              opens: ls.opens,
              due: ls.due,
            };
            return { ...base, ...dress.laneStep?.(l, base, j) };
          }),
          ...dress.lane?.(l),
        })),
      };
    }
    const data = world().stepData[flow.id]?.[s.id] ?? { reads: [], produces: [] };
    const base: CanvasStep = {
      id: s.id,
      marker: String(i + 1),
      actors: [stepActor(s.actor, copy)],
      title: s.title,
      uses: data.reads,
      produces: data.produces,
      stage: stages.find((x) => x.id === s.stage)?.label ?? s.stage,
    };
    return { kind: 'step', step: { ...base, ...dress.step?.(s, i) } };
  });
  return { trigger: { title: capital(flow.trigger), note: dress.triggerNote }, nodes };
}
