/**
 * What the screens of the programs area draw, worked out from the example
 * data (`fixtures/programs.ts`, the flows) and what the reader changed
 * (`state.ts`). Counts are computed here from the same lists everywhere, so
 * «3 flussi» in the list is the number of flows that name the program, and
 * the PCs the agents count is the number of rows that say so.
 */
import type { ProgramStateKind } from '../../../../ui/programs/model';
import type { UiCopy } from '../../../../ui/copy/types';
import type { ProgramSeed as AccessSeed } from '../../../../ui/fixtures/programs';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import type { FlowSeed } from '../../../../ui/fixtures/org/types';
import { CHANNELS, type ChannelSeed } from '../../../../ui/fixtures/channels';
import {
  CATALOG, DOCUMENT_LOCATIONS, FACET_RULES, FUNCTION_WORDS, MIGRATIONS, COMPUTERS, PROGRAMS,
  type CatalogEntry, type DocumentLocation, type FacetRule, type PcSeed, type ProgramSeed,
} from '../../../../ui/fixtures/programs';
import { halleyPasswordSavedAt, type Vault } from '../../store/vault';
import { INITIAL_PROGRAMS, type ProgramsState } from './state';

/** `2026-11-06T10:30:00+01:00` to `10:30`. */
export const clock = (iso: string) => iso.slice(11, 16);

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The state of the slice, with defaults for whatever an older save did not have. */
export function withDefaults(s: Partial<ProgramsState> | undefined): ProgramsState {
  return { ...INITIAL_PROGRAMS, ...s, agent: { ...INITIAL_PROGRAMS.agent, ...s?.agent }, remote: { ...INITIAL_PROGRAMS.remote, ...s?.remote } };
}

/** The programs as the screens read them: the slice, plus the Halley robot's password from the vault. */
export interface ProgramsView extends ProgramsState {
  /** HH:mm the Halley robot's new password was saved; empty while it is still the one Halley changed on 05/11. */
  halleyPasswordAt: string;
}

export function viewOf(s: Partial<ProgramsState> | undefined, vault: Vault): ProgramsView {
  const saved = halleyPasswordSavedAt(vault);
  return { ...withDefaults(s), halleyPasswordAt: saved ? clock(saved) : '' };
}

/* ---------- programs and the flows that use them ---------- */

/** The flows of the organization that name a program in one of their steps. */
export function flowsUsing(program: ProgramSeed): FlowSeed[] {
  const names = [fold(program.id), fold(program.name)];
  return FLOWS.filter((f) => f.org === 'nocera' && f.steps.some((s) => s.program && names.includes(fold(s.program))));
}

/** The channels a program provides (PEC Aruba is the PEC box, Microsoft 365 the office mailboxes and Teams). */
export function channelsUsing(program: ProgramSeed): ChannelSeed[] {
  const names = [fold(program.name), fold(program.maker ?? '')];
  return CHANNELS.filter((ch) => names.includes(fold(ch.provider)));
}

/* ---------- PCs ---------- */

export interface LivePc extends Omit<PcSeed, 'kind'> {
  kind: PcSeed['kind'];
  state: 'working' | 'ready' | 'too-old' | 'removed';
}

export function liveComputers(st: ProgramsState): LivePc[] {
  const base: LivePc[] = COMPUTERS.map((p) => {
    const removed = st.removedAgents.includes(p.id);
    const version = st.versions[p.id] ?? p.version;
    const state: LivePc['state'] = p.tooOld ? 'too-old' : removed ? 'removed' : p.kind === 'agent' && p.id === 'PC-RAGIONERIA-02' && st.agent.status === 'live' ? 'working' : 'ready';
    return { ...p, version, state, kind: removed ? 'none' : p.kind, does: removed ? '' : p.does, programs: removed ? [] : p.programs };
  });
  const added: LivePc[] = st.addedPcs.map((a) => ({
    id: a.id, office: a.office, os: a.os, ramGb: 4, kind: 'remote-only', programs: [], does: '', version: a.version, lastSeenMin: 0, window: 'desktop', state: 'ready',
  }));
  return [...base, ...added];
}

/** PCs whose agent works in programs: the figure the sidebar and the cards print. */
export const agentComputers = (pcs: LivePc[]) => pcs.filter((p) => p.kind === 'agent');

/* ---------- state of a program ---------- */

export interface LiveProgramState {
  kind: ProgramStateKind;
  /** The agent that reaches it was taken off every PC. */
  agentGone?: boolean;
}

