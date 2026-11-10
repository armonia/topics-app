import type { UiCopy } from '../copy/types';
import type {
  ActorModel, CanvasActor, CanvasLane, CanvasNode, CanvasStep, FlowCanvasModel, FlowModel, FlowPathModel, FlowStepModel, StepEditing,
} from './model';

/** The id the canvas gives a step of a lane: the ids of the steps repeat from one path to the next (`a`, `b`), the canvas needs them unique. */
export const laneStepKey = (pathId: string, stepId: string) => `${pathId}-${stepId}`;

/** Who does a step, as the canvas draws it. The trigger is not a step of the column: the canvas draws it on top. */
export function canvasActorOf(actor: ActorModel, copy: UiCopy): CanvasActor | undefined {
  switch (actor.kind) {
    case 'trigger': return undefined;
    case 'rule': return { kind: 'rule', label: copy.flows.rule };
    case 'ai': return { kind: 'agent', name: actor.name ?? copy.common.ai };
    case 'person': return { kind: 'person', name: actor.name ?? copy.flows.person };
    case 'program': return { kind: 'program', name: actor.name ?? copy.flowBuild.robot };
    case 'action': return { kind: 'action', name: actor.name ?? copy.flowBuild.actionActor };
  }
}

/** One step of a flow model as the canvas step. `trailing` («card in Board») is where the step ends up: the canvas calls that the stage. (allow-italian: quotes the Italian interface) */
export function canvasStepOf(step: FlowStepModel, copy: UiCopy, id: string = step.id): CanvasStep {
  return {
    id,
    marker: step.marker,
    actors: step.actors.map((a) => canvasActorOf(a, copy)).filter((a): a is CanvasActor => a !== undefined),
    title: step.title,
    note: step.note,
    uses: step.uses,
    produces: step.produces,
    opens: step.opens,
    due: step.due,
    stage: step.trailing,
  };
}

function laneOf(path: FlowPathModel, copy: UiCopy): CanvasLane {
  return {
    id: path.id,
    letter: path.letter,
    kind: path.kind,
    title: path.title,
    hint: path.hint,
    badge: path.badge,
    meta: path.meta,
    steps: (path.steps ?? []).map((s) => canvasStepOf(s, copy, laneStepKey(path.id, s.id))),
  };
}

export interface CanvasOfOptions {
  /** A step that runs whatever the case, after the lanes meet again (SARIM's last step of the report flow). */
  after?: { marker: string; title: string; /** Printed before the title, e.g. «Sempre». (allow-italian: quotes the Italian interface) */ badge?: string };
  /** What tells the cases apart, in the sentence «in base al …»; the word for a type by default. (allow-italian: quotes the Italian interface) */
  by?: string;
}

/**
 * The flow model of a page as the one drawing of a flow (`FlowCanvas`) reads
 * it: the trigger, the steps every case takes, then one split into every path
 * with ALL its steps (nothing folded), then the step that closes every case.
 * A flow without paths is one column.
 */
export function canvasOf(flow: FlowModel, copy: UiCopy, opts: CanvasOfOptions = {}): FlowCanvasModel {
  const nodes: CanvasNode[] = flow.steps.map((s) => ({ kind: 'step', step: canvasStepOf(s, copy) }));
  if (flow.branch && flow.branch.paths.length > 0) {
    nodes.push({
      kind: 'split',
      id: 'split',
      marker: flow.branch.marker,
      by: opts.by ?? copy.flowRun.run.factsType.toLowerCase(),
      lanes: flow.branch.paths.map((p) => laneOf(p, copy)),
    });
  }
  if (opts.after) {
    nodes.push({
      kind: 'step',
      step: {
        id: 'after',
        marker: opts.after.marker,
        actors: [],
        title: opts.after.title,
        badges: opts.after.badge ? [{ label: opts.after.badge, tone: 'neutral' }] : undefined,
      },
    });
  }
  return {
    trigger: { title: flow.trigger.title, note: flow.trigger.note, produces: flow.trigger.produces },
    nodes,
  };
}

/** The step id of the flow model behind an id of the canvas (a lane step carries its path in front). */
export function originalStepId(flow: FlowModel, id: string): string {
  for (const p of flow.branch?.paths ?? []) {
    for (const s of p.steps ?? []) if (laneStepKey(p.id, s.id) === id) return s.id;
  }
  return id;
}

/** The same `editing`, speaking the ids of the flow model: what a page keeps its steps by is not the id the canvas gives a lane step. */
export function editingOnModel(editing: StepEditing, flow: FlowModel): StepEditing {
  const own = (id: string) => originalStepId(flow, id);
  return {
    ...editing,
    onOpen: (id) => editing.onOpen(own(id)),
    onAdd: (container, afterId) => editing.onAdd(container, afterId === null ? null : own(afterId)),
    menu: (container, id) => editing.menu(container, own(id)),
  };
}

/** Every step of a flow drawn by the canvas, in order, lanes included: what a container searches to show the detail of the step pressed. */
export function canvasSteps(model: FlowCanvasModel): CanvasStep[] {
  return model.nodes.flatMap((n) => (n.kind === 'step' ? [n.step] : n.lanes.flatMap((l) => l.steps)));
}
