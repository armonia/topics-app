/**
 * Restarts the shared e2e server in the middle of a spec, the way production
 * restarts: SIGTERM, then the same launcher with the same environment.
 *
 * A spec that calls it is `@nightly`: on the PR gate the restart would be paid
 * by whichever spec runs next.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { resolve } from "node:path";
import { E2E_BASE, E2E_PORT, testServerEnv } from "./test-server";
import { killTestListeners } from "./port-guard";

/** A Mac outside CI runs no Chromium (the ban in `playwright.config.ts`). */
const NO_CHROMIUM_HERE = process.platform === "darwin" && process.env.GITHUB_ACTIONS !== "true";

export async function portOpen(): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const s = net.createConnection({ port: E2E_PORT, host: "127.0.0.1" }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(800, () => { s.destroy(); res(false); });
  });
}

/**
 * SIGTERM the test server (as the file watcher does in production) and start
 * it again with the environment it was born with. Returns its output, where
 * the boot reports what it did; the array keeps growing after the return.
 *
 * On a Mac outside CI `CHROMIUM_PATH` points nowhere, on purpose: a headless
 * launch attempted by mistake fails loudly instead of starting a Chromium
 * there. Elsewhere the server comes back with the environment it had, so the
 * specs that run after this one still find the Chromium global-setup gave it.
 */
export async function restartTestServer(): Promise<string[]> {
  killTestListeners(E2E_PORT); // only the test server (helpers/port-guard.ts)
  const down = Date.now();
  while (Date.now() - down < 15_000 && (await portOpen())) await new Promise((r) => setTimeout(r, 200));
  const out: string[] = [];
  const proc = spawn("bash", [resolve(__dirname, "../../../scripts/start-test-server.sh")], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      ...testServerEnv(E2E_PORT),
      ...(NO_CHROMIUM_HERE ? { CHROMIUM_PATH: "/nonexistent/no-chromium-on-this-mac" } : {}),
    },
  });
  proc.unref();
  proc.stdout?.on("data", (d: Buffer) => out.push(d.toString()));
  proc.stderr?.on("data", (d: Buffer) => out.push(d.toString()));
  const up = Date.now();
  while (Date.now() - up < 45_000) {
    if (await portOpen()) {
      const r = await fetch(`${E2E_BASE}/api/topics`).catch(() => null);
      if (r?.ok) return out;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the test server did not come back:\n${out.join("")}`);
}
