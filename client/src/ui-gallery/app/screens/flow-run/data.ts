/**
 * What the flow-at-work screens compute from the fixtures and from what the
 * reader changed: the configuration of a step with the edits laid on it, the
 * versions of a flow, the test of a version on yesterday's runs, and the runs
 * with the changes made on them (a retry that worked, a hand-over).
 */
import type { FlowSeed, FlowStepSeed } from '../../../../ui/fixtures/org/types';
import { FLOWS } from '../../../../ui/fixtures/org/flows';
import { baseVersions, runsOf, stepConfig, type RunSeed, type VersionSeed } from '../../../../ui/fixtures/flowrun';
import { applyOverride, changesOf, ruleHolds, type StepChange, type StepConfig, type StepOverride } from '../../../../ui/flowrun/config';
import type { UiRunStatus } from '../../../../ui/flowrun/model';

export const flowById = (id: string): FlowSeed | undefined => FLOWS.find((f) => f.id === id);
export const stepById = (flow: FlowSeed, id: string): FlowStepSeed | undefined => flow.steps.find((s) => s.id === id);

/** Steps by their marker on the rail: `1`, `2`, then `a`, `b` for the steps of the legal path. */
export const markerOf = (flow: FlowSeed, index: number): string => {
  if (flow.id !== 'pec') return String(index + 1);
  return index < 2 ? String(index + 1) : String.fromCharCode(97 + index - 2);
};

export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/* ---------- overrides ---------- */

export type OverrideMap = Record<string, StepOverride>;

export function mergeOverride(a: StepOverride | undefined, b: StepOverride | undefined): StepOverride {
  return {
    ...a,
    ...b,
    robot: a?.robot || b?.robot ? { ...a?.robot, ...b?.robot } : undefined,
    generic: a?.generic || b?.generic ? { ...a?.generic, ...b?.generic } : undefined,
    typeWhen: a?.typeWhen || b?.typeWhen ? { ...a?.typeWhen, ...b?.typeWhen } : undefined,
  };
}

export function mergeMaps(a: OverrideMap, b: OverrideMap): OverrideMap {
  const out: OverrideMap = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = mergeOverride(a[k], v);
  return out;
}

/* ---------- the state of one flow's versions ---------- */

export interface SavedVersion {
  n: number;
  at: string;
  who: string;
  summary: string;
  overrides: OverrideMap;
}

export interface TestRecord {
  n: number;
  at: string;
  label: string;
  total: number;
  rows: Array<{ runId: string; before: Outcome; after: Outcome; change: TestChange }>;
}

export type Outcome = 'person' | 'auto' | 'flow';
export type TestChange = 'same' | 'better' | 'risky' | 'more-person' | 'new-flow';

export interface FlowRunSlice {
  activeN: number;
  /** What the active version changes on the fixtures, per step (set when a version is activated). */
  activeOv: OverrideMap;
  snapshots: Record<string, OverrideMap>;
  /** Edits made on the step pages, not yet in an active version. */
  working: OverrideMap;
  saved: SavedVersion[];
  tests: Record<string, TestRecord>;
}

export function initialSlice(flow: FlowSeed, now: string): FlowRunSlice {
  const base = baseVersions(flow);
  const active = base.find((v) => v.status === 'active');
  const slice: FlowRunSlice = { activeN: active?.n ?? 0, activeOv: {}, snapshots: {}, working: {}, saved: [], tests: {} };
  const pendingFixture = base.find((v) => v.status === 'testing' && flow.id === 'pec');
  if (pendingFixture) {
    const record = simulate(flow, slice, pendingFixture.n, pendingFixture.overrides, pendingFixture.added, now);
    slice.tests[String(pendingFixture.n)] = record;
  }
  return slice;
}

export interface VersionInfo {
  n: number;
  status: 'active' | 'testing' | 'draft' | 'old';
  who: string;
  at: string;
  summary: string;
  overrides: OverrideMap;
  added: VersionSeed['added'];
  saved: boolean;
}

