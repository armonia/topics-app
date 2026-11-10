/**
 * The state and the models of the flow-building area: the flows a person
 * added, switched off or edited on top of the example ones, and the view
 * models the pages draw from them. Nothing here draws.
 */
import type { CaseSeed, FlowSeed, FlowStepKind, FlowStepSeed, Office } from '../../../../ui/fixtures/org/types';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import { CASES } from '../../../../ui/fixtures/org/cases';
import {
  CERTIFIED_MAIL_FLOW, OFFICE_TIMES, PEC_PHASE, PROGRAM_ROLE, STEP_DETAIL, TRIGGER_DETAIL, type StepDetail,
} from '../../../../ui/fixtures/flows';
import { FLOW_FACTS, OFFICE_OWNER } from '../../../../ui/fixtures/flow-build';
import type { UiCopy } from '../../../../ui/copy/types';
import type { FieldRef, Tone } from '../../../../ui/types';
import type { ActorModel, CollectedDataModel, FlowModel, FlowPathModel, FlowStepModel } from '../../../../ui/flows/model';
import { MAIN_CONTAINER } from '../../../../ui/flows/model';
import type { OfficeMatrixModel, OfficeRowModel } from '../../../../ui/flows/OfficeMatrix';

export type FlowStatus = FlowSeed['status'];

/** A change a person made to the steps of a flow, replayed in order on the example. */
export type FlowOp =
  | { op: 'add'; id: string; container: string; after: string | null; label: string; kind: FlowStepKind; office?: Office; program?: string }
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; dir: -1 | 1 };

/** A flow made in the preview: from a template, a copy, the chat, an interview or a description. */
export interface CreatedFlow extends FlowSeed {
  from?: string;
  origin: 'template' | 'duplicate' | 'chat' | 'interview' | 'blank' | 'suggestion';
  /** What each step says, carried from where it came from. */
  details: Record<string, StepDetail>;
  triggerNote?: string;
  /** YYYY-MM-DD of its creation. */
  createdAt: string;
}

/** The domain state of the area: slice `flows`. Other areas read `created` and `status`. */
export interface FlowsSlice {
  created: CreatedFlow[];
  /** A state changed by hand (turned off, turned on), by flow id. */
  status: Record<string, FlowStatus>;
  edits: Record<string, FlowOp[]>;
}

export const EMPTY_FLOWS: FlowsSlice = { created: [], status: {}, edits: {} };

/** Every flow of an organization, the added ones last, with the state set by hand. */
export function flowsOf(slice: FlowsSlice, org: FlowSeed['org']): FlowSeed[] {
  return [...FLOWS, ...slice.created]
    .filter((f) => f.org === org)
    .map((f) => (slice.status[f.id] ? { ...f, status: slice.status[f.id] } : f));
}

export function findFlow(slice: FlowsSlice, id: string): (FlowSeed & Partial<CreatedFlow>) | undefined {
  const base = [...FLOWS, ...slice.created].find((f) => f.id === id);
  if (!base) return undefined;
  return slice.status[id] ? { ...base, status: slice.status[id] } : base;
}

export const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The container a step of the PEC flow belongs to: its path, or the steps every PEC takes. */
const pecContainerOf = (id: string): string => {
  if (id === 's1' || id === 's2') return MAIN_CONTAINER;
  if (/^[a-g]$/.test(id)) return 'pA';
  const m = id.match(/^([bcf])\d/);
  return m ? `p${m[1].toUpperCase()}` : MAIN_CONTAINER;
};

/** The steps of each container, `main` first: the PEC flow keeps one container per path. */
function baseContainers(seed: FlowSeed): Record<string, FlowStepSeed[]> {
  if (seed.id !== 'pec') return { [MAIN_CONTAINER]: [...seed.steps] };
  const out: Record<string, FlowStepSeed[]> = { [MAIN_CONTAINER]: [], pA: [], pB: [], pC: [], pF: [] };
  for (const s of seed.steps) out[pecContainerOf(s.id)].push(s);
  return out;
}

