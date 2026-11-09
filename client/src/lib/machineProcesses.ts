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
import { apiFetch } from './shell/net';

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
  /** True when the reading covers only some of the unit's processes: the real figure is higher. */
  cpuPartial: boolean;
  gpuPct: number | null;
  netInBps: number | null;
  netOutBps: number | null;
  script: UnitScript | null;
  /**
   * The process the service can close for this unit: its main pid and the
   * instant that pid was born, which the service checks before it signals (a
   * pid the system reused is refused). Null for system, service and MCP units,
   * for project scripts (they have their own Stop) and where the hub sent no
   * birth instant.
   */
  closable: CloseTarget | null;
}

/** What the close request carries to the service. */
export interface CloseTarget {
  pid: number;
  /** Unix ms the pid was born, as the census read it. */
  startedAt: number;
}

/** Kinds the view never offers to close: the system, the services and the MCP servers. */
const PROTECTED_KINDS: readonly UnitKind[] = ['macos', 'servizio', 'mcp']; // allow-italian: the census's wire values

/** At or above this a row's memory is drawn warm (the mockup's 1,6 GB dev server). */
const MEM_WARN_MB = 1500;

// Both separators: a Windows server sends `C:\\work\\acme-web`.
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** One CPU reading of the hub: the pid it is keyed to, a fraction of one core, how many processes it covers. */
interface CpuReading {
  pid: number;
  cpu: number;
  n: number;
}

function cpuReadings(raw: unknown): CpuReading[] {
  return list(raw).flatMap((r) => {
    const pid = num(r.pid), cpu = num(r.cpu);
    return pid === null || cpu === null ? [] : [{ pid, cpu, n: Math.max(1, num(r.n) ?? 1) }];
  });
}

/**
 * The CPU the hub measured for one process alone, by pid, as a fraction of one
 * core. The hub groups its heaviest processes (`hogs`) by name and keys the
 * group's sum to its first pid only, so a group of several says nothing about
 * that pid: only the hogs of a single process are kept.
 */
export function cpuByPid(mac: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!isRecord(mac)) return out;
  for (const h of cpuReadings(mac.hogs)) if (h.n === 1) out.set(h.pid, h.cpu);
  return out;
}

/** The CPU of a unit and how many of its processes the reading covers. */
interface UnitCpu {
  pct: number | null;
  measured: number;
}

/**
 * An agent's tree (`trees`) covers its root and every descendant, so a unit
 * holding a tree root takes the trees' sums and nothing else: a single hog in
 * the same unit may be one of those descendants. Without a tree, the
 * single-process hogs.
 */
function unitCpu(pids: readonly number[], trees: readonly CpuReading[], single: ReadonlyMap<number, number>): UnitCpu {
  const own = new Set(pids);
  const mine = trees.filter((t) => own.has(t.pid));
  const parts = mine.length ? mine : pids.filter((p) => single.has(p)).map((p) => ({ cpu: single.get(p) ?? 0, n: 1 }));
  if (!parts.length) return { pct: null, measured: 0 };
  const cpu = parts.reduce((s, x) => s + x.cpu, 0);
  return { pct: Math.round(cpu * 1000) / 10, measured: Math.min(pids.length, parts.reduce((s, x) => s + x.n, 0)) };
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
  const single = cpuByPid(mac);
  const trees = isRecord(mac) ? cpuReadings(mac.trees) : [];
  const top = Math.max(1, ...units.map((u) => num(u.memMB) ?? 0));
  return units.map((u, i) => {
    const kind = (KINDS as readonly string[]).includes(String(u.type)) ? (u.type as UnitKind) : 'altro'; // allow-italian: the census's fallback kind
    const pids = Array.isArray(u.pids) ? u.pids.filter((p): p is number => typeof p === 'number') : [];
    const cpu = unitCpu(pids, trees, single);
    const memMB = num(u.memMB) ?? 0;
    const script = scriptForUnit(u, scripts);
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
      cpuPct: cpu.pct,
      cpuPartial: cpu.pct !== null && cpu.measured < pids.length,
      gpuPct: num(u.gpuPct),
      netInBps: num(u.netInBps),
      netOutBps: num(u.netOutBps),
      script,
      closable: script || PROTECTED_KINDS.includes(kind) ? null : closeTarget(u),
    };
  });
}

/** The first of the unit's `procs` that has a pid and a birth instant. */
function closeTarget(unit: JsonRecord): CloseTarget | null {
  for (const p of list(unit.procs)) {
    const pid = num(p.pid), startedAt = num(p.startedAt);
    if (pid !== null && pid > 1 && startedAt !== null) return { pid, startedAt };
  }
  return null;
}