export function programState(seed: ProgramSeed, st: ProgramsView, pcs: LivePc[]): LiveProgramState {
  if (st.connected[seed.id]) return { kind: 'ok' };
  // The robot cannot log in until the new password is saved: the same fact the stopped run (n11) and the Registro tell.
  if (seed.id === 'halley' && !st.halleyPasswordAt) return { kind: 'failed' };
  const check = st.checks[seed.id];
  if (check && !check.ok) return { kind: 'failed' };
  if (seed.pcs?.length && seed.state !== 'to-connect') {
    const hosting = pcs.filter((p) => seed.pcs?.includes(p.id));
    if (hosting.length > 0 && hosting.every((p) => p.state === 'removed')) return { kind: 'to-connect', agentGone: true };
  }
  return { kind: seed.state };
}

/** The way the list names a program's «alternatives»: how many, and what is advised. */
export function alternativesOf(program: string) {
  const m = MIGRATIONS.find((x) => x.program === program);
  return m ? { count: m.alternatives.length, verdict: m.advice.verdict } : undefined;
}

/* ---------- smart search ---------- */

export interface ActiveFacet {
  id: string;
  rule: FacetRule;
}

/** What a question was understood as: one facet per rule the words trigger. */
export function facetsOf(query: string): ActiveFacet[] {
  const words = fold(query).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const out: ActiveFacet[] = [];
  for (const rule of FACET_RULES) {
    if (words.some((w) => rule.words.some((r) => w.startsWith(r) || (r.length <= 3 && w === r)))) out.push({ id: `${rule.kind}:${rule.value}`, rule });
  }
  return out;
}

function facetHolds(rule: FacetRule, e: CatalogEntry): boolean {
  switch (rule.kind) {
    case 'sector': return e.sectors.includes(rule.value);
    case 'function': return (FUNCTION_WORDS[rule.value] ?? []).some((w) => e.functions.includes(w));
    case 'hook': return e.hooks.includes('mcp') || e.hooks.includes('api');
    case 'region': return e.regions.includes(fold(rule.value));
  }
}

/** The catalogue entries that answer a question, best first; `off` lists the facets the reader loosened. */
export function searchCatalog(query: string, off: string[]): CatalogEntry[] {
  const q = query.trim();
  if (!q) return CATALOG;
  const facets = facetsOf(q).filter((f) => !off.includes(f.id));
  const all = facetsOf(q);
  if (all.length === 0) {
    const tokens = fold(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    return CATALOG.filter((e) => tokens.some((t) => fold(`${e.name} ${e.maker} ${e.description}`).split(/[^a-z0-9]+/).some((w) => w.startsWith(t))));
  }
  const functions = facets.filter((f) => f.rule.kind === 'function');
  const scored = CATALOG.map((e, i) => ({ e, i, score: facets.filter((f) => facetHolds(f.rule, e)).length, fn: functions.some((f) => facetHolds(f.rule, e)) }))
    .filter((x) => x.score > 0 && (functions.length === 0 || x.fn));
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.e);
}

/** The kinds of document that match a question, best first. */
export function searchDocuments(query: string): DocumentLocation[] {
  const q = fold(query.trim());
  if (!q) return DOCUMENT_LOCATIONS;
  const tokens = q.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const scored = DOCUMENT_LOCATIONS.map((d, i) => {
    const words = fold(`${d.document} ${d.keywords} ${PROGRAMS.find((p) => p.id === d.program)?.name ?? ''}`).split(/[^a-z0-9]+/);
    const score = tokens.filter((t) => words.some((w) => w.startsWith(t) || (t.length >= 4 && t.startsWith(w) && w.length >= 4))).length;
    return { d, i, score };
  }).filter((x) => x.score > 0);
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.d);
}

/**
 * The access lines of a program (user, password, last check), the same on the list's panel and on the program's
 * page. Halley's robot password reads «scaduta il 05/11» until the new one is saved, then the time it was saved.
 */
export function accessLinesOf(seed: AccessSeed, st: ProgramsView, c: UiCopy['programs']): Array<{ label: string; value: string }> {
  const check = st.checks[seed.id];
  return seed.access.map((a) => {
    if (a.key === 'password' && seed.id === 'halley') {
      return st.halleyPasswordAt
        ? { label: c.list.detail.accessLabels.password, value: c.common.todayAt(st.halleyPasswordAt) }
        : { label: c.list.detail.passwordLabel, value: c.list.detail.passwordExpiredValue };
    }
    return { label: c.list.detail.accessLabels[a.key], value: a.key === 'lastCheck' ? c.common.todayAt(check?.ok ? check.at : a.value) : a.value };
  });
}
