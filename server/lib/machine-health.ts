/**
 * The health of every machine Topics uses, written to
 * `<APP_DATA_DIR>/machines-health.json` for the tray: security (probes every
 * 30 minutes), CPU and memory (one sample every 5 minutes for 24 hours) and
 * cards run today, hour by hour.
 *
 * The history lives in memory and in a second save file (no migration): after
 * a server restart the charts do not start from zero, and the last probe
 * result of a machine that is off stays, with its own time.
 */
import type { Database } from "bun:sqlite";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  MachineHealthEntry,
  MachineHistory,
  MachineSecurity,
  MachineSecurityReport,
  MachinesHealthFile,
} from "../../shared/machine-health";

export const STEP_S = 300;
export const HISTORY_POINTS = 288;
export const SECURITY_EVERY_MS = 30 * 60_000;
const HISTORY_FILE_VERSION = 1;

export interface Sample { t: number; cpu: number | null; mem: number | null }

export interface HealthTarget {
  id: string;
  name: string;
  kind: "local" | "remote";
}

/** Adds a sample keeping 24 hours at most; two samples in the same 5-minute slot are one (the last wins). */
export function pushSample(list: Sample[], sample: Sample): Sample[] {
  const slot = Math.floor(sample.t / STEP_S);
  const next = list.filter((s) => Math.floor(s.t / STEP_S) !== slot);
  next.push(sample);
  const oldest = (Math.floor(sample.t / STEP_S) - (HISTORY_POINTS - 1)) * STEP_S;
  return next.filter((s) => s.t >= oldest).sort((a, b) => a.t - b.t);
}

/** The last 24 hours at a fixed step: always 288 points, `null` where the machine did not answer. */
export function buildHistory(samples: Sample[], nowS: number): MachineHistory {
  const last = Math.floor(nowS / STEP_S);
  const first = last - (HISTORY_POINTS - 1);
  const cpu: Array<number | null> = new Array(HISTORY_POINTS).fill(null);
  const mem: Array<number | null> = new Array(HISTORY_POINTS).fill(null);
  for (const s of samples) {
    const i = Math.floor(s.t / STEP_S) - first;
    if (i < 0 || i >= HISTORY_POINTS) continue;
    cpu[i] = s.cpu;
    mem[i] = s.mem;
  }
  return { step_s: STEP_S, from: first * STEP_S, cpu, mem };
}

/**
 * CPU and memory of a machine whose own server cannot say them (the PC, while it runs an old Topics without the
 * `machine-metrics` route), from the usage hub's minute log `pc-history.jsonl` (`{"t","s","cpu","mem",...}`, a
 * sleeping PC has no `cpu`). The minutes of one 5-minute slot are averaged; a slot with no reading is not listed,
 * so it stays a gap in the chart, never a made-up zero.
 */
export function samplesFromMinuteLog(text: string, sinceS: number): Sample[] {
  const slots = new Map<number, { cpu: number[]; mem: number[] }>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row: { t?: unknown; cpu?: unknown; mem?: unknown };
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.t !== "number" || row.t < sinceS) continue;
    const slot = Math.floor(row.t / STEP_S);
    const bucket = slots.get(slot) ?? { cpu: [], mem: [] };
    if (typeof row.cpu === "number") bucket.cpu.push(row.cpu);
    if (typeof row.mem === "number") bucket.mem.push(row.mem);
    slots.set(slot, bucket);
  }
  const avg = (v: number[]): number | null => (v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null);
  return [...slots.entries()]
    .map(([slot, b]) => ({ t: slot * STEP_S, cpu: avg(b.cpu), mem: avg(b.mem) }))
    .filter((x) => x.cpu !== null || x.mem !== null)
    .sort((a, b) => a.t - b.t);
}

