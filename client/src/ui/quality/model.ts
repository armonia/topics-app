import type { Tone } from '../types';

export interface QualityKpiModel {
  id: string;
  label: string;
  value: string;
  detail: string;
  tone?: Tone;
}

export interface DimensionRowModel {
  id: string;
  name: string;
  means: string;
  /** The check that stands for it, in the words of the sector. */
  example: string;
  pctText: string;
  tone: Tone;
  /** Checks that weigh on the score / checks it has. */
  on: number;
  total: number;
}

export interface CheckRowModel {
  id: string;
  label: string;
  where: string;
  dimension: string;
  scope: string;
  pctText: string;
  tone: Tone;
  /** «on 5 example rows», «example». */
  basis: string;
  on: boolean;
  /** The cases that failed it, for the line under the label. */
  failing: number;
}

export interface OddityRowModel {
  id: string;
  title: string;
  where: string;
  summary: string;
  statusText: string;
  statusTone: Tone;
  /** The stage: stopped, decided by a person, or settled alone. */
  waiting: boolean;
}

export interface OriginalModel {
  title: string;
  tag: string;
  detail: string;
  rows: Array<{ label: string; value: string; flag?: boolean }>;
}

export interface QuarantineModel {
  title: string;
  checkLabel: string;
  headline: string;
  why: string;
  risk: string;
  left: OriginalModel;
  right: OriginalModel;
  held: { title: string; body: string };
  history: Array<{ id: string; at: string; text: string }>;
  unblockers: Array<{ who: string; may: string }>;
  /** What happened to it: a decision, a question sent, or settled by itself. */
  outcome?: { tone: Tone; text: string; at: string };
  receipt?: { title: string; lines: string[] };
}
