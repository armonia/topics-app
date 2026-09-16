/**
 * NO PID IS EVER SIGSTOPPED UNLESS IT IS ALREADY ON DISK.
 *
 * A stopped process is continued by exactly one thing - this server - and a
 * SIGKILL (`launchctl kickstart -k`, a crash, a machine that runs out of memory
 * while we are deciding) takes that one thing away mid-signal. What is left is a
 * tree STOPped forever, holding its memory and its gate slot, with nobody who
 * even knows its pids. So the ledger is written BEFORE every batch of signals,
 * not after: a crash between the write and the signal leaves a recorded pid that
 * is merely running, and a SIGCONT to a running process is harmless.
 *
 * TWO SECTIONS, because they answer two questions with different lifetimes.
 * `active` is "who is stopped right now" and loses a tree only after its SIGCONT.
 * `counts` is "how many times has this tree been frozen", which has to survive
 * the thaw AND a reload - otherwise "at most two freezes per tree" resets every
 * time the server restarts, and a tree could be frozen forever in instalments.
 * A count is forgotten when its root pid is no longer on the machine, which the
 * freezer checks against the table of every beat (`pruneCounts`).
 *
 * IDENTITY, NOT NUMBERS. Every recorded pid carries its `lstart`: a pid can be
 * recycled while the server is away, and a SIGCONT by number alone would be sent
 * to whatever now holds it. A mismatch at boot is skipped and said out loud.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, existsSync } from "fs";
import { dirname } from "path";

export interface LedgerPidRef {
  pid: number;
  /** `ps -o lstart=`: the same pid started at another time is another process. */
  lstart: string;
}

export interface LedgerBatch {
  groups: { pgid: number; leaderLstart: string }[];
  pids: LedgerPidRef[];
}

export interface LedgerTree {
  treeId: string;
  sessionKey: string;
  frozenAt: number;
  root: LedgerPidRef;
  batches: LedgerBatch[];
}

export interface LedgerCount {
  root: LedgerPidRef;
  n: number;
  lastFrozenAt: number;
}

export interface LedgerFile {
  v: 1;
  active: LedgerTree[];
  counts: LedgerCount[];
}

const EMPTY: LedgerFile = { v: 1, active: [], counts: [] };

export interface LedgerIo {
  /** The file's text, or `null` when there is none. */
  read: () => string | null;
  /** Atomic: tmp, fsync, rename. */
  write: (text: string) => void;
  log: (line: string) => void;
}

export interface SwapFreezeLedger {
  snapshot(): LedgerFile;
  /** Opens a tree with no batches yet. */
  begin(tree: Omit<LedgerTree, "batches">): void;
  /** Records a batch and flushes it. The caller signals only after this returns. */
  addBatch(treeId: string, batch: LedgerBatch): void;
  /** After the SIGCONT of the whole tree. */
  release(treeId: string): void;
  freezeCount(root: LedgerPidRef): number;
  bumpCount(root: LedgerPidRef, at: number): number;
  /** Drops counts whose root identity is gone. */
  pruneCounts(alive: (ref: LedgerPidRef) => boolean): void;
  /** Empties `active` without signalling: the boot thaw has already acted. */
  clearActive(): void;
}

const sameRef = (a: LedgerPidRef, b: LedgerPidRef): boolean => a.pid === b.pid && a.lstart === b.lstart;

export function createSwapFreezeLedger(io: LedgerIo): SwapFreezeLedger {
  let state: LedgerFile = readLedger(io);
  const flush = (): void => {
    try { io.write(JSON.stringify(state)); }
    catch (err) { io.log(`[freeze] ledger write failed: ${String(err)}`); }
  };
  return {
    snapshot: () => structuredClone(state),
    begin(tree) {
      state.active = state.active.filter((t) => t.treeId !== tree.treeId);
      state.active.push({ ...tree, batches: [] });
      flush();
    },
    addBatch(treeId, batch) {
      const tree = state.active.find((t) => t.treeId === treeId);
      if (!tree) throw new Error(`[freeze] batch for an unopened tree ${treeId}`);
      tree.batches.push(batch);
      flush();
    },
    release(treeId) {
      state.active = state.active.filter((t) => t.treeId !== treeId);
      flush();
    },
    freezeCount: (root) => state.counts.find((c) => sameRef(c.root, root))?.n ?? 0,
    bumpCount(root, at) {
      const found = state.counts.find((c) => sameRef(c.root, root));
      if (found) { found.n += 1; found.lastFrozenAt = at; flush(); return found.n; }
      state.counts.push({ root, n: 1, lastFrozenAt: at });
      flush();
      return 1;
    },
    pruneCounts(alive) {
      const kept = state.counts.filter((c) => alive(c.root));
      if (kept.length === state.counts.length) return;
      state.counts = kept;
      flush();
    },
    clearActive() {
      if (state.active.length === 0) return;
      state.active = [];
      flush();
    },
  };
}

