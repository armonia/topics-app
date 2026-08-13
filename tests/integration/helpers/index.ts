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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `topics-${label}-`));
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
 * Una cartella temporanea UNICA per processo, sotto `/tmp/topics-test/`.
 *
 * PERCHE' ESISTE. Un path fisso non isola niente: isola dagli ALTRI programmi,
 * non da un'altra copia di questa suite. Due run in parallelo aprono lo stesso
 * file SQLite, lo stesso HOME finto e lo stesso repo git, e la prima `rmSync` di
 * un `beforeAll` porta via i dati dell'altra mentre sta lavorando. Misurato: 3
 * run concorrenti, circa 65 test rossi fra `SQLITE_IOERR_VNODE` e lock contesi,
 * tutti verdi presi da soli. Il caso peggiore e' il broker ai-bridge, il cui
 * socket unix deriva da un hash di `DATA_DIR`: un `DATA_DIR` fisso mette due run
 * sullo stesso socket, cioe' a parlare con lo stesso demone.
 *
 * PERCHE' `/tmp` E NON `os.tmpdir()`. Su macOS `tmpdir()` e' un
 * `/var/folders/xx/…/T/` da una cinquantina di caratteri. Un socket unix ha un
 * tetto duro di 104 caratteri di path (`sun_path`), e i test che ne creano uno
 * lo mettono dentro la cartella che ricevono da qui: con una radice corta il
 * socket resta legale, con quella di sistema si rischia un ENAMETOOLONG che non
 * parla di niente.
 *
 * Esempio di risultato: `/tmp/topics-test/live-phase-gate-a3Xk9Z`.
 *
 * Chi la chiede la cancella: `afterAll(() => rmSync(dir, { recursive: true,
 * force: true }))`, o `/tmp/topics-test` cresce a ogni run.
 */
export function testTmpDir(label: string): string {
  const root = "/tmp/topics-test";
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${label}-`));
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
  const { closeDatabase } = await import("../../../server/db");
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create an `AppContext` rooted at the repo root + stub broadcastToAll
 * to a no-op. Same call shape every test had inline.
 */
export async function createTestAppContext(): Promise<AppContext> {
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
