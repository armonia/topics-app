/** Words for what changed and how long it took: the copy catalogue applied to the data of the area. */
import type { UiCopy } from '../../../../ui/copy/types';
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import type { StepChange } from '../../../../ui/flowrun/config';

const stepTitle = (flow: FlowSeed, id: string) => flow.steps.find((s) => s.id === id)?.label ?? id;

export function changeText(copy: UiCopy, c: StepChange): string {
  const t = copy.flowRun.versions.changeText;
  switch (c.kind) {
    case 'threshold': return t.threshold(c.from, c.to);
    case 'prompt': return t.prompt;
    case 'knowledge': return t.knowledge(c.added, c.removed);
    case 'fields': return t.fields(c.added, c.removed);
    case 'conditions': return t.conditions(c.added, c.removed, c.edited);
    case 'types': return t.types(c.ids);
    case 'preRules': return t.preRules(c.added, c.removed);
    case 'robot': return t.robot(c.keys.map((k) => copy.flowRun.versions.robotKeys[k as keyof typeof copy.flowRun.versions.robotKeys] ?? k));
    case 'generic': return t.generic(c.keys.map((k) => copy.flowRun.versions.genericKeys[k as keyof typeof copy.flowRun.versions.genericKeys] ?? k));
    case 'added': return t.added(c.title);
  }
}

export const changeLabel = (copy: UiCopy, c: StepChange) => copy.flowRun.versions.changeLabel[c.kind];

export const changeStepId = (c: StepChange): string | undefined => (c.kind === 'added' ? undefined : c.stepId);

/** One line for the list of versions: the first two changes, with the step they are on. */
export function summarize(copy: UiCopy, flow: FlowSeed, changes: StepChange[]): string {
  if (!changes.length) return copy.flowRun.versions.summaryNone;
  const parts = changes.slice(0, 2).map((c) => {
    const id = changeStepId(c);
    return id ? `${stepTitle(flow, id)}: ${changeText(copy, c)}` : changeText(copy, c);
  });
  return parts.join(' · ') + (changes.length > 2 ? ` · +${changes.length - 2}` : '');
}

export function duration(copy: UiCopy, sec: number): string {
  const d = copy.flowRun.runs.duration;
  if (sec < 60) return d.seconds(Math.max(1, Math.round(sec)));
  const min = Math.round(sec / 60);
  if (min < 60) return d.minutes(min);
  return d.hours(Math.floor(min / 60), min % 60);
}
