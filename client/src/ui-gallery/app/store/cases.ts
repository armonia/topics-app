/**
 * The example cases as the reader left them: the seed (`fixtures/org/cases`)
 * with what they changed on top (`CaseLive`). Every count the preview prints
 * about cases (the queue in the sidebar, the stuck ones in the overview, the
 * Board columns) is computed here from the same list, so the numbers agree on
 * every screen and change together when a case is confirmed.
 */
import type { CaseSeed, OrgKey, StepState } from '../../../ui/fixtures/org/types';
import type { Persona } from '../../../ui/fixtures/org/people';
import { CASES } from '../../../ui/fixtures/org/cases';
import type { CaseLive, DemoState } from './state';

/** A case with the reader's changes applied. */
export interface LiveCase extends CaseSeed {
  live: CaseLive;
}

/**
 * The protocol number a case has now. The fixture of a case still waiting for confirmation carries the number that
 * Halley will give it, but the number is assigned by the confirmation, so until then the case has none.
 */
export function protocolOf(seed: CaseSeed, live?: CaseLive): CaseSeed['protocol'] {
  if (live?.protocol) return live.protocol;
  return seed.status === 'da-confermare' ? undefined : seed.protocol;  // allow-italian: id of the fixture data, not shown
}

export function caseSeed(id: string): CaseSeed | undefined {
  return CASES.find((c) => c.id === id);
}

export function liveCase(state: DemoState, seed: CaseSeed): LiveCase {
  const live = state.cases[seed.id] ?? {};
  const steps = live.steps
    ? seed.steps.map((s) => (live.steps?.[s.id] ? { ...s, state: live.steps[s.id] as StepState } : s))
    : seed.steps;
  const fields = live.values
    ? seed.fields.map((f) => (live.values?.[f.id] !== undefined ? { ...f, value: live.values[f.id] as string, confidence: 100 } : f))
    : seed.fields;
  return {
    ...seed,
    status: live.status ?? seed.status,
    protocol: protocolOf(seed, live),
    assignee: live.assignee ?? seed.assignee,
    steps,
    fields,
    history: [...seed.history, ...(live.events ?? [])],
    live,
  };
}

export function findLiveCase(state: DemoState, id: string): LiveCase | undefined {
  const seed = caseSeed(id);
  return seed ? liveCase(state, seed) : undefined;
}

/** Every case of an organization, with the reader's changes. */
export function orgCases(state: DemoState, org: OrgKey): LiveCase[] {
  return CASES.filter((c) => c.org === org).map((c) => liveCase(state, c));
}

/** The cases a person sees: their organizations, and their offices when they have some. */
export function visibleCases(state: DemoState, persona: Persona, org?: OrgKey): LiveCase[] {
  return CASES
    .filter((c) => persona.orgs.includes(c.org) && (!org || c.org === org))
    .filter((c) => !persona.offices.length || persona.offices.includes(c.office) || c.assignee === persona.id)
    .map((c) => liveCase(state, c));
}

/** What waits for a person to confirm: the queue of «Da fare». (allow-italian: quotes the Italian interface) */
export function queueFor(state: DemoState, persona: Persona, org: OrgKey = 'nocera'): LiveCase[] {
  return visibleCases(state, persona, org).filter((c) => c.status === 'da-confermare');
}
