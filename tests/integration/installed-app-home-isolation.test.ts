/**
 * WHAT TOPICS LEAVES IN SOMEBODY'S HOME AFTER IT HAS RUN.
 *
 * An installed app is judged by its footprint, and a footprint is not something
 * you can review by reading code: it is what the filesystem says afterwards. So
 * this test does the only thing that answers the question. It boots the real
 * server against an EMPTY, throwaway HOME wired exactly the way the desktop
 * shell wires it (desktop-tauri/src-tauri/src/lib.rs: NO_TLS, BUN_PORT,
 * TOPICS_DATA_DIR, DATA_DIR, TOPICS_HOME, TOPICS_EMBEDDED), runs a session
 * through it, stops it, and then walks that home.
 *
 * Notably it does NOT set OPENCLAW_DIR the way `spawnRealServer` does: pinning
 * every directory by hand is how a test about stray files never sees one.
 *
 * THE THREE ROOTS THAT ARE ALLOWED, and each is a measurement, not an opinion:
 *
 *   .topics    ours, by definition. Data, logs, backups, the hook token.
 *   .openclaw  ALSO ours, under the name the app had before it was Topics:
 *              `APP_DATA_DIR` is documented as defaulting there (README), and
 *              media/ and workspace/ still live under it on every installation
 *              that exists. Renaming that root moves data people already have,
 *              which is a migration with a card of its own, not a side effect
 *              of this one.
 *   .codex     NOT written by us. Measured on 2026-09-08: `codex --version`
 *              alone, with HOME pointed at an empty directory, creates
 *              `~/.codex/tmp/arg0/...`. The CLI manages its own home; Topics
 *              only asks it its version.
 *   .gemini    Same shape, measured on 2026-09-07: `gemini --version` alone
 *              under an empty HOME creates `~/.gemini`. It shows up only on a
 *              machine where that CLI is installed (this one), which is why
 *              the first CI run of this test never saw it. `claude --version`
 *              under the same empty HOME creates NOTHING, so `.claude` stays
 *              exactly the finding described below.
 *
 * And the runtime's own cache for `bun run server.ts`: `Library/` on macOS,
 * `.bun/` on Linux (measured on the CI runner, 2026-09-07: the first run of
 * this test there failed on exactly that one entry). The shipped server is a
 * compiled single file: it transpiles nothing and writes none of this. It is
 * an artefact of running the test from source, so both names are excluded
 * explicitly rather than pretended away.
 *
 * ANYTHING ELSE IS A FINDING. In particular `.claude`: until 2026-09-07 the
 * server wrote its hook token into the user's Claude config dir on every boot.
 * That is the case this test is pointed at, and the reason it names no
 * exception for it.
 *
 * @covers RUNTIME-19
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { freePort, testTmpDir } from "./helpers";

const PROJECT_ROOT = path.join(import.meta.dir, "..", "..");
const ROOT = testTmpDir("home-isolation");
const HOME = path.join(ROOT, "home");

/** Top-level names allowed to exist in HOME afterwards. See the note above. */
const ALLOWED_IN_HOME = new Set([".topics", ".openclaw", ".codex", ".gemini", "Library", ".bun"]);

/** Everything the run left in HOME, one entry per top-level name. */
function homeEntries(): string[] {
  try {
    return fs.readdirSync(HOME).sort();
  } catch {
    return [];
  }
}

/** Every file under `dir`, relative to it. Empty when the dir is absent. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

let stopped = false;
let child: ReturnType<typeof Bun.spawn> | null = null;

afterAll(async () => {
  if (child && !stopped) {
    child.kill("SIGKILL");
    await child.exited;
  }
});

describe("an installed Topics writes only into its own home", () => {
  test("a boot and a session leave nothing outside ~/.topics", async () => {
    const port = freePort();
    const dataDir = path.join(HOME, ".topics", "app-data");
    fs.mkdirSync(HOME, { recursive: true });

    // The empty-home precondition IS the before-snapshot: anything found later
    // was put there by this run.
    expect(homeEntries()).toEqual([]);

    child = Bun.spawn(["bun", "run", "server.ts"], {
      cwd: PROJECT_ROOT,
      // Built from scratch, never spread from process.env: an inherited data
      // dir or port would let the child touch the app the developer has open.
      env: {
        PATH: process.env.PATH ?? "",
        NO_TLS: "1",
        BUN_PORT: String(port),
        PORT: String(port),
        HOME,
        TOPICS_DATA_DIR: dataDir,
        DATA_DIR: path.join(dataDir, "data"),
        TOPICS_HOME: path.join(HOME, ".topics"),
        TOPICS_EMBEDDED: "1",
        TOPICS_PUBLIC_DIR: path.join(ROOT, "public"),
        TOPICS_BROWSER_SWEEP: "0",
        TOPICS_DISABLE_PTY_BRIDGE: "1",
        TOPICS_PTY_SOCKET: path.join(ROOT, "pty.sock"),
        TOPICS_AI_BRIDGE: "0",
        TOPICS_AI_BRIDGE_SOCKET: path.join(ROOT, "ai.sock"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 1200 && !up; i++) {
      if (child.exitCode !== null) break;
      try {
        up = (await fetch(`${baseUrl}/api/system/status`)).ok;
      } catch { /* not listening yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 50));
    }
    if (!up) {
      const err = await new Response(child.stderr as ReadableStream).text().catch(() => "");
      throw new Error(`the server never answered on ${port}\n${err.slice(-2000)}`);
    }

    // A session, not just a boot: the paths a chat touches are the ones that
    // historically escaped (the hook token, the transcript dirs, the caches).
    const created = await fetch(`${baseUrl}/api/topics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "home isolation probe" }),
    });
    expect(created.ok).toBe(true);

    child.kill("SIGTERM");
    await child.exited;
    stopped = true;

    expect(homeEntries().filter((e) => !ALLOWED_IN_HOME.has(e))).toEqual([]);
    // The one that had a real leak: nothing of ours goes into the Claude dir.
    expect(filesUnder(path.join(HOME, ".claude"))).toEqual([]);
    // And the app really did write: an empty home would pass vacuously.
    expect(filesUnder(path.join(HOME, ".topics")).length).toBeGreaterThan(0);
  }, 90_000);
});
