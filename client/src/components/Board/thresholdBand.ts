/**
 * The guide bar under a threshold slider: the shared band function, painted.
 *
 * Its own module and not a helper inside `GlobalCapControl.tsx` because that file
 * exports a component, and Fast Refresh wants component files to export only
 * components (`react-refresh/only-export-components`). The test imports it from
 * here for the same reason.
 */
import type { ThresholdBand } from '../../lib/board';

/** The paint of each band on the slider's guide bar. Translucent on purpose so
 *  it reads as a guide under the thumb, not as a filled progress track. */
const BAND_PAINT: Record<ThresholdBand, string> = {
  green: 'rgb(16 185 129 / 0.55)',
  amber: 'rgb(245 158 11 / 0.55)',
  red: 'rgb(244 63 94 / 0.55)',
};

/**
 * SAMPLED, NOT TRANSCRIBED. The breakpoints (0.35, 0.6, 1.2, 1.6 for load) live
 * in `shared/board.ts` and nowhere else; sampling the function along the
 * slider's own range means a change there repaints the bar with no edit here.
 * Sixty samples over a 56-step slider: every stop lands within one step.
 */
export function bandGradient(min: number, max: number, band: (ratio: number) => ThresholdBand): string {
  const steps = 60;
  const stops: string[] = [];
  let current: ThresholdBand | null = null;
  let from = 0;
  for (let i = 0; i <= steps; i++) {
    const pct = (i / steps) * 100;
    const b = band(min + ((max - min) * i) / steps);
    if (b !== current) {
      if (current) stops.push(`${BAND_PAINT[current]} ${from.toFixed(1)}% ${pct.toFixed(1)}%`);
      current = b;
      from = pct;
    }
  }
  if (current) stops.push(`${BAND_PAINT[current]} ${from.toFixed(1)}% 100%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
