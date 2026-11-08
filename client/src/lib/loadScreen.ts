/**
 * The load screen (`/schermo[/<machine>]`): what a machine that takes the
 * load shows on its own monitor, as pure reads of four answers.
 *
 *   /api/system/machine-readout  its processes by program (MB, CPU) and, on
 *                                the PC, the sleep keeper's screen file
 *   /api/hub/machines            its state and the four gauges, from the hub
 *   /api/hub/board               the pace of each account (the dial)
 *   /api/all-boards/tasks        the cards running on it
 *
 * Nothing here fetches or keeps time: `now` comes from the caller, so the
 * countdown is a function of two numbers and is tested as one.
 */
import type { ProcessRow, UnitKind } from './machineProcesses';

type JsonRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const list = (v: unknown): JsonRecord[] => (Array.isArray(v) ? v.filter(isRecord) : []);

export interface ScreenProc { name: string; count: number; memMB: number; cpuPct: number | null }
export interface ScreenJob { project: string | null; what: string; who: string | null; since: number | null }
export interface ScreenOutcome { project: string | null; what: string; ok: boolean | null; interrupted: boolean; seconds: number | null; endedAt: number | null }

export interface Readout {
  machine: { id: string | null; name: string; local: boolean };
  /** Why there is no readout: the node does not answer, is not paired, ... */
  error: string | null;
  at: number | null;
  platform: string | null;
  cores: number | null;
  memTotalMB: number | null;
  memMetric: 'rss' | 'working-set' | null;
  procs: ScreenProc[];
  rest: { count: number; memMB: number };
  total: number;
  screen: {
    at: number | null;
    thresholdMin: number | null;
    sleepsAt: number | null;
    reasons: string[];
    jobs: ScreenJob[];
    outcomes: ScreenOutcome[];
  } | null;
}

/** The route's answer, defensively: a field of the wrong type is absent, never a crash. */
export function readReadout(raw: unknown): Readout {
  const top = isRecord(raw) ? raw : {};
  const m = isRecord(top.machine) ? top.machine : {};
  const r = isRecord(top.readout) ? top.readout : null;
  const s = r && isRecord(r.screen) ? r.screen : null;
  const rest = r && isRecord(r.rest) ? r.rest : {};
  return {
    machine: { id: str(m.id), name: str(m.name) ?? '', local: m.local === true },
    error: str(top.error) ?? (r ? null : 'empty'),
    at: r ? num(r.at) : null,
    platform: r ? str(r.platform) : null,
    cores: r ? num(r.cores) : null,
    memTotalMB: r ? num(r.memTotalMB) : null,
    memMetric: r && (r.memMetric === 'rss' || r.memMetric === 'working-set') ? r.memMetric : null,
    procs: r ? list(r.procs).flatMap((p) => {
      const name = str(p.name);
      const memMB = num(p.memMB);
      return name && memMB !== null ? [{ name, count: Math.max(1, num(p.count) ?? 1), memMB, cpuPct: num(p.cpuPct) }] : [];
    }) : [],
    rest: { count: num(rest.count) ?? 0, memMB: num(rest.memMB) ?? 0 },
    total: r ? num(r.total) ?? 0 : 0,
    screen: s ? {
      at: num(s.at),
      thresholdMin: num(s.thresholdMin),
      sleepsAt: num(s.sleepsAt),
      reasons: Array.isArray(s.reasons) ? s.reasons.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [],
      jobs: list(s.jobs).map((j) => ({ project: str(j.project), what: str(j.what) ?? '', who: str(j.who), since: num(j.since) })),
      outcomes: list(s.outcomes).map((o) => ({
        project: str(o.project), what: str(o.what) ?? '', ok: typeof o.ok === 'boolean' ? o.ok : null, interrupted: o.interrupted === true, seconds: num(o.seconds), endedAt: num(o.endedAt),
      })),
    } : null,
  };
}

/**
 * What a program IS, from its name, for the row's icon and label: the
 * operating system's own (Windows' or macOS'), a coding agent's session, a
 * service the load relies on, or an app. Only names known for sure are
 * classified; anything else is an app, never a guess.
 */
const SYSTEM_WIN = new Set([
  'system', 'idle', 'registry', 'secure system', 'memory compression', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso',
  'svchost', 'dwm', 'fontdrvhost', 'msmpeng', 'mpdefendercoreservice', 'nissrv', 'securityhealthservice', 'securityhealthsystray', 'spoolsv',
  'wmiprvse', 'audiodg', 'conhost', 'dllhost', 'sihost', 'taskhostw', 'runtimebroker', 'searchhost', 'searchindexer', 'ctfmon', 'explorer',
  'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost', 'applicationframehost', 'wudfhost', 'smartscreen', 'wlanext', 'aggregatorhost',
]);
const SYSTEM_MAC = new Set(['kernel_task', 'launchd', 'windowserver', 'mds', 'mds_stores', 'mdworker', 'mdworker_shared', 'logd', 'coreaudiod', 'opendirectoryd', 'syspolicyd', 'trustd', 'cfprefsd', 'distnoted', 'fseventsd', 'loginwindow', 'dock', 'finder', 'systemuiserver', 'controlcenter']);
const AGENT = new Set(['claude', 'codex', 'jcode', 'muse', 'museagent', 'opencode', 'gemini']);
const SERVICE = new Set(['bun', 'sshd', 'tailscaled', 'tailscale', 'tailscale-ipn', 'sunshine', 'parsec', 'parsecd', 'ollama']);

