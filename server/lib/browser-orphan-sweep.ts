/**
 * Il marchio sui Chromium che apriamo noi, e la regola che decide quali
 * spazzare all'avvio.
 *
 * IL PROBLEMA. `gracefulShutdown` chiude il BrowserService, quindi l'uscita
 * pulita è coperta. Scoperto è tutto il resto: `kill -9`, un crash, un
 * watch-restart che non arriva al gestore. Il Chromium resta vivo, viene
 * reparentato a launchd (ppid 1) e al riavvio il server non ha modo di
 * riconoscerlo come proprio, quindi resta lì finché non si riavvia il Mac.
 * Misura del 12/08 sulla macchina di Attilio: 28 chromium vivi, 1461 MB.
 *
 * IL VINCOLO CHE DECIDE IL DISEGNO. Sulla stessa macchina girano Chromium di
 * Playwright, di jarvis-browser e lanciati a mano. Uccidere quelli sarebbe
 * peggio del leak, quindi un processo che non porta il NOSTRO marchio non si
 * tocca mai. Il marchio è un interruttore custom nella riga di comando
 * (`--topics-browser=<ruolo>:<pid del server>`): Chromium ignora gli switch che
 * non conosce, e `ps` ce lo restituisce.
 *
 * PERCHE' IL PID DEL PADRE STA DENTRO IL MARCHIO. Il test ovvio ("ppid == 1")
 * è sbagliato, e la misura lo dice: dei 5 chromium con ppid 1 trovati quel
 * giorno, DUE erano helper di un browser VIVO e legittimo. Su macOS un helper
 * può essere reparentato a launchd mentre il suo browser sta benissimo. Il pid
 * del server che l'ha aperto invece risponde alla domanda giusta: se quel
 * processo non c'è più, quel browser non ha più nessuno che lo governi. Come
 * effetto secondario due server vivi in parallelo (prod + un worktree, o gli
 * shard degli E2E) si risparmiano a vicenda, cosa che una regola sulla porta
 * non saprebbe fare.
 *
 * DUE FILTRI, NON UNO. Si giudicano solo i processi BROWSER, cioè quelli senza
 * `--type=`: gli helper non si giudicano mai da soli, si tirano dentro solo
 * come parte di un browser già condannato. Il ramo `--type=` è esattamente
 * quello che risparmia i due helper della misura.
 *
 * Modulo puro: guarda righe di testo e restituisce un piano. Chi spara sta in
 * `server/services/browser-orphan-reap.ts`.
 */

/** Il ruolo scritto nel marchio: i due spawner che abbiamo. */
export type BrowserRole = "agent" | "sidecar";

/** Il prefisso dell'interruttore. Anche la chiave per `pgrep -f`. */
export const BROWSER_MARK_FLAG = "--topics-browser=";

/**
 * L'argomento da passare a Chromium. `ownerPid` è il pid del SERVER che apre
 * il browser (`process.pid`), non quello del browser: è il padre di cui si
 * verifica la morte al giro successivo.
 */
export function browserMarkArg(role: BrowserRole, ownerPid: number): string {
  return `${BROWSER_MARK_FLAG}${role}:${ownerPid}`;
}

/** Il marchio letto da una riga di comando, o `null` se non c'è. */
export function parseBrowserMark(
  command: string,
): { role: BrowserRole; ownerPid: number } | null {
  const i = command.indexOf(BROWSER_MARK_FLAG);
  if (i < 0) return null;
  const m = /^(agent|sidecar):(\d+)/.exec(command.slice(i + BROWSER_MARK_FLAG.length));
  if (!m) return null;
  const ownerPid = Number(m[2]);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return null;
  return { role: m[1] as BrowserRole, ownerPid };
}

/**
 * Un helper di Chromium (renderer, GPU, utility, zygote) porta sempre
 * `--type=`; il processo browser non l'ha mai. E' l'unico modo affidabile di
 * distinguerli guardando solo la riga di comando.
 */
export function isChromiumHelper(command: string): boolean {
  return /(?:^|\s)--type=/.test(command);
}

