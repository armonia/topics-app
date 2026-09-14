/**
 * A LOSING BOOT TOUCHES NOTHING.
 *
 * The singleton lock used to be taken just above `Bun.serve`, at the very end
 * of init. Everything that makes a boot expensive ran first: the database was
 * opened, migrations and the ui_state repairs applied, the PTY and AI bridges
 * joined, live sessions reattached, idle ones parked, partial rows swept. Only
 * then did the second process find the lock and exit. That is not a singleton,
 * it is a race with a polite ending, and on 2026-09-13 at 03:38 a stray
 * `bun run server.ts` in the production working directory ran the whole thing
 * against the live home nine seconds before the real server took a SIGTERM.
 *
 * So the test is not "does it exit non-zero": it is "what did it touch before
 * exiting". A live lock is planted in a throwaway home, the server is started
 * with an empty data directory, and afterwards the data directory must still
 * be empty and the log must carry none of the markers that init prints.
 *
 * @covers RUNTIME-14
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT, freePort, testTmpDir } from "./helpers";

const ROOT = testTmpDir("lock-before-effects");
const HOME = path.join(ROOT, "home");
const TOPICS_HOME = path.join(HOME, ".topics");
const DATA_ROOT = path.join(HOME, ".topics", "app-data");
const DATA_DIR = path.join(DATA_ROOT, "data");

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
 * Markers every phase of init prints. None of them may appear in a boot that
 * lost the lock: each one is the receipt of an effect on shared state.
 */
const INIT_MARKERS = ["[DB]", "[Startup]", "[chat-reattach]", "[Migration"];

describe("the singleton lock is taken before anything else happens", () => {
  test("a second boot exits non-zero without opening the database", async () => {
    fs.mkdirSync(TOPICS_HOME, { recursive: true });
    // A LIVE lock: this test process is running, so its pid is alive, and the
    // timestamp is now, so it cannot be mistaken for a lock predating boot.
    fs.writeFileSync(
      path.join(TOPICS_HOME, "daemon-process.lock"),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    );

    const port = freePort();
    const child = Bun.spawn(["bun", "run", "server.ts"], {
      cwd: PROJECT_ROOT,
      // HOME points at the throwaway tree, which also keeps the worktree
      // isolation out of the way: this checkout is not under that HOME.
      env: {
        PATH: process.env.PATH ?? "",
        NO_TLS: "1",
        BUN_PORT: String(port),
        PORT: String(port),
        HOME: HOME,
        TOPICS_DATA_DIR: DATA_ROOT,
        DATA_DIR: DATA_DIR,
        TOPICS_HOME: TOPICS_HOME,
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
    children.push(child);

    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
    ]);

    expect(err).toContain("already running");
    expect(code).not.toBe(0);

    // The point of the card: no database file, so no migration, no repair,
    // no sweep could have run. Empty directories are tolerated and named as
    // such: `server/routes/processes.ts` mkdirs its persist dir at MODULE
    // IMPORT, which is before any statement of server.ts runs and cannot be
    // ordered by moving the lock. A directory is not shared state; a file is.
    expect(fs.existsSync(path.join(DATA_DIR, "topics.db"))).toBe(false);
    expect(filesUnder(DATA_ROOT)).toEqual([]);

    const log = `${out}\n${err}`;
    expect(INIT_MARKERS.filter((m) => log.includes(m))).toEqual([]);

    // And the incumbent's lock is left exactly as it was found.
    const lock = JSON.parse(fs.readFileSync(path.join(TOPICS_HOME, "daemon-process.lock"), "utf-8"));
    expect(lock.pid).toBe(process.pid);
  }, 60_000);
});
