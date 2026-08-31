/**
 * HOW HEAVY THE MACHINE IS, AS ONE NUMBER AND ONE COLOUR.
 *
 * The foot of the column used to spell it out: megabytes, a percentage and a
 * frame rate, three readouts on a strip nobody looked at until something was
 * already wrong. Those numbers did not move to a smaller font, they moved into
 * the "Topics" menu, and what stays in sight is a dot next to the word
 * "Topics". A dot cannot say 1.5 GB, and it does not have to: the question you
 * ask a hundred times a day is not "how many megabytes" but "is this thing
 * fine right now", and that question has a colour for an answer.
 *
 * ── WHY A RAMP AND NOT THREE STATES ─────────────────────────────────────────
 * Green, amber, red is the shape the old strip used, and it lies twice. Once
 * at each edge: at 49% and 51% of a threshold the machine is doing the same
 * thing and the dot says two different words. And once in the middle, because
 * "amber" covers everything between comfortable and about to swap, which is
 * most of a working day. A continuous hue has no edges to sit on: it moves
 * while the load moves, so what you read is the DIRECTION, which is the part
 * that lets you catch a runaway before it is a problem.
 *
 * ── WHY THE NUMBER IS A MAXIMUM AND NOT AN AVERAGE ──────────────────────────
 * Memory and CPU do not share a scale and they do not compensate. A machine at
 * 95% CPU and 10% of its memory budget is a busy machine, and averaging the two
 * would report it as half calm. The load is therefore the WORST of the parts
 * that are actually measured: a part nobody could measure (the phone does not
 * expose its processes) is left out of the maximum instead of counted as zero,
 * which would be an invented reassurance.
 *
 * The frame rate is deliberately NOT in the maximum. It is a measure of this
 * window, not of the machine, and it collapses for reasons that have nothing to
 * do with load (a hidden window, a video decoding elsewhere). It stays in the
 * words the dot spells out on hover.
 */

/** What the ramp is fed. Every field is nullable, because "not measured" is a
 *  real answer here and it is not the same as zero. */
export interface LoadInput {
  /** Percent of the whole machine, as `computeTopicsFootprint` totals it. */
  cpu: number | null;
  /** Megabytes Topics holds, all of it: shell, panes, server, agents. */
  memMB: number | null;
  /** The megabytes at which memory counts as fully loaded. The caller owns this
   *  because the honest ceiling depends on which halves it could measure. */
  memCeilingMB: number;
}

/** Where the CPU stops being interesting. Past this the machine is busy and the
 *  exact figure changes nothing about what you would do next, so the ramp
 *  saturates rather than spending half its range on numbers nobody acts on. */
export const CPU_CEILING = 80;

/**
 * The load, from 0 (idle) to 1 (as loud as this ramp goes).
 *
 * Nothing measured at all gives 0 and not `null`: the dot is always drawn, so a
 * `null` would only push the same decision one level up. What it does instead
 * is answer `misurato: false`, and the caller says so in words.
 */
export function loadLevel(input: LoadInput): { livello: number; misurato: boolean } {
  const parts: number[] = [];
  if (input.cpu !== null) parts.push(clamp01(input.cpu / CPU_CEILING));
  if (input.memMB !== null && input.memCeilingMB > 0) parts.push(clamp01(input.memMB / input.memCeilingMB));
  if (parts.length === 0) return { livello: 0, misurato: false };
  return { livello: Math.max(...parts), misurato: true };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * The colour of a load, as a CSS colour string.
 *
 * ── WHY AN INLINE COLOUR AND NOT A TOKEN ────────────────────────────────────
 * Every other tint in the chrome is a token, and this one cannot be: a token is
 * a fixed value, and the whole point here is that the value is continuous. A
 * ramp expressed as ten tokens is ten discrete states with extra steps.
 *
 * ── WHY THESE NUMBERS READ ON BOTH THEMES ───────────────────────────────────
 * The dot sits on `--chrome-bg`, which is near white in light and near black in
 * dark, so a fill has to be far enough from BOTH. Saturation stays high and
 * lightness stays mid (around 45%): a mid-lightness saturated hue is the one
 * band that separates from white and from black at once, which is exactly why
 * traffic lights are painted in it. Lightness rises slightly with the load so
 * the hot end also gains weight, not just hue: colour-blind eyes read the
 * brightness step when they cannot read green against red.
 *
 * The hue goes 150 (green) to 0 (red) THROUGH amber, which is the direction the
 * eye already reads as "getting worse" without a legend.
 */
export function loadTint(livello: number): string {
  const l = clamp01(livello);
  const hue = 150 - 150 * l;
  const sat = 62 + 18 * l;
  const light = 42 + 6 * l;
  return `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
}

/**
 * Which of the three words a level lands on. The dot itself has no steps, but
 * the sentence it carries on hover does: a hue is not a number, and somebody
 * has to be able to say out loud what they are looking at. It is also what an
 * end-to-end test can assert without sampling a pixel.
 */
export type LoadWord = 'calmo' | 'caldo' | 'carico';

export function loadWord(livello: number): LoadWord {
  const l = clamp01(livello);
  if (l < 0.45) return 'calmo';
  if (l < 0.75) return 'caldo';
  return 'carico';
}
