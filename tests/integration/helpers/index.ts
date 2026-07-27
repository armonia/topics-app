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
import path from "node:path";
import type { AppContext } from "../../../server/types";

/**
 * Absolute path to the topics-app repo root, computed once from this
 * helper's own location so tests don't have to know how deep they sit.
 */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * Wipe `testDataDir` and point `process.env.DATA_DIR` at it. Call from
 * `beforeAll`. The cleanup is intentionally only the directory wipe —
 * letting each test owning DATA_DIR keeps the global env mutation
 * visible at the test-file level.
 */
export function setupTestDataDir(testDataDir: string): void {
  fs.rmSync(testDataDir, { recursive: true, force: true });
  process.env.DATA_DIR = testDataDir;
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
