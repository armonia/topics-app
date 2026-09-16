/**
 * The one `/bin/ps` behind `memory-owners.ts`, on the beat that already exists.
 *
 * ONE READ A MINUTE, NEVER ONE PER CARD: seven held cards asking the machine
 * who is holding the memory would be seven forks a retry on the machine that is
 * already short of it. The dispatcher's 10 s beat already prints `[memsig]` once
 * a minute; this hangs off that same minute, and every held card reads the
 * answer it left behind.
 *
 * ABSOLUTE PATH, for the reason PR #69 wrote down: under launchd the PATH has
 * neither `/usr/sbin` nor, reliably, `/bin`.
 */
import { captureWithDeadline } from "../lib/bounded-capture";
import { responsiblePid } from "../lib/fleet-usage";
import { memoryOwners, parsePsMemRows, type MemoryFamily } from "./memory-owners";

export const PS_BIN = "/bin/ps";
/** The same deadline the freezer's probes use: the machine this runs on is the thrashing one. */
const PS_TIMEOUT_MS = 4_000;
/**
 * Past this the list is not shown at all.
 *
 * It names apps to quit, and a name three minutes old can be an app the person
 * has already quit - which turns the one actionable sentence on the card into a
 * wrong instruction. Silence is the honest fallback: the floor's sentence stood
 * on its own before this existed.
 */
export const OWNERS_STALE_MS = 180_000;

export interface MemoryOwnersReader {
  sample(): Promise<void>;
  /** The last list, or `[]` when there is none or it is stale. */
  latest(): MemoryFamily[];
}

export function createMemoryOwnersReader(deps: {
  selfPid: number;
  /** Read at sample time, not at boot: the worktrees directory is known later than this reader. */
  ourMarkers: () => readonly string[];
  now?: () => number;
  read?: () => Promise<string | null>;
  ownerOf?: (pid: number) => number | null;
  measurable?: boolean;
}): MemoryOwnersReader {
  const now = deps.now ?? Date.now;
  const measurable = deps.measurable ?? process.platform === "darwin";
  const read = deps.read ?? (async () => {
    const got = await captureWithDeadline([PS_BIN, "-Ao", "pid=,ppid=,rss=,command="], PS_TIMEOUT_MS);
    return got === null ? null : got.text;
  });
  const ownerOf = deps.ownerOf ?? responsiblePid;
  let last: { at: number; families: MemoryFamily[] } | null = null;
  let inFlight: Promise<void> | null = null;
  return {
    // Single-flight for the reason `createMemSignal` is: under thrash a fork
    // takes seconds, and a stacked probe costs the memory we are measuring.
    sample() {
      if (!measurable) return Promise.resolve();
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const text = await read();
          // A mute `ps` keeps the previous list until it goes stale: it is the
          // shape of a machine in swap, not of a machine with nothing to name.
          if (text === null) return;
          last = {
            at: now(),
            families: memoryOwners({
              rows: parsePsMemRows(text),
              selfPid: deps.selfPid,
              ourMarkers: deps.ourMarkers(),
              ownerOf,
            }),
          };
        } catch { /* same as a mute ps */ } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    latest: () => (last && now() - last.at < OWNERS_STALE_MS ? last.families : []),
  };
}
