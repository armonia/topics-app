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
import type { AppContext, RouteHandler } from "../../../server/types";

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
 * POST JSON helper. Builds a `Request`, hands it to the router, and
 * waits for the Response. Mirrors what board-jump-to-tab.test.ts
 * already did module-locally.
 */
export async function postJson(
  router: RouteHandler,
  url: string,
  body: unknown,
): Promise<Response> {
  return router(new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

/** GET helper — symmetric to postJson, no body. */
export async function getJson(
  router: RouteHandler,
  url: string,
): Promise<Response> {
  return router(new Request(url, { method: "GET" }));
}

/** PATCH JSON helper — same shape as postJson with a different verb. */
export async function patchJson(
  router: RouteHandler,
  url: string,
  body: unknown,
): Promise<Response> {
  return router(new Request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}
