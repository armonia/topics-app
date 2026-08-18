/**
 * Fleet usage: how much machine the SERVER SIDE of Topics is really using.
 *
 * WHY THIS EXISTS: `/api/system/status` used to report `process.memoryUsage().rss`,
 * i.e. the Bun process and nothing else. Measured on a live box that reads ~87 MB
 * while the work the server actually owns (the detached pty-bridge and the whole
 * tree of `claude` CLIs, MCP servers and headless Chromes hanging off it, plus the
 * ai-bridge and the WebRTC sidecar) was ~5 GB across ~95 processes. The one number
 * the status bar exists to show was off by roughly 50x.
 *
 * The desktop shell has the same problem SOLVED on its side (`perf_metrics` in
 * desktop-tauri walks the macOS "responsible process" set and sums footprint), but
 * that set covers the shell and its WKWebView XPC services only: the sidecars are
 * launchd-reparented children of the SERVER and never appear in it. This module is
 * the server's half of the same answer.
 *
 * ATTRIBUTION: on macOS we use `responsibility_get_pid_responsible_for_pid` (the
 * same kernel call the Tauri shell uses). This survives launchd reparenting: a
 * detached pty-bridge still names the server as its responsible process. Processes
 * where resp==server.pid form the server set; processes where resp==sidecar.pid
 * form the sidecar set. Two sets defined by two roots are disjoint by construction,
 * no subtraction needed. On non-macOS we fall back to socket-path matching + ppid
 * walking (the original logic), which is imprecise but always worked there.
 *
 * THREE AXES:
 *  - server root: the Bun process and its direct children
 *  - sidecars: pty-bridge, ai-bridge, WebRTC (identified by socket path)
 *  - scripts: agent-launched work (registered via registerFleetScriptSource),
 *    EXCLUDED from the server total so the UI can show it separately
 *
 * METRIC HONESTY (revised 2026-08-04): we sum `phys_footprint` where the kernel
 * exposes it, falling back to `ps rss` only where it does not. `memMetric` says
 * which metric landed in the total so the client can label it instead of guessing.
 */

import { machineCores } from "./machine-cores";

const isWindows = process.platform === "win32";

/** Core logici della macchina. Passa da `machine-cores.ts` e non da `cpus()`
 *  perché quella lettura, sotto carico, sa tornare vuota: qui il danno sarebbe
 *  silenzioso e al contrario: `cpuPercent` è normalizzato su questo numero,
 *  quindi una macchina creduta da un core fa SOTTOSTIMARE la CPU della flotta,
 *  e il freno che la legge resterebbe largo proprio quando deve stringere. */
const CPU_CORES = () => machineCores();

/** Sidecars that hold the server-side fleet. Kept as a closed union so a typo
 *  in a registration site is a type error, not a silently missing 4 GB. */
export type FleetKind = "pty-bridge" | "ai-bridge" | "webrtc-bridge";

const sockets = new Map<FleetKind, string>();

/**
 * Declare "the process whose command line contains this socket path is one of
 * ours". Called at module scope by each sidecar client. Idempotent; the last
 * registration wins (a socket path is recomputed only when the data dir changes,
 * which in practice means a different process entirely).
 */
export function registerFleetSocket(kind: FleetKind, socketPath: string): void {
  if (socketPath) sockets.set(kind, socketPath);
}

/** Una sessione PTY e il pid di testa del suo albero. Il bridge lo riporta gia'
 *  su create e reconcile (`routes/terminal.ts`), quindi non c'e' niente di nuovo
 *  da tracciare: va solo passato di qua. */
export interface FleetSessionRef {
  sessionId: string;
  name: string;
  pid: number;
}

/** Un processo lanciato da un agente (via runningScripts in processes.ts).
 *  Identificato per pid + lstart per essere robusto ai pid riusati. */
export interface FleetScriptRef {
  pid: number;
  /** Tempo di avvio del processo nel formato di `ps lstart`, per evitare di
   *  confondere un pid riusato con quello originale. Opzionale: se assente,
   *  si usa solo il pid. */
  lstart?: string;
}

/** Da dove arrivano le sessioni al momento del campionamento.
 *
 *  E' un seam, non un import diretto, per la stessa ragione per cui i sidecar si
 *  registrano da soli: `routes/terminal.ts` importa gia' questo modulo, e
 *  importarlo all'indietro chiuderebbe il ciclo. Assente => nessuna attribuzione
 *  per sessione, e tutto il resto continua a funzionare come prima. */