/**
 * Il profilo dichiarato nella riga di comando.
 *
 * Serve a raccogliere gli helper di un browser condannato: gli helper NON
 * portano il marchio (Chromium non propaga gli switch che non conosce) ma
 * portano il `--user-data-dir` del loro browser. Il valore si prende fino al
 * prossimo ` --`, così un percorso con spazi dentro sopravvive: da un `ps`
 * appiattito non si può fare di meglio, e i nostri due percorsi non hanno
 * spazi.
 */
export function userDataDirOf(command: string): string | null {
  const key = "--user-data-dir=";
  const i = command.indexOf(key);
  if (i < 0) return null;
  const rest = command.slice(i + key.length);
  const end = rest.search(/\s--/);
  const dir = (end < 0 ? rest : rest.slice(0, end)).trim();
  return dir || null;
}

export interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * L'uscita di `ps -axo pid=,ppid=,command=`, riga per riga.
 *
 * Sta qui e non nell'adattatore perché è la parte che può sbagliare in
 * silenzio: un parser che perde le righe fa un censimento a zero candidati,
 * che è indistinguibile da "tutto pulito".
 */
export function parseProcSnapshot(psOutput: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const command = m[3]!.trim();
    if (!command) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command });
  }
  return rows;
}

export interface SweepInput {
  /** La fotografia dei processi della macchina. */
  rows: readonly ProcRow[];
  /**
   * Il pid di QUESTO server.
   *
   * Doppio uso. Non si spara mai su di sé, ovviamente. E un browser marchiato
   * col nostro stesso pid all'AVVIO è per costruzione un residuo di un server
   * morto di cui il sistema ha riciclato il numero: a quel punto noi non
   * abbiamo ancora aperto niente. E' il motivo per cui questa regola vale solo
   * al boot, e per cui il piano si chiama `planBootSweep`.
   */
  ownPid: number;
}

export interface SweepVerdict {
  pid: number;
  /** Perché sta in questa lista. Finisce nel log: un pid senza motivo non si può contestare. */
  why: string;
}

export interface SweepPlan {
  kill: SweepVerdict[];
  spared: SweepVerdict[];
  /** Quanti processi BROWSER marchiati sono stati esaminati. */
  markedBrowsers: number;
  /** Quante righe di `ps` sono state lette. Zero non vuol dire "pulito", vuol dire "non ho guardato". */
  rowsSeen: number;
}

/**
 * Chi si spazza e chi si risparmia. Nessun effetto: decide e riferisce.
 *
 * L'ordine dei passi è la regola:
 *  1. si guardano SOLO i browser marchiati (marchio presente, nessun `--type=`);
 *  2. orfano = il pid del server scritto nel marchio non è fra i vivi (oppure è
 *     il nostro, vedi `ownPid`);
 *  3. il profilo di un browser RISPARMIATO è intoccabile: il sidecar ha un
 *     `--user-data-dir` FISSO, quindi un sidecar vivo e un sidecar morto
 *     condividono il percorso, e allargarsi per profilo lì ucciderebbe gli
 *     helper del vivo. In quel caso si uccide solo il browser orfano e ci si
 *     affida al fatto che Chromium fa morire i propri helper.
 *  4. per gli altri orfani si tira dentro chi condivide il profilo o chi è loro
 *     figlio: sono i pezzi dello stesso browser.
 */
