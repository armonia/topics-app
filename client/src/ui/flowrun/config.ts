/**
 * What a step of a flow is configured with, and what the reader may change.
 * A step has a base configuration (the active version); the reader's edits
 * are a `StepOverride` laid on top (`applyOverride`), and what differs between
 * the two is a list of `StepChange`s (`changesOf`), which is what a new
 * version records and the comparison of versions draws. Pure data and pure
 * functions: no state of its own.
 */
import type { FieldRef } from '../types';
import type {
  ClassifyType, Condition, ConditionField, ConditionSample, FieldDef, PreRule, RobotStepModel, RunBars, StepKind,
} from './model';

export interface ClassifyConfig {
  type: 'classify';
  takes: Array<{ field: FieldRef; from: string }>;
  gives: Array<{ field: FieldRef; note: string }>;
  types: ClassifyType[];
  preRules: PreRule[];
  corrections: Array<{ id: string; label: string; n: number }>;
  threshold: number;
  /** Percent of items below a threshold, a stima: [threshold, percent] pairs, rising. */
  calibration: Array<[number, number]>;
  /** Knowledge the step reads. */
  knowledge: string[];
}

export interface AiConfig {
  type: 'ai';
  prompt: string;
  knowledge: string[];
  knowledgePool: string[];
  fields: FieldDef[];
  threshold: number;
  calibration: Array<[number, number]>;
  corrections: number;
  lastCorrection: string;
  model: string;
  region: string;
  personalData: string;
  cost: string;
  lastTest: { label: string; same: number; diffs: Array<{ id: string; label: string; n: number }> };
}

export interface RuleConfig {
  type: 'rule';
  question: string;
  thenLabel: string;
  elseLabel: string;
  /** Conditions that send an item to a person count in the test of a version. */
  routesToPerson: boolean;
  conditions: Condition[];
  fields: ConditionField[];
  table: { name: string; items: string[] };
}

export interface RobotConfig {
  type: 'robot';
  program: string;
  title: string;
  intro: string;
  user: string;
  vault: string;
  where: string;
  hours: string;
  offHours: string;
  oneAtATime: boolean;
  retries: number;
  everyMin: number;
  then: string;
  notify: string;
  steps: RobotStepModel[];
  checks: string;
  runs: RunBars;
}

export interface GenericConfig {
  type: 'generic';
  office: string;
  hours: number;
  note: string;
  uses: FieldRef[];
  produces: FieldRef[];
  opens?: string;
}

export type StepConfig = ClassifyConfig | AiConfig | RuleConfig | RobotConfig | GenericConfig;

/** What the reader changed on a step, on top of its base configuration. */
export interface StepOverride {
  threshold?: number;
  prompt?: string;
  knowledge?: string[];
  fields?: FieldDef[];
  conditions?: Condition[];
  typeWhen?: Record<string, string>;
  preRules?: PreRule[];
  robot?: Partial<Pick<RobotConfig, 'hours' | 'offHours' | 'oneAtATime' | 'retries' | 'everyMin' | 'then' | 'notify'>>;
  generic?: Partial<Pick<GenericConfig, 'office' | 'hours' | 'note'>>;
}

export function applyOverride(base: StepConfig, ov: StepOverride | undefined): StepConfig {
  if (!ov) return base;
  switch (base.type) {
    case 'classify':
      return {
        ...base,
        threshold: ov.threshold ?? base.threshold,
        knowledge: ov.knowledge ?? base.knowledge,
        preRules: ov.preRules ?? base.preRules,
        types: ov.typeWhen ? base.types.map((t) => (ov.typeWhen?.[t.id] !== undefined ? { ...t, when: ov.typeWhen[t.id] } : t)) : base.types,
      };
    case 'ai':
      return {
        ...base,
        threshold: ov.threshold ?? base.threshold,
        prompt: ov.prompt ?? base.prompt,
        knowledge: ov.knowledge ?? base.knowledge,
        fields: ov.fields ?? base.fields,
      };
    case 'rule':
      return { ...base, conditions: ov.conditions ?? base.conditions };
    case 'robot':
      return { ...base, ...(ov.robot ?? {}) };
    case 'generic':
      return { ...base, ...(ov.generic ?? {}) };
  }
}