let sessionSource: (() => FleetSessionRef[]) | null = null;

export function registerFleetSessionSource(fn: () => FleetSessionRef[]): void {
  sessionSource = fn;
}

/** Da dove arrivano i processi-script al momento del campionamento.
 *  Stesso pattern di sessionSource. Assente => scriptsMB = 0. */
let scriptSource: (() => FleetScriptRef[]) | null = null;

export function registerFleetScriptSource(fn: () => FleetScriptRef[]): void {
  scriptSource = fn;
}

/** Test seam: forget every registration (unit tests register their own). */
export function _resetFleetSockets(): void {
  sockets.clear();
  sessionSource = null;
  scriptSource = null;
}

export interface FleetRootUsage {
  kind: FleetKind | "server";
  pid: number;
  processCount: number;
  memoryMB: number;
  cpuPercent: number;
}

export interface FleetSessionUsage {
  sessionId: string;
  name: string;
  /** Pid di testa dell'albero della sessione. */
  pid: number;
  processCount: number;
  memoryMB: number;
  /** `null` = NON MISURATA, che non è la stessa cosa di zero. Una sessione
   *  appena avviata non ha ancora un delta di CPU da cui ricavare una
   *  percentuale; dichiararla `0` la farebbe passare per ferma. Stessa regola
   *  che `makeInstantCpu` applica ai pid senza base. */
  cpuPercent: number | null;
}

export interface FleetUsage {
  /** Processes counted, including the server itself. */
  processCount: number;
  /** Memoria della flotta in MB — `phys_footprint` dove il kernel lo espone
   *  (stessa metrica della shell e di Monitoraggio Attività), `ps rss` come
   *  ripiego. Quale delle due lo dice `memMetric`. */
  memoryMB: number;
  /** Da dove viene `memoryMB`: `footprint` = la metrica buona ovunque,
   *  `rss` = solo il ripiego, `mixed` = una parte per uno. Esposto perché il
   *  client possa etichettare il numero invece di far finta che sia sempre lo
   *  stesso — `rss` sovrastima le pagine condivise di circa il 40%. */
  memMetric: "footprint" | "rss" | "mixed";
  /** CPU della flotta sulla scala 0-100 dell'INTERA macchina, come la legge
   *  Monitoraggio Attività — non la somma grezza di `ps %cpu`.
   *
   *  `ps` conta per CORE: 100% = un core saturo, e su questa macchina il
   *  massimo è 1200%. Affiancata alla CPU di sistema (0-100) quella scala si
   *  legge male: "170%" accanto a un Mac al 30% sembra una contraddizione,
   *  mentre sono 1,7 core su 12 = il 14% della macchina. Si divide una volta
   *  qui, alla sorgente, così ogni consumatore parla la stessa lingua.
   *  `cpuCores` resta esposto per poter risalire al numero per-core. */
  cpuPercent: number;
  /** Core logici su cui è normalizzato `cpuPercent` (vedi `machine-cores.ts`). */
  cpuCores: number;
  /** Per-root split, so the dropdown can say WHERE the memory is. */
  roots: FleetRootUsage[];
  /** Ripartizione per SESSIONE dentro il pty-bridge. `roots` sa dire «il
   *  pty-bridge tiene 1,2 GB su 14 processi»; questo sa dire quanto ne tiene
   *  ciascuna sessione. Vuoto quando nessuna sorgente è registrata (o nessuna
   *  sessione è viva), e i totali non ne dipendono. */
  sessions: FleetSessionUsage[];
  /** Memoria dei processi lanciati dagli agenti (terzo asse, escluso dal totale
   *  server). Questi sono npm/pnpm/bun install, build, test e simili avviati
   *  dall'agente: contano nel budget del dispositivo ma non nel costo di Topics. */
  scriptsMB: number;
  /** Numero di processi classificati come script-agente. */
  scriptsProcessCount: number;
  /** False when the platform has no usable `ps` (Windows) — the client then
   *  keeps showing the single-process figure instead of a confident wrong one. */
  supported: boolean;
}

