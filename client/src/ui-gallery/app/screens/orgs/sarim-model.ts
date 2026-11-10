/**
 * The SARIM flows as the list, the flow page and the overview show them. The
 * seeds (`fixtures/sarim.ts`) hold the shape; where `org/flows.ts` also lists
 * a SARIM flow, its name, trigger, version, volume and state win, so the
 * counts agree with the list of flows everywhere.
 */
import type { UiCopy } from '../../../../ui/copy/types';
import { SARIM_FLOWS, REPORTS_PATH_VOLUMES, type SarimFlowSeed } from '../../../../ui/fixtures/sarim';
import type { FlowModel, FlowStepModel } from '../../../../ui/flows/model';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { OFFICE_LABEL } from '../../../../ui/fixtures/org/people';
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import { openItems, type SarimState } from './sarim-state';

export interface SarimFlowInfo {
  seed: SarimFlowSeed;
  name: string;
  trigger: string;
  version: number;
  perMonth: number;
  status: FlowSeed['status'];
  /** The flow as `org/flows.ts` lists it, when it does: its steps are drawn as they are there. */
  listed?: FlowSeed;
}

export function sarimFlows(): SarimFlowInfo[] {
  return SARIM_FLOWS.map((seed) => {
    const listed = FLOWS.find((f) => f.id === seed.id && f.org === 'sarim');
    return {
      seed,
      name: listed?.name ?? seed.name,
      trigger: listed?.trigger ?? seed.trigger,
      version: listed?.version ?? seed.version,
      perMonth: listed?.perMonth ?? seed.perMonth,
      status: listed?.status ?? 'attivo', // allow-italian: status code of the data, not shown
      listed,
    };
  });
}

export const sarimFlow = (id: string) => sarimFlows().find((f) => f.seed.id === id);

/** Thousands with a dot, as Italian writes them (the runtime's own grouping skips four-digit numbers). */
export const fmt = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Items waiting for a person, by flow: the call center's open queue is the report flow's, the others are examples. */
export function sarimStuck(st: SarimState, copy: UiCopy): Record<string, { place: string; count: number; callCenter?: boolean } | undefined> {
  const out: Record<string, { place: string; count: number; callCenter?: boolean } | undefined> = {};
  const queue = openItems(st).length;
  if (queue > 0) out['sarim-segnalazioni'] = { place: copy.shell.nav.callcenter, count: queue, callCenter: true };
  for (const f of SARIM_FLOWS) if (f.stuck) out[f.id] = f.stuck;
  return out;
}

/** The volume of one path of the report flow. */
export const pathVolume = (id: string) => REPORTS_PATH_VOLUMES[id] ?? 0;

const STEP_ACTORS: Record<FlowSeed['steps'][number]['kind'], (program?: string) => FlowStepModel['actors']> = {
  classify: () => [{ kind: 'ai' }],
  ai: () => [{ kind: 'ai' }],
  rule: () => [{ kind: 'rule' }],
  person: () => [{ kind: 'person' }],
  robot: (program) => [{ kind: 'program', name: program, tone: 'green' }],
  program: (program) => [{ kind: 'program', name: program, tone: 'blue' }],
  view: () => [{ kind: 'rule' }],
  send: () => [{ kind: 'rule' }],
};

/** A flow listed in `org/flows.ts` as the steps page draws it (no branch): the same steps, in the same order. */
export function modelFromListed(info: SarimFlowInfo, copy: UiCopy, status: FlowModel['status']): FlowModel | undefined {
  const f = info.listed;
  if (!f) return undefined;
  const p = copy.orgs.sarim.plainPanel;
  return {
    crumbs: [{ label: copy.flows.root }, { label: f.name }],
    status,
    trigger: { id: 'trigger', actors: [{ kind: 'trigger' }], title: f.trigger, note: copy.orgs.sarim.perMonthNote(fmt(f.perMonth)) },
    steps: f.steps.map((st, i) => ({ id: st.id, marker: String(i + 1), actors: STEP_ACTORS[st.kind](st.program), title: st.label })),
    branch: { marker: '', count: 0, paths: [] },
    collected: {
      tag: p.tag,
      title: p.title,
      description: p.description,
      sections: [{ label: p.section, rows: f.steps.map((st, i) => ({ label: `${i + 1}. ${st.label}`, value: st.program ?? (st.office ? OFFICE_LABEL[st.office] : '') })) }],
      access: { label: p.access, value: OFFICE_LABEL[f.office] },
    },
  };
}