// ── Search and order ─────────────────────────────────────────────────────────

export type SortKey = 'mem' | 'cpu' | 'gpu' | 'net' | 'name';
export const SORT_KEYS: readonly SortKey[] = ['mem', 'cpu', 'gpu', 'net', 'name'];

/** Rows whose name, kind or detail contain every word of the query, case aside. */
export function filterRows(rows: readonly ProcessRow[], query: string): ProcessRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...rows];
  return rows.filter((r) => {
    const hay = `${r.name} ${r.kind} ${r.detail} ${r.script ? `${r.script.project} ${r.script.scriptName}` : ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Heaviest first by the key; a number the hub did not measure goes last. The name sorts A to Z. */
export function sortRows(rows: readonly ProcessRow[], key: SortKey): ProcessRow[] {
  const value = (r: ProcessRow): number | null => {
    if (key === 'mem') return r.memMB;
    if (key === 'cpu') return r.cpuPct;
    if (key === 'gpu') return r.gpuPct;
    return r.netInBps === null || r.netOutBps === null ? null : r.netInBps + r.netOutBps;
  };
  return [...rows].sort((a, b) => {
    if (key === 'name') return a.name.localeCompare(b.name);
    const x = value(a), y = value(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  });
}

// ── The Mac's backup ─────────────────────────────────────────────────────────

export interface BackupView {
  /** Outcome of the last run. */
  ok: boolean;
  at: number;
  /** The service's sentence on it (size, duration, or why it failed). */
  detail: string | null;
  /** The last runs, oldest first, one tick each. */
  ticks: Array<{ at: number; ok: boolean }>;
}

/**
 * The service reads the backup's state file itself, so this works with Topics
 * off. No file (or one with no run in it) is null: the view says there is no
 * backup recorded, it does not invent a state.
 */
export function backupView(raw: unknown): BackupView | null {
  if (!isRecord(raw) || !isRecord(raw.last)) return null;
  const at = num(raw.last.at);
  if (at === null) return null;
  const ticks = list(raw.ticks).flatMap((t) => {
    const tAt = num(t.at);
    return tAt === null ? [] : [{ at: tAt, ok: t.ok === true }];
  }).sort((a, b) => a.at - b.at);
  return { ok: raw.last.ok === true, at, detail: str(raw.last.detail), ticks };
}

/** Asks the service to close a process. Resolves to the refusal's reason, or null when it went. */
export async function closeProcess(target: CloseTarget, signal: 'TERM' | 'KILL'): Promise<string | null> {
  try {
    const r = await apiFetch('/api/hub/mac/procs/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: target.pid, startedAt: target.startedAt, signal }),
    });
    if (r.ok) return null;
    const body: unknown = await r.json().catch(() => null);
    return (isRecord(body) ? str(body.error) : null) ?? `HTTP ${r.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
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
  /** The memory pressure the hub reads (a different measure from the used GB), in %. */
  memPressurePct: number | null;
  swapUsedGB: number | null;
  swapTotalGB: number | null;
  gpuPct: number | null;
  netInBps: number | null;
  netOutBps: number | null;
  /**
   * The machine's last 24 h, per gauge, as the hub keeps it; empty where it
   * keeps none (swap, network). Memory has none here: the hub's memory history
   * is the system's pressure, not the used GB the gauge shows.
   */
  history: { cpu: HistoryPoint[]; gpu: HistoryPoint[] };
  /** 0 calm, 1 busy, 2 strained: the hub's level, memory pressure and a full swap included. */
  level: number;
  /** The hub's sentences on why it strains and which projects it paused until the Mac breathes again. */
  lines: string[];
  /** The disk: share used and the hub's note on the free space, or null where it is not read. */
  disk: { pct: number | null; note: string | null } | null;
  /** The hub's note on each gauge (cores in use, the swap read back from disk). */
  notes: { cpu: string | null; mem: string | null; swap: string | null; gpu: string | null };
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

function metricNote(machine: JsonRecord | undefined, key: string): string | null {
  const m = machine ? list(machine.metrics).find((x) => x.key === key) : undefined;
  return m ? str(m.note) : null;
}

const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string' && l.trim() !== '') : []);

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
    memPressurePct: metric(local, 'mem'),
    swapUsedGB: num(m.swapUsedGB),
    swapTotalGB: num(m.swapTotalGB),
    gpuPct: metric(local, 'gpu'),
    netInBps: num(summary.netInBps),
    netOutBps: num(summary.netOutBps),
    history: { cpu: metricHistory(local, 'cpu'), gpu: metricHistory(local, 'gpu') },
    level: local ? num(local.level) ?? 0 : 0,
    lines: local ? stringsOf(local.lines) : [],
    disk: local && list(local.metrics).some((x) => x.key === 'disk') ? { pct: metric(local, 'disk'), note: metricNote(local, 'disk') } : null,
    notes: { cpu: metricNote(local, 'cpu'), mem: metricNote(local, 'mem'), swap: metricNote(local, 'swap'), gpu: metricNote(local, 'gpu') },
  };
}

// ── The PC ──────────────────────────────────────────────────────────────────

/**
 * `closed`: on, but Windows' firewall refuses ssh (the hub's own state for
 * it), a command away on the PC; `unknown`: it does not answer at all.
 */
type PcState = 'dorme' | 'acceso' | 'lavora' | 'closed' | 'unknown'; // allow-italian: the hub's wire values

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
  const state: PcState = s === 'dorme' || s === 'acceso' || s === 'lavora' ? s : s === 'acceso, ssh chiuso' ? 'closed' : 'unknown'; // allow-italian: the hub's wire values
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
  /** What it is, in the hub's words (the port it forwards, when it sleeps). */
  what: string | null;
  /** The launchd job: the handle for `launchctl kickstart` and the logs. */
  label: string | null;
  /** Its web page, when it has one (http only). */
  url: string | null;
  /** Memory with the processes it started (agents, browsers, MCP), and how many. */
  treeMB: number | null;
  children: number;
  /** The hub's area for it: «Consumi», «Assistente», «Agenti», «Strumenti». */
  group: string | null;
  /** One of the person's own apps (hub, tray, Topics): they come first, as on the hub's page. */
  app: boolean;
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
    const url = str(s.url);
    return {
      id: str(s.id) ?? String(i), name: str(s.name) ?? str(s.id) ?? '', state, port: num(s.port), memMB: num(s.mb), problem: str(s.problem),
      what: str(s.what), label: str(s.label), url: url && /^https?:\/\//.test(url) ? url : null,
      treeMB: num(s.treeMb), children: num(s.children) ?? 0,
      group: str(s.group), app: s.app === true,
    };
  });
  const rank = (r: ServiceRow) => STATE_ORDER[r.state] * 2 + (r.problem ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b));
}