export interface PsRow {
  pid: number;
  ppid: number;
  rssKB: number;
  /** `phys_footprint` in KB quando il kernel lo sa dire: la stessa metrica della
   *  shell e di Monitoraggio Attività. Assente ⇒ si usa `rssKB`, che sovrastima
   *  le pagine condivise. Vedi `procFootprintKB`. */
  footprintKB?: number;
  /** `ps pcpu`: media sull'INTERA VITA del processo. Ripiego, non la misura. */
  cpu: number;
  /** `ps time`: secondi di CPU consumati finora. La differenza fra due letture,
   *  divisa per il tempo trascorso, e' la CPU istantanea. */
  cpuSeconds: number;
  command: string;
}

/** `[[dd-]hh:]mm:ss[.cc]` → secondi. Il formato di `ps time=` cambia con la
 *  durata (`12:34`, `1:02:03`, `3-04:05:06`), quindi si conta dai campi in coda. */
export function parseCpuTimeSeconds(v: string): number {
  const m = v.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  const [, d, h, mi, se] = m;
  return (+(d ?? 0)) * 86400 + (+(h ?? 0)) * 3600 + (+mi) * 60 + parseFloat(se);
}

/** Parse `ps -axo pid=,ppid=,rss=,pcpu=,time=,command=`. Exported for the unit
 *  test: the parsing (not the spawning) is where this can silently go wrong.
 *
 *  `cpu` resta la lettura di `pcpu` (media di VITA del processo), tenuta solo
 *  come ripiego; il numero che conta e' `cpuSeconds`, da cui si ricava la CPU
 *  ISTANTANEA per differenza fra due letture. Vedi `getFleetUsage`. */
export function parsePsRows(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: +m[1], ppid: +m[2], rssKB: +m[3],
      cpu: parseFloat(m[4]),
      cpuSeconds: parseCpuTimeSeconds(m[5]),
      command: m[6],
    });
  }
  return rows;
}

/**
 * Sum rss/cpu over `roots` and every descendant of theirs, counting each pid once
 * (a pid reachable from two roots must not be billed twice). Pure: the test
 * drives it with a synthetic table instead of the live machine.
 *
 * When `responsibleOf` is provided (macOS), a process belongs to a root if
 * `responsibleOf(proc.pid) == root.pid`. This survives launchd reparenting.
 * Without it we fall back to ppid walking (the original logic).
 */