/**
 * The cards that ran today, one entry per run, with the machine id written on the card (`null` = this computer).
 *
 * A run is an attempt created today, OR a card that is in progress now or entered progress today and has no
 * attempt today (a node's cards are dispatched without a local attempt row, and a card started yesterday that is
 * still working did run today). That one is counted once, at the hour it started, or at midnight if it started
 * before. Counting attempts alone gave a server with an agent at work "0 cards today" while the same server's
 * overview counted the agent.
 */
export function cardRunsToday(db: Database, sinceMs: number): Array<{ machineId: string | null; createdAt: string }> {
  const since = new Date(sinceMs).toISOString();
  const attempts = db.query(
    `SELECT t.machine_id AS machineId, a.created_at AS createdAt, t.id AS taskId
       FROM task_attempts a JOIN tasks t ON t.id = a.task_id
      WHERE a.created_at >= ?`,
  ).all(since) as Array<{ machineId: string | null; createdAt: string; taskId: string }>;
  const withAttempt = new Set(attempts.map((a) => a.taskId));
  const running = db.query(
    `SELECT id AS taskId, machine_id AS machineId, in_progress_at AS startedAt
       FROM tasks
      WHERE status = 'in_progress' OR in_progress_at >= ?`,
  ).all(since) as Array<{ taskId: string; machineId: string | null; startedAt: string | null }>;
  const out = attempts.map((a) => ({ machineId: a.machineId, createdAt: a.createdAt }));
  for (const r of running) {
    if (withAttempt.has(r.taskId)) continue;
    const started = r.startedAt && r.startedAt >= since ? r.startedAt : since;
    out.push({ machineId: r.machineId, createdAt: started });
  }
  return out;
}

/** Today's cards (the server's local day) per local hour: 24 integers. */
export function cardsPerHour(createdAt: string[], nowMs: number): number[] {
  const out = new Array<number>(24).fill(0);
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  for (const iso of createdAt) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t < midnight.getTime() || t > nowMs) continue;
    out[new Date(t).getHours()]++;
  }
  return out;
}

export function emptySecurity(): MachineSecurity {
  return { checked_at: null, status: "unknown", checks: [] };
}

/** Atomic write: a temporary file next to it and `rename`, so the tray never reads half a file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, path);
}

interface SavedState {
  version: number;
  samples: Record<string, Sample[]>;
  security: Record<string, MachineSecurity>;
}

export interface MachineHealthDeps {
  targets: () => HealthTarget[];
  /** CPU and memory in percent; `null` if the machine does not answer. */
  readMetrics: (target: HealthTarget) => Promise<{ cpu: number | null; mem: number | null } | null>;
  /** Readings the machine's own server cannot give, from another source (the PC's minute log); merged into the slots that have none. */
  externalSamples?: (target: HealthTarget, sinceS: number) => Promise<Sample[]>;
  /** That machine's security probes; `null` if it does not answer (the last result stays). */
  probe: (target: HealthTarget) => Promise<MachineSecurityReport | null>;
  /** When each card of today was created, with the machine id written on it (`null` = this computer). */
  attemptsToday: (sinceMs: number) => Array<{ machineId: string | null; createdAt: string }>;
  /** Which machine of the file the id written on the card belongs to; `null` = none (e.g. cloud, not listed). */
  attribute: (machineId: string | null) => string | null;
  /** Called after each round with the security reading of every machine (the alerts); its failure never stops the round. */
  onRound?: (machines: Record<string, { name: string; security: MachineSecurity }>) => Promise<void>;
  filePath: string;
  statePath: string;
  now: () => number;
  log?: (msg: string) => void;
}

