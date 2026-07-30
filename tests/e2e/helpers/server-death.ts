/**
 * Quando il server di test muore A METÀ RUN, dirlo — invece di far fallire 8
 * test per un motivo finto.
 *
 * `run-lock.ts` protegge chi ARRIVA: la seconda run si ferma prima di toccare
 * la porta di quella già in corso. Ma non protegge chi è già DENTRO, e su
 * questa macchina il killer non passa dal lock: ogni worktree di dispatch è un
 * checkout a sé, e 11 dei 24 vivi sono nati PRIMA che il lock esistesse (`git
 * log --diff-filter=A -- tests/e2e/helpers/run-lock.ts` → 2026-07-28). Il
 * `global-setup` di quei checkout ammazza chi tiene la porta 13334 e cancella
 * `topics.db` senza chiedere il permesso a nessuno, perché quel codice lì il
 * lock non ce l'ha.
 *
 * Il risultato l'ho visto due volte di fila: UN `[Shutdown] Received SIGTERM`
 * nel log del server, e da lì in poi ogni test che fallisce con
 * `apiRequestContext.get: connect ECONNREFUSED ::1:13334` finché `maxFailures`
 * non abortisce la run. Otto rossi che parlano di HTTP mentre il difetto è che
 * il server non c'è più — e il primo sospettato diventa l'ultimo commit, che
 * non c'entra niente. Due ore di diagnosi.
 *
 * Qui la morte viene NOMINATA, con le prove raccolte nel momento in cui
 * succede: il PID del server è ancora vivo? il lock della porta è ancora
 * nostro, o ce l'ha un altro checkout (con cwd e ora d'inizio)? chi tiene la
 * porta adesso? Sono le tre domande che ho dovuto fare a mano, e la risposta
 * cambia completamente il verdetto: «un'altra run ti ha ammazzato il server»
 * non è «il tuo codice è rotto».
 *
 * La decisione è pura (`describeServerDeath`) e vive in `tests/unit`: la
 * diagnosi di un difetto che si vede una volta al mese non può essere l'unica
 * cosa non verificata della catena.
 */

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { E2E_PORT } from "./test-server";
import { isPidAlive, lockPathForPort } from "./run-lock";

/** Chi tiene la porta adesso, se qualcuno la tiene. */
export interface PortHolder {
  pid: number;
  /** Riga di comando, troncata: serve a distinguere «un altro checkout» da «un residuo». */
  cmd: string;
}

/** Tutto ciò che si può sapere sulla morte, raccolto UNA volta e passato alla decisione. */
export interface DeathProbe {
  /** Il server che il `globalSetup` ha avviato (env `__TEST_SERVER_PID`). */
  serverPid: number | null;
  /** Quel PID risponde ancora a `kill(pid, 0)`? */
  serverAlive: boolean;
  /** Il contenuto grezzo di `/tmp/topics-e2e-run-<porta>.lock`, o null se non c'è più. */
  runLockRaw: string | null;
  /** Il PID che il `globalSetup` di QUESTA run ha scritto nel lock (env `__E2E_RUN_LOCK_PID`). */
  ourRunPid: number | null;
  /** Chi ascolta sulla porta in questo istante. */
  portHolders: PortHolder[];
}

