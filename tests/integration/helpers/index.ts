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
// Static, not dynamic: `setupTestDataDir` is synchronous, and what it has to do
// with this - close the handle the previous file left open - cannot wait for a
// promise. The module only declares things when imported.
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
  // THE HANDLE OF WHOEVER CAME BEFORE, CLOSED HERE. `server/db.ts` keeps a
  // PROCESS singleton and `initDatabase` returns it as it is when it is already
  // open: pointing `DATA_DIR` somewhere new is then a statement nobody reads,
  // and the file inherits the database of the file that ran before it - with
  // its rows inside. Half of the files in this directory call `setupTestDataDir`
  // without the matching `cleanupTestDataDir`, so their handle stays open for
  // the rest of the shard: this is the symmetric half of that pair, and it is
  // the one that does not depend on every file remembering it. Alone, a file
  // passes either way; in a shard of five hundred it is the difference between
  // measuring your own database and someone else's.
  closeDatabase();
  if (!isUnderTestTmp(testDataDir)) {
    throw new Error(
      `setupTestDataDir: "${testDataDir}" non viene da testTmpDir(). ` +
        `Un path fisso non è ermetico: due suite in parallelo si cancellano i dati a vicenda. ` +
        `Usa: const ROOT = testTmpDir("<label>")`,
    );
  }
  fs.rmSync(testDataDir, { recursive: true, force: true });
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
