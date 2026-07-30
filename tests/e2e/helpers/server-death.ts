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

  // `execFileSync` e non `execSync`: niente shell, quindi niente da citare e
  // niente `|| true` — l'uscita non-zero di lsof («nessuno tiene la porta») è
  // già gestita dal catch.
  const portHolders: PortHolder[] = [];
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
      portHolders.push({ pid, cmd });
    }
  } catch { /* nessuno sulla porta (lsof esce 1), o niente lsof: si diagnostica lo stesso */ }

  return {
    serverPid,
    serverAlive: serverPid !== null && isPidAlive(serverPid),
    runLockRaw,
    ourRunPid: num(process.env.__E2E_RUN_LOCK_PID),
    portHolders,
  };
}

/**
 * Il verdetto, dalle sole prove. `null` = il server è VIVO, quindi l'errore che
 * ha portato qui è un errore vero e va lasciato passare intatto: una diagnosi
 * che si sovrascrive a un rosso legittimo è peggio del rosso.
 */
export function describeServerDeath(p: DeathProbe, port: number = E2E_PORT): string | null {
  if (p.serverAlive) return null;
  // Nessun PID noto e la porta risponde ancora: non sappiamo niente, e
  // inventarci una morte sarebbe peggio del silenzio.
  if (p.serverPid === null && p.portHolders.length > 0) return null;

  const lines: string[] = [];
  lines.push(
    `[e2e] IL SERVER DI TEST NON C'È PIÙ (porta ${port}` +
      (p.serverPid !== null ? `, PID ${p.serverPid} avviato dal globalSetup` : "") +
      `).`,
  );
  lines.push("");
  lines.push(
    "Da questo punto in poi OGNI test fallisce con ECONNREFUSED: sono rossi finti, " +
      "non dicono niente sul codice sotto test. Il primo rosso vero è questo.",
  );
  lines.push("");

  // Il lock è la prova decisiva: se non è più nostro, qualcuno è entrato.
  let holder: { pid?: number; cwd?: string; startedAt?: string } | null = null;
  try {
    holder = p.runLockRaw ? JSON.parse(p.runLockRaw) : null;
  } catch {
    holder = null;
  }

  if (p.ourRunPid !== null && holder && typeof holder.pid === "number" && holder.pid !== p.ourRunPid) {
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
