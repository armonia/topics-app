/**
 * WHO PAYS FOR EACH PROCESS: the pure half of the per-session consumption.
 *
 * Topics launches a lot of processes on behalf of its sessions (the agent's
 * CLI, the tools it runs, a test suite, a headless browser) and keeps a few
 * that every session uses at once (the server, the terminal bridge, the AI
 * bridge). This module takes ONE process table and decides, for every
 * process, whose it is. No I/O and no module state: the test drives it with a
 * synthetic table.
 *
 * THE RULE, and it is the whole contract:
 *
 *  1. A process belongs to the NEAREST session head above it (itself
 *     included). A head is the pid Topics registered for a session: the
 *     terminal's root, the CLI of a chat, a command the native runtime
 *     started, a script a session launched. "Nearest" is what keeps a
 *     sub-agent's tree out of its coordinator's: the card folds them together
 *     later, by unit, never by counting a pid twice.
 *  2. A process with no head above it but a SHARED ROOT (the server, a
 *     bridge) belongs to that root's bucket. The bucket is split in EQUAL
 *     slices between the sessions that use the root: for a bridge, those whose
 *     head sits under it; for the server, every live session. A root nobody
 *     uses stays unattributed, it is never handed to a session that does not
 *     touch it.
 *  3. A process Topics started for nobody (a dev server of a project) is
 *     `unowned`: it is reported apart and never shared out. Dividing a dev
 *     server between chats would be a number nobody can act on.
 *  4. Anything else is not Topics' and is not counted.
 *
 * Each process lands in exactly ONE of those places, so what the sessions are
 * billed plus the unattributed remainder is the sum of the table's scanned
 * processes: nothing is billed twice. That equality is what the test pins.
 *
 * Why equal slices and not a weighted split: a weight (CPU, tokens) moves
 * from one reading to the next, so the same bridge would be billed unevenly
 * for no reason a person can see, and a quiet chat would look free on the
 * strength of being quiet while the bridge it keeps open is not. 1/N is the
 * rule a reader can check with a pencil, and the row prints it.
 */

/** A process as the table lists it. `cpu` is % of one core; null = not measured (no base reading yet). */
export interface AttrRow {
  pid: number;
  ppid: number;
  /** Memory in KB, footprint where the kernel knows it. */
  memKB: number;
  cpu: number | null;
  command: string;
}

/** A process every session may use. */
export interface AttrRoot { id: string; pid: number }

/** A pid Topics registered for a session unit. */
export interface AttrHead { unit: string; pid: number }

export interface AttributionInput {
  rows: readonly AttrRow[];
  roots: readonly AttrRoot[];
  /** More specific heads first: a pid registered twice keeps the first unit. */
  heads: readonly AttrHead[];
  /** Pids of Topics work that no session owns (project scripts): a process below one is `unowned`. */
  unowned?: readonly number[];
  /** Every live unit; the users of the `server` root. */
  units: readonly string[];
  /** The kernel's "responsible process", used where reparenting broke the parent chain. */
  responsibleOf?: (pid: number) => number | null;
}

export interface ProcLoad { name: string; count: number; memKB: number; cpu: number | null }

/** The slice of one shared root a unit is billed. */
export interface ShareLoad {
  root: string;
  /** The whole bucket of the root, before the split. */
  totalKB: number;
  /** How many units divide it. */
  of: number;
  /** This unit's slice. */
  kb: number;
  cpu: number | null;
}

export interface UnitLoad {
  unit: string;
  ownKB: number;
  ownCpu: number | null;
  ownProcesses: number;
  /** The programs inside, heaviest first. */
  procs: ProcLoad[];
  shares: ShareLoad[];
}

export interface Attribution {
  units: Map<string, UnitLoad>;
  unattributed: { kb: number; cpu: number | null; processes: number };
  /** KB billed to units (own plus slices). */
  billedKB: number;
  /** KB of every scanned process: `billedKB + unattributed.kb`. */
  scannedKB: number;
}

