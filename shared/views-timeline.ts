/**
 * The `timeline` view (GENUI-07): a plan in order, door to door. Each step has
 * an optional time, a means (bus, train, plane…), what it costs and how long
 * it takes, and up to three alternatives for the same leg (bus 32 min OR taxi
 * 47-53 €). Steps sharing a `day` are drawn under one heading.
 *
 * A step may be a `deadline` (the gate closes, the check-out): it is drawn as
 * a limit, not as something to do.
 */
import { z } from 'zod/mini';
import { asRecord, linkOf, priceOf, str, MAX_TITLE } from './views-util';

export const TIMELINE_MAX_STEPS = 24;
export const TIMELINE_MAX_ALTERNATIVES = 3;
export const STEP_MODES = ['walk', 'bus', 'train', 'metro', 'plane', 'taxi', 'car', 'boat', 'wait', 'stay', 'other'] as const;
export type StepMode = (typeof STEP_MODES)[number];

const priceSchema = z.object({ amount: z.number(), currency: z.string(), note: z.optional(z.string()) });

const alternativeSchema = z.object({
  title: z.string(),
  mode: z.optional(z.enum(STEP_MODES)),
  detail: z.optional(z.string()),
  duration: z.optional(z.string()),
  price: z.optional(priceSchema),
});

const stepSchema = z.object({
  title: z.string(),
  day: z.optional(z.string()),
  time: z.optional(z.string()),
  mode: z.optional(z.enum(STEP_MODES)),
  detail: z.optional(z.string()),
  duration: z.optional(z.string()),
  price: z.optional(priceSchema),
  deadline: z.optional(z.boolean()),
  alternatives: z.optional(z.array(alternativeSchema)),
  link: z.optional(z.object({ url: z.string(), label: z.optional(z.string()) })),
});

export const timelineViewSchema = z.object({
  view: z.literal('timeline'),
  title: z.string(),
  subtitle: z.optional(z.string()),
  verdict: z.optional(z.string()),
  steps: z.array(stepSchema),
});

export type TimelineAlternative = z.infer<typeof alternativeSchema>;
export type TimelineStep = z.infer<typeof stepSchema>;
export type TimelineViewSpec = z.infer<typeof timelineViewSchema>;

/** "8:05", "08.05" -> "08:05"; anything else is not a time. */
function timeOf(v: unknown): string | undefined | null {
  const s = str(v, 12);
  if (!s) return undefined;
  const m = s.match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

const modeOf = (v: unknown): StepMode | undefined =>
  typeof v === 'string' && (STEP_MODES as readonly string[]).includes(v) ? (v as StepMode) : undefined;

export function normalizeTimeline(raw: Record<string, unknown>, errors: string[]): TimelineViewSpec | null {
  const title = str(raw.title, MAX_TITLE);
  if (!title) errors.push("'title' (string) is required");
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (rawSteps.length < 1 || rawSteps.length > TIMELINE_MAX_STEPS) {
    errors.push(`'steps' must have 1-${TIMELINE_MAX_STEPS} items (got ${rawSteps.length})`);
  }
  const steps: TimelineStep[] = [];
  rawSteps.slice(0, TIMELINE_MAX_STEPS).forEach((st, i) => {
    const r = asRecord(st);
    const stitle = str(r.title, MAX_TITLE);
    if (!stitle) { errors.push(`steps[${i}].title (string) is required`); return; }
    const step: TimelineStep = { title: stitle };
    const day = str(r.day, 40);
    if (day) step.day = day;
    const time = timeOf(r.time);
    if (time === null) errors.push(`steps[${i}].time must be HH:MM (got '${String(r.time)}')`);
    else if (time) step.time = time;
    const mode = modeOf(r.mode);
    if (mode) step.mode = mode;
    const detail = str(r.detail, 200);
    if (detail) step.detail = detail;
    const duration = str(r.duration, 24);
    if (duration) step.duration = duration;
    const price = priceOf(r.price, r.price_note ?? r.priceNote);
    if (price) step.price = price;
    if (r.deadline === true) step.deadline = true;
    const link = linkOf(r.link ?? r.url);
    if (link) step.link = link;
    if (Array.isArray(r.alternatives)) {
      if (r.alternatives.length > TIMELINE_MAX_ALTERNATIVES) {
        errors.push(`steps[${i}].alternatives: at most ${TIMELINE_MAX_ALTERNATIVES} (got ${r.alternatives.length})`);
      }
      const alts = r.alternatives.slice(0, TIMELINE_MAX_ALTERNATIVES).map((a): TimelineAlternative | null => {
        const ar = asRecord(a);
        const atitle = str(ar.title, 80);
        if (!atitle) return null;
        const alt: TimelineAlternative = { title: atitle };
        const amode = modeOf(ar.mode);
        if (amode) alt.mode = amode;
        const adetail = str(ar.detail, 160);
        if (adetail) alt.detail = adetail;
        const adur = str(ar.duration, 24);
        if (adur) alt.duration = adur;
        const aprice = priceOf(ar.price, ar.price_note ?? ar.priceNote);
        if (aprice) alt.price = aprice;
        return alt;
      }).filter((x): x is TimelineAlternative => !!x);
      if (alts.length) step.alternatives = alts;
    }
    steps.push(step);
  });
  if (errors.length || !title) return null;
  const spec: TimelineViewSpec = { view: 'timeline', title, steps };
  const subtitle = str(raw.subtitle);
  if (subtitle) spec.subtitle = subtitle;
  const verdict = str(raw.verdict);
  if (verdict) spec.verdict = verdict;
  return spec;
}

/** Consecutive steps with the same `day`, in order. A step without a day joins the group before it. Pure. */
export function groupStepsByDay(steps: readonly TimelineStep[]): Array<{ day?: string; steps: TimelineStep[] }> {
  const groups: Array<{ day?: string; steps: TimelineStep[] }> = [];
  for (const s of steps) {
    const last = groups[groups.length - 1];
    if (last && (!s.day || s.day === last.day)) last.steps.push(s);
    else groups.push({ day: s.day, steps: [s] });
  }
  return groups;
}
