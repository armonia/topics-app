/**
 * The machine's Processes view, as pure reads of what the usage hub answers
 * (hub-smistamento, HUBBR-08 and HUBBR-09).
 *
 *   /api/hub/mac/procs  the census: one unit per app, service, session, job,
 *                       with memory, GPU and network per unit ("now": the hub
 *                       recomputes it at most every 30 s, when somebody reads)
 *   /api/hub/mac        the machine: memory in GB, swap, and the CPU of the
 *                       heaviest processes and of the agents' trees
 *   /api/hub/machines   this Mac and the PC in one list: state, 24 h measures
 *   hub:live services   the hub's services, with state, memory and port
 *   switchboard logs    the Claude proxy's log, one JSON line per SSE event
 *
 * Nothing here fetches. A number the hub did not measure stays null and is
 * drawn as a dash, never as 0: 0 is "measured and idle". The only command the
 * view carries is the Stop button on a project script Topics started and can stop
 * itself (`scriptForUnit`); the hub is read-only from here.
 */
import type { ScriptProcessInfo } from './api';

// ── Small readers ────────────────────────────────────────────────────────────

type JsonRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const list = (v: unknown): JsonRecord[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** «2,9 GB» from 1000 MB up, «980 MB» under it. Italian decimal comma. */
export function formatMem(mb: number): string {
  if (mb >= 1000) return `${(mb / 1024).toFixed(1).replace('.', ',')} GB`;
  return `${Math.round(mb)} MB`;
}

/** «14 KB/s», «1,8 MB/s», «208 B/s». */
export function formatRate(bps: number): string {
  if (bps >= 1024 * 1024) return `${(bps / (1024 * 1024)).toFixed(1).replace('.', ',')} MB/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

/** What a cell shows for a number the hub did not measure. */
export const NOT_MEASURED = '-';

/** A percentage the hub measured, or the not-measured mark. */
export function formatPct(v: number | null): string {
  return v === null ? NOT_MEASURED : `${Math.round(v)}%`;
}

// ── Process rows (census + CPU + Topics scripts) ─────────────────────────────

export type UnitKind = 'app' | 'servizio' | 'sessione' | 'lavoro' | 'devserver' | 'mcp' | 'macos' | 'altro' | 'resto'; // allow-italian: the census's wire values, compared by value
const KINDS: readonly UnitKind[] = ['app', 'servizio', 'sessione', 'lavoro', 'devserver', 'mcp', 'macos', 'altro', 'resto']; // allow-italian: the census's wire values

/** A project script Topics started and can stop: the only Stop button of the view. */
interface UnitScript {
  processId: string;
  scriptName: string;
  projectPath: string;
  project: string;
  port: number | null;
}

export interface ProcessRow {
  id: string;
  name: string;
  kind: UnitKind;
  /** The hub's own words on how it is used (hours of use over 14 days), or who owns it. */
  detail: string;
  memMB: number;
  /** Share of the heaviest row, for the bar. */
  memShare: number;
  /** Heavy enough to warm the number. */
  memWarn: boolean;
  /** CPU of the unit in % of one core; null where the hub does not measure it. */
  cpuPct: number | null;
  gpuPct: number | null;
  netInBps: number | null;
  netOutBps: number | null;
  script: UnitScript | null;
}

/** At or above this a row's memory is drawn warm (the mockup's 1,6 GB dev server). */
const MEM_WARN_MB = 1500;

// Both separators: a Windows server sends `C:\\work\\acme-web`.
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/**
 * The CPU the hub measured, by pid, as a fraction of one core: the heaviest
 * processes (`hogs`) and the agents' trees (`trees`). A pid in both keeps the
 * larger reading, so a tree is not counted twice.
 */
export function cpuByPid(mac: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!isRecord(mac)) return out;
  for (const r of [...list(mac.hogs), ...list(mac.trees)]) {
    const pid = num(r.pid), cpu = num(r.cpu);
    if (pid === null || cpu === null) continue;
    out.set(pid, Math.max(out.get(pid) ?? 0, cpu));
  }
  return out;
}

/** The running Topics script behind a unit: same process id, else one of its pids. */
function scriptForUnit(unit: JsonRecord, scripts: readonly ScriptProcessInfo[]): UnitScript | null {
  const pids = Array.isArray(unit.pids) ? unit.pids.filter((p): p is number => typeof p === 'number') : [];
  const pid = str(unit.processId);
  const s = scripts.find((x) => x.status === 'running' && ((pid !== null && x.processId === pid) || (x.pid !== null && pids.includes(x.pid))));
  if (!s) return null;
  return { processId: s.processId, scriptName: s.scriptName, projectPath: s.projectPath, project: baseName(s.projectPath), port: s.ports[0] ?? null };
}

export function processRows(census: unknown, mac: unknown, scripts: readonly ScriptProcessInfo[]): ProcessRow[] {
  const units = isRecord(census) ? list(census.units) : [];
  const cpu = cpuByPid(mac);
  const top = Math.max(1, ...units.map((u) => num(u.memMB) ?? 0));
  return units.map((u, i) => {
    const kind = (KINDS as readonly string[]).includes(String(u.type)) ? (u.type as UnitKind) : 'altro'; // allow-italian: the census's fallback kind
    const pids = Array.isArray(u.pids) ? u.pids.filter((p): p is number => typeof p === 'number') : [];
    const measured = pids.filter((p) => cpu.has(p));
    const memMB = num(u.memMB) ?? 0;
    const use = isRecord(u.use) ? str(u.use.text) : null;
    const owner = isRecord(u.owner) ? str(u.owner.label) : null;
    return {
      id: str(u.id) ?? String(i),
      name: str(u.name) ?? '',
      kind,
      detail: use ?? owner ?? '',
      memMB,
      memShare: Math.min(1, memMB / top),
      memWarn: memMB >= MEM_WARN_MB,
      cpuPct: measured.length ? Math.round(measured.reduce((s, p) => s + (cpu.get(p) ?? 0), 0) * 1000) / 10 : null,
      gpuPct: num(u.gpuPct),
      netInBps: num(u.netInBps),
      netOutBps: num(u.netOutBps),
      script: scriptForUnit(u, scripts),
    };
  });
}

/** When the census was taken (ms), or null. */
export function censusAt(census: unknown): number | null {
  return isRecord(census) ? num(census.at) : null;
}

// ── The Mac's gauges ────────────────────────────────────────────────────────

export interface MacGauges {
  cores: number | null;
  totalGB: number | null;
  /** The hub's word for the machine (strained, calm). */
  state: string | null;
  cpuPct: number | null;
  memUsedGB: number | null;
  swapUsedGB: number | null;
  swapTotalGB: number | null;
  gpuPct: number | null;
  netInBps: number | null;
  netOutBps: number | null;
  /** The machine's last 24 h, per gauge, as the hub keeps it; empty where it keeps none (swap, network). */
  history: { cpu: HistoryPoint[]; mem: HistoryPoint[]; gpu: HistoryPoint[] };
}

/** One sample of a machine's history: unix seconds and a percentage. */
export interface HistoryPoint {
  t: number;
  v: number;
}

/** The samples of a metric's `history`, the malformed ones dropped, oldest first. */
export function historyOf(raw: unknown): HistoryPoint[] {
  return list(raw)
    .map((p) => ({ t: num(p.t), v: num(p.v) }))
    .filter((p): p is HistoryPoint => p.t !== null && p.v !== null)
    .sort((a, b) => a.t - b.t);
}

function metricHistory(machine: JsonRecord | undefined, key: string): HistoryPoint[] {
  const m = machine ? list(machine.metrics).find((x) => x.key === key) : undefined;
  return m ? historyOf(m.history) : [];
}

function metric(machine: JsonRecord | undefined, key: string): number | null {
  const m = machine ? list(machine.metrics).find((x) => x.key === key) : undefined;
  return m ? num(m.pct) : null;
}

/** This Mac and the PC, picked from `/api/machines`. */
function machinesOf(data: unknown): { local?: JsonRecord; pc?: JsonRecord } {
  const all = list(data);
  return { local: all.find((m) => m.local === true), pc: all.find((m) => m.local !== true) };
}

export function macGauges(mac: unknown, machines: unknown, census: unknown): MacGauges {
  const m = isRecord(mac) ? mac : {};
  const mem = isRecord(m.mem) ? m.mem : {};
  const { local } = machinesOf(machines);
  const summary = isRecord(census) && isRecord(census.summary) ? census.summary : {};
  return {
    cores: num(m.cores),
    totalGB: num(mem.totalGB),
    state: local ? str(local.state) : null,
    cpuPct: metric(local, 'cpu'),
    memUsedGB: num(mem.usedGB),
    swapUsedGB: num(m.swapUsedGB),
    swapTotalGB: num(m.swapTotalGB),
    gpuPct: metric(local, 'gpu'),
    netInBps: num(summary.netInBps),
    netOutBps: num(summary.netOutBps),
    history: { cpu: metricHistory(local, 'cpu'), mem: metricHistory(local, 'mem'), gpu: metricHistory(local, 'gpu') },
  };
}

// ── The PC ──────────────────────────────────────────────────────────────────

type PcState = 'dorme' | 'acceso' | 'lavora' | 'unknown'; // allow-italian: the hub's wire values

export interface PcView {
  state: PcState;
  /** The hub's sentences on why (linked from the Mac, the heaviest program). */
  lines: string[];
  /** The idle rule, e.g. sleeps after 20 minutes without work. */
  caption: string | null;
  metrics: Array<{ key: string; name: string; pct: number | null; note: string | null; history: HistoryPoint[] }>;
  heavy: Array<{ name: string; cores: number }>;
  /** Jobs the Mac sent it. */
  offload: number;
}

export function pcView(machines: unknown): PcView | null {
  const { pc } = machinesOf(machines);
  if (!pc) return null;
  const s = str(pc.state);
  const state: PcState = s === 'dorme' || s === 'acceso' || s === 'lavora' ? s : 'unknown'; // allow-italian: the hub's wire values
  return {
    state,
    lines: Array.isArray(pc.lines) ? pc.lines.filter((l): l is string => typeof l === 'string') : [],
    caption: str(pc.caption),
    metrics: list(pc.metrics).map((x) => ({ key: str(x.key) ?? '', name: str(x.name) ?? '', pct: num(x.pct), note: str(x.note), history: historyOf(x.history) })),
    heavy: list(pc.procs).map((p) => ({ name: str(p.name) ?? '', cores: num(p.cores) ?? 0 })).filter((p) => p.name),
    offload: num(pc.offload) ?? 0,
  };
}

// ── Services ────────────────────────────────────────────────────────────────

type ServiceState = 'vivo' | 'in attesa' | 'fermo' | 'spento'; // allow-italian: the hub's wire values

export interface ServiceRow {
  id: string;
  name: string;
  state: ServiceState;
  port: number | null;
  memMB: number | null;
  problem: string | null;
}

/** The Claude proxy: the one service whose log the view streams. */
export const PROXY_SERVICE_ID = 'switchboard';

const STATE_ORDER: Record<ServiceState, number> = { fermo: 0, vivo: 1, 'in attesa': 2, spento: 3 }; // allow-italian: the hub's wire values

/**
 * The hub's services, the ones in trouble first: stopped, then with a
 * problem, then up, then asleep on demand. Switched off on purpose go last;
 * the view counts them instead of listing them.
 */
export function serviceRows(data: unknown): ServiceRow[] {
  const raw = isRecord(data) ? list(data.services) : [];
  const rows = raw.map((s, i): ServiceRow => {
    const st = str(s.state);
    const state: ServiceState = st === 'vivo' || st === 'in attesa' || st === 'fermo' || st === 'spento' ? st : 'fermo'; // allow-italian: the hub's wire values
    return { id: str(s.id) ?? String(i), name: str(s.name) ?? str(s.id) ?? '', state, port: num(s.port), memMB: num(s.mb), problem: str(s.problem) };
  });
  const rank = (r: ServiceRow) => STATE_ORDER[r.state] * 2 + (r.problem ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b));
}

// ── The proxy's log ─────────────────────────────────────────────────────────

type LogTone = 'error' | 'warn' | 'ok' | 'plain';

export interface LogLine {
  ts: string;
  tag: string;
  msg: string;
  tone: LogTone;
}

/** One SSE `data:` of the proxy's stream, or null when it is not a log line. */
export function parseLogEvent(raw: string): LogLine | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isRecord(v)) return null;
  const msg = str(v.msg);
  if (!msg) return null;
  const tag = str(v.tag) ?? '';
  return { ts: str(v.ts) ?? '', tag, msg, tone: logTone(tag, msg) };
}

export function logTone(tag: string, msg: string): LogTone {
  const t = `${tag} ${msg}`;
  if (/\berror\b|\bfail|expired|\b(4\d\d|5\d\d)\b/i.test(t)) return 'error';
  if (/warn|retry|switch|rotat|limit/i.test(t)) return 'warn';
  if (/\b200\b|\bok\b/i.test(t)) return 'ok';
  return 'plain';
}

/** The lines the log keeps on screen: the newest at the top, at most `max`. */
export function pushLogLine(lines: readonly LogLine[], line: LogLine, max = 200): LogLine[] {
  return [line, ...lines].slice(0, max);
}
