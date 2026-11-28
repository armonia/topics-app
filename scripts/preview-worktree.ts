#!/usr/bin/env bun
/**
 * Shows THIS checkout as a live app on `$PORT`, without touching real data.
 *
 * It is the script a card's preview manager starts (`preview:worktree` in
 * package.json) from a freshly born worktree. Such a worktree has no built
 * `public/` and no `client/node_modules`, and `bun run start` there served the
 * 503 "Bundle not built yet" (14 cards photographed it) or read the machine's
 * real data. So:
 *
 *   1. the client dependencies, when missing;
 *   2. the bundle built OUTSIDE the checkout (`build:client --out`), so
 *      `public/` is never left half empty;
 *   3. the isolated test server (`start-test-server.sh`: its own DATA_DIR,
 *      HOME, sockets and CLI stubs) on `$PORT`, serving that bundle;
 *   4. a made-up, standalone topic with a couple of messages, created through
 *      the server's own API, so the shot shows a chat instead of the first-run
 *      screen. Nothing real goes in.
 *
 * All output goes to stdout/stderr: when something breaks, the last lines end
 * up in the reason written on the card.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { previewServerEnv } from "./preview-env";
import { seedPreviewData } from "./preview-seed";

const REPO_ROOT = resolve(import.meta.dir, "..");
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port <= 0) {
  console.error("✗ preview-worktree: PORT missing or invalid");
  process.exit(2);
}

// Canonical root (/private/tmp on macOS): the server script compares it with real paths.
const root = join(realpathSync("/tmp"), `topics-preview-${port}`);
const bundleDir = join(root, "public");
mkdirSync(root, { recursive: true });

function step(label: string, cmd: string[], cwd: string): void {
  console.log(`▸ ${label}`);
  const res = spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`✗ ${label} failed (exit ${res.status ?? res.signal})`);
    process.exit(res.status || 1);
  }
}

// The page worth showing is announced through this file (see PreviewCommand.deepLinkFile).
// Removed first so a stale answer from an earlier run is never read.
const deepLinkFile = process.env.PREVIEW_DEEP_LINK_FILE;
if (deepLinkFile) rmSync(deepLinkFile, { force: true });

const clientDir = join(REPO_ROOT, "client");
if (!existsSync(join(clientDir, "node_modules"))) {
  step("client dependencies", ["bun", "install", "--frozen-lockfile"], clientDir);
}
step("client bundle", ["bun", "run", "scripts/build-client.ts", "--out", bundleDir], REPO_ROOT);

console.log(`▸ isolated server on :${port}`);
const server = spawn("bash", [join(REPO_ROOT, "scripts", "start-test-server.sh")], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: previewServerEnv(process.env, {
    BUN_PORT: String(port),
    DATA_DIR: join(root, "data"),
    TOPICS_PUBLIC_DIR: bundleDir,
  }),
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => server.kill(sig));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

const base = `http://127.0.0.1:${port}`;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return res.json().catch(() => ({}));
}

/** Waits for the server to answer, polling fast: the seed should land before anyone opens the page. */
async function waitForServer(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/system/status`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Example data, all invented, and the page to photograph. The order of the
 * steps lives in `preview-seed.ts`, which is tested without a server: a failed
 * seed is reported and ignored, the preview still serves.
 */
async function seed(): Promise<void> {
  await seedPreviewData({
    api,
    // `?topic=` opens exactly that topic, without the sidebar: the chat is what the shot shows.
    announce: (deepLink) => { if (deepLinkFile) writeFileSync(deepLinkFile, deepLink); },
  });
}

if (await waitForServer(120_000)) {
  try { await seed(); } catch (err) { console.error(`▸ seed skipped: ${err instanceof Error ? err.message : err}`); }
}