/** The steps of a flow after the person's changes, by container. */
export function editedContainers(seed: FlowSeed, ops: FlowOp[] = []): Record<string, FlowStepSeed[]> {
  const lists = baseContainers(seed);
  for (const op of ops) {
    if (op.op === 'add') {
      const list = lists[op.container] ?? (lists[op.container] = []);
      const found = op.after === null ? -1 : list.findIndex((s) => s.id === op.after);
      const at = op.after === null ? 0 : found < 0 ? list.length : found + 1;
      list.splice(at, 0, { id: op.id, label: op.label, kind: op.kind, office: op.office, program: op.program });
    } else if (op.op === 'remove') {
      for (const k of Object.keys(lists)) lists[k] = lists[k].filter((s) => s.id !== op.id);
    } else {
      for (const k of Object.keys(lists)) {
        const list = lists[k];
        const i = list.findIndex((s) => s.id === op.id);
        const j = i + op.dir;
        if (i >= 0 && j >= 0 && j < list.length) [list[i], list[j]] = [list[j], list[i]];
      }
    }
  }
  return lists;
}

/** All the steps, in the order the page shows them. */
export function editedSteps(seed: FlowSeed, ops: FlowOp[] = []): FlowStepSeed[] {
  return Object.values(editedContainers(seed, ops)).flat();
}

/** The next id for an added step: never reused, even after a removal. */
export const nextStepId = (ops: FlowOp[] = []) => `x${ops.filter((o) => o.op === 'add').length + 1}`;

/** What the PEC flow's hand-drawn steps say, in the same shape as the others. */
function pecDetails(): Record<string, StepDetail> {
  const out: Record<string, StepDetail> = {};
  const all = [...CERTIFIED_MAIL_FLOW.steps, ...CERTIFIED_MAIL_FLOW.branch.paths.flatMap((p) => p.steps ?? [])];
  const OPENS_TO: Record<string, StepDetail['opensTo']> = { b: 'parcel', d: 'inbox', f: 'presentation' };
  for (const s of all) {
    out[s.id] = { note: s.note, uses: s.uses, produces: s.produces, opens: s.opens, opensTo: OPENS_TO[s.id], due: s.due, trailing: s.trailing, phase: PEC_PHASE[s.id] };
  }
  return out;
}

export function detailsOf(flow: FlowSeed & Partial<CreatedFlow>): Record<string, StepDetail> {
  if (flow.details) return flow.details;
  if (flow.id === 'pec') return pecDetails();
  return STEP_DETAIL[flow.id] ?? {};
}

const PROGRAM_TONE: Record<string, Tone> = { Halley: 'green', Prunes: 'blue', TeamSystem: 'violet', Publisys: 'amber', Traspare: 'pink', SAP: 'red' };

export function actorsOf(kind: FlowStepKind, program: string | undefined, copy: UiCopy): ActorModel[] {
  switch (kind) {
    case 'classify': case 'ai': return [{ kind: 'ai' }];
    case 'rule': return [{ kind: 'rule' }];
    case 'person': case 'view': return [{ kind: 'person' }];
    case 'robot': case 'program': return [{ kind: 'program', name: program ?? copy.flowBuild.robot, tone: program ? (PROGRAM_TONE[program] ?? 'green') : 'green' }];
    case 'send': return [{ kind: 'action', name: copy.flowBuild.actionActor }];
  }
}

