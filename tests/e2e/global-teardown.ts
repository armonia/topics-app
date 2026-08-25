/**
 * Playwright global teardown — runs AFTER all test suites.
 * Kills the isolated test server process started by global-setup.
 * Also cleans up any stale processes on the test port.
 */

import { execSync, execFileSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { E2E_PORT, descendantsOf, testServerEnv } from "./helpers/test-server";
import { liveLockHolder, releaseRunLock } from "./helpers/run-lock";

const TEST_PORT = E2E_PORT;

/**
 * Spegne il ponte PTY del BANCO — e solo quello.
 *
 * Il ponte nasce `detached` + `unref()` (server/routes/terminal.ts): sopravvive
 * per progetto alla morte del server, così le sessioni reggono un riavvio.
 * Ottimo in sviluppo, un accumulo qui: senza questo passo ogni run lascerebbe
 * dietro un `pty-bridge.mjs` orfano, uno per porta, per sempre.
 *
 * Il bersaglio è il SOCKET del banco, mai il nome del processo. Un
 * `pkill -f pty-bridge` porterebbe via anche il ponte di PRODUZIONE, con dentro
 * le sessioni Claude vive dell'utente — esattamente l'incidente che
 * `start-test-server.sh` evita dando al banco un socket suo. Il socket di
 * produzione ha un path diverso per costruzione, quindi non può mai finire in
 * questa lista. L'invariante è controllata da
 * tests/unit/pty-bridge-e2e-isolation.test.ts.
 */
function bankBridgePids(socket: string, pidFile: string): number[] {
  const pids = new Set<number>();

  // 1. Il pidfile che il ponte scrive accanto al suo socket.
  try {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf-8").trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  } catch { /* pidfile illeggibile: resta la scansione qui sotto */ }

  // 2. Cintura: un ponte morto male può non aver lasciato il pidfile, e un ponte
  //    RINATO dopo la scrittura può averlo lasciato stantio. Si cerca per riga
  //    di comando, ancorata al path ESATTO del socket del banco.
  try {
    const rows = execSync("ps ax -o pid=,command= 2>/dev/null || true").toString();
    for (const row of rows.split("\n")) {
      if (!row.includes(socket)) continue;
      const pid = Number(row.trim().split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  } catch { /* ps non disponibile */ }

  // Vivi soltanto: un pid morto nel pidfile non è un orfano da riportare.
  return [...pids].filter((pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });
}

/**
 * Aspetta che sulla porta del banco non ascolti PIÙ NESSUNO.
 *
 * Va prima di spegnere il ponte, e non è pignoleria d'ordine: alla chiusura del
 * socket il server aspetta 500 ms e poi chiama `ensureBridge()`
 * (server/routes/terminal.ts, handler `socket.on('close')`), che ne spawna uno
 * nuovo. Ammazzare il ponte con un server ancora vivo NON lo spegne: lo fa
 * rinascere mezzo secondo dopo, orfano. Il SIGTERM di sopra è asincrono, quindi
 * senza questa attesa il teardown correva contro la resurrezione — e la perdeva.
 */
async function waitForServersGone(port: number, timeoutMs = 10_000): Promise<void> {
  const listeners = () => {
    try {
      return execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null || true`)
        .toString().trim().split("\n").filter(Boolean);
    } catch { return []; }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!listeners().length) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Non se n'è andato con le buone: si insiste, poi si va avanti comunque —
  // il ponte va spento anche se un server si è impuntato.
  const rimasti = listeners();
  if (rimasti.length) {
    console.warn(`[global-teardown] Server ancora in ascolto su ${port} (PID ${rimasti.join(", ")}): SIGKILL.`);
    for (const pid of rimasti) {
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* già morto */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function killBankPtyBridge(port: number): Promise<void> {
  const socket = testServerEnv(port).TOPICS_PTY_SOCKET;
  const pidFile = socket.replace(/\.sock$/, ".pid");
  const killed = new Set<number>();

  // Più passate, e non una sola. Il primo tentativo ne lasciava uno vivo a ogni
  // run che RIAVVIA il server (terminal-session-resume): il server morente vede
  // il socket sparire, chiama `ensureBridge()` e ne spawna un altro SUBITO DOPO
  // la scansione — un orfano nuovo di zecca, nato dopo la sua stessa pulizia.
  // Si ripassa finché una scansione non trova più niente; il server ormai è
  // morto, quindi la lista converge a zero.
  for (let pass = 0; pass < 4; pass++) {
    const pids = bankBridgePids(socket, pidFile);
    if (!pids.length) break;
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); killed.add(pid); } catch { /* già morto */ }
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  for (const f of [socket, pidFile]) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* non nostro / già sparito */ }
  }

  const rimasti = bankBridgePids(socket, pidFile);
  if (rimasti.length) {
    // Non si alza la voce a vuoto: se resta, resta detto — un ponte orfano tiene
    // aperti i PTY e si accumula una run dopo l'altra.
    console.warn(`[global-teardown] ATTENZIONE: ponte PTY del banco ancora vivo (PID ${rimasti.join(", ")}) su ${socket}`);
  } else if (killed.size) {
    console.log(`[global-teardown] Ponte PTY del banco spento (PID ${[...killed].join(", ")}) su ${socket}`);
  }
}

async function globalTeardown() {
  // Da qui in poi la morte del server è ATTESA: il banner "morto a metà run"
  // di global-setup (stesso processo, modulo diverso) deve tacere.
  process.env.__E2E_TEARDOWN_STARTED = "1";
  const pid = process.env.__TEST_SERVER_PID;

  if (pid) {
    console.log(`[global-teardown] Killing test server (PID: ${pid})...`);
    try {
      // Kill the process group (negative PID kills the group)
      process.kill(-Number(pid), "SIGTERM");
    } catch {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // Already dead
      }
    }
  }

  // Also kill any stale processes on the test port.
  // `-sTCP:LISTEN`: solo chi ASCOLTA. Senza il filtro lsof restituisce anche i
  // socket dei client — i Chromium ancora connessi mentre si smonta — e questo
  // kill li porterebbe via insieme al server.
  //
  // BUT FIRST: IS THAT PORT MINE?
  //
  // The teardown runs ALWAYS, including when the global-setup REFUSED to start
  // because another run held the lock. Without this question, the refused run
  // reached here and killed whatever was listening on the port - which is the
  // server of the very run the lock was protecting. That is the opposite of
  // what the lock exists for, and it is not hypothetical: on 2026-08-25 at
  // 01:37 a refused run printed `Killed stale processes on port 13334: 45374`
  // and killed another agent's suite mid-run.
  //
  // `liveLockHolder` answers `null` when the lock is mine or absent, so the
  // normal case - my own run tearing itself down - does not change one line.
  const otherRun = liveLockHolder(TEST_PORT);
  if (otherRun) {
    console.log(
      `[global-teardown] Port ${TEST_PORT} belongs to another live run (PID ${otherRun.pid}, ` +
        `cwd ${otherRun.cwd}): leaving its processes alone.`,
    );
    console.log("[global-teardown] Test server stopped.");
    return;
  }
  try {
    const pids = execSync(
      `lsof -ti :${TEST_PORT} -sTCP:LISTEN 2>/dev/null || true`
    )
      .toString()
      .trim();
    if (pids) {
      execSync(`kill ${pids.split("\n").join(" ")} 2>/dev/null || true`);
      console.log(`[global-teardown] Killed stale processes on port ${TEST_PORT}: ${pids.replace(/\n/g, ", ")}`);
    }
  } catch {
    // No stale processes
  }

  console.log("[global-teardown] Test server stopped.");

  // Dopo il server, non prima: finché il server respira può rispawnare il ponte.
  await waitForServersGone(TEST_PORT);
  await killBankPtyBridge(TEST_PORT);

  // Reap Chromiums orphaned by THIS run — never anyone else's.
  //
  // This used to kill every ms-playwright/mcp-chrome Chromium on the machine, on
  // every single run (not just crashes). That reaches well outside the project:
  // a concurrent E2E run in another repo lost its browsers and its results, and
  // `mcp-chrome` is the user's own claude-in-chrome window. global-setup snapshots
  // the PIDs alive before we launch anything and hands them over in
  // __FOREIGN_CHROMIUM_PIDS; whatever was already running is by definition not
  // ours, so it is spared. Everything else is still reaped hard.
  try {
    const spared = new Set(
      (process.env.__FOREIGN_CHROMIUM_PIDS || "").split(",").filter(Boolean),
    );
    // Nostri = discendenti di QUESTO runner. La fotografia dei PID pre-esistenti
    // resta come cintura in più, ma da sola non basterebbe più: con gli shard in
    // parallelo i browser degli altri nascono DOPO la nostra fotografia.
    const mine = descendantsOf(process.pid);
    const chromiumPids = execSync(
      'ps ax -o pid=,command= | grep -E "ms-playwright|mcp-chrome" | grep -Ei "chromium|chrome" | grep -v grep | awk \'{ print $1 }\' 2>/dev/null || true'
    ).toString().trim();
    const ours = chromiumPids
      .split("\n")
      .map((s: string) => s.trim())
      .filter((pid: string) => /^\d+$/.test(pid) && !spared.has(pid) && mine.has(pid));
    if (ours.length) {
      execSync(`kill -9 ${ours.join(' ')} 2>/dev/null || true`);
      console.log(`[global-teardown] Killed ${ours.length} orphaned Chromium process(es) from this run` +
        (spared.size ? `; spared ${spared.size} pre-existing` : ""));
    } else {
      console.log("[global-teardown] No orphaned Chromium processes found." +
        (spared.size ? ` (${spared.size} pre-existing spared)` : ""));
    }
  } catch {}

  // Auto-run AI visual review on screenshots
  try {
    const reviewScript = `${process.cwd()}/scripts/ai-review-screenshots.sh`;
    const fs = await import('fs');
    if (fs.existsSync(reviewScript)) {
      console.log("[global-teardown] Running AI visual review...");
      const pyScript = reviewScript.replace('ai-review-screenshots.sh', 'ai-review-screenshots.py');
      if (fs.existsSync(pyScript)) {
        execFileSync('python3', [pyScript], { stdio: 'inherit', timeout: 120000 });
      } else {
        // zsh, matching the script's shebang: it uses `typeset -A` + zsh array
        // syntax, which macOS' stock /bin/bash 3.2 rejects outright.
        execFileSync('zsh', [reviewScript], { stdio: 'inherit', timeout: 120000 });
      }
    }
  } catch (e) {
    console.log(`[global-teardown] AI review skipped: ${e instanceof Error ? e.message : e}`);
  }

  // Ultimo passo: restituisce la porta. Va DOPO il kill del server — finché
  // quel processo respira, la prossima run non deve poter entrare e ammazzarlo.
  // `releaseRunLock` toglie solo il lock di questo PID, quindi è innocuo anche
  // se il lock nel frattempo è passato a qualcun altro.
  releaseRunLock(TEST_PORT);
}

export default globalTeardown;