export function summarizeFleet(
  rows: PsRow[],
  roots: { kind: FleetKind | "server"; pid: number }[],
  /** CPU % ISTANTANEA di un pid. Assente = si ripiega su `ps pcpu` (media di
   *  vita), che e' cio' che faceva prima e va bene solo come ultima risorsa.
   *  `null` = pid senza base, quindi NON MISURATO: conta 0 nei totali (come ha
   *  sempre fatto) ma le sessioni lo distinguono da uno zero vero. */
  instantCpu?: (row: PsRow) => number | null,
  /** Core logici su cui normalizzare la CPU. Default 1 = scala `ps` grezza
   *  (per-core), che e' cio' che i test verificano; `getFleetUsage` passa i core
   *  della macchina per restituire la scala 0-100. */
  cpuCores = 1,
  /** Sessioni da attribuire dentro l'albero gia' coperto dai root. Vuoto =
   *  nessuna attribuzione, e ogni altro numero resta identico. */
  sessions: FleetSessionRef[] = [],
  /** Processi-script (lavoro degli agenti): vengono esclusi dal totale server e
   *  contati nell'asse `scripts`. Vuoto = scriptsMB = 0. */
  scripts: FleetScriptRef[] = [],
  /** Opzionale: dato un pid, restituisce il suo responsible pid (macOS).
   *  Quando presente si usa per l'attribuzione invece del ppid walk. */
  responsibleOf?: (pid: number) => number | null,
): Omit<FleetUsage, "supported"> {
  const byPid = new Map<number, PsRow>();
  const children = new Map<number, number[]>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const arr = children.get(r.ppid);
    if (arr) arr.push(r.pid); else children.set(r.ppid, [r.pid]);
  }

  // Una macchina senza core dichiarati non deve produrre Infinity/NaN.
  const divisor = cpuCores > 0 ? cpuCores : 1;
  const counted = new Set<number>();
  const rootUsages: FleetRootUsage[] = [];
  // Quale metrica di memoria e' finita davvero nel totale. Un insieme misto
  // (footprint per alcuni pid, rss per altri) si dichiara "mixed" invece di
  // presentarsi come footprint puro.
  let sawFootprint = false;
  let sawRss = false;

  // Script pids: processi lanciati dagli agenti che vanno contati separatamente.
  const scriptPidSet = new Set<number>(scripts.map(s => s.pid).filter(p => byPid.has(p)));

  for (const root of roots) {
    if (!byPid.has(root.pid)) continue;
    let procs = 0, rssKB = 0, cpu = 0;

    // ATTRIBUZIONE: usa responsible pid quando disponibile (macOS), ppid walk
    // come ripiego. Le due strade producono lo stesso risultato su processi
    // normali; divergono sugli orfani reparentati a launchd, dove il responsible
    // pid sopravvive e il ppid non aiuta.
    if (responsibleOf) {
      // Tutti i processi con responsible == root.pid appartengono a questo root.
      // Il root stesso e' incluso con un controllo esplicito sul pid.
      for (const row of rows) {
        if (row.pid !== root.pid && responsibleOf(row.pid) !== root.pid) continue;
        if (scriptPidSet.has(row.pid)) continue; // terzo asse: escludi gli script
        if (counted.has(row.pid)) continue;
        counted.add(row.pid);
        procs++;
        if (row.footprintKB !== undefined) sawFootprint = true; else sawRss = true;
        rssKB += row.footprintKB ?? row.rssKB;
        cpu += (instantCpu ? instantCpu(row) : row.cpu) ?? 0;
      }
    } else {
      // Fallback: ppid walk originale (non-macOS o FFI non disponibile).
      const stack = [root.pid];
      const seenHere = new Set<number>();
      while (stack.length) {
        const pid = stack.pop()!;
        if (seenHere.has(pid)) continue;
        seenHere.add(pid);
        for (const c of children.get(pid) ?? []) stack.push(c);
        if (scriptPidSet.has(pid)) continue; // terzo asse: escludi gli script
        if (counted.has(pid)) continue; // already billed to an earlier root
        counted.add(pid);
        const row = byPid.get(pid);
        if (!row) continue;
        procs++;
        // Footprint quando c'e', `rss` come ripiego.
        if (row.footprintKB !== undefined) sawFootprint = true; else sawRss = true;
        rssKB += row.footprintKB ?? row.rssKB;
        cpu += (instantCpu ? instantCpu(row) : row.cpu) ?? 0;
      }
    }

    rootUsages.push({
      kind: root.kind,
      pid: root.pid,
      processCount: procs,
      memoryMB: Math.round(rssKB / 1024),
      // Normalizzato qui, sul singolo root: il totale e' la somma dei root, che
      // resterebbe per-core se dividessimo solo la'.
      cpuPercent: Math.round((cpu / divisor) * 10) / 10,
    });
  }

  // Calcola il terzo asse: processi-script e la loro memoria.
  // Questi NON sono nella counted set e vengono misurati separatamente.
  let scriptsTotalKB = 0;
  let scriptsProcs = 0;
  for (const s of scripts) {
    // Usa ppid walk per i figli dello script (es. i nipoti di npm install).
    const stack = [s.pid];
    const seen = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      for (const c of children.get(pid) ?? []) stack.push(c);
      const row = byPid.get(pid);
      if (!row) continue;
      scriptsProcs++;
      scriptsTotalKB += row.footprintKB ?? row.rssKB;
      if (row.footprintKB !== undefined) sawFootprint = true; else sawRss = true;
    }
  }

  // Le sessioni si calcolano in un passaggio SEPARATO, con un proprio insieme
  // di pid gia' fatturati. Riusare `counted` dei root sottrarrebbe processi ai
  // root stessi (le sessioni vivono DENTRO l'albero del pty-bridge): i totali
  // di flotta devono restare esattamente quelli di prima, e questa parte e'
  // solo una lente su una porzione gia' contata.
  const sessionUsages: FleetSessionUsage[] = [];
  const billed = new Set<number>();
  for (const s of sessions) {
    if (!byPid.has(s.pid)) continue; // sessione registrata ma processo gia' morto
    let procs = 0, memKB = 0, cpu = 0, measured = 0;
    const stack = [s.pid];
    const seenHere = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (seenHere.has(pid)) continue;
      seenHere.add(pid);
      for (const c of children.get(pid) ?? []) stack.push(c);
      if (billed.has(pid)) continue; // una sessione annidata in un'altra non raddoppia
      billed.add(pid);
      const row = byPid.get(pid);
      if (!row) continue;
      procs++;
      memKB += row.footprintKB ?? row.rssKB;
      const c = instantCpu ? instantCpu(row) : row.cpu;
      if (c !== null) { cpu += c; measured++; }
    }
    sessionUsages.push({
      sessionId: s.sessionId,
      name: s.name,
      pid: s.pid,
      processCount: procs,
      memoryMB: Math.round(memKB / 1024),
      // Nessun pid con una base => non misurata. Uno `0` qui direbbe "ferma",
      // che di una sessione appena avviata non lo sappiamo.
      cpuPercent: measured > 0 ? Math.round((cpu / divisor) * 10) / 10 : null,
    });
  }

  return {
    processCount: rootUsages.reduce((a, r) => a + r.processCount, 0),
    memoryMB: rootUsages.reduce((a, r) => a + r.memoryMB, 0),
    cpuPercent: Math.round(rootUsages.reduce((a, r) => a + r.cpuPercent, 0) * 10) / 10,
    cpuCores: divisor,
    memMetric: sawFootprint ? (sawRss ? "mixed" : "footprint") : "rss",
    roots: rootUsages,
    sessions: sessionUsages,
    scriptsMB: Math.round(scriptsTotalKB / 1024),
    scriptsProcessCount: scriptsProcs,
  };
}

