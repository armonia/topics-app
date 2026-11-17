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
 *      HOME, sockets and CLI stubs) on `$PORT`, serving that bundle.
 *
 * All output goes to stdout/stderr: when something breaks, the last lines end
 * up in the reason written on the card.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

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

const clientDir = join(REPO_ROOT, "client");
if (!existsSync(join(clientDir, "node_modules"))) {
  step("client dependencies", ["bun", "install", "--frozen-lockfile"], clientDir);
}
step("client bundle", ["bun", "run", "scripts/build-client.ts", "--out", bundleDir], REPO_ROOT);

console.log(`▸ isolated server on :${port}`);
const server = spawn("bash", [join(REPO_ROOT, "scripts", "start-test-server.sh")], {
  cwd: REPO_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    BUN_PORT: String(port),
    DATA_DIR: join(root, "data"),
    TOPICS_PUBLIC_DIR: bundleDir,
  },
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => server.kill(sig));
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
