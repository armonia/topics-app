/**
 * Da un piano a un segnale: la spazzata dei Chromium orfani, all'avvio.
 *
 * Il giudizio («chi è orfano») vive puro e provato in
 * `server/lib/browser-orphan-sweep.ts`. Qui c'è la sola parte che tocca la
 * macchina: la fotografia di `ps`, il pavimento di sicurezza e il `kill`.
 *
 * PERCHE' STA IN UN SERVIZIO E NON INLINE. Stessa ragione di
 * `services/orphan-census.ts`: l'anello fra il giudizio e l'azione è il posto
 * dove una regressione torna senza che nessun test se ne accorga, perché un
 * test che monta la propria copia della catena prova la copia. Qui il test
 * monta QUESTA funzione con un `ps` finto e un `kill` che registra, cioè la
 * catena vera meno il grilletto.
 *
 * SI CHIAMA UNA VOLTA SOLA, ALL'AVVIO. La regola tratta un browser marchiato
 * col nostro stesso pid come un residuo di un pid riciclato: vero al boot,
 * quando non abbiamo ancora aperto niente, falso e distruttivo dopo. Vedi
 * `planBootSweep`.
 */

import {
  parseProcSnapshot,
  planBootSweep,
  formatSweepPlan,
  type SweepPlan,
} from "../lib/browser-orphan-sweep";

/** Cosa fa la spazzata, letto da `TOPICS_BROWSER_SWEEP`. */
export type SweepMode = "sweep" | "dry" | "off";

/**
 * `off` la spegne, `dry` la fa parlare senza sparare, tutto il resto (compreso
 * l'assente) spazza: è il comportamento che questo lavoro deve avere di serie.
 */
export function sweepModeFromEnv(raw: string | undefined): SweepMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false") return "off";
  if (v === "dry" || v === "dryrun" || v === "dry-run") return "dry";
  return "sweep";
}

export interface ReaperDeps {
  /** L'uscita grezza di `ps -axo pid=,ppid=,command=`, o `null` se non si è potuto guardare. */
  snapshot(): string | null;
  /** Il grilletto. Iniettato: un test non deve poter uccidere niente. */
  kill(pid: number): void;
  /** Il pid di questo server. */
  ownPid: number;
  mode: SweepMode;
  log?: (msg: string) => void;
}

export interface ReapResult {
  mode: SweepMode;
  plan: SweepPlan | null;
  /** I pid su cui il segnale è partito davvero. */
  killed: number[];
}

/**
 * Il pavimento, e l'ultimo posto dove si può ancora non sparare.
 *
 * Un piano non dovrebbe mai contenere questi pid, e i test della regola dicono
 * che non li contiene. Ma fra «la regola è giusta» e «il segnale parte» c'è un
 * numero che viaggia, e su un `kill` un numero sbagliato non si annulla: 0
 * significa «tutto il gruppo di processi», 1 è launchd, e il nostro pid siamo
 * noi. Vale la riga.
 */
function isForbiddenTarget(pid: number, ownPid: number): boolean {
  return !Number.isSafeInteger(pid) || pid <= 1 || pid === ownPid;
}

export function reapOrphanBrowsers(deps: ReaperDeps): ReapResult {
  const log = deps.log ?? ((m: string) => console.log(m));
  if (deps.mode === "off") {
    log("[browser-sweep] spenta da TOPICS_BROWSER_SWEEP");
    return { mode: "off", plan: null, killed: [] };
  }

  const raw = deps.snapshot();
  if (raw === null) {
    // Zero righe non vuol dire «pulito», vuol dire «non ho guardato»: lo si dice
    // invece di far passare un censimento a vuoto per un esito.
    log("[browser-sweep] impossibile leggere i processi: nessuna spazzata");
    return { mode: deps.mode, plan: null, killed: [] };
  }

  const plan = planBootSweep({ rows: parseProcSnapshot(raw), ownPid: deps.ownPid });
  // Silenzio quando non c'è niente da dire: una riga a ogni avvio pulito
  // seppellirebbe l'unica riga che conta.
  if (plan.kill.length > 0 || deps.mode === "dry") {
    log(formatSweepPlan(plan, deps.mode === "dry" ? "dry" : "sweep"));
  }
  if (deps.mode === "dry") return { mode: "dry", plan, killed: [] };

  const killed: number[] = [];
  for (const target of plan.kill) {
    if (isForbiddenTarget(target.pid, deps.ownPid)) {
      log(`[browser-sweep] RIFIUTATO il pid ${target.pid}: non e' un bersaglio legittimo`);
      continue;
    }
    try {
      deps.kill(target.pid);
      killed.push(target.pid);
    } catch {
      // Gia' morto fra il `ps` e adesso: e' l'esito che volevamo.
    }
  }
  return { mode: "sweep", plan, killed };
}

/** La fotografia vera. `null` su Windows (niente `ps`) o se il comando fallisce. */
export function psSnapshot(): string | null {
  if (process.platform === "win32") return null;
  try {
    const r = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!r.success) return null;
    const out = r.stdout.toString();
    return out.trim() ? out : null;
  } catch {
    return null;
  }
}

/**
 * SIGKILL, non SIGTERM.
 *
 * Su un processo che abbiamo già giudicato senza padrone un'uscita pulita non
 * compra niente (il profilo di Playwright è una cartella temporanea) e un
 * Chromium che si impunta sullo shutdown lascerebbe in piedi esattamente il
 * leak che stiamo chiudendo. Gli helper seguono da soli: muoiono quando cade il
 * canale del loro browser.
 */
export function sigkill(pid: number): void {
  process.kill(pid, "SIGKILL");
}

/** La catena completa, con le dipendenze vere. E' quello che chiama il server. */
export function reapOrphanBrowsersAtBoot(log?: (msg: string) => void): ReapResult {
  return reapOrphanBrowsers({
    snapshot: psSnapshot,
    kill: sigkill,
    ownPid: process.pid,
    mode: sweepModeFromEnv(process.env.TOPICS_BROWSER_SWEEP),
    log,
  });
}