export function versionsOf(flow: FlowSeed, slice: FlowRunSlice): VersionInfo[] {
  const base = baseVersions(flow).map<VersionInfo>((v) => ({
    n: v.n, who: v.who, at: v.at, summary: v.summary, overrides: v.overrides, added: v.added, saved: false,
    status: v.n === slice.activeN ? 'active' : v.n < slice.activeN ? 'old' : v.status === 'active' ? 'old' : v.status,
  }));
  const saved = slice.saved.map<VersionInfo>((v) => ({
    n: v.n, who: v.who, at: v.at, summary: v.summary, overrides: v.overrides, added: [], saved: true,
    status: v.n === slice.activeN ? 'active' : v.n < slice.activeN ? 'old' : 'draft',
  }));
  return [...base, ...saved].sort((a, b) => b.n - a.n);
}

/* ---------- configuration of every step ---------- */

export function configOf(flow: FlowSeed, step: FlowStepSeed, ovs: OverrideMap[]): StepConfig {
  let cfg = stepConfig(flow, step);
  for (const m of ovs) cfg = applyOverride(cfg, m[step.id]);
  return cfg;
}

export function configMap(flow: FlowSeed, ovs: OverrideMap[]): Record<string, StepConfig> {
  return Object.fromEntries(flow.steps.map((s) => [s.id, configOf(flow, s, ovs)]));
}

/** The configuration a step page shows: the fixtures, the active version, then the edits not yet saved. */
export const currentConfig = (flow: FlowSeed, step: FlowStepSeed, slice: FlowRunSlice) => configOf(flow, step, [slice.activeOv, slice.working]);

/** What the working copy changes on the active version, step by step. */
export function workingChanges(flow: FlowSeed, slice: FlowRunSlice): StepChange[] {
  return flow.steps.flatMap((s) => changesOf(s.id, configOf(flow, s, [slice.activeOv]), slice.working[s.id]));
}

/** What a version changes on the active one. */
export function versionChanges(flow: FlowSeed, slice: FlowRunSlice, v: VersionInfo): StepChange[] {
  const fromActive = flow.steps.flatMap((s) => changesOf(s.id, configOf(flow, s, [slice.activeOv]), v.overrides[s.id]));
  return [...fromActive, ...v.added];
}

/* ---------- the test of a version ---------- */

const RISKY_BELOW = 80;

function thresholdOf(flow: FlowSeed, cfgs: Record<string, StepConfig>): number | null {
  for (const s of flow.steps) {
    const c = cfgs[s.id];
    if (c && (c.type === 'classify' || c.type === 'ai') && (s.kind === 'classify' || s.kind === 'ai')) return c.threshold;
  }
  return null;
}

/** Where a run goes under a set of configurations: to a person or on by itself. */
export function decide(flow: FlowSeed, cfgs: Record<string, StepConfig>, run: RunSeed): Outcome {
  const th = thresholdOf(flow, cfgs);
  if (th !== null && run.confidence < th) return 'person';
  const values = { fiducia: run.confidence, allegati: run.unreadable, mittente: run.senderListed, giorni: run.daysLeft, importo: run.amount };
  for (const s of flow.steps) {
    const c = cfgs[s.id];
    if (c?.type === 'rule' && c.routesToPerson && ruleHolds(c.conditions, c.fields, values)) return 'person';
  }
  return 'auto';
}

/** The runs a trial replays: yesterday's finished ones (2418, still waiting for the Legale since yesterday, is not one). */
export const finishedYesterday = (r: { day: string; status: string }): boolean => r.day === 'yesterday' && (r.status === 'done' || r.status === 'archived');

export function simulate(flow: FlowSeed, slice: FlowRunSlice, n: number, overrides: OverrideMap, added: VersionSeed['added'], now: string): TestRecord {
  const runs = runsOf(flow.id).filter(finishedYesterday);
  const before = configMap(flow, [slice.activeOv]);
  const after = configMap(flow, [slice.activeOv, overrides]);
  const startsFlow = added.some((a) => a.stepKind === 'send');
  const rows = runs.map((r) => {
    const b = decide(flow, before, r);
    let a = decide(flow, after, r);
    let change: TestChange = 'same';
    if (startsFlow && r.type === 'F') { a = 'flow'; change = 'new-flow'; }
    else if (b === a) change = 'same';
    else if (b === 'person' && a === 'auto') change = r.confidence < RISKY_BELOW ? 'risky' : 'better';
    else change = 'more-person';
    return { runId: r.id, before: b, after: a, change };
  });
  return { n, at: now, label: `${runs.length}`, total: runs.length, rows };
}