type Owner = { kind: 'unit'; unit: string } | { kind: 'root'; id: string } | { kind: 'unowned' };

const MAX_CHAIN = 64;

/**
 * The program a command line runs, for the detail rows. An app bundle keeps
 * its name with spaces (`.../Google Chrome Helper.app/Contents/MacOS/Google
 * Chrome Helper --type=x`); anything else is its first word's basename.
 */
export function programOf(command: string): string {
  const c = command.trim();
  const bundle = /\.app\/Contents\/MacOS\/([^/]+?)(?:\s+-|$)/.exec(c);
  if (bundle) return bundle[1]!;
  const first = c.split(/\s+/)[0] ?? c;
  return first.split('/').pop() || first;
}

const addCpu = (acc: number | null, v: number | null): number | null => (v === null ? acc : (acc ?? 0) + v);

export function attributeProcesses(input: AttributionInput): Attribution {
  const byPid = new Map<number, AttrRow>();
  for (const r of input.rows) byPid.set(r.pid, r);

  const headByPid = new Map<number, string>();
  for (const h of input.heads) if (!headByPid.has(h.pid)) headByPid.set(h.pid, h.unit);
  const rootByPid = new Map<number, string>();
  for (const r of input.roots) if (!rootByPid.has(r.pid)) rootByPid.set(r.pid, r.id);
  const unowned = new Set(input.unowned ?? []);

  const parentOf = (pid: number): number | null => {
    const row = byPid.get(pid);
    if (row && row.ppid > 1) return row.ppid;
    const resp = input.responsibleOf?.(pid) ?? null;
    return resp !== null && resp > 1 && resp !== pid ? resp : null;
  };

  const memo = new Map<number, Owner | null>();
  const ownerOf = (pid: number): Owner | null => {
    const hit = memo.get(pid);
    if (hit !== undefined) return hit;
    let found: Owner | null = null;
    const seen = new Set<number>();
    let cur: number | null = pid;
    for (let i = 0; i < MAX_CHAIN && cur !== null && !seen.has(cur); i++) {
      seen.add(cur);
      const unit = headByPid.get(cur);
      if (unit !== undefined) { found = { kind: 'unit', unit }; break; }
      if (unowned.has(cur)) { found = { kind: 'unowned' }; break; }
      const root = rootByPid.get(cur);
      if (root !== undefined) { found = { kind: 'root', id: root }; break; }
      cur = parentOf(cur);
    }
    memo.set(pid, found);
    return found;
  };

  /** The first shared root above a pid, ignoring heads: which bridge a session sits under. */
  const rootAbove = (pid: number): string | null => {
    const seen = new Set<number>();
    let cur: number | null = pid;
    for (let i = 0; i < MAX_CHAIN && cur !== null && !seen.has(cur); i++) {
      seen.add(cur);
      const root = rootByPid.get(cur);
      if (root !== undefined) return root;
      cur = parentOf(cur);
    }
    return null;
  };

  // Own processes per unit, and the buckets of the roots.
  interface Bucket { kb: number; cpu: number | null; processes: number; groups: Map<string, ProcLoad> }
  const newBucket = (): Bucket => ({ kb: 0, cpu: null, processes: 0, groups: new Map() });
  const take = (b: Bucket, r: AttrRow) => {
    b.kb += r.memKB;
    b.cpu = addCpu(b.cpu, r.cpu);
    b.processes += 1;
    const name = programOf(r.command);
    const g = b.groups.get(name) ?? { name, count: 0, memKB: 0, cpu: null };
    g.count += 1;
    g.memKB += r.memKB;
    g.cpu = addCpu(g.cpu, r.cpu);
    b.groups.set(name, g);
  };

  const own = new Map<string, Bucket>();
  const rootBuckets = new Map<string, Bucket>();
  const loose = newBucket();
  let scannedKB = 0;

  for (const r of input.rows) {
    const owner = ownerOf(r.pid);
    if (owner === null) continue;
    scannedKB += r.memKB;
    if (owner.kind === 'unit') {
      const b = own.get(owner.unit) ?? newBucket();
      take(b, r);
      own.set(owner.unit, b);
    } else if (owner.kind === 'root') {
      const b = rootBuckets.get(owner.id) ?? newBucket();
      take(b, r);
      rootBuckets.set(owner.id, b);
    } else {
      take(loose, r);
    }
  }

  // Who uses each root: every unit for the server, the units whose head sits under it for a bridge.
  const users = new Map<string, Set<string>>();
  for (const h of input.heads) {
    const root = rootAbove(h.pid);
    if (root === null) continue;
    const s = users.get(root) ?? new Set<string>();
    s.add(h.unit);
    users.set(root, s);
  }
  const usersOf = (rootId: string): string[] => {
    if (rootId === 'server') return [...input.units];
    return [...(users.get(rootId) ?? [])].filter((u) => input.units.includes(u));
  };

  const units = new Map<string, UnitLoad>();
  const unitOf = (key: string): UnitLoad => {
    let u = units.get(key);
    if (!u) { u = { unit: key, ownKB: 0, ownCpu: null, ownProcesses: 0, procs: [], shares: [] }; units.set(key, u); }
    return u;
  };
  for (const key of input.units) unitOf(key);
  for (const [key, b] of own) {
    const u = unitOf(key);
    u.ownKB = b.kb;
    u.ownCpu = b.cpu;
    u.ownProcesses = b.processes;
    u.procs = [...b.groups.values()].sort((a, c) => c.memKB - a.memKB);
  }

  const unattributed = { kb: loose.kb, cpu: loose.cpu, processes: loose.processes };
  for (const [rootId, b] of rootBuckets) {
    const who = usersOf(rootId);
    if (who.length === 0) {
      unattributed.kb += b.kb;
      unattributed.cpu = addCpu(unattributed.cpu, b.cpu);
      unattributed.processes += b.processes;
      continue;
    }
    for (const key of who) {
      unitOf(key).shares.push({
        root: rootId, totalKB: b.kb, of: who.length, kb: b.kb / who.length,
        cpu: b.cpu === null ? null : b.cpu / who.length,
      });
    }
  }

  let billedKB = 0;
  for (const u of units.values()) billedKB += u.ownKB + u.shares.reduce((s, x) => s + x.kb, 0);
  return { units, unattributed, billedKB, scannedKB };
}