function num(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Quanto si aspetta, dopo la morte del server, prima di dichiararla un problema.
 *
 * Non è una pausa di cortesia: è il tempo che serve a distinguere una morte da
 * un RIAVVIO. `terminal-session-resume.spec.ts` ammazza il server e ne spawna
 * un altro sulla stessa porta di proposito, e le due cose sono identiche
 * nell'istante in cui succedono — differiscono solo per ciò che viene dopo.
 * Generoso di proposito: il costo di aspettare è solo quanto tardi arriva un
 * messaggio, il costo di sbagliare è un allarme falso a ogni run.
 */
export const SERVER_DEATH_GRACE_MS = 15_000;

/**
 * Chi ascolta sulla porta, adesso.
 *
 * `execFileSync` e non `execSync`: niente shell, quindi niente da citare e
 * niente `|| true` — l'uscita non-zero di lsof («nessuno tiene la porta») è già
 * gestita dal catch.
 */
export function portHolders(port: number = E2E_PORT): PortHolder[] {
  const holders: PortHolder[] = [];
  try {
    const pids = execFileSync("lsof", ["-ti", `:${port}`], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    for (const raw of pids.split("\n").filter(Boolean)) {
      const pid = Number(raw);
      if (!Number.isFinite(pid)) continue;
      let cmd = "?";
      try {
        cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim()
          .slice(0, 120);
      } catch { /* il processo può sparire fra le due chiamate */ }
      holders.push({ pid, cmd });
    }
  } catch { /* nessuno sulla porta (lsof esce 1), o niente lsof: si diagnostica lo stesso */ }
  return holders;
}

/**
 * Raccoglie le prove. Ogni sonda è difensiva: si chiama mentre qualcosa sta già
 * andando storto, e una diagnosi che a sua volta lancia nasconde l'errore vero.
 */
export function probeServerDeath(port: number = E2E_PORT): DeathProbe {
  const serverPid = num(process.env.__TEST_SERVER_PID);
  let runLockRaw: string | null = null;
  try {
    runLockRaw = readFileSync(lockPathForPort(port), "utf8");
  } catch {
    runLockRaw = null;
  }

  return {
    serverPid,
    serverAlive: serverPid !== null && isPidAlive(serverPid),
    runLockRaw,
    ourRunPid: num(process.env.__E2E_RUN_LOCK_PID),
    portHolders: portHolders(port),
  };
}

/**
 * Il verdetto, dalle sole prove. `null` = il server è VIVO, quindi l'errore che
 * ha portato qui è un errore vero e va lasciato passare intatto: una diagnosi
 * che si sovrascrive a un rosso legittimo è peggio del rosso.
 */
export function describeServerDeath(p: DeathProbe, port: number = E2E_PORT): string | null {
  // Il lock è la prova decisiva: se non è più nostro, qualcuno è entrato.
  let holder: { pid?: number; cwd?: string; startedAt?: string } | null = null;
  try {
    holder = p.runLockRaw ? JSON.parse(p.runLockRaw) : null;
  } catch {
    holder = null;
  }
  const stolen =
    p.ourRunPid !== null &&
    holder != null &&
    typeof holder.pid === "number" &&
    holder.pid !== p.ourRunPid;

  // Porta rubata: qualunque cosa risponda adesso è il server di UN ALTRO
  // checkout, col SUO database. Va detto anche — anzi soprattutto — se la porta
  // risponde, perché è il caso in cui i test proseguono contro il server
  // sbagliato invece di fallire subito.
  if (!stolen) {
    if (p.serverAlive) return null;
    // Qualcuno tiene la porta e il lock è ancora nostro: quel server è il
    // NOSTRO, eventualmente RIAVVIATO. Non è un'ipotesi di scuola —
    // `terminal-session-resume.spec.ts` (AC-2) ammazza il server e ne spawna un
    // altro *detached* di proposito: da lì in poi `__TEST_SERVER_PID` punta a un
    // processo morto per tutti i ~70 test che restano. Una diagnosi basata solo
    // su quel PID mentirebbe a ogni errore di rete fino a fine suite.
    if (p.portHolders.length > 0) return null;
  }

  // Il nostro server è stato non solo ucciso ma RIMPIAZZATO: dire «non c'è più»
  // manderebbe a cercare un buco dove invece c'è qualcosa che risponde — e che
  // risponde dal database sbagliato.
  const usurped = stolen && p.portHolders.length > 0;

  const lines: string[] = [];
  lines.push(
    usurped
      ? `[e2e] SULLA PORTA ${port} C'È IL SERVER DI UN'ALTRA RUN, NON IL NOSTRO.`
      : `[e2e] IL SERVER DI TEST NON C'È PIÙ (porta ${port}` +
        (p.serverPid !== null ? `, PID ${p.serverPid} avviato dal globalSetup` : "") +
        `).`,
  );
  lines.push("");
  lines.push(
    usurped
      ? "Il nostro è stato ucciso e rimpiazzato: da qui in poi i test interrogano " +
        "un DATABASE che non è il loro: verdi e rossi sono ugualmente privi di valore."
      : "Da questo punto in poi OGNI test fallisce con ECONNREFUSED: sono rossi finti, " +
        "non dicono niente sul codice sotto test. Il primo rosso vero è questo.",
  );
  lines.push("");

  if (stolen && holder) {
    lines.push(
      `CAUSA: un'ALTRA run E2E si è presa la porta. Il lock ${lockPathForPort(port)} ` +
        `era nostro (PID ${p.ourRunPid}), adesso è di PID ${holder.pid}` +
        (holder.cwd ? `, cwd ${holder.cwd}` : "") +
        (holder.startedAt ? `, avviata ${holder.startedAt}` : "") +
        ". Il suo globalSetup ammazza chi tiene la porta: quel «chi» eravamo noi.",
    );
  } else if (p.ourRunPid !== null && p.runLockRaw === null) {
    lines.push(
      `CAUSA PROBABILE: un'altra run E2E ha attraversato questa porta — il lock ` +
        `${lockPathForPort(port)} era nostro (PID ${p.ourRunPid}) e adesso non c'è più. ` +
        `I checkout nati prima del 2026-07-28 (i worktree di dispatch lo sono quasi tutti) ` +
        `non hanno il lock: il loro globalSetup ammazza chi tiene la porta senza guardare.`,
    );
  } else {
    lines.push(
      "CAUSA: il server è morto senza che nessuno gli abbia sfilato il lock. " +
        "Cerca nel log qui sopra l'ultima riga `[test-server]` prima del buco: un " +
        "`[Shutdown] Received SIGTERM` senza teardown = qualcuno l'ha ucciso da fuori " +
        "(tipicamente `lsof -ti :PORTA | xargs kill` di un altro checkout); un'uscita " +
        "senza saluti = è crashato, e il motivo è in quelle righe.",
    );
  }

  if (p.portHolders.length) {
    lines.push("");
    lines.push(`Sulla porta ${port} adesso c'è:`);
    for (const h of p.portHolders) lines.push(`  PID ${h.pid}  ${h.cmd}`);
  }

  lines.push("");
  lines.push(
    `RIMEDIO: dai a questa run una porta tutta sua — porta, DATA_DIR, bundle e socket ` +
      `derivano tutti da E2E_PORT (tests/e2e/helpers/test-server.ts):\n\n    E2E_PORT=13400 npx playwright test`,
  );
  return lines.join("\n");
}

/** Scorciatoia: sonda + verdetto. `null` se il server è vivo. */
export function diagnoseServerDeath(port: number = E2E_PORT): string | null {
  return describeServerDeath(probeServerDeath(port), port);
}

/**
 * Il lock della porta è passato a un'ALTRA run?
 *
 * Sonda povera apposta — una `readFileSync` di poche centinaia di byte, niente
 * `lsof`, niente `ps` — perché va chiamata all'inizio di ogni file di spec. Serve
 * a coprire il caso che nessun altro copre: quando il server che ci ha rubato la
 * porta *risponde*, non ci sono ECONNREFUSED da intercettare, i test proseguono
 * contro un database che non è il loro e finiscono verdi o rossi senza che né
 * l'uno né l'altro significhi qualcosa. Un guasto silenzioso vale meno di zero:
 * vale il tempo che qualcuno perde a credergli.
 *
 * `null` quando va tutto bene o quando non sappiamo di chi sia il lock (fuori dal
 * `globalSetup` non c'è `__E2E_RUN_LOCK_PID`: in dubbio si tace).
 */
export function runLockStolenBy(port: number = E2E_PORT): number | null {
  const ourRunPid = num(process.env.__E2E_RUN_LOCK_PID);
  if (ourRunPid === null) return null;
  try {
    const holder = JSON.parse(readFileSync(lockPathForPort(port), "utf8")) as { pid?: unknown };
    return typeof holder.pid === "number" && holder.pid !== ourRunPid ? holder.pid : null;
  } catch {
    // Lock sparito o illeggibile: è un indizio, non una prova, e qui non
    // possiamo permetterci falsi positivi. Se ne accorge chi inciampa in un
    // errore di rete (`withServerDeathDiagnosis`), con le prove complete.
    return null;
  }
}

/**
 * Arricchisce un errore di rete con la diagnosi, se il server è davvero morto.
 * Restituisce l'errore ORIGINALE quando il server è vivo: il chiamante rilancia
 * sempre quello che riceve, così un rosso legittimo resta identico a prima.
 */
export function withServerDeathDiagnosis(err: unknown, port: number = E2E_PORT): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  // Solo gli errori di CONNESSIONE meritano la sonda: un 500 o un assert
  // fallito non hanno niente a che vedere con un server assente.
  if (!/ECONNREFUSED|ECONNRESET|socket hang up|connect ETIMEDOUT|fetch failed/i.test(msg)) return err;
  const diagnosis = describeServerDeath(probeServerDeath(port), port);
  if (!diagnosis) return err;
  const wrapped = new Error(`${diagnosis}\n\nErrore originale: ${msg}`);
  if (err instanceof Error && err.stack) wrapped.stack = `${wrapped.message}\n${err.stack}`;
  return wrapped;
}
