/**
 * Shared helpers for integration tests. Centralises the boilerplate
 * every test in this directory used to duplicate inline:
 *   - PROJECT_ROOT      — absolute path to the topics-app repo root
 *                         (was `path.resolve(import.meta.dirname, "../..")`
 *                         in every test file)
 *   - setupTestDataDir  — beforeAll(rmSync + process.env.DATA_DIR = ...)
 *                         (was a 3-line beforeAll in every test)
 *   - createTestAppContext — `createAppContext(PROJECT_ROOT)` + the
 *                         broadcast-noop stub every test installed
 *   - postJson / getJson — typed REST helpers (lifted from
 *                         board-jump-to-tab.test.ts where they were
 *                         already defined but module-private)
 *
 * Import from here in new tests. Migrating existing tests is mechanical:
 * delete the inline copies, add `import { ... } from "./helpers"`.
 */

import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { closeDatabase, getDatabase } from "../../../server/db";
import type { AppContext } from "../../../server/types";
import { trackTestTmpDir } from "../../setup/test-tmp-dirs";
import { guardAgainstOrphans, releaseFromOrphanGuard, retireOrphanGuard } from "../../helpers/orphan-guard";
import { killProcessTree } from "../../../server/lib/process-tree";
import { topicsHome } from "../../../server/services/daemon-state";

/**
 * Absolute path to the topics-app repo root, computed once from this
 * helper's own location so tests don't have to know how deep they sit.
 */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

/** Scratch roots created by `testTmpDir` in this process. */
const tmpRoots: string[] = [];

/**
 * A scratch folder UNIQUE to this process, under `/tmp/topics-test`.
 *
 * It keeps the suite hermetic when it runs in PARALLEL. With a constant path
 * (`/tmp/topics-phase-c-data`) two `bun test` runs started together in
 * different worktrees write and delete the SAME folder: on 2026-08-13 that
 * produced 15 red files, all under `tests/integration/`, and zero reds outside.
 * The red did not belong to the code under test.
 *
 * `mkdtempSync` creates the folder at once with a random suffix, so two
 * processes cannot collide. The folder is removed once the test file that
 * created it is over, after that file's own teardown: the preload sweeps it
 * (see `tests/setup/test-tmp-dirs.ts` for why it is not an `afterAll` from
 * here). It used to go in `process.on("exit")`, which `bun test` never calls.
 *
 * Use it for the ROOT of a test's scratch and derive the subpaths from it:
 *
 *   const ROOT = testTmpDir("live-phase-gate");
 *   const TEST_DATA = path.join(ROOT, "data");
 */
export function testTmpDir(label: string): string {
  // A SHORT root, not `os.tmpdir()`: on macOS that is `/var/folders/…/T/`, and
  // a unix socket created in there breaks the 104-character path limit with an
  // ENAMETOOLONG that says nothing useful. Example result:
  // `/tmp/topics-test/live-phase-gate-a3Xk9Z`.
  const base = "/tmp/topics-test";
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, `${label}-`));
  tmpRoots.push(dir);
  trackTestTmpDir(dir, () => holdsOpenDatabase(dir));
  return dir;
}

/**
 * True while the process database singleton is a file inside `root`: a later
 * file's `initDatabase` may have been handed that open handle.
 */
function holdsOpenDatabase(root: string): boolean {
  let file: string;
  try {
    file = getDatabase().filename;
  } catch {
    return false;
  }
  return path.resolve(file).startsWith(root + path.sep);
}

/** True se `p` sta dentro (o è) una radice creata da `testTmpDir`. */
function isUnderTestTmp(p: string): boolean {
  const abs = path.resolve(p);
  return tmpRoots.some((root) => abs === root || abs.startsWith(root + path.sep));
}


/**
 * What `DATA_DIR` was before the first `setupTestDataDir` that no
 * `cleanupTestDataDir` has answered yet; null when none is pending.
 */
let dataDirBeforeSetup: { value: string | undefined } | null = null;

