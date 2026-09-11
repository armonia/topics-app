/**
 * Fleet summary: the PURE half of `fleet-usage.ts` — turning a `ps` snapshot and
 * a set of roots into totals, with zero I/O and zero module state.
 *
 * Split out of `fleet-usage.ts` (2026-09, `check:bloat`) along the seam the file
 * already named in its own comments: `parsePsRows`/`summarizeFleet` are "Pure:
 * the test drives it with a synthetic table instead of the live machine", while
 * everything left in `fleet-usage.ts` (the sockets registry, the TTL cache, the
 * `responsibility_get_pid_responsible_for_pid` FFI, the dispatcher-facing
 * `fleetLoadSync`/`fleetSessionCoreUnits`) depends on live process state or the
 * module's registrations and cannot move without carrying that state with it.
 */

/** Sidecars that hold the server-side fleet. Kept as a closed union so a typo
 *  in a registration site is a type error, not a silently missing 4 GB. */
export type FleetKind = "pty-bridge" | "ai-bridge" | "webrtc-bridge";

/** Una sessione PTY e il pid di testa del suo albero. Il bridge lo riporta gia'
 *  su create e reconcile (`routes/terminal.ts`), quindi non c'e' niente di nuovo
 *  da tracciare: va solo passato di qua. */
export interface FleetSessionRef {
  sessionId: string;
  name: string;
  pid: number;
  /**
   * THE SESSION-TO-PROJECT BRIDGE, and it costs nothing to carry.
   *
   * A per-session memory figure answers "how much is this terminal holding".
   * It cannot answer "how much is this PROJECT holding", which is the question
   * anyone looking at the panel actually has, because the row has no idea which
   * project it belongs to. The producer of these refs (`getFleetSessionRefs` in
   * `routes/terminal.ts`) builds them from a `TerminalSession` that already
   * carries `cwd` and `topicId` and was throwing both away.
   *
   * All three are OPTIONAL and ADDITIVE: `paneUsage.ts` and `featureUsage.ts`
   * read this shape and must keep compiling untouched. Absent means "not
   * known", never "no project" - a shell opened outside any project has no
   * `projectPath`, and so does a chat whose topic row was not resolved.
   */
  topicId?: string;
  /** Working directory of the session's root process, when the producer knows it. */
  cwd?: string;
  /**
   * Absolute project path this session belongs to, when it could be resolved
   * without a per-session query. For a terminal it is the topic's project (or
   * the session `cwd` as the fallback); for a chat it is `topics.project_path`.
   * Group by `projectIdForPath(projectPath)` to line these rows up with the
   * per-project token totals, which are keyed by that same id.
   */
  projectPath?: string;
  /**
   * WHERE `projectPath` came from, because the two are not equally strong.
   *
   * `topic` = the session's topic declares this project: a claim. `cwd` = no
   * topic said, so the working directory is standing in for one: an inference,
   * and a good one for a terminal opened inside a repo, a bad one for a shell
   * sitting in `$HOME` — which would otherwise turn the home directory into a
   * project with no rows behind it. A client rolling sessions up per project
   * can trust the first and filter the second against the projects it knows.
   */
  projectSource?: "topic" | "cwd";
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
  /** Topic this session belongs to, from the ref. Absent = not known. */
  topicId?: string;
  /** Working directory of the session's root process, from the ref. */
  cwd?: string;
  /** Absolute project path, from the ref. Absent = not resolved, NOT "no project". */
  projectPath?: string;
  /** `topic` = declared by the session's topic; `cwd` = inferred from the folder. */
  projectSource?: "topic" | "cwd";
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
  /** CPU of the third axis, on the same 0-100 machine scale as `cpuPercent`.
   *  Kept apart from it for the same reason the memory is: the count cap reads
   *  the fleet WITHOUT the agents' own scripts, and the budget reads both. */
  scriptsCpuPercent: number;
  /**
   * CPU of everything that is NOT ours, on the same 0-100 machine scale.
   *
   * It is the term that turns the budget into a ceiling instead of a right (see
   * `shared/machine-budget.ts`): what we may take is the budget or what the
   * others leave free, whichever is less. It comes from the SAME `ps` snapshot
   * as our own share, so the two cannot describe two different instants, and it
   * is a sum of instantaneous percentages, not a load average.
   */
  otherCpuPercent: number;
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
   *  le pagine condivise. Vedi `procFootprintKB` in `fleet-usage.ts`. */
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
 *  ISTANTANEA per differenza fra due letture. Vedi `getFleetUsage` in
 *  `fleet-usage.ts`. */
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
    const kids = children.get(r.ppid);
    if (kids) kids.push(r.pid); else children.set(r.ppid, [r.pid]);
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

