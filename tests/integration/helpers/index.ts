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
import * as os from "node:os";
import path from "node:path";
import type { AppContext } from "../../../server/types";
import { closeDatabase } from "../../../server/db";

/**
 * Absolute path to the topics-app repo root, computed once from this
 * helper's own location so tests don't have to know how deep they sit.
 */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

/** Radici di scratch create da `testTmpDir` in questo processo. */
const tmpRoots: string[] = [];
let cleanupArmed = false;

/**
 * Cartella di scratch UNICA per questo processo, sotto `os.tmpdir()`.
 *
 * Serve a tenere la suite ermetica quando gira in PARALLELO. Con un path
 * costante (`/tmp/topics-phase-c-data`) due `bun test` avviati insieme in
 * worktree diversi scrivono e cancellano la STESSA cartella: il 2026-08-13
 * questo ha prodotto 15 file rossi, tutti sotto `tests/integration/`, con zero
 * rossi fuori. Il rosso non era del codice in prova.
 *
 * `mkdtempSync` crea la cartella subito con un suffisso casuale, quindi due
 * processi non possono collidere. La cartella viene rimossa all'uscita del
 * processo.
 *
 * Usala per la RADICE dello scratch di un test e derivane i sottopath:
 *
 *   const ROOT = testTmpDir("live-phase-gate");
 *   const TEST_DATA = path.join(ROOT, "data");
 */
export function testTmpDir(label: string): string {
  // Radice CORTA, non `os.tmpdir()`: su macOS quella e' `/var/folders/…/T/`, e
  // un socket unix creato li' dentro sfonda il limite di 104 caratteri del path
  // con un ENAMETOOLONG che non parla di niente. Esempio di risultato:
  // `/tmp/topics-test/live-phase-gate-a3Xk9Z`.
  const radice = "/tmp/topics-test";
  fs.mkdirSync(radice, { recursive: true });
  const dir = fs.mkdtempSync(path.join(radice, `${label}-`));
  tmpRoots.push(dir);
  if (!cleanupArmed) {
    cleanupArmed = true;
    process.on("exit", () => {
      for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
    });
  }
  return dir;
}

/** True se `p` sta dentro (o è) una radice creata da `testTmpDir`. */
function isUnderTestTmp(p: string): boolean {
  const abs = path.resolve(p);
  return tmpRoots.some((root) => abs === root || abs.startsWith(root + path.sep));
}


/**
 * Wipe `testDataDir` and point `process.env.DATA_DIR` at it. Call from
 * `beforeAll`. The cleanup is intentionally only the directory wipe:
 * letting each test own DATA_DIR keeps the global env mutation
 * visible at the test-file level.
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
  fs.rmSync(testDataDir, { recursive: true, force: true });
  process.env.DATA_DIR = testDataDir;
  // AND the handle of whoever came before is closed here, not only in their
  // own afterAll. `initDatabase` returns the cached `_db` WITHOUT looking at
  // DATA_DIR, so a file that opened the database and never closed it hands the
  // next one its own rows: the boot list of a file that seeded three topics
  // answers with somebody else's. That is not a hypothesis, it is what turned
  // `topics-list-weight` red twice on 2026-09-06 (first assertion, wrong topic
  // count) while it stayed green alone and green in shard order: which files
  // share a shard changes from run to run, so the pollution is a lottery.
  // Closing on SETUP makes the isolation the file's own business instead of
  // depending on the discipline of whoever ran before it. `closeDatabase` is
  // idempotent.
  closeDatabase();
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
  /** SIGTERM the child and wait for it to exit. Call from `afterAll`. */
  stop(): Promise<void>;
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
  const openclaw = path.join(root, "openclaw");
  const topicsHome = path.join(root, "topics-home");
  const publicDir = path.join(root, "public");
  for (const d of [dataDir, home, openclaw, topicsHome, publicDir]) fs.mkdirSync(d, { recursive: true });

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
      OPENCLAW_DIR: openclaw,
      TOPICS_HOME: topicsHome,
      TOPICS_PUBLIC_DIR: publicDir,
      TOPICS_BROWSER_SWEEP: "0",
      TOPICS_DISABLE_PTY_BRIDGE: "1",
      TOPICS_PTY_SOCKET: path.join(root, "pty.sock"),
      TOPICS_AI_BRIDGE: "0",
      TOPICS_AI_BRIDGE_SOCKET: path.join(root, "ai.sock"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

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
          async stop() { child.kill("SIGTERM"); await child.exited; },
        };
      }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill("SIGKILL");
  const errorOutput = await new Response(child.stderr as ReadableStream).text().catch(() => "");
  throw new Error(`the spawned server never answered on ${port}\n${errorOutput.slice(-2000)}`);
}
