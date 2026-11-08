/**
 * THE MACHINE'S OWN READOUT: who weighs on THIS machine, process by process,
 * and, on a machine that takes the load (the Windows PC), what its sleep
 * keeper says on its screen file.
 *
 * WHY IT EXISTS. The usage hub knows the PC only through `pc-state`, one
 * `type` of `autosleep.now` a minute: the heaviest program and four
 * percentages. It cannot ask for more without resetting the PC's sleep count
 * (a longer ssh session counts as work). The PC's own Topics server can read
 * its process list and the sleep keeper's screen file locally, for free, and
 * the Mac reaches it through the node channel it already has (HTTP, not ssh).
 *
 * Two halves, kept apart so the parsing is tested without a machine:
 *  - pure readers of `ps`, of PowerShell's `Get-Process` lines and of the
 *    screen file;
 *  - `createMachineReadout`, the one reader with a cache, whose process list
 *    and file come from injected functions.
 *
 * METRIC HONESTY. Memory is `rss` from `ps` and the working set on Windows
 * (`memMetric` says which). CPU is in % of ONE core, the Processes view's
 * convention. On Windows it is the difference between two readings of the
 * cumulative processor seconds, so the first reading has none: a null, drawn
 * as a dash, never a 0.
 */

/** One process as the OS listed it. `cpuPct` is null where the reading has none. */
export interface RawProc {
  pid: number;
  name: string;
  memMB: number;
  /** % of one core, from `ps` (darwin, linux). */
  cpuPct: number | null;
  /** Cumulative processor seconds, from `Get-Process` (Windows). */
  cpuSeconds: number | null;
  /** Set when its command line, or an ancestor's, names `offload` or `pw-remote`: work sent from the Mac, not a service. */
  job?: true;
}

/** Processes grouped by program name, the heaviest first. */
export interface ProcGroup {
  name: string;
  count: number;
  memMB: number;
  /** % of one core summed over the group; null when no process of it was measured. */
  cpuPct: number | null;
  /** The group is work sent from the Mac (see `RawProc.job`): kept apart from a same-named service. */
  job?: true;
}

export interface ScreenJob {
  project: string | null;
  what: string;
  who: string | null;
  since: number | null;
}

export interface ScreenOutcome {
  project: string | null;
  what: string;
  /** true = it passed, false = it failed, null = interrupted or an outcome the file did not name. */
  ok: boolean | null;
  /** Stopped before its end (the keeper's `interrotto`: the ssh went away, a signal). allow-italian: the keeper's wire value */
  interrupted: boolean;
  seconds: number | null;
  endedAt: number | null;
}

/** What the sleep keeper wrote for the PC's own screen. */
export interface ScreenState {
  at: number | null;
  thresholdMin: number | null;
  /** When the machine goes to sleep, null while something keeps it awake. */
  sleepsAt: number | null;
  reasons: string[];
  jobs: ScreenJob[];
  outcomes: ScreenOutcome[];
}

export interface MachineReadout {
  at: number;
  platform: string;
  cores: number;
  memTotalMB: number | null;
  memMetric: "rss" | "working-set";
  procs: ProcGroup[];
  /** Everything after the top rows, in one line. */
  rest: { count: number; memMB: number };
  /** Total processes listed. */
  total: number;
  screen: ScreenState | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/**
 * A time as the keeper writes it: `sospendeAlle` is epoch milliseconds (its
 * `Epoch-Ms`, a NUMBER), the other times are ISO strings. Both are read; a
 * number too small to be milliseconds is seconds.
 */
const timeOf = (v: unknown): number | null => {
  const n = num(v);
  if (n !== null) return n > 0 ? (n < 1e11 ? n * 1000 : n) : null;
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/** `C:\Program Files\x\Code.exe` and `/usr/bin/node` are `Code` and `node`. */
export function programName(raw: string): string {
  const base = raw.trim().split(/[\\/]/).pop() ?? raw;
  return base.replace(/\.exe$/i, "") || raw;
}

/**
 * `ps -axo pid=,rss=,%cpu=,comm=` lines. `comm` may hold spaces (macOS app
 * bundles), so it is the rest of the line.
 */
export function parsePsLines(text: string): RawProc[] {
  const out: RawProc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      name: programName(m[4]),
      memMB: Number(m[2]) / 1024,
      cpuPct: Number(m[3].replace(",", ".")),
      cpuSeconds: null,
    });
  }
  return out;
}

