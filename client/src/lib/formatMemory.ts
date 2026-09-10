/**
 * ONE WAY TO WRITE A NUMBER OF MEGABYTES, for every surface that writes one.
 *
 * There were four, and they lived in four files: `1.8GB` on the identity card
 * and on the row that opens the status level, `1.8 GB` in the load dot's
 * tooltip, `1834 MB` inside the performance tooltip, `1234MB` in the two tiles
 * under it. The same footprint, in one gesture, spelled three ways - which is
 * the reason the total on the row does not read as the sum of the two tiles
 * below it. A reader does not compare numbers that are not written alike.
 *
 * THE RULE: gigabytes past a thousand, one decimal, always a space before the
 * unit. Four digits of memory glued to a name read as a phone number, which is
 * why the threshold exists; and the space is what lets `tabular-nums` line the
 * digits up in a column instead of the unit doing it.
 *
 * THE PARTIAL SIGN IS NOT A CHARACTER HERE. A leading `~` was the only
 * abbreviation on the panel and nothing on the panel explained it (the legend
 * lived in another surface's tooltip), so a tilde glued to a digit reads as a
 * typo. Surfaces that must say "this covers one half of the app" say it in
 * words, next to the figure - see `perf.partialReading`. The narrow chips that
 * have no room for a word keep the sign, and pass `partial: true` to get it.
 */

/** How many megabytes before switching to gigabytes. Below it the decimal
 *  would be noise; above it the digit count is what stops being readable. */
const GB = 1024;

export function formatMemoryMB(mb: number, opts?: { partial?: boolean }): string {
  const text = mb >= GB ? `${(mb / GB).toFixed(1)} GB` : `${mb} MB`;
  return opts?.partial ? `~${text}` : text;
}