    /* ATTRIBUZIONE: responsible pid E ppid, non l'uno O l'altro.
     *
     * QUI C'ERA UN BUCO DA 911 MB, misurato sull'app viva il 2026-08-20 e reso
     * visibile dall'inventario del peso (che mostrava «Terminali e sessioni:
     * 669 MB» sopra un totale di flotta dichiarato di 560).
     *
     * Il commento precedente diceva che le due strade «producono lo stesso
     * risultato su processi normali» e divergono solo sugli orfani. E' falso, e
     * il controesempio girava su questa macchina: i `claude` delle sessioni
     * sono figli dell'ai-bridge (ppid 57835) ma macOS li dichiara
     * RESPONSABILI DI SE STESSI — `responsibility_get_pid_responsible_for_pid`
     * torna il pid stesso. Con il solo ramo `responsibleOf` non appartenevano a
     * nessun root, quindi 911 MB di `claude` restavano fuori dal totale che la
     * status bar esiste per mostrare.
     *
     * Non e' un caso limite: un processo che si dichiara responsabile di se'
     * stesso e' cio' che macOS fa a un programma lanciato come sessione propria
     * — cioe' esattamente i CLI degli agenti, che sono la parte che pesa.
     *
     * Le due strade ora si UNISCONO: un processo appartiene al root se il suo
     * responsible e' il root, OPPURE se discende da lui per ppid. `counted`
     * garantisce che nessun pid venga fatturato due volte, quindi unire non
     * puo' gonfiare i totali — puo' solo smettere di perdere pezzi. */
    if (responsibleOf) {
      const owned = new Set<number>([root.pid]);
      for (const row of rows) {
        if (responsibleOf(row.pid) === root.pid) owned.add(row.pid);
      }
      // …piu' la discendenza per ppid di tutto cio' che gia' gli appartiene.
      // Il giro si ripete perche' un figlio appena aggiunto puo' averne altri.
      const stack = [...owned];
      while (stack.length) {
        const pid = stack.pop()!;
        for (const c of children.get(pid) ?? []) {
          if (owned.has(c)) continue;
          owned.add(c);
          stack.push(c);
        }
      }
      for (const pid of owned) {
        const row = byPid.get(pid);
        if (!row) continue;
        if (scriptPidSet.has(pid)) continue; // terzo asse: escludi gli script
        if (counted.has(pid)) continue;
        counted.add(pid);
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

  // Calcola il terzo asse: processi-script, la loro memoria e la loro CPU. allow-italian: pre-existing comment, only the word "CPU" was added
  // Questi NON sono nella counted set e vengono misurati separatamente.
  let scriptsTotalKB = 0;
  let scriptsProcs = 0;
  let scriptsCpu = 0;
  const scriptPidsSeen = new Set<number>();
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
      scriptPidsSeen.add(pid);
      scriptsTotalKB += row.footprintKB ?? row.rssKB;
      scriptsCpu += (instantCpu ? instantCpu(row) : row.cpu) ?? 0;
      if (row.footprintKB !== undefined) sawFootprint = true; else sawRss = true;
    }
  }

  // WHAT IS NOT OURS: the whole rest of the table, from the same reading.
  // Without this term the budget would be a right to squeeze the machine; with
  // it, it is a ceiling on what the others leave free.
  let otherCpu = 0;
  for (const row of rows) {
    if (counted.has(row.pid) || scriptPidsSeen.has(row.pid)) continue;
    otherCpu += (instantCpu ? instantCpu(row) : row.cpu) ?? 0;
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
      // Carried through, not recomputed: this function only knows pids. Changing
      // the interface alone would have left every reading with the fields empty,
      // which is the failure this line exists to prevent.
      ...(s.topicId ? { topicId: s.topicId } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
      ...(s.projectPath ? { projectPath: s.projectPath } : {}),
      ...(s.projectSource ? { projectSource: s.projectSource } : {}),
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
    scriptsCpuPercent: Math.round((scriptsCpu / divisor) * 10) / 10,
    otherCpuPercent: Math.round((otherCpu / divisor) * 10) / 10,
  };
}
