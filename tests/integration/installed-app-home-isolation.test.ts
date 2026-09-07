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
 * THE ROOTS THAT ARE ALLOWED, and each is a measurement, not an opinion:
 *
 *   .topics    ours, by definition. Data, logs, backups, the hook token.
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
 * `.openclaw` USED TO BE ON THAT LIST, and taking it off is the point of card
 * 211605ee. The app data root fell back to `${HOME}/.openclaw` whenever the
 * shell had not pinned it, so a fresh install created `media/` and `workspace/`
 * under the name the product had before it was Topics: a second home, in
 * somebody's house, for a product they installed once. It is now resolved by a
 * single rule (`resolveAppDataDir`, server/lib/data-dir.ts) whose two branches
 * are exactly the two tests below.
 *
 * NO DATA IS MOVED. The second test is the other half of the same decision: an
 * install that ALREADY has `~/.openclaw` keeps writing there, because its media
 * paths are recorded in the DB and migrating them is a card of its own.
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
/** A second throwaway home, this one carrying a legacy `.openclaw` already. */
const LEGACY_HOME = path.join(ROOT, "legacy-home");

/** Top-level names allowed to exist in HOME afterwards. See the note above. */
const ALLOWED_IN_HOME = new Set([".topics", ".codex", ".gemini", "Library", ".bun"]);

/** Everything the run left in `home`, one entry per top-level name. */
function homeEntries(home: string): string[] {
  try {
    return fs.readdirSync(home).sort();
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

const children: ReturnType<typeof Bun.spawn>[] = [];

afterAll(async () => {
  for (const c of children) {
    if (c.exitCode === null) {
      c.kill("SIGKILL");
      await c.exited;
    }
  }
});

/**
 * Boot the real server against `home`, wired the way the desktop shell wires
 * it, run one session through it, and stop it. Returns nothing: what the test
 * reads afterwards is the filesystem.
 *
 * `slug` keeps the two runs' sockets and public dirs apart, so the second boot
 * cannot inherit anything of the first one's.
 */
async function bootSessionAndStop(home: string, slug: string): Promise<void> {
  const port = freePort();
  const dataDir = path.join(home, ".topics", "app-data");

  const child = Bun.spawn(["bun", "run", "server.ts"], {
    cwd: PROJECT_ROOT,
    // Built from scratch, never spread from process.env: an inherited data
    // dir or port would let the child touch the app the developer has open.
    // And no APP_DATA_DIR/OPENCLAW_DIR: pinning the root by hand is exactly
    // what would hide the behaviour these two tests are about.
    env: {
      PATH: process.env.PATH ?? "",
      NO_TLS: "1",
      BUN_PORT: String(port),
      PORT: String(port),
      HOME: home,
      TOPICS_DATA_DIR: dataDir,
      DATA_DIR: path.join(dataDir, "data"),
      TOPICS_HOME: path.join(home, ".topics"),
      TOPICS_EMBEDDED: "1",
      TOPICS_PUBLIC_DIR: path.join(ROOT, "public"),
      TOPICS_BROWSER_SWEEP: "0",
      TOPICS_DISABLE_PTY_BRIDGE: "1",
      TOPICS_PTY_SOCKET: path.join(ROOT, `pty-${slug}.sock`),
      TOPICS_AI_BRIDGE: "0",
      TOPICS_AI_BRIDGE_SOCKET: path.join(ROOT, `ai-${slug}.sock`),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);

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
}

describe("an installed Topics writes only into its own home", () => {
  test("a boot and a session leave nothing outside ~/.topics", async () => {
    fs.mkdirSync(HOME, { recursive: true });

    // The empty-home precondition IS the before-snapshot: anything found later
    // was put there by this run.
    expect(homeEntries(HOME)).toEqual([]);

    await bootSessionAndStop(HOME, "fresh");

    expect(homeEntries(HOME).filter((e) => !ALLOWED_IN_HOME.has(e))).toEqual([]);
    // The one that had a real leak: nothing of ours goes into the Claude dir.
    expect(filesUnder(path.join(HOME, ".claude"))).toEqual([]);
    // And the app really did write: an empty home would pass vacuously.
    expect(filesUnder(path.join(HOME, ".topics")).length).toBeGreaterThan(0);
    // The name the app had before it was Topics is never born here again.
    expect(fs.existsSync(path.join(HOME, ".openclaw"))).toBe(false);
  }, 90_000);

  test("a home that already has ~/.openclaw keeps using it", async () => {
    // The precondition IS the legacy install: a root that exists before the
    // server starts, with something in it, the way a real one would be.
    fs.mkdirSync(path.join(LEGACY_HOME, ".openclaw", "media"), { recursive: true });
    fs.writeFileSync(path.join(LEGACY_HOME, ".openclaw", "media", "kept.txt"), "already here\n");

    await bootSessionAndStop(LEGACY_HOME, "legacy");

    // Still the app data root: the workspace of a dispatch is created under the
    // legacy name, not under a second one that appeared overnight.
    expect(fs.existsSync(path.join(LEGACY_HOME, ".openclaw"))).toBe(true);
    expect(fs.existsSync(path.join(LEGACY_HOME, ".openclaw", "media", "kept.txt"))).toBe(true);
    // And nothing NEW outside the two roots this home legitimately owns.
    const allowedHere = new Set([...ALLOWED_IN_HOME, ".openclaw"]);
    expect(homeEntries(LEGACY_HOME).filter((e) => !allowedHere.has(e))).toEqual([]);
    expect(filesUnder(path.join(LEGACY_HOME, ".claude"))).toEqual([]);
  }, 90_000);
});