/** A group of the services: `apps` is the person's own apps, otherwise the hub's area by name. */
export interface ServiceGroup {
  key: string;
  /** The hub's word for the area; null for `apps`, whose name the view says. */
  label: string | null;
  rows: ServiceRow[];
}

/**
 * The services in the hub's groups: the person's own apps first, then each
 * area, the one holding the service most in trouble first. Inside a group the
 * order stays the one `serviceRows` gave, the ones in trouble first. A service
 * with no area goes in the last group, `other` for the view.
 */
export function serviceGroups(rows: readonly ServiceRow[]): ServiceGroup[] {
  const groups: ServiceGroup[] = [];
  const find = (key: string, label: string | null) => {
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, label, rows: [] }; groups.push(g); }
    return g;
  };
  find('apps', null);
  for (const r of rows) {
    if (r.app) find('apps', null).rows.push(r);
    else if (r.group) find(`group:${r.group}`, r.group).rows.push(r);
  }
  for (const r of rows) if (!r.app && !r.group) find('other', null).rows.push(r);
  return groups.filter((g) => g.rows.length > 0);
}

/** When the hub took its picture of the services (it keeps one for a minute), or null. */
export function servicesReadAt(data: unknown): number | null {
  return isRecord(data) ? num(data.at) : null;
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
  const tag = str(v.tag) ?? '';
  // The stream opens with its own greeting (tag `system`, no time): not a line of the proxy.
  if (!msg || tag === 'system') return null;
  return { ts: str(v.ts) ?? '', tag, msg, tone: logTone(tag, msg) };
}

export function logTone(tag: string, msg: string): LogTone {
  const t = `${tag} ${msg}`;
  if (/\berror\b|\bfail|expired|\b(4\d\d|5\d\d)\b/i.test(t)) return 'error';
  if (/warn|retry|switch|rotat|limit/i.test(t)) return 'warn';
  if (/\b200\b|\bok\b/i.test(t)) return 'ok';
  return 'plain';
}

/** The services that ask for a look: stopped, or up with a problem. Switched off on purpose is not one. */
export function servicesToWatch(rows: readonly ServiceRow[]): number {
  return rows.filter((r) => r.state === 'fermo' || (r.state !== 'spento' && r.problem !== null)).length; // allow-italian: the hub's wire values
}

/** The lines the log keeps on screen: the newest at the top, at most `max` (the hub's page kept 400). */
export function pushLogLine(lines: readonly LogLine[], line: LogLine, max = 400): LogLine[] {
  return [line, ...lines].slice(0, max);
}