/** A line of what a version changes, in words a copy catalogue turns into a sentence. */
export type StepChange =
  | { kind: 'threshold'; stepId: string; from: number; to: number }
  | { kind: 'prompt'; stepId: string }
  | { kind: 'knowledge'; stepId: string; added: string[]; removed: string[] }
  | { kind: 'fields'; stepId: string; added: string[]; removed: string[] }
  | { kind: 'conditions'; stepId: string; added: number; removed: number; edited: number }
  | { kind: 'types'; stepId: string; ids: string[] }
  | { kind: 'preRules'; stepId: string; added: number; removed: number }
  | { kind: 'robot'; stepId: string; keys: string[] }
  | { kind: 'generic'; stepId: string; keys: string[] }
  | { kind: 'added'; after: string; stepKind: StepKind; program?: string; title: string; note?: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

/** What an override changes compared with the base it is laid on. */
export function changesOf(stepId: string, base: StepConfig, ov: StepOverride | undefined): StepChange[] {
  if (!ov) return [];
  const out: StepChange[] = [];
  const next = applyOverride(base, ov);
  if ((base.type === 'classify' || base.type === 'ai') && next.type === base.type && next.threshold !== base.threshold) {
    out.push({ kind: 'threshold', stepId, from: base.threshold, to: next.threshold });
  }
  if (base.type === 'ai' && next.type === 'ai') {
    if (next.prompt !== base.prompt) out.push({ kind: 'prompt', stepId });
    const fa = minus(next.fields.map((f) => f.name), base.fields.map((f) => f.name));
    const fr = minus(base.fields.map((f) => f.name), next.fields.map((f) => f.name));
    if (fa.length || fr.length) out.push({ kind: 'fields', stepId, added: fa, removed: fr });
  }
  if ((base.type === 'ai' || base.type === 'classify') && next.type === base.type) {
    const ka = minus(next.knowledge, base.knowledge);
    const kr = minus(base.knowledge, next.knowledge);
    if (ka.length || kr.length) out.push({ kind: 'knowledge', stepId, added: ka, removed: kr });
  }
  if (base.type === 'classify' && next.type === 'classify') {
    const ids = base.types.filter((t, i) => t.when !== next.types[i].when).map((t) => t.letter);
    if (ids.length) out.push({ kind: 'types', stepId, ids });
    const pa = next.preRules.filter((r) => !base.preRules.some((b) => b.id === r.id)).length;
    const pr = base.preRules.filter((r) => !next.preRules.some((b) => b.id === r.id)).length;
    if (pa || pr) out.push({ kind: 'preRules', stepId, added: pa, removed: pr });
  }
  if (base.type === 'rule' && next.type === 'rule') {
    const added = next.conditions.filter((c) => !base.conditions.some((b) => b.id === c.id)).length;
    const removed = base.conditions.filter((c) => !next.conditions.some((b) => b.id === c.id)).length;
    const edited = next.conditions.filter((c) => base.conditions.some((b) => b.id === c.id && !same(b, c))).length;
    if (added || removed || edited) out.push({ kind: 'conditions', stepId, added, removed, edited });
  }
  if (base.type === 'robot' && next.type === 'robot') {
    const keys = (Object.keys(ov.robot ?? {}) as Array<keyof NonNullable<StepOverride['robot']>>).filter((k) => !same(base[k], next[k]));
    if (keys.length) out.push({ kind: 'robot', stepId, keys });
  }
  if (base.type === 'generic' && next.type === 'generic') {
    const keys = (Object.keys(ov.generic ?? {}) as Array<keyof NonNullable<StepOverride['generic']>>).filter((k) => !same(base[k], next[k]));
    if (keys.length) out.push({ kind: 'generic', stepId, keys });
  }
  return out;
}

/** The percentage a calibration table gives for a threshold: a straight line between its points. */
export function belowPercent(calibration: Array<[number, number]>, threshold: number): number {
  if (!calibration.length) return 0;
  const points = [...calibration].sort((a, b) => a[0] - b[0]);
  if (threshold <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (threshold <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      return Math.round(y0 + ((y1 - y0) * (threshold - x0)) / (x1 - x0));
    }
  }
  return points[points.length - 1][1];
}

/** One item the conditions are tried on: a sample row, with the values the fields read. */
export function conditionHolds(c: Condition, field: ConditionField | undefined, values: ConditionSample['values']): boolean {
  if (!field) return false;
  const v = values[field.id];
  if (c.op === 'in') return v === true;
  if (typeof v !== 'number') return false;
  const n = Number(c.value);
  if (Number.isNaN(n)) return false;
  switch (c.op) {
    case 'lt': return v < n;
    case 'gt': return v > n;
    case 'gte': return v >= n;
    case 'eq': return v === n;
    default: return false;
  }
}

/** A rule goes to the `then` side when at least one condition holds. */
export function ruleHolds(conditions: Condition[], fields: ConditionField[], values: ConditionSample['values']): boolean {
  return conditions.some((c) => conditionHolds(c, fields.find((f) => f.id === c.field), values));
}