/**
 * Wipe `testDataDir` and point `process.env.DATA_DIR` at it. Call from
 * `beforeAll`, and pair it with `cleanupTestDataDir` in `afterAll`: the
 * cleanup puts `DATA_DIR` back.
 *
 * WHY THE CLEANUP PUTS IT BACK. `server/db.ts` resolves the data folder as
 * `process.env.DATA_DIR || <root>/data`, and `bun test` runs every file of a
 * shard in one process. A `DATA_DIR` left behind sends every later
 * `initDatabase(ownTmpRoot)` to the SAME folder: on 08/10/2026
 * `server/attention/system-notices.test.ts` opened the `topics.db` that
 * `born-seen.test.ts` had just written and found its `topic:front` row, red in
 * every shard that ran `browser-state-store.test.ts` before them, green alone.
 * The saved value is the one before the first unanswered setup, so a file that
 * never cleans up does not hand its folder on through the next file's cleanup.
 *
 * Il path DEVE venire da `testTmpDir` (vedi sopra). Un path costante passa
 * i test da solo e li fa fallire a caso quando la suite gira due volte in
 * parallelo, quindi qui è un errore rumoroso invece che un rosso misterioso
 * fra tre settimane.
 */
export function setupTestDataDir(testDataDir: string): void {
  if (!isUnderTestTmp(testDataDir)) {
    throw new Error(
      `setupTestDataDir: "${testDataDir}" non viene da testTmpDir(). ` +
        `Un path fisso non è ermetico: due suite in parallelo si cancellano i dati a vicenda. ` +
        `Usa: const ROOT = testTmpDir("<label>")`,
    );
  }
  // Hand back the previous file's handle BEFORE moving DATA_DIR. `server/db.ts`
  // keeps `_db` in a PROCESS singleton and a shard runs hundreds of files in
  // one process, so an open handle survives the file that opened it: the next
  // `createTestAppContext` gets THAT database, under this file's name, with the
  // previous file's rows still in it. Until now the isolation this helper
  // promises rested on every previous file remembering `cleanupTestDataDir`,
  // and 18 of the 46 files that use it do not. Closing here makes the promise
  // hold whatever the neighbours do, and closing is idempotent.
  closeDatabase();
  fs.rmSync(testDataDir, { recursive: true, force: true });
  dataDirBeforeSetup ??= { value: process.env.DATA_DIR };
  process.env.DATA_DIR = testDataDir;
}

/**
 * Il gemello di `setupTestDataDir`: chiude il DB e porta via la cartella.
 * Chiamalo da `afterAll`, passando la RADICE che il file ha creato con
 * `testTmpDir` (non la sola `data/`, se ne ha derivate altre).
 *
 * L'ordine non e' un dettaglio, e' tutto il punto. `server/db.ts` tiene un
 * singleton `_db` di PROCESSO, e `bun test` fa girare ogni file nello stesso
 * processo: cancellare la cartella lasciando la maniglia aperta consegna al file
 * successivo un DB che punta a un albero che non esiste piu', e il primo
 * `.all()` esce con `SQLITE_IOERR_VNODE`. Misurato: 35 test rossi, tutti verdi
 * presi da soli. `closeDatabase` e' idempotente, quindi chiamarlo qui va bene
 * anche se un test lo aveva gia' chiuso per conto suo.
 */