/** Resolve the registered sockets to live pids using one `ps` snapshot. */
export function resolveFleetRoots(rows: PsRow[], selfPid: number): { kind: FleetKind | "server"; pid: number }[] {
  const roots: { kind: FleetKind | "server"; pid: number }[] = [{ kind: "server", pid: selfPid }];
  for (const [kind, sock] of sockets) {
    // The sidecar's own command line contains `--socket <path>`. Skip ourselves:
    // the server never carries the socket on its argv, but a future refactor
    // might, and billing the server twice would be silent double counting.
    const hit = rows.find(r => r.pid !== selfPid && r.command.includes(sock));
    if (hit) roots.push({ kind, pid: hit.pid });
  }
  return roots;
}

// One snapshot shared by every caller in a window. The status endpoint is polled
// at 5s by the status bar and faster by the dropdown; `ps -axo … command=` over
// ~500 processes is cheap but not free, so it is not run per request.
let cached: FleetUsage | null = null;
let cachedAt = 0;
const FLEET_TTL_MS = 4000;

/**
 * `phys_footprint` di un pid in KB — la stessa cifra che Monitoraggio Attività
 * mostra nella colonna "Memoria", e la stessa che la shell Tauri già usa per la
 * sua metà (`proc_pid_rusage` in `desktop-tauri/src-tauri/src/lib.rs`).
 *
 * IL DIFETTO CHE CHIUDE, misurato il 2026-08-04: la barra sommava il footprint
 * della shell con la somma di `ps rss` del lato server — DUE METRICHE DIVERSE
 * presentate come un totale unico. Il punto non è che una sia più bassa: è che
 * sommarle non significa niente. Misurato sull'albero server (19 processi):
 * 2,07 GB di `rss` contro 1,17 GB di footprint, il 44% in meno.
 *
 * Le due divergono in ENTRAMBI i versi, quindi non aspettarsi un segno fisso:
 * `rss` conta ogni pagina CONDIVISA una volta per processo (e il lato server è
 * un albero di processi che condividono lo stesso runtime Bun — di qui il -44%
 * qui), ma NON conta ciò che il kernel ha compresso o mandato in swap, che il
 * footprint invece include. Sulla stessa macchina, sommando TUTTI i processi,
 * il footprint risultava 3x l'`rss` proprio per la memoria compressa.
 *
 * `null` quando la piattaforma non sa rispondere (non-macOS, o un Bun senza
 * FFI): il chiamante ripiega su `rss`, che è impreciso ma esiste ovunque —
 * meglio la stima vecchia che nessun numero.
 */
const procFootprintKB: (pid: number) => number | null = (() => {
  if (isWindows) return () => null;
  try {
    // rusage_info_v2: 16 byte di uuid, poi `uint64_t`; `ri_phys_footprint` è il
    // settimo dopo l'uuid → offset 16 + 7*8 = 72.
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.dylib", {
      proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    const buf = new BigUint64Array(64);
    const view = new DataView(buf.buffer);
    return (pid: number): number | null => {
      try {
        // RUSAGE_INFO_V2 = 2. Non-zero = pid morto o non interrogabile.
        if (lib.symbols.proc_pid_rusage(pid, 2, buf) !== 0) return null;
        const bytes = view.getBigUint64(72, true);
        return bytes > 0n ? Number(bytes / 1024n) : null;
      } catch {
        return null;
      }
    };
  } catch {
    // Nessuna FFI: si resta su `rss` senza far rumore.
    return () => null;
  }
})();

