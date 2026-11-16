/**
 * SUBAGENT-29. Closes the known debt of SUBAGENT-27: `remoteChildLogs` (`routes/terminal.ts`)
 * lives in memory, keyed by index. After a restart the map is empty again, and
 * the log is rebuilt from the node's own report with no history of how many
 * entries a caller already had — a `since` that happens to fall at or before
 * the rebuilt log's length reads as "still the same log", and the entries
 * before it are never sent again, silently.
 *
 * THE FIX IS AN EPOCH, not a bigger log: every process picks one at random
 * on boot, and every cursor this process hands out carries it, baked into the
 * same number (`epoch * SCALE + index`). A `since` from a PREVIOUS process
 * carries a different epoch (or none at all, `0` from a caller that never
 * read), and decodes back to index 0: the caller replays the log from the
 * start instead of silently missing its first entries. Showing something
 * twice is the known, accepted cost (see `subagent-remote-read.ts`); losing
 * it for good is not.
 */

/** Room for 10 million events in one child's log — far past anything a run produces. */
const SCALE = 10_000_000;

/** One random epoch per process boot, small enough that `epoch * SCALE` stays a safe integer. */
export function randomLogEpoch(): number {
  return Math.floor(Math.random() * 1_000_000);
}

/** The cursor a caller gets back: this epoch baked into the log's own index. */
export function encodeLogOffset(epoch: number, index: number): number {
  return epoch * SCALE + index;
}

/** The index to resume from: `0` when `since` carries a different epoch (or none) than this process's. */
export function decodeLogSince(epoch: number, since: number): number {
  const asked = Math.max(0, Math.trunc(since) || 0);
  return Math.floor(asked / SCALE) === epoch ? asked % SCALE : 0;
}