/** The PowerShell line format `Name|Id|CPU|WorkingSet64[|job]` (see WINDOWS_PS_LOOP); the last field is `1` for work sent from the Mac. */
export function parseWinProcLines(text: string): RawProc[] {
  const out: RawProc[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split("|");
    if (parts.length !== 4 && parts.length !== 5) continue;
    const pid = Number(parts[1]);
    const ws = Number(parts[3]);
    if (!Number.isFinite(pid) || !Number.isFinite(ws) || !parts[0].trim()) continue;
    // A process the reader may not open (System, Idle) has an empty CPU: not measured.
    const cpu = parts[2].trim() === "" ? null : Number(parts[2].replace(",", "."));
    out.push({
      pid, name: programName(parts[0]), memMB: ws / (1024 * 1024), cpuPct: null, cpuSeconds: cpu !== null && Number.isFinite(cpu) ? cpu : null,
      ...(parts[4]?.trim() === "1" ? { job: true as const } : {}),
    });
  }
  return out;
}

/**
 * The CPU of each Windows process between two readings, in % of one core.
 * A pid seen for the first time (or whose counter went back: a reused pid)
 * has no figure.
 */
export function winCpuBetween(prev: ReadonlyMap<number, number>, cur: RawProc[], dtSeconds: number): RawProc[] {
  if (!(dtSeconds > 0)) return cur;
  return cur.map((p) => {
    const before = prev.get(p.pid);
    if (p.cpuSeconds === null || before === undefined || p.cpuSeconds < before) return p;
    return { ...p, cpuPct: ((p.cpuSeconds - before) / dtSeconds) * 100 };
  });
}

/** The processes by program, heaviest memory first, the top `top` and the rest. */
export function groupProcs(procs: RawProc[], top = 12): { procs: ProcGroup[]; rest: { count: number; memMB: number } } {
  const by = new Map<string, ProcGroup>();
  for (const p of procs) {
    // Work sent from the Mac is its own row: a `bun` test suite is not the `bun` service beside it.
    const key = p.job ? `${p.name.toLowerCase()}\u0000job` : p.name.toLowerCase();
    const g = by.get(key) ?? { name: p.name, count: 0, memMB: 0, cpuPct: null, ...(p.job ? { job: true as const } : {}) };
    g.count += 1;
    g.memMB += p.memMB;
    if (p.cpuPct !== null) g.cpuPct = (g.cpuPct ?? 0) + p.cpuPct;
    by.set(key, g);
  }
  const all = [...by.values()].sort((a, b) => b.memMB - a.memMB);
  const shown = all.slice(0, top).map((g) => ({ ...g, memMB: Math.round(g.memMB), cpuPct: g.cpuPct === null ? null : Math.round(g.cpuPct * 10) / 10 }));
  const restRows = all.slice(top);
  return { procs: shown, rest: { count: restRows.reduce((s, g) => s + g.count, 0), memMB: Math.round(restRows.reduce((s, g) => s + g.memMB, 0)) } };
}

/**
 * The screen file as the sleep keeper writes it: one global assignment, the
 * object being PowerShell's ConvertTo-Json. Anything that does not parse is
 * null: the screen then says it has no reading, never a made-up countdown.
 */
export function parseScreenFile(text: string): ScreenState | null {
  const body = text.replace(/^\uFEFF/, "").trim().replace(/^window\.STATO\s*=\s*/, "").replace(/;\s*$/, "");
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return null; }
  if (!isRecord(raw)) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isRecord) : []);
  const outcome = (v: unknown): boolean | null => {
    const s = str(v)?.toLowerCase();
    return s === "ok" || s === "riuscito" ? true : s === "fallito" || s === "errore" ? false : null; // allow-italian: the keeper's wire values
  };
  return {
    at: timeOf(raw.ora),
    thresholdMin: num(raw.sogliaMinuti),
    sleepsAt: timeOf(raw.sospendeAlle),
    reasons: (Array.isArray(raw.motivi) ? raw.motivi : []).map(str).filter((s): s is string => s !== null),
    jobs: list(raw.lavori).map((j) => ({
      project: str(j.progetto),
      what: str(j.cosa) ?? str(j.comando) ?? "",
      who: str(j.chi) ?? str(j.per),
      since: timeOf(j.inizio) ?? timeOf(j.dal) ?? timeOf(j.da),
    })).filter((j) => j.what !== "" || j.project !== null),
    outcomes: list(raw.esiti).map((e) => ({
      project: str(e.progetto),
      what: str(e.cosa) ?? "",
      ok: outcome(e.esito),
      interrupted: str(e.esito)?.toLowerCase() === "interrotto", // allow-italian: the keeper's wire value
      seconds: num(e.secondi),
      endedAt: timeOf(e.fine),
    })).slice(0, 8),
  };
}