export function createMachineHealth(deps: MachineHealthDeps) {
  const samples = new Map<string, Sample[]>();
  const security = new Map<string, MachineSecurity>();
  let loaded = false;
  let running: Promise<void> | null = null;

  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const saved = JSON.parse(await readFile(deps.statePath, "utf8")) as SavedState;
      if (saved.version !== HISTORY_FILE_VERSION) return;
      for (const [id, list] of Object.entries(saved.samples ?? {})) samples.set(id, list);
      for (const [id, sec] of Object.entries(saved.security ?? {})) security.set(id, sec);
    } catch { /* first start or a damaged file: start from zero */ }
  }

  async function save(): Promise<void> {
    const state: SavedState = {
      version: HISTORY_FILE_VERSION,
      samples: Object.fromEntries(samples),
      security: Object.fromEntries(security),
    };
    await writeJsonAtomic(deps.statePath, state);
  }

  function snapshot(targets: HealthTarget[]): MachinesHealthFile {
    const nowMs = deps.now();
    const nowS = Math.floor(nowMs / 1000);
    const midnight = new Date(nowMs);
    midnight.setHours(0, 0, 0, 0);
    const perMachine = new Map<string, string[]>();
    for (const a of deps.attemptsToday(midnight.getTime())) {
      const id = deps.attribute(a.machineId);
      if (!id) continue;
      const list = perMachine.get(id) ?? [];
      list.push(a.createdAt);
      perMachine.set(id, list);
    }
    const machines: MachineHealthEntry[] = targets.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      security: security.get(t.id) ?? emptySecurity(),
      history: buildHistory(samples.get(t.id) ?? [], nowS),
      cards_today: cardsPerHour(perMachine.get(t.id) ?? [], nowMs),
    }));
    return { at: nowS, machines };
  }

  async function runOnce(): Promise<void> {
    await load();
    const targets = deps.targets();
    const nowMs = deps.now();
    await Promise.all(targets.map(async (t) => {
      const [metrics, report] = await Promise.all([
        deps.readMetrics(t).catch(() => null),
        (() => {
          const last = security.get(t.id)?.checked_at;
          const due = last == null || nowMs - last * 1000 >= SECURITY_EVERY_MS - 30_000;
          return due ? deps.probe(t).catch(() => null) : Promise.resolve(null);
        })(),
      ]);
      samples.set(t.id, pushSample(samples.get(t.id) ?? [], { t: Math.floor(nowMs / 1000), cpu: metrics?.cpu ?? null, mem: metrics?.mem ?? null }));
      if (report) security.set(t.id, { checked_at: report.checked_at, status: report.status, checks: report.checks });
    }));
    // Slots the machine's own server did not fill, from the other source: its reading always wins.
    if (deps.externalSamples) {
      const sinceS = Math.floor(nowMs / 1000) - HISTORY_POINTS * STEP_S;
      await Promise.all(targets.map(async (t) => {
        const extra = await deps.externalSamples!(t, sinceS).catch(() => [] as Sample[]);
        if (extra.length === 0) return;
        let list = samples.get(t.id) ?? [];
        for (const e of extra) {
          const own = list.find((x) => Math.floor(x.t / STEP_S) === Math.floor(e.t / STEP_S));
          if (own && (own.cpu !== null || own.mem !== null)) continue;
          list = pushSample(list, e);
        }
        samples.set(t.id, list);
      }));
    }
    // Machines that are gone do not stay in the save file.
    const ids = new Set(targets.map((t) => t.id));
    for (const id of [...samples.keys()]) if (!ids.has(id)) samples.delete(id);
    for (const id of [...security.keys()]) if (!ids.has(id)) security.delete(id);
    await writeJsonAtomic(deps.filePath, snapshot(targets));
    await save();
    if (deps.onRound) {
      const now = Object.fromEntries(targets.map((t) => [t.id, { name: t.name, security: security.get(t.id) ?? emptySecurity() }]));
      await deps.onRound(now).catch((err) => deps.log?.(`[machines-health] alerts skipped: ${(err as Error).message}`));
    }
  }

  return {
    /** One round: sample, probe the ones that need it, write the file. Two rounds at once are one. */
    tick(): Promise<void> {
      if (running) return running;
      running = runOnce().catch((err) => { deps.log?.(`[machines-health] round skipped: ${(err as Error).message}`); }).finally(() => { running = null; });
      return running;
    },
    /** What the next round would write, without writing (for tests). */
    snapshot,
  };
}