function stepModel(s: FlowStepSeed, marker: string, detail: StepDetail | undefined, copy: UiCopy): FlowStepModel {
  return {
    id: s.id, marker, actors: actorsOf(s.kind, s.program, copy), title: s.label,
    note: detail?.note, uses: detail?.uses, produces: detail?.produces, opens: detail?.opens, due: detail?.due, trailing: detail?.trailing,
  };
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Who wrote a field, in the words of the collected-data panel. */
function writerOf(s: FlowStepSeed, copy: UiCopy): string {
  switch (s.kind) {
    case 'classify': case 'ai': return copy.common.ai;
    case 'rule': return copy.flows.rule;
    case 'robot': case 'program': return s.program ?? copy.flowBuild.robot;
    case 'send': return copy.flowBuild.actionActor;
    default: return s.office ? OFFICE_LABEL[s.office] : copy.flows.person;
  }
}

/** The side panel of a flow without hand-drawn data: what each step writes, and who may read it. */
function collectedOf(seed: FlowSeed, steps: FlowStepSeed[], details: Record<string, StepDetail>, copy: UiCopy): CollectedDataModel {
  const t = copy.flowBuild.flow;
  const sections: CollectedDataModel['sections'] = [];
  const trigger = TRIGGER_DETAIL[seed.id];
  if (trigger?.produces?.length) {
    sections.push({ label: t.fromTrigger, rows: trigger.produces.map((p) => ({ field: p, label: t.writtenBy, value: copy.flows.trigger })) });
  }
  steps.forEach((s, i) => {
    const produces = details[s.id]?.produces;
    if (produces?.length) sections.push({ label: t.stepSection(i + 1), rows: produces.map((p) => ({ field: p, label: t.writtenBy, value: writerOf(s, copy) })) });
  });
  const offices = [...new Set([seed.office, ...steps.map((s) => s.office).filter((o): o is Office => Boolean(o))])];
  return {
    tag: t.dataTag,
    title: t.dataTitle,
    description: t.dataBody,
    sections,
    access: { label: t.access, value: offices.map((o) => OFFICE_LABEL[o]).join(', ') },
  };
}

/** The status chip text of a flow page: `Attivo · v4`. (allow-italian: quotes the Italian interface) */
export const statusText = (seed: FlowSeed, copy: UiCopy) => `${copy.flowBuild.status[seed.status]} · v${seed.version}`;

const STATUS_TONE: Record<FlowStatus, Tone> = { attivo: 'green', collaudo: 'blue', bozza: 'neutral', spento: 'neutral' };

/** The model of the flow page (w01): the PEC flow from its drawing, every other from its steps. */
export function flowModelOf(seed: FlowSeed & Partial<CreatedFlow>, ops: FlowOp[], copy: UiCopy): FlowModel {
  const lists = editedContainers(seed, ops);
  const details = detailsOf(seed);
  const crumbs = [{ label: seed.name }];
  const status = { text: statusText(seed, copy), tone: STATUS_TONE[seed.status] };
  const marked = (list: FlowStepSeed[]) => list.map((s, i) => stepModel(s, String(i + 1), details[s.id], copy));

  if (seed.id === 'pec') {
    const drawn = CERTIFIED_MAIL_FLOW;
    const byId = new Map<string, FlowStepModel>([...drawn.steps, ...drawn.branch.paths.flatMap((p) => p.steps ?? [])].map((s) => [s.id, s]));
    const steps = (list: FlowStepSeed[], numeric: boolean) =>
      list.map((s, i) => {
        const marker = numeric ? String(i + 1) : LETTERS[i] ?? String(i + 1);
        const own = byId.get(s.id);
        return own ? { ...own, marker, highlighted: false } : stepModel(s, marker, details[s.id], copy);
      });
    const main = steps(lists[MAIN_CONTAINER] ?? [], true);
    // A path drawn without steps shows the ones a person added to it.
    const paths: FlowPathModel[] = drawn.branch.paths.map((p) => (p.steps || lists[p.id]?.length ? { ...p, steps: steps(lists[p.id] ?? [], false) } : p));
    return {
      crumbs, status, trigger: drawn.trigger, steps: main,
      branch: { marker: String(main.length + 1), count: drawn.branch.count, paths },
      collected: drawn.collected,
    };
  }

  const list = lists[MAIN_CONTAINER] ?? [];
  const trigger = TRIGGER_DETAIL[seed.id];
  return {
    crumbs, status,
    trigger: {
      id: 'trigger', actors: [{ kind: 'trigger' }], title: capitalize(seed.trigger),
      note: trigger?.note ?? seed.triggerNote, produces: trigger?.produces,
    },
    steps: marked(list),
    collected: collectedOf(seed, list, details, copy),
  };
}

/** The default stage of a step in the by-office view when its detail does not say. */
const PHASE_OF_KIND: Record<FlowStepKind, NonNullable<StepDetail['phase']>> = {
  classify: 'reading', ai: 'reading', rule: 'check', view: 'check', robot: 'registration', program: 'registration', send: 'registration', person: 'work',
};
const PHASES = ['arrival', 'reading', 'check', 'registration', 'work'] as const;

const baseName = (f: FieldRef) => f.name.split('.')[0];

/** A flow by who does what (w03), derived from its steps and what each reads and writes. */
export function officeMatrixOf(seed: FlowSeed & Partial<CreatedFlow>, ops: FlowOp[], copy: UiCopy): OfficeMatrixModel {
  const t = copy.flowBuild.offices;
  const details = detailsOf(seed);
  // The by-office view of the PEC flow follows the legal path A, as the drawing does.
  const lists = editedContainers(seed, ops);
  const steps = seed.id === 'pec' ? [...(lists[MAIN_CONTAINER] ?? []), ...(lists.pA ?? [])] : Object.values(lists).flat();
  const rowsById = new Map<string, OfficeRowModel>();
  const owners = new Map<string, string>();
  const rowFor = (s: FlowStepSeed | null): { id: string; label: string; sub: string } => {
    if (!s || !['robot', 'program', 'person', 'view'].includes(s.kind)) return { id: 'system', label: t.system, sub: t.systemSub };
    if (s.kind === 'robot' || s.kind === 'program') {
      const name = s.program ?? copy.flowBuild.robot;
      return { id: `program-${name}`, label: name, sub: (s.program && PROGRAM_ROLE[s.program]) || t.robotSub };
    }
    const office = s.office ?? seed.office;
    return { id: `office-${office}`, label: OFFICE_LABEL[office], sub: t.officeSub };
  };
  const place = (stepId: string, who: ReturnType<typeof rowFor>, phase: string, cell: OfficeRowModel['cells'][string][number]) => {
    const row = rowsById.get(who.id) ?? { id: who.id, label: who.label, sub: who.sub, cells: {} };
    (row.cells[phase] ??= []).push(cell);
    rowsById.set(who.id, row);
    owners.set(stepId, who.id);
  };
  place('trigger', rowFor(null), 'arrival', { id: 'trigger', actor: { kind: 'trigger' }, title: capitalize(seed.trigger) });
  for (const s of steps) {
    const d = details[s.id];
    place(s.id, rowFor(s), d?.phase ?? PHASE_OF_KIND[s.kind], {
      id: s.id, actor: actorsOf(s.kind, s.program, copy)[0], title: s.label, due: d?.due, opens: d?.opens,
    });
  }
  const passes: FieldRef[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    for (const p of details[s.id]?.produces ?? []) {
      const key = baseName(p);
      const consumers = steps.filter((o) => owners.get(o.id) !== owners.get(s.id) && (details[o.id]?.uses ?? []).some((u) => baseName(u) === key));
      if (consumers.length && !seen.has(key)) {
        seen.add(key);
        passes.push({ kind: p.kind, name: key });
      }
    }
  }
  const rows = [...rowsById.values()];
  const phases = PHASES.filter((p) => rows.some((r) => r.cells[p]?.length)).map((p) => ({ id: p, label: t.phases[p] }));
  const times = seed.origin === undefined ? OFFICE_TIMES[seed.id] : undefined;
  return { phases, rows, times: (times?.rows ?? []).map((r) => ({ label: r.who, value: r.time })), stuck: times?.stuck, passes };
}

/** The first example case of a flow, which the views a step opens show. */
export function caseOfFlow(flow: string): CaseSeed | undefined {
  return CASES.find((c) => c.flow === flow);
}

/** Who answers for a flow, as the list shows it. */
export function ownerOf(seed: FlowSeed): { owner: string; monogram: string; color: string } {
  const f = FLOW_FACTS[seed.id];
  if (f) return f;
  return OFFICE_OWNER[seed.office] ?? { owner: OFFICE_LABEL[seed.office], monogram: OFFICE_LABEL[seed.office].slice(0, 2).toUpperCase(), color: '#475569' };
}