/** The line that closes one listing of the warm PowerShell loop. */
export const WINDOWS_PS_END = "__TOPICS_PROCS_END__";

/**
 * The warm PowerShell loop behind the Windows list (`warm-lister.ts`): for
 * every line read on stdin, one line per process and then the end marker. It
 * ends by itself when stdin closes. No module to load.
 *
 * A `bun` process is looked at once, when it first appears: its command line
 * and its ancestors' (up to six) are read, and one that names `offload` or
 * `pw-remote` is work sent from the Mac, flagged `1` in the last field. The
 * answer is kept by pid and dropped when the process goes, so a steady reading
 * costs what it cost before and only a new `bun` pays for the query.
 */
export const WINDOWS_PS_LOOP = [
  "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $jobs=@{};",
  "function Test-SentWork($id) { for ($i=0; $i -lt 6 -and $id; $i++) { $w=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id); if (-not $w) { return 0 }; if ($w.CommandLine -match 'offload|pw-remote') { return 1 }; $id=$w.ParentProcessId }; return 0 };",
  "while ($null -ne [Console]::In.ReadLine()) {",
  "$all=@(Get-Process); $live=@{};",
  "foreach ($p in $all) { if ($p.ProcessName -eq 'bun') { $live[$p.Id]=1; if (-not $jobs.ContainsKey($p.Id)) { $jobs[$p.Id]=Test-SentWork $p.Id } } };",
  "foreach ($k in @($jobs.Keys)) { if (-not $live.ContainsKey($k)) { $jobs.Remove($k) } };",
  "$all | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessName,$_.Id,$_.CPU,$_.WorkingSet64,$jobs[$_.Id] };",
  `'${WINDOWS_PS_END}'; [Console]::Out.Flush() }`,
].join(" ");

export interface MachineReadoutDeps {
  platform: string;
  cores: () => number;
  memTotalMB: () => number | null;
  /** The OS's process listing as text (ps lines, or the PowerShell lines on Windows). */
  listProcesses: () => Promise<string>;
  /** The screen file's text, null when the machine has none. */
  readScreenFile: () => Promise<string | null>;
  now: () => number;
  /** A reading younger than this is served again (the PowerShell list costs a fraction of a second of CPU). */
  ttlMs?: number;
}

/**
 * One reader per process. Concurrent callers share the read in flight; a
 * failed listing answers an empty list with the screen file still read, so a
 * broken `ps` does not hide the countdown.
 */
export function createMachineReadout(deps: MachineReadoutDeps): () => Promise<MachineReadout> {
  const ttl = deps.ttlMs ?? 20_000;
  const windows = deps.platform === "win32";
  let cached: MachineReadout | null = null;
  let inFlight: Promise<MachineReadout> | null = null;
  let prevCpu: { at: number; byPid: Map<number, number> } | null = null;

  async function read(): Promise<MachineReadout> {
    const at = deps.now();
    let procs: RawProc[] = [];
    try {
      const text = await deps.listProcesses();
      procs = windows ? parseWinProcLines(text) : parsePsLines(text);
    } catch { procs = []; }
    if (windows) {
      const byPid = new Map(procs.flatMap((p) => (p.cpuSeconds === null ? [] : [[p.pid, p.cpuSeconds] as [number, number]])));
      if (prevCpu) procs = winCpuBetween(prevCpu.byPid, procs, (at - prevCpu.at) / 1000);
      if (byPid.size > 0) prevCpu = { at, byPid };
    }
    let screen: ScreenState | null = null;
    try {
      const text = await deps.readScreenFile();
      screen = text === null ? null : parseScreenFile(text);
    } catch { screen = null; }
    const grouped = groupProcs(procs);
    return {
      at,
      platform: deps.platform,
      cores: deps.cores(),
      memTotalMB: deps.memTotalMB(),
      memMetric: windows ? "working-set" : "rss",
      procs: grouped.procs,
      rest: grouped.rest,
      total: procs.length,
      screen,
    };
  }

  return async () => {
    if (cached && deps.now() - cached.at < ttl) return cached;
    if (inFlight) return inFlight;
    inFlight = read().then((r) => { cached = r; return r; }).finally(() => { inFlight = null; });
    return inFlight;
  };
}