export function procKind(name: string, platform: string | null): UnitKind {
  const n = name.toLowerCase();
  if (AGENT.has(n)) return 'sessione'; // allow-italian: the census's wire value
  if (SERVICE.has(n)) return 'servizio'; // allow-italian: the census's wire value
  if (platform === 'win32' ? SYSTEM_WIN.has(n) : platform === 'darwin' ? SYSTEM_MAC.has(n) : false) return 'macos';
  return 'app';
}

/** At or above this a row's memory is drawn warm, as in the Processes view. */
const MEM_WARN_MB = 1500;

/**
 * The readout's programs as rows of the Processes view (`ProcessRowView`):
 * the same row, so the screen and the view cannot drift. GPU and network per
 * process are not measured on the PC: a dash, never a 0.
 */
export function readoutRows(r: Readout, processesWord: (n: number) => string): ProcessRow[] {
  const peak = Math.max(1, ...r.procs.map((p) => p.memMB));
  return r.procs.map((p, i) => ({
    id: `${i}:${p.name}`,
    name: p.name,
    kind: procKind(p.name, r.platform),
    detail: p.count > 1 ? processesWord(p.count) : '',
    memMB: p.memMB,
    memShare: p.memMB / peak,
    memWarn: p.memMB >= MEM_WARN_MB,
    cpuPct: p.cpuPct,
    cpuPartial: false,
    gpuPct: null,
    netInBps: null,
    netOutBps: null,
    script: null,
  }));
}

/** What the hero of the screen says. */
export type SleepView =
  | { kind: 'working' }
  | { kind: 'countdown'; minutes: number; at: number }
  | { kind: 'sleeping' }
  | { kind: 'idle'; thresholdMin: number | null };

/**
 * Working when a card or a job runs on it, or when the keeper names no time
 * to sleep; the countdown when it does, in whole minutes rounded UP (at 30 s
 * left it still says 1 minute, never 0 while it is awake).
 */
export function sleepView(r: Readout, busy: number, now: number): SleepView {
  const s = r.screen;
  if (busy > 0 || (s?.jobs.length ?? 0) > 0) return { kind: 'working' };
  if (s?.sleepsAt != null) {
    const left = s.sleepsAt - now;
    return left <= 0 ? { kind: 'sleeping' } : { kind: 'countdown', minutes: Math.max(1, Math.ceil(left / 60_000)), at: s.sleepsAt };
  }
  if (s && s.reasons.length > 0) return { kind: 'working' };
  return { kind: 'idle', thresholdMin: s?.thresholdMin ?? null };
}

/** A card of the board as the screen needs it. */
export interface ScreenCard {
  id: string;
  title: string;
  projectId: string;
  model: string | null;
  since: number | null;
  /** Who sent it here: the device or the person that started its run. */
  from: string | null;
  /** The feed's row as it came, for the board's own card. */
  raw: JsonRecord;
}

/**
 * The cards in progress on this machine: on a node, those whose `machineId`
 * names it; on the local screen, those with no machine or with the local one.
 * The longest-running first.
 */
export function cardsOn(feed: unknown, machineId: string | null, local: boolean): ScreenCard[] {
  const tasks = isRecord(feed) ? list(feed.tasks) : [];
  return tasks.filter((t) => {
    if (t.status !== 'in_progress') return false;
    const on = str(t.machineId);
    return local ? on === null || on === machineId : on !== null && on === machineId;
  }).map((t) => {
    const since = str(t.inProgressAt) ?? str(t.updatedAt);
    const at = since ? Date.parse(since) : Number.NaN;
    return {
      id: str(t.id) ?? '',
      title: str(t.text) ?? '',
      projectId: str(t.projectId) ?? '',
      model: str(t.model),
      since: Number.isFinite(at) ? at : null,
      // Who started the run, never where it runs: that is this screen's own machine.
      from: str(t.runInitiatorDeviceName) ?? str(t.runInitiatorPersonName),
      raw: t,
    };
  }).sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
}

/**
 * A card's project as a person reads it: the project row whose folder hashes
 * to the board id, else the board id without its hash (`acme-web-gr9brd` is
 * `acme-web`), never the bare id.
 */
export function projectLabel(boardId: string, byBoard: ReadonlyMap<string, { name: string; path: string }>): { name: string; path: string | null } {
  const row = byBoard.get(boardId);
  if (row) return { name: row.name, path: row.path || null };
  return { name: boardId.replace(/-[0-9a-z]{1,6}$/, '') || boardId, path: null };
}

/** An elapsed time as whole hours and minutes, for the «for N min» chips. */
export function elapsedParts(ms: number): { h: number; m: number } {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  return { h: Math.floor(mins / 60), m: mins % 60 };
}

/**
 * The page is laid out for LAYOUT_WIDTH x LAYOUT_HEIGHT px and enlarged to the
 * screen: the same components the app draws, read from across a room. The
 * zoom is the smaller of the two fits, so a wide screen (the PC's 3440x1440)
 * does not trade height for width: zoomed by its width alone it left 720 px
 * of layout, and the last process row was cut in half. Never below 1 (a small
 * window stays the app's own size), never above 2.
 */
export const LAYOUT_WIDTH = 1320;
export const LAYOUT_HEIGHT = 740;

export function screenZoom(width: number, height = Infinity): number {
  if (!(width > 0) || !(height > 0)) return 1;
  const fit = Math.min(width / LAYOUT_WIDTH, height / LAYOUT_HEIGHT);
  return Math.min(2, Math.max(1, Math.floor(fit * 20) / 20));
}

/** The machine named in the address: `/schermo/<id>`, null for this machine. */
export function loadScreenMachine(pathname: string): string | null | undefined {
  const m = /^\/schermo(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!m) return undefined;
  return m[1] ? decodeURIComponent(m[1]) : null;
}