function readLedger(io: LedgerIo): LedgerFile {
  let text: string | null;
  try { text = io.read(); } catch (err) { io.log(`[freeze] ledger unreadable: ${String(err)}`); return structuredClone(EMPTY); }
  if (!text) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(text) as LedgerFile;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.active) || !Array.isArray(parsed.counts)) {
      io.log("[freeze] ledger unreadable: not a v1 ledger; nothing signalled");
      return structuredClone(EMPTY);
    }
    return parsed;
  } catch (err) {
    io.log(`[freeze] ledger unreadable: ${String(err)}; nothing signalled`);
    return structuredClone(EMPTY);
  }
}

export interface BootThawDeps {
  ledger: SwapFreezeLedger;
  /** `ps -o pid=,lstart=` for the recorded pids; `null` when `ps` did not answer. */
  lstartOf: (pids: number[]) => Promise<Map<number, string> | null>;
  signal: (pid: number, sig: "SIGCONT") => void;
  log: (line: string) => void;
}

/**
 * EVERY TREE THE PREVIOUS SERVER LEFT STOPPED IS CONTINUED BEFORE ANYTHING ELSE
 * STARTS, and only where the identity still matches. Batches are undone in
 * reverse (leaves first, the root's group last), the same order an ordinary thaw
 * uses: two ways of undoing one list is how the two start disagreeing.
 *
 * A `ps` THAT SAYS NOTHING IS NOT A LIST OF RECYCLED PIDS. When `lstartOf`
 * answers `null` the identities cannot be checked, so every recorded pid is
 * continued anyway - a SIGCONT to a process that is merely running does nothing -
 * and the ledger is KEPT: it is the last copy of those pids, and clearing it
 * would leave a stopped tree with nobody who knows its numbers, which is the one
 * outcome this file exists to prevent.
 */
export async function thawLedgerAtBoot(deps: BootThawDeps): Promise<{ continued: number; skipped: number }> {
  const { active } = deps.ledger.snapshot();
  if (active.length === 0) return { continued: 0, skipped: 0 };
  const recorded = new Map<number, string>();
  for (const tree of active) {
    for (const batch of tree.batches) {
      for (const p of batch.pids) recorded.set(p.pid, p.lstart);
      for (const g of batch.groups) recorded.set(g.pgid, g.leaderLstart);
    }
  }
  const live = await deps.lstartOf([...recorded.keys()]).catch(() => null);
  const matches = (pid: number, lstart: string): boolean => live === null || live.get(pid) === lstart;
  let continued = 0;
  let skipped = 0;
  for (const tree of active) {
    for (const batch of [...tree.batches].reverse()) {
      // Leaves first INSIDE the batch as well, which is what the ordinary thaw
      // does (`swap-freeze.ts`): the claim above is only true if both walks are.
      for (const p of [...batch.pids].reverse()) {
        if (!matches(p.pid, p.lstart)) { skipped++; continue; }
        try { deps.signal(p.pid, "SIGCONT"); continued++; } catch { /* gone between the read and the signal */ }
      }
      for (const g of batch.groups) {
        if (!matches(g.pgid, g.leaderLstart)) { skipped++; continue; }
        try { deps.signal(-g.pgid, "SIGCONT"); } catch { /* the group is gone */ }
      }
    }
  }
  if (live !== null) deps.ledger.clearActive();
  deps.log(
    `[freeze] boot: continued ${continued} pids of ${active.length} tree(s) left by the previous server` +
    (live === null
      ? "; ps did not answer, so nothing was checked and the ledger is kept for the next boot"
      : ` (${skipped} skipped: recycled)`),
  );
  return { continued, skipped };
}

/** The production IO: one file under the data dir, written tmp + fsync + rename. */
export function fileLedgerIo(path: string, log: (line: string) => void): LedgerIo {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf8") : null),
    write: (text) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, text);
      const fd = openSync(tmp, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, path);
    },
    log,
  };
}