export async function cleanupTestDataDir(dir: string): Promise<void> {
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
  // Put back the DATA_DIR the setup found (see `setupTestDataDir`).
  if (dataDirBeforeSetup) {
    if (dataDirBeforeSetup.value === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = dataDirBeforeSetup.value;
    dataDirBeforeSetup = null;
  }
}

/**
 * Create an `AppContext` rooted at the repo root + stub broadcastToAll
 * to a no-op. Same call shape every test had inline.
 *
 * -- WHY THERE IS A GUARD HERE ----------------------------------------------
 * The context opens the database, and WHICH database depends on `DATA_DIR`.
 * Without that variable `server/db.ts` falls back to the repo root, that is to
 * `data/topics.db`: the PRODUCTION DATABASE, the one belonging to the app the
 * user has open right now. A test that forgets `setupTestDataDir` does not
 * fail - it passes, and it passes by writing to the real data.
 *
 * This is not a hypothesis: on 25/08/2026 it happened. `topic-links.test.ts`
 * created 24 topics in the live DB before anyone noticed, and the only clue was
 * one log line ("Opened existing database at .../data/topics.db") in the middle
 * of a green run. The other 24 files that use this helper were already doing
 * the right thing, so the guard is born green: it costs nothing and closes a
 * door that opens quietly.
 */
export async function createTestAppContext(): Promise<AppContext> {
  const dataDir = process.env.DATA_DIR;
  if (!dataDir || !isUnderTestTmp(dataDir)) {
    throw new Error(
      `createTestAppContext: DATA_DIR ${dataDir ? `= "${dataDir}"` : "not set"}, ` +
        `so the context would open the PRODUCTION database (data/topics.db). ` +
        `Isolate the file before creating the context:\n` +
        `  const ROOT = testTmpDir("<label>");\n` +
        `  beforeAll(() => setupTestDataDir(join(ROOT, "data")));\n` +
        `  afterAll(() => cleanupTestDataDir(ROOT));`,
    );
  }
  const { createAppContext } = await import("../../../server/utils");
  const ctx = createAppContext(PROJECT_ROOT);
  (ctx as { broadcastToAll: (msg: object) => void }).broadcastToAll = () => {};
  return ctx;
}

/**
 * POST/GET JSON helper — RIMOSSI.
 *
 * `postJson`/`getJson` chiamavano `router(req)` con UN argomento, ma
 * `RouteHandler` è `(req, url, pathname, method) => Response | null`: quelle due
 * funzioni non hanno mai potuto funzionare. Nessuno le importava, quindi
 * nessuno se n'è accorto — l'unica cosa che le teneva in piedi era che tests/
 * non era sotto typecheck. Chi ne ha bisogno chiami il router con la firma
 * vera, come fa board-jump-to-tab.test.ts.
 */

// ── The REAL server as a child process ───────────────────────────────────────

/** A port nobody holds: bind on 0, read what the kernel gave, release it. */
export function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = probe.port;
  probe.stop(true);
  return p;
}

export interface RealServer {
  port: number;
  baseUrl: string;
  /**
   * Kills the child's whole process GROUP and waits for it to exit. Call from
   * `afterAll`. A plain SIGTERM on the child used to leave behind anything the
   * server had spawned itself (card 617a7a68).
   */
  stop(): Promise<void>;
}

/**
 * The bind host for a server a test spawns. The server defaults to "::"
 * (dual stack, every interface): a test child left on the default is
 * reachable from the LAN for as long as it runs, and these tests only ever
 * probe 127.0.0.1 anyway, so the child is always told to bind loopback only.
 */
export function spawnedServerHostEnv(): Record<string, string> {
  return { SERVER_HOST: "127.0.0.1" };
}

/**
 * Boot `server.ts` as a child process on a free port, isolated from the app the
 * developer has open, and resolve once it answers `GET /api/system/status`.
 *
 * Extracted from `leak-ws-registries.test.ts`, which documents every line of the
 * environment below and still carries its own copy: a test needs the real
 * process (not the in-process router with a no-op broadcast) whenever what it
 * proves is a frame on a WebSocket. The env is built from scratch and NOT spread
 * from `process.env`, so an inherited port or data dir cannot make the child
 * touch the live app; the PTY bridge is disabled because a server booted from
 * this cwd with the default socket would attach to the PRODUCTION bridge and
 * its startup reconcile would kill every session missing from its empty DB.
 *
 * `root` must come from `testTmpDir`.
 */