/**
 * Work a session sent to another machine (a test suite on the PC), billed to
 * the sessions of the project it names. The machine reports its load of sent
 * work as ONE figure for all its jobs, so it is divided: equally between the
 * jobs first, then each job's part equally between the sessions of its
 * project. A job whose project no live session carries stays unattributed.
 */
export interface RemoteJob { what: string; project: string | null; who: string | null; since: number | null }

export interface RemoteSlice {
  job: RemoteJob;
  /** How many sessions of the project divide this job's part. */
  of: number;
  memMB: number | null;
  cpuPct: number | null;
}

export function attachRemoteJobs(
  jobs: readonly RemoteJob[],
  load: { memMB: number | null; cpuPct: number | null },
  sessionsByProject: ReadonlyMap<string, readonly string[]>,
): { bySession: Map<string, RemoteSlice[]>; unmatched: RemoteJob[] } {
  const bySession = new Map<string, RemoteSlice[]>();
  const unmatched: RemoteJob[] = [];
  const n = Math.max(1, jobs.length);
  for (const job of jobs) {
    const keys = job.project ? sessionsByProject.get(job.project.toLowerCase()) ?? [] : [];
    if (keys.length === 0) { unmatched.push(job); continue; }
    for (const key of keys) {
      const list = bySession.get(key) ?? [];
      list.push({
        job, of: keys.length,
        memMB: load.memMB === null ? null : load.memMB / n / keys.length,
        cpuPct: load.cpuPct === null ? null : load.cpuPct / n / keys.length,
      });
      bySession.set(key, list);
    }
  }
  return { bySession, unmatched };
}
