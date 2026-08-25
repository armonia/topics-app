/**
 * Una sola run E2E per porta, e chi arriva secondo lo scopre SUBITO.
 *
 * Il `global-setup` è distruttivo per costruzione: ammazza chiunque tenga la
 * porta del server di test e cancella `topics.db` dalla `DATA_DIR`. Ha senso
 * finché quel qualcuno è un residuo di una run morta male — che è l'assunto
 * scritto nel commento "Kill any stale test server processes". L'assunto salta
 * se la run precedente è VIVA: il secondo `playwright test` SIGTERM-a il server
 * del primo e gli sfila il file SQLite da sotto una connessione aperta.
 *
 * Il primo non muore in modo pulito: continua a girare con un vnode che non
 * esiste più e ogni query diventa `SQLITE_IOERR_VNODE` (errno 6922, "disk I/O
 * error"). Da lì in poi ogni test fallisce per un motivo finto — successo:
 * 31 passati e 389 mai partiti, con un `[Shutdown] Received SIGTERM` nel log
 * che quella run non aveva mai emesso. Ore di diagnosi su un difetto che non
 * era nel codice sotto test.
 *
 * Il lock trasforma quella distruzione silenziosa in un errore leggibile prima
 * che parta un solo test. Non serializza nulla e non aspetta: dice che la
 * porta è occupata e da chi, e ricorda che `E2E_PORT` esiste apposta per far
 * girare due run insieme (ogni porta ha la sua `DATA_DIR` e i suoi socket —
 * vedi `test-server.ts`).
 *
 * Vive in `/tmp` e non sotto `DATA_DIR` proprio perché `DATA_DIR` è ciò che il
 * setup ripulisce: un lock cancellato dalla pulizia che deve proteggere non
 * proteggerebbe niente.
 */

import { readFileSync, unlinkSync, writeFileSync } from "fs";

export interface LockRecord {
  pid: number;
  /** ISO — serve a distinguere una run viva da un PID riciclato. */
  startedAt: string;
  cwd: string;
  port: number;
}

/** Il minimo di filesystem che serve qui, così la decisione è testabile a secco. */
export interface LockFs {
  read(path: string): string | null;
  write(path: string, content: string): void;
  remove(path: string): void;
}

/**
 * Oltre questa età un lock non è più credibile: nessuna suite dura sei ore, e
 * un PID su macOS si ricicla. Un lock vecchio con un PID vivo è quasi certo un
 * altro processo che ha ereditato il numero, non la run di prima.
 */
export const LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function lockPathForPort(port: number): string {
  return `/tmp/topics-e2e-run-${port}.lock`;
}

export type LockDecision =
  /** Si prende. `reason` dice perché era libero. */
  | { action: "acquire"; reason: "free" | "unreadable" | "self" | "dead" | "expired"; previous?: LockRecord }
  /** C'è una run viva: chi chiama deve fermarsi, non "provarci lo stesso". */
  | { action: "refuse"; holder: LockRecord };

