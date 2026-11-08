/**
 * Logs a recurring line only when its text changes, plus a slow heartbeat.
 *
 * A periodic sweep that prints its state every tick writes the same line 1,440
 * times a day when nothing moves. The heartbeat keeps "it looked and nothing
 * changed" distinguishable from "it did not look" without printing every minute.
 *
 * `null` or an empty text forgets the key, so a state that returns after a clean
 * pass is printed again. The clock and the sink are injectable for tests; the
 * defaults read `Date.now()` and `console.log` at call time, so a spy installed
 * after this module loads still sees the lines.
 */
const HEARTBEAT_MS = 30 * 60_000;

export function createChangeLogger(
  log: (line: string) => void = (line) => console.log(line),
  now: () => number = () => Date.now(),
  heartbeatMs: number = HEARTBEAT_MS,
): (key: string, text: string | null) => void {
  const lastPrinted = new Map<string, { text: string; at: number }>();
  return function logOnChange(key, text) {
    if (!text) {
      lastPrinted.delete(key);
      return;
    }
    const at = now();
    const prev = lastPrinted.get(key);
    if (prev && prev.text === text && at - prev.at < heartbeatMs) return;
    log(text);
    lastPrinted.set(key, { text, at });
  };
}
