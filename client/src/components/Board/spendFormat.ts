/**
 * How agent spend is WRITTEN, in one place.
 *
 * Two surfaces show the same number (the chip in the board header and the panel
 * in the settings), and until this module existed they held two byte-identical
 * copies of the same formatter. Two copies of a rule about money is how one
 * surface starts rounding differently from the other.
 *
 * It is a plain module and not a block at the top of a component, for the reason
 * `react-refresh/only-export-components` states: a file that exports both a
 * component and a helper loses fast refresh for everything that imports it.
 */

/** Cents to dollars. Above one hundred dollars the cents are noise. */
export function spendLabel(cents: number): string {
  const v = cents / 100;
  return v >= 100 ? `$${Math.round(v).toLocaleString('it-IT')}` : `$${v.toFixed(2)}`;
}

/**
 * What a cap box shows: whole dollars, and EMPTY when there is no cap.
 *
 * Zero is not a cap, it is the absence of one, so it must not appear in the box
 * as a number somebody could read as "capped at nothing".
 */
export function capBoxValue(cents: number): string {
  return cents > 0 ? String(Math.round(cents / 100)) : '';
}
