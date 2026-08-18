/**
 * Uccidere un albero di processi senza lasciare nipoti.
 *
 * PERCHE' STA IN `lib/` E NON IN `routes/processes.ts`, dove e' nato. Quel
 * modulo e' una rotta con effetti collaterali all'import: legge lo stato da
 * disco (`loadState`), crea `.state/`, riadotta pid veri e fa partire i timer
 * del detector. Chi vuole solo la primitiva (il tool `bash` del runtime nativo,
 * i checks pre-review) non puo' pagare tutto questo per una funzione pura di
 * segnali, e finora infatti non la usava: chiamava `proc.kill()` sul figlio
 * diretto e lasciava vivo chi ascoltava sulla porta.
 *
 * Qui dentro non si importa niente del progetto. Solo `Bun` e `process`, che il
 * runtime ha gia' globali.
 */

// Cached process table (ppid → child pids). ONE `ps` snapshot replaces the old
// recursive `pgrep -P` storm, which spawned one process per tree node, per
// session, every detector cycle (and per script on every GET /api/scripts) — a
// real subprocess/CPU drain that contended with the renderer. Refreshed at most
// every PROC_TABLE_TTL; all getDescendantPids calls in a cycle share it.
let _procTableAt = 0;
let _childrenByPpid: Map<number, number[]> = new Map();
const PROC_TABLE_TTL = 2000;

async function getProcTable(fresh = false): Promise<Map<number, number[]>> {
  const now = Date.now();
  if (!fresh && now - _procTableAt < PROC_TABLE_TTL && _childrenByPpid.size) return _childrenByPpid;
  const children = new Map<number, number[]>();
  try {
    const proc = Bun.spawn(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = +m[1], ppid = +m[2];
      const arr = children.get(ppid);
      if (arr) arr.push(pid); else children.set(ppid, [pid]);
    }
    _childrenByPpid = children;
    _procTableAt = now;
  } catch { /* keep the previous table on transient failure */ }
  return _childrenByPpid;
}

/**
 * `fresh: true` = ristampa la tabella dei processi invece di riusarne una vecchia
 * fino a 2 secondi.
 *
 * La cache esiste per il DETECTOR, che gira ogni pochi secondi e non ha fretta.
 * Chi sta per uccidere un albero sì: un discendente nato dentro quella finestra
 * (ed è la finestra in cui nascono — si spegne un server proprio mentre sta
 * finendo di tirare su i suoi lavoratori) non compare nella tabella vecchia, non
 * riceve nessun segnale e resta vivo con la sua porta occupata. Una `ps` in più
 * per ogni kill è un prezzo che si paga volentieri.
 */
export async function getDescendantPids(pid: number, opts?: { fresh?: boolean }): Promise<Set<number>> {
  const children = await getProcTable(opts?.fresh === true);
  const out = new Set<number>([pid]);
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop()!;
    for (const c of children.get(p) ?? []) {
      if (!out.has(c)) { out.add(c); stack.push(c); }
    }
  }
  return out;
}

/**
 * Per-pid identity snapshot (`pid → lstart`) for the delayed-SIGKILL guard.
 * A PID can be recycled by the OS within the 5s SIGTERM→SIGKILL grace; killing
 * by number alone could then SIGKILL an unrelated fresh process. The start
 * timestamp disambiguates: a reused pid has a different lstart.
 */
export async function getPidStartTimes(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  try {
    const proc = Bun.spawn(["ps", "-o", "pid=,lstart=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) out.set(+m[1], m[2]);
    }
  } catch { /* transient ps failure → empty map → the guard skips the SIGKILL */ }
  return out;
}

/**
 * SIGTERM a un pid e a tutti i suoi DISCENDENTI, poi un SIGKILL protetto
 * dall'identita' dopo la grazia.
 *
 * PERCHE' ESPORTATA. Chi spawna `bun run dev` non uccide il server: quel figlio
 * e' un lanciatore, e chi ASCOLTA sulla porta e' un suo discendente. Un
 * `proc.kill()` sul solo wrapper lascia il vero server in piedi con la porta
 * occupata — e' cosi' che il pool delle anteprime si prosciugava, finche' una
 * card in review non aveva piu' una porta su cui nascere. La stessa forma della
 * strada di Stop del pannello (`killRunningScript`) e dello sweep delle shell:
 * discendenti, SIGTERM, poi SIGKILL solo su chi e' ancora la STESSA incarnazione
 * (un pid puo' essere riciclato dentro i 5 secondi di grazia).
 *
 * Non lancia mai: chiuderne uno solo e' meglio di non chiuderne nessuno.
 */
export interface KillTreeDeps {
  /** L'albero da colpire. Deve leggere una tabella FRESCA (vedi sotto). */
  descendants(pid: number): Promise<Set<number>>;
  startTimes(pids: number[]): Promise<Map<number, string>>;
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void;
  /** Ritorna la maniglia del timer: chi la usa deve poterla staccare dal loop. */
  defer(fn: () => void, ms: number): { unref?: () => void };
}

/** Il corpo di `killProcessTree`, con le primitive iniettate (test). */
export async function killProcessTreeWith(pid: number, graceMs: number, deps: KillTreeDeps): Promise<void> {
  if (!pid || pid <= 0) return;
  let pids: number[];
  try {
    pids = [...await deps.descendants(pid)];
  } catch {
    pids = [pid];
  }
  if (!pids.includes(pid)) pids.push(pid);
  // L'identita' si cattura PRIMA del segnale: dopo la grazia il numero da solo
  // puo' essere di un altro processo.
  const identity = await deps.startTimes(pids);
  for (const p of pids) { try { deps.signal(p, "SIGTERM"); } catch { /* gia' morto */ } }
  // UNREF. Il SIGKILL ritardato è una cortesia, non un impegno: un timer
  // referenziato tiene sveglio l'event loop per tutta la grazia a OGNI chiamata,
  // e `teardownAll()` allo spegnimento ne accende uno per anteprima — cinque
  // secondi di ritardo sullo shutdown per un segnale che, se il processo se ne
  // va prima, non serviva a nessuno.
  const timer = deps.defer(async () => {
    const still = await deps.startTimes(pids);
    for (const p of pids) {
      const then = identity.get(p);
      if (then && still.get(p) === then) {
        try { deps.signal(p, "SIGKILL"); } catch { /* uscito nel grace */ }
      }
    }
  }, graceMs);
  timer.unref?.();
}

export async function killProcessTree(pid: number, graceMs = 5000): Promise<void> {
  return killProcessTreeWith(pid, graceMs, {
    // FRESCA: un discendente nato negli ultimi 2 secondi non sta nella tabella
    // in cache, e senza questa riga non riceveva nessun segnale.
    descendants: (p) => getDescendantPids(p, { fresh: true }),
    startTimes: getPidStartTimes,
    signal: (p, sig) => { process.kill(p, sig); },
    defer: (fn, ms) => setTimeout(fn, ms),
  });
}