function parseRecord(raw: string | null): LockRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    if (!r || typeof r !== "object") return null;
    if (typeof r.pid !== "number" || !Number.isFinite(r.pid)) return null;
    return {
      pid: r.pid,
      startedAt: typeof r.startedAt === "string" ? r.startedAt : "",
      cwd: typeof r.cwd === "string" ? r.cwd : "?",
      port: typeof r.port === "number" ? r.port : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Chi tiene la porta, e se conta ancora. L'ordine dei controlli:
 *
 * - un lock illeggibile non blocca nulla (un file corrotto non deve rendere la
 *   suite inavviabile per sempre);
 * - il proprio PID non blocca se stesso;
 * - un PID morto è un residuo, si prende;
 * - un PID vivo ma con un lock più vecchio di `LOCK_MAX_AGE_MS` è un PID
 *   riciclato: si prende, rumorosamente;
 * - solo un PID vivo e recente fa rifiutare.
 */
export function decideLock(
  raw: string | null,
  self: LockRecord,
  isAlive: (pid: number) => boolean,
  now: number,
  maxAgeMs: number = LOCK_MAX_AGE_MS,
): LockDecision {
  if (raw === null) return { action: "acquire", reason: "free" };
  const holder = parseRecord(raw);
  if (!holder) return { action: "acquire", reason: "unreadable" };
  if (holder.pid === self.pid) return { action: "acquire", reason: "self", previous: holder };
  if (!isAlive(holder.pid)) return { action: "acquire", reason: "dead", previous: holder };

  const age = now - new Date(holder.startedAt).getTime();
  if (Number.isFinite(age) && age > maxAgeMs) {
    return { action: "acquire", reason: "expired", previous: holder };
  }
  return { action: "refuse", holder };
}

/** Il messaggio che l'umano legge invece di veder morire due run insieme. */
export function refusalMessage(holder: LockRecord, port: number): string {
  const da = holder.startedAt ? ` (avviata ${holder.startedAt})` : "";
  return (
    `[e2e] Un'altra run E2E sta usando la porta ${port}: PID ${holder.pid}${da}, cwd ${holder.cwd}.\n\n` +
    `Due run sulla stessa porta non convivono: questo setup ammazzerebbe il suo server e le ` +
    `cancellerebbe il DB di test da sotto una connessione aperta. L'altra run non morirebbe — ` +
    `continuerebbe a girare in SQLITE_IOERR_VNODE, fallendo ogni test per un motivo finto.\n\n` +
    `Aspetta che finisca, oppure dai a questa run la sua porta (porta, DATA_DIR e socket sono ` +
    `tutti derivati da E2E_PORT):\n\n    E2E_PORT=13344 npx playwright test\n\n` +
    `Se sei certo che quella run sia morta: rm ${lockPathForPort(port)}`
  );
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = esiste ma è di un altro utente: vivo comunque.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const nodeFs: LockFs = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  write(path, content) {
    writeFileSync(path, content);
  },
  remove(path) {
    try {
      unlinkSync(path);
    } catch { /* già sparito */ }
  },
};

export interface AcquireOptions {
  fs?: LockFs;
  isAlive?: (pid: number) => boolean;
  now?: number;
  maxAgeMs?: number;
  log?: (msg: string) => void;
}

/**
 * Prende il lock o lancia. Lanciare è il punto: Playwright abortisce il run
 * prima del primo test, senza aver toccato niente di quello altrui.
 */
export function acquireRunLock(port: number, opts: AcquireOptions = {}): LockRecord {
  const fs = opts.fs ?? nodeFs;
  const isAlive = opts.isAlive ?? isPidAlive;
  const now = opts.now ?? Date.now();
  const log = opts.log ?? ((m: string) => console.log(m));
  const path = lockPathForPort(port);
  const self: LockRecord = {
    pid: process.pid,
    startedAt: new Date(now).toISOString(),
    cwd: process.cwd(),
    port,
  };

  const decision = decideLock(fs.read(path), self, isAlive, now, opts.maxAgeMs);
  if (decision.action === "refuse") throw new Error(refusalMessage(decision.holder, port));

  if (decision.reason === "dead" || decision.reason === "expired") {
    log(
      `[global-setup] Lock E2E ${decision.reason === "dead" ? "orfano" : "scaduto"} ` +
        `(PID ${decision.previous?.pid}): lo rilevo.`,
    );
  }
  fs.write(path, JSON.stringify(self, null, 2));
  return self;
}

/**
 * Rilascia SOLO se il lock è ancora nostro. Se nel frattempo l'ha preso un
 * altro (lock scaduto e rilevato), cancellarlo lascerebbe la porta scoperta
 * per una terza run — esattamente il buco che questo file chiude.
 */
/**
 * Who holds the lock on this port, if anyone holds it and is alive.
 *
 * It exists for one question the teardown could not ask itself: "is this port
 * MINE?". With no answer, a run refused by the setup still went on to kill
 * whatever was listening on that port - which is the server of the very run the
 * lock was protecting. That is the opposite of what the lock exists for, and it
 * is not hypothetical: `Killed stale processes on port 13334: 45374`, printed by
 * a run the setup had correctly turned away.
 */
export function liveLockHolder(
  port: number,
  opts: { fs?: LockFs; isAlive?: (pid: number) => boolean } = {},
): LockRecord | null {
  const io2 = opts.fs ?? nodeFs;
  const alive = opts.isAlive ?? isPidAlive;
  const holder = parseRecord(io2.read(lockPathForPort(port)));
  if (!holder) return null;
  if (holder.pid === process.pid) return null; // mine: it does not protect me from myself
  return alive(holder.pid) ? holder : null;
}

export function releaseRunLock(port: number, opts: { fs?: LockFs } = {}): void {
  const fs = opts.fs ?? nodeFs;
  const path = lockPathForPort(port);
  const holder = parseRecord(fs.read(path));
  if (holder && holder.pid !== process.pid) return;
  fs.remove(path);
}