export function planBootSweep(input: SweepInput): SweepPlan {
  const livePids = new Set(input.rows.map((r) => r.pid));
  const kill = new Map<number, string>();
  const spared: SweepVerdict[] = [];
  /** Profili di browser marchiati e VIVI: non si allarga mai su questi. */
  const sparedDirs = new Set<string>();
  /**
   * Pid intoccabili: i browser marchiati e risparmiati, e i pochi helper che
   * portassero il marchio.
   *
   * Non ci sono dentro 0, 1 e il nostro pid: nella regola non esiste un cammino
   * che li raggiunga (launchd non ha un `--user-data-dir` e non è figlio di un
   * orfano), quindi metterli qui sarebbe un ramo che nessun test può far
   * scattare. Il pavimento «mai launchd, mai noi stessi» sta dove diventa un
   * segnale vero, cioè in `browser-orphan-reap.ts` subito prima del `kill`.
   */
  const protectedPids = new Set<number>();

  const markedBrowsers: { row: ProcRow; ownerPid: number; role: BrowserRole }[] = [];
  for (const row of input.rows) {
    const mark = parseBrowserMark(row.command);
    if (!mark) continue;
    if (isChromiumHelper(row.command)) {
      // Un helper marchiato non si giudica: il suo destino lo decide il browser.
      // (In pratica Chromium non propaga il marchio agli helper, ma non ci si
      // appoggia a un dettaglio di implementazione per non uccidere niente.)
      protectedPids.add(row.pid);
      continue;
    }
    markedBrowsers.push({ row, ownerPid: mark.ownerPid, role: mark.role });
  }

  // Primo giro: chi è orfano e chi no. Serve completo prima di allargarsi, così
  // `sparedDirs` è già pieno quando si guardano i profili.
  const orphans: { row: ProcRow; ownerPid: number; role: BrowserRole }[] = [];
  for (const m of markedBrowsers) {
    const ownerDead = !livePids.has(m.ownerPid);
    const ownerIsUs = m.ownerPid === input.ownPid;
    if (ownerDead || ownerIsUs) {
      orphans.push(m);
      kill.set(
        m.row.pid,
        ownerIsUs
          ? `${m.role}: marchiato col nostro pid ${m.ownerPid} ma non l'abbiamo aperto noi (pid riciclato)`
          : `${m.role}: il server ${m.ownerPid} che l'ha aperto non esiste piu'`,
      );
    } else {
      spared.push({ pid: m.row.pid, why: `${m.role}: il server ${m.ownerPid} e' vivo` });
      protectedPids.add(m.row.pid);
      const dir = userDataDirOf(m.row.command);
      if (dir) sparedDirs.add(dir);
    }
  }

  // Secondo giro: i pezzi degli orfani.
  for (const o of orphans) {
    const dir = userDataDirOf(o.row.command);
    const dirIsShared = dir !== null && sparedDirs.has(dir);
    if (dir && dirIsShared) {
      spared.push({
        pid: o.row.pid,
        why: `profilo ${dir} condiviso con un browser vivo: non si allarga agli helper`,
      });
    }
    for (const row of input.rows) {
      if (row.pid === o.row.pid || kill.has(row.pid) || protectedPids.has(row.pid)) continue;
      const sameProfile = !!dir && !dirIsShared && userDataDirOf(row.command) === dir;
      const isChild = row.ppid === o.row.pid;
      if (!sameProfile && !isChild) continue;
      kill.set(
        row.pid,
        isChild ? `pezzo dell'orfano ${o.row.pid} (figlio)` : `pezzo dell'orfano ${o.row.pid} (stesso profilo)`,
      );
    }
  }

  return {
    kill: [...kill].map(([pid, why]) => ({ pid, why })).sort((a, b) => a.pid - b.pid),
    spared: spared.sort((a, b) => a.pid - b.pid),
    markedBrowsers: markedBrowsers.length,
    rowsSeen: input.rows.length,
  };
}

/**
 * La riga di log. Nomina i pid, perché il senso della spazzata è poterla
 * contestare: "3 orfani" non permette a nessuno di dire "quello lo stavo
 * usando".
 */
export function formatSweepPlan(plan: SweepPlan, mode: "sweep" | "dry"): string {
  const head =
    `[browser-sweep${mode === "dry" ? " DRY" : ""}] ${plan.rowsSeen} processi letti, ` +
    `${plan.markedBrowsers} chromium marchiati, ${plan.kill.length} da spazzare`;
  const who = plan.kill.length ? `\n${plan.kill.map((k) => `  kill ${k.pid} · ${k.why}`).join("\n")}` : "";
  const safe = plan.spared.length
    ? `\n${plan.spared.map((s) => `  salvo ${s.pid} · ${s.why}`).join("\n")}`
    : "";
  return head + who + safe;
}