export async function spawnRealServer(root: string): Promise<RealServer> {
  if (!isUnderTestTmp(root)) {
    throw new Error(`spawnRealServer: "${root}" does not come from testTmpDir(); a fixed path is not hermetic.`);
  }
  const port = freePort();
  const dataDir = path.join(root, "data");
  const home = path.join(root, "home");
  const appData = path.join(root, "app-data");
  const topicsHome = path.join(root, "topics-home");
  const publicDir = path.join(root, "public");
  for (const d of [dataDir, home, appData, topicsHome, publicDir]) fs.mkdirSync(d, { recursive: true });

  const child = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      // Plain HTTP: the server turns TLS on by itself when an untracked
      // `certs/fullchain.pem` exists next to it, and the probe below is `http://`.
      NO_TLS: "1",
      BUN_PORT: String(port),
      PORT: String(port),
      DATA_DIR: dataDir,
      TOPICS_DATA_DIR: dataDir,
      HOME: home,
      APP_DATA_DIR: appData,
      TOPICS_HOME: topicsHome,
      TOPICS_PUBLIC_DIR: publicDir,
      TOPICS_BROWSER_SWEEP: "0",
      TOPICS_DISABLE_PTY_BRIDGE: "1",
      TOPICS_PTY_SOCKET: path.join(root, "pty.sock"),
      TOPICS_AI_BRIDGE: "0",
      TOPICS_AI_BRIDGE_SOCKET: path.join(root, "ai.sock"),
      ...spawnedServerHostEnv(),
    },
    stdout: "pipe",
    stderr: "pipe",
    // Leader of its own process group, so ONE signal to `-pid` reaches whatever
    // the server spawned itself, and so the detached watchdog below can clean
    // it up after a cut run. `stop()` relies on it.
    detached: true,
  });
  // Registered before the readiness probe: a run cut while the server is still
  // booting is how the orphans of card 617a7a68 were born.
  guardAgainstOrphans({ groupLeaderPid: child.pid, root });

  const baseUrl = `http://127.0.0.1:${port}`;
  // 60 s of readiness polling, not 15: under a loaded fleet (measured at load
  // 25 on 12 cores) the child needs well past fifteen seconds to answer, and a
  // ceiling that expires there reports the machine instead of the code.
  for (let i = 0; i < 1200; i++) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${baseUrl}/api/system/status`);
      if (res.ok) {
        return {
          port,
          baseUrl,
          async stop() { await stopSpawnedServer(child); },
        };
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  child.kill("SIGKILL");
  releaseFromOrphanGuard(child.pid);
  // This helper spawns one server per test file: the release above was the
  // last one it ever registers, so the watchdog has nothing left to watch.
  // Retiring now, instead of waiting for its 250 ms poll, is what keeps the
  // registry directory out of a check that runs right after this file ends
  // (card b66e32c0, seen on the full suite under CI load: a file using this
  // shared helper left `.guards` behind for that poll window).
  retireOrphanGuard();
  const errorOutput = await new Response(child.stderr as ReadableStream).text().catch(() => "");
  throw new Error(`the spawned server never answered on ${port}\n${errorOutput.slice(-2000)}`);
}

/**
 * Stops a server spawned as a group leader: the group first (so a tunnel helper
 * or a worktree command it started goes with it), SIGKILL on the group if it is
 * still there, and only then does the watchdog stop watching that pid.
 */
async function stopSpawnedServer(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  await killProcessTree(child.pid, 5000, { group: true });
  await Promise.race([child.exited, Bun.sleep(10_000)]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    child.kill("SIGKILL");
  }
  await child.exited;
  releaseFromOrphanGuard(child.pid);
  // Same reasoning as the boot-failure path above: this helper's one server
  // per file is the only thing it ever registers, so retire now rather than
  // leave the registry for the watchdog's next poll to find.
  retireOrphanGuard();
}

/**
 * The credential the agent and terminal routes accept (server/lib/agent-auth.ts):
 * the daemon token, re-read from `<TOPICS_HOME>/daemon-state.json` on every
 * request. Writes one under this process's TOPICS_HOME (call it AFTER the test
 * pins TOPICS_HOME, if it does) and returns it, to send as `x-daemon-token`.
 */
export function installDaemonToken(): string {
  const home = topicsHome();
  fs.mkdirSync(home, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const state = { pid: process.pid, port: 0, token, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(home, "daemon-state.json"), JSON.stringify(state), { mode: 0o600 });
  return token;
}