/**
 * `responsibility_get_pid_responsible_for_pid`: dato un pid, restituisce il pid
 * del processo "responsabile" secondo macOS. Sopravvive al reparenting a launchd:
 * un sidecar reparentato a pid 1 mantiene il server come responsible pid.
 *
 * Costo: ~2 ms su ~950 pid (misurato). Nessun fork, nessun `ps`.
 *
 * `null` quando la piattaforma non e' macOS o la FFI non e' disponibile. In quel
 * caso `finish()` passa `undefined` a `summarizeFleet` che ricade sul ppid walk.
 */
const { responsiblePidFn, responsiblePidAvailable } = (() => {
  if (isWindows || process.platform !== "darwin") {
    return { responsiblePidFn: (_: number): number | null => null, responsiblePidAvailable: false };
  }
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.dylib", {
      responsibility_get_pid_responsible_for_pid: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    const fn = (pid: number): number | null => {
      try {
        const r = lib.symbols.responsibility_get_pid_responsible_for_pid(pid);
        // -1 = pid non trovato o zombi, 0 = non applicabile.
        return r > 0 ? r : null;
      } catch { return null; }
    };
    return { responsiblePidFn: fn, responsiblePidAvailable: true };
  } catch {
    return { responsiblePidFn: (_: number): number | null => null, responsiblePidAvailable: false };
  }
})();

/** Lettura precedente dei secondi di CPU per pid: e' la BASE da cui si ricava
 *  la percentuale istantanea. Senza, si potrebbe solo riportare la media di
 *  vita di `ps pcpu`, che e' il difetto che questo modulo aveva. */
let prevSample: { at: number; byPid: Map<number, number> } | null = null;

async function snapshot(): Promise<PsRow[]> {
  const proc = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss=,pcpu=,time=,command="], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  const rows = parsePsRows(text);
  // Footprint dove il kernel lo sa dire; `rssKB` resta il ripiego (vedi
  // `procFootprintKB`). Si arricchisce QUI, non dentro `parsePsRows`, perche'
  // quella e' pura e il test la guida con una tabella sintetica.
  for (const r of rows) {
    const fp = procFootprintKB(r.pid);
    if (fp !== null) r.footprintKB = fp;
  }
  return rows;
}

/** CPU % di un pid fra due letture. Un pid mai visto prima non ha una base e
 *  restituisce `null` — NON MISURATO, che non è «misurato, zero»: un processo
 *  appena nato non ha ancora un delta da cui ricavare una percentuale.
 *
 *  I totali continuano a trattarlo come 0 (era già così, e sommare «non lo so»
 *  non ha senso), ma l'attribuzione per sessione se ne accorge e lo dichiara
 *  invece di far passare una sessione appena avviata per ferma. */
function makeInstantCpu(base: { at: number; byPid: Map<number, number> } | null, nowMs: number) {
  const dt = base ? (nowMs - base.at) / 1000 : 0;
  if (!base || dt <= 0) return undefined;
  return (row: PsRow): number | null => {
    const before = base.byPid.get(row.pid);
    if (before === undefined) return null;
    const d = row.cpuSeconds - before;
    return d > 0 ? (d / dt) * 100 : 0;
  };
}

function finish(
  rows: PsRow[],
  base: { at: number; byPid: Map<number, number> } | null,
  nowMs: number,
): FleetUsage {
  // Una sorgente che esplode non deve portarsi dietro tutta la misura: senza
  // sessioni/script si perde la lente, non il totale.
  const sessions = (() => { try { return sessionSource?.() ?? []; } catch { return []; } })();
  const scripts = (() => { try { return scriptSource?.() ?? []; } catch { return []; } })();

  const usage = {
    ...summarizeFleet(
      rows,
      resolveFleetRoots(rows, process.pid),
      makeInstantCpu(base, nowMs),
      CPU_CORES(),
      sessions,
      scripts,
      // Usa il responsible pid su macOS (FFI disponibile), ppid walk altrove.
      responsiblePidAvailable ? responsiblePidFn : undefined,
    ),
    supported: true,
  };
  cached = usage;
  cachedAt = Date.now();
  return usage;
}