export function testSummary(t: TestRecord) {
  const count = (c: TestChange) => t.rows.filter((r) => r.change === c).length;
  return { same: count('same'), better: count('better'), risky: count('risky'), morePerson: count('more-person'), newFlow: count('new-flow') };
}

/* ---------- runs ---------- */

export interface RunOverride {
  status?: UiRunStatus;
  /** The step it is at now, when it moved on from the seed's (a resumed run that goes on to a person). */
  stepId?: string;
  /** When the robot went on, and from which step: that step and the next one are timed from then, not from the seed. */
  restartedAt?: string;
  restartedStep?: string;
  /** Attempts added after the ones the run came with, as `HH:mm`. */
  extraAttempts?: string[];
  /** When it finished, ISO, for a run that a retry freed. */
  finishedAt?: string;
  protocol?: string;
  events?: Array<{ at: string; text: string }>;
  notified?: Array<{ who: string; when: string }>;
  handedOver?: boolean;
}

export type RunOverrides = Record<string, RunOverride>;

/** The slice of what happened on the runs since the preview started. */
export const RUNS_SLICE = 'flowRunRuns';

export interface LiveRun extends RunSeed {
  live: RunOverride;
  baseStatus: UiRunStatus;
}

export function liveRun(seed: RunSeed, ov: RunOverrides): LiveRun {
  const o = ov[seed.id] ?? {};
  return {
    ...seed,
    status: o.status ?? seed.status,
    stepId: o.stepId ?? seed.stepId,
    protocol: o.protocol ?? seed.protocol,
    attempts: seed.attempts + (o.extraAttempts?.length ?? 0),
    live: o,
    baseStatus: seed.status,
  };
}

export function liveRunsOf(flowId: string, ov: RunOverrides): LiveRun[] {
  return runsOf(flowId).map((r) => liveRun(r, ov));
}

export function findRun(flowId: string, runId: string, ov: RunOverrides): LiveRun | undefined {
  const seed = runsOf(flowId).find((r) => r.id === runId);
  return seed ? liveRun(seed, ov) : undefined;
}

export type RunFilterKey = 'all' | 'running' | 'person' | 'error' | 'done';

export const filterOf = (status: UiRunStatus): RunFilterKey =>
  status === 'running' ? 'running' : status === 'person' ? 'person' : status === 'error' || status === 'blocked' ? 'error' : 'done';

/** The runs that wait on the same step as a stopped one: they are freed together. */
export function waitingWith(run: LiveRun, all: LiveRun[]): LiveRun[] {
  return all.filter((r) => r.id !== run.id && r.status === 'blocked' && r.stepId === run.stepId);
}

/* ---------- time ---------- */

const pad = (n: number) => String(n).padStart(2, '0');
export const clockTime = (iso: string) => iso.slice(11, 16);
export const dayOf = (iso: string) => iso.slice(0, 10);
export const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
export const minutesBetween = (fromIso: string, toIso: string) => Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000));

export const addMinutes = (iso: string, m: number): string => {
  const d = new Date(new Date(iso).getTime() + m * 60000);
  const local = new Date(d.getTime() + 3600000); // the demo clock is +01:00
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00+01:00`;
};

/** When a step of a run happened, as an ISO time: from the arrival, or from the moment it went on after waiting. */
export function stepTime(run: RunSeed | LiveRun, flow: FlowSeed, index: number): string {
  const pathIds = run.path;
  const live = 'live' in run ? run.live : undefined;
  if (live?.restartedAt && live.restartedStep) {
    const from = pathIds.indexOf(live.restartedStep);
    if (from >= 0 && index >= from) return live.restartedAt;
  }
  const personIdx = pathIds.findIndex((id) => flow.steps.find((s) => s.id === id)?.kind === 'person');
  if (run.resumedAt && personIdx >= 0) {
    return index <= personIdx ? addMinutes(run.arrived, index) : addMinutes(run.resumedAt, (index - personIdx) * 5);
  }
  const afterPerson = personIdx >= 0 && index > personIdx && run.personStepId ? 28 : 0;
  return addMinutes(run.arrived, index + afterPerson);
}

