/**
 * One run of a flow, laid on the drawing of the flow: the same canvas the flow
 * page draws, with every step saying where the run stands (done, the one it is
 * at, stopped, still to come) and, where the flow splits, the case the run took
 * marked and the others left quieter. Nothing is drawn here: this dresses the
 * model that `canvasOf` built from the flow.
 */
import { FileText, Image, Mail, type LucideIcon } from 'lucide-react';
import type { CaseDocument, FlowSeed } from '../../../../ui/fixtures/org/types';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import type { UiCopy } from '../../../../ui/copy/types';
import type { CanvasLane, CanvasNode, CanvasOriginal, CanvasStep, CanvasStepState, FlowCanvasModel } from '../../../../ui/flows/model';
import { clockTime, stepTime, type LiveRun } from './data';

const DOC_ICON: Record<CaseDocument['kind'], LucideIcon> = { pdf: FileText, image: Image, mail: Mail, xml: FileText };

/** The documents a case came with, as originals to open beside the step that reads them. */
export function originalsOf(docs: CaseDocument[], open: () => void): CanvasOriginal[] {
  return docs
    .filter((d) => !d.draft)
    .map((d) => ({ id: d.id, name: d.name, meta: d.detail, icon: DOC_ICON[d.kind], onOpen: open }));
}

/** A step reads the original when it takes a file or a message in. */
const readsOriginal = (step: CanvasStep) => Boolean(step.uses?.some((u) => u.kind === 'file' || u.kind === 'mail'));

export function dressRun({ model, flow, run, copy, originals }: {
  model: FlowCanvasModel;
  flow: FlowSeed;
  run: LiveRun;
  copy: UiCopy;
  /** What the case came with; none when the case is not among the examples. */
  originals: CanvasOriginal[];
}): FlowCanvasModel {
  const c = copy.flowRun.run;
  const path = run.path.filter((id) => flow.steps.some((s) => s.id === id));
  const idxNow = Math.max(0, path.indexOf(run.stepId));
  const finished = run.status === 'done' || run.status === 'archived';
  const split = model.nodes.find((n): n is Extract<CanvasNode, { kind: 'split' }> => n.kind === 'split');
  const before = split ? model.nodes.indexOf(split) : model.nodes.length;
  // The run has reached the split once it is past the steps every case takes.
  const reached = Boolean(split) && (finished || idxNow >= before);

  const dress = (step: CanvasStep, originalId: string, index: number): CanvasStep => {
    const seed = flow.steps.find((s) => s.id === originalId);
    const at = clockTime(stepTime(run, flow, index));
    let state: CanvasStepState;
    if (finished || index < idxNow) state = 'done';
    else if (index === idxNow) state = run.status === 'error' ? 'error' : run.status === 'running' ? 'current' : 'waiting';
    else state = 'next';
    const out: CanvasStep = { ...step, state };
    if (state === 'done') out.done = seed?.kind === 'classify' && run.type ? `${c.factsType} ${run.type} · ${run.confidence}% · ${at}` : at;
    if (state === 'error') {
      out.flag = c.stepNote.error;
      out.badges = [{ label: c.stepAttempts(run.attempts), tone: 'red' }];
    } else if (state === 'waiting') {
      out.flag = run.status === 'person' ? c.stepNote.person(OFFICE_LABEL[seed?.office ?? flow.office]) : c.stepNote.waiting;
    } else if (state === 'current') out.flag = c.stepNote.running;
    if (state !== 'next' && originals.length > 0 && readsOriginal(step)) out.originals = originals;
    return out;
  };

  const inPath = (id: string) => path.indexOf(id);
  // The case the run took: the letter of its type; a run without one takes the lane its steps are in.
  const takenLane = (lanes: CanvasLane[]): CanvasLane | undefined => {
    if (!reached) return undefined;
    const byType = run.type ? lanes.find((l) => l.letter === run.type) : undefined;
    return byType ?? lanes.find((l) => l.steps.some((s) => inPath(s.id.slice(l.id.length + 1)) >= 0));
  };

  // The step the run is at, when the lane it took does not hold it (the fixtures give the robot's step of the legal path to runs of other types): it is shown where the flow has it.
  const current = finished ? undefined : path[idxNow];
  const lanesOf = split ? split.lanes : [];
  const taken = split ? takenLane(lanesOf) : undefined;
  const mainHolds = model.nodes.some((n) => n.kind === 'step' && n.step.id === current);
  const takenHolds = Boolean(taken?.steps.some((s) => s.id.slice(taken.id.length + 1) === current));
  const strayLane = current && !mainHolds && !takenHolds ? lanesOf.find((l) => l.steps.some((s) => s.id.slice(l.id.length + 1) === current)) : undefined;

  const nodes = model.nodes.map((node): CanvasNode => {
    if (node.kind === 'step') {
      const index = inPath(node.step.id);
      return index < 0 ? node : { kind: 'step', step: dress(node.step, node.step.id, index) };
    }
    return {
      ...node,
      reached,
      lanes: node.lanes.map((lane): CanvasLane => {
        if (lane === strayLane) {
          return { ...lane, steps: lane.steps.map((s) => (s.id.slice(lane.id.length + 1) === current ? dress(s, current, idxNow) : s)) };
        }
        if (lane !== taken) return lane;
        const own = (s: CanvasStep) => s.id.slice(lane.id.length + 1);
        const resolved = lane.steps.some((s) => inPath(own(s)) >= 0);
        return {
          ...lane,
          taken: true,
          steps: lane.steps.map((s) => {
            const index = inPath(own(s));
            if (index >= 0) return dress(s, own(s), index);
            // The path of a run of another type names steps of another lane: this lane is the case it took, all or none of it done.
            if (resolved) return s;
            return { ...s, state: finished ? 'done' : 'next' };
          }),
        };
      }),
    };
  });
  return { trigger: model.trigger, nodes };
}