/**
 * Oltre questa età una lettura non serve più a decidere: dice cosa faceva la
 * flotta mezzo minuto fa, e il freno del peso decide su ADESSO. Più larga del
 * TTL della misura (4s) di proposito, perché qui non si vuole una lettura
 * fresca a ogni chiamata, si vuole non decidere su una vecchia.
 */
const FLEET_LOAD_MAX_AGE_MS = 30_000;

/**
 * Il carico della NOSTRA flotta in unità di core, letto SENZA aspettare.
 *
 * Serve al freno del peso del dispatcher (`ownLoad` in `task-dispatcher.ts`),
 * che decide dentro un tick sincrono e non può fermarsi ad aspettare uno `ps`.
 * Torna l'ultima misura se è ancora attuale; altrimenti innesca un
 * aggiornamento in sottofondo e torna `null`, che per il freno vuol dire «non
 * lo so» e non «via libera»: chi chiama ripiega sul load di sistema.
 *
 * `cpuPercent` è già normalizzato sulla scala 0-100 dell'INTERA macchina, quindi
 * si torna a moltiplicare per i core per avere la stessa unità del load average
 * (1 = un core saturo). Le due misure vanno confrontate con soglie diverse: vedi
 * `HEAVY_MAX_OWN_LOAD_PER_CORE`.
 */
export function fleetLoadSync(): { coreUnits: number; cores: number } | null {
  if (isWindows) return null;
  if (!cached || Date.now() - cachedAt >= FLEET_LOAD_MAX_AGE_MS) {
    // Scalda la cache per il prossimo giro. Non si aspetta e non si propaga:
    // un errore qui deve valere «non lo so», mai far cadere un tick di dispatch.
    void getFleetUsage().catch(() => {});
    return null;
  }
  if (!cached.supported) return null;
  const cores = Math.max(1, cached.cpuCores);
  return { coreUnits: (cached.cpuPercent / 100) * cores, cores };
}

export async function getFleetUsage(): Promise<FleetUsage> {
  const unsupported: FleetUsage = { processCount: 0, memoryMB: 0, cpuPercent: 0, cpuCores: CPU_CORES(), memMetric: "rss", roots: [], sessions: [], scriptsMB: 0, scriptsProcessCount: 0, supported: false };
  if (isWindows) return unsupported;
  const now = Date.now();
  if (cached && now - cachedAt < FLEET_TTL_MS) return cached;
  try {
    const rows = await snapshot();
    if (!rows.length) return cached ?? unsupported;

    // CPU ISTANTANEA, non la media di vita.
    //
    // Prima si sommava `ps pcpu`, che su macOS e' la media sull'INTERA VITA del
    // processo: un CLI che ha macinato per un'ora resta alto per sempre anche a
    // riposo, e la somma sulla flotta non scende piu'. Dopo una sessione lunga
    // la status bar arrivava a segnare 318% con l'app ferma — misurato il
    // 2026-08-02, con `top` che dava l'8% per lo stesso processo.
    //
    // Si misura per DIFFERENZA: `ps time` e' la CPU cumulata, quindi
    // (Δsecondi di CPU / Δtempo reale) × 100 e' la percentuale nella finestra
    // fra due letture. Alla primissima lettura non c'e' una base, quindi se ne
    // prendono due ravvicinate: meglio 200 ms di attesa una tantum che un
    // numero inventato.
    let base = prevSample;
    if (!base) {
      await new Promise((r) => setTimeout(r, 200));
      const second = await snapshot();
      if (second.length) {
        base = { at: now, byPid: new Map(rows.map((r) => [r.pid, r.cpuSeconds])) };
        prevSample = { at: Date.now(), byPid: new Map(second.map((r) => [r.pid, r.cpuSeconds])) };
        return finish(second, base, prevSample.at);
      }
    }
    const sampleNow = { at: now, byPid: new Map(rows.map((r) => [r.pid, r.cpuSeconds])) };
    const usage = finish(rows, base, now);
    prevSample = sampleNow;
    cached = usage;
    cachedAt = now;
    return usage;
  } catch {
    // Keep the last good reading rather than flashing a zero through the UI.
    return cached ?? unsupported;
  }
}
