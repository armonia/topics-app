/**
 * The command line that starts the detached ai-bridge daemon, in both worlds.
 *
 * The bug this pins down was not a crash. In the shipped bundle the old argv
 * was `topics-server /$bunfs/ai-bridge.mjs --socket …`, and a Bun single-file
 * executable ignores argv[1] and runs its own embedded entry: the spawn
 * SUCCEEDED and started a second detached Topics server, once per failed
 * connect, up to the spawn cap. Measured on 2026-09-08 against the binary that
 * was shipping: `--ai-bridge-daemon` made it print the server's startup lines
 * and write daemon state, and no socket was ever created. The rebuilt binary
 * answers `[AI Bridge] Listening on …`.
 *
 * @covers RUNTIME-18
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  AI_BRIDGE_DAEMON_FLAG,
  AI_BRIDGE_SCRIPT_REL,
  aiBridgeDaemonLaunch,
} from "./ai-bridge-daemon-argv";

describe("how the ai-bridge daemon is launched", () => {
  test("in a checkout: the runtime running us, plus the script next door", () => {
    const launch = aiBridgeDaemonLaunch({
      moduleDir: "/repo/server/lib",
      execPath: "/opt/homebrew/bin/bun",
      exists: (p) => p === "/repo/server/ai-bridge.mjs",
    });
    expect(launch).toEqual({ cmd: "/opt/homebrew/bin/bun", args: ["/repo/server/ai-bridge.mjs"] });
  });

  test("in the installed app: our own binary, asked to be the daemon", () => {
    const launch = aiBridgeDaemonLaunch({
      // What a compiled binary really reports, measured.
      moduleDir: "/$bunfs/root",
      execPath: "/Applications/Topics.app/Contents/MacOS/topics-server",
      exists: () => false,
    });
    expect(launch.cmd).toBe("/Applications/Topics.app/Contents/MacOS/topics-server");
    expect(launch.args).toEqual([AI_BRIDGE_DAEMON_FLAG]);
  });

  test("never a runtime looked up on PATH, in either world", () => {
    for (const exists of [() => true, () => false]) {
      const { cmd, args } = aiBridgeDaemonLaunch({
        moduleDir: "/x/server/lib",
        execPath: "/x/bin/topics-server",
        exists,
      });
      expect(cmd).toBe("/x/bin/topics-server");
      for (const bare of ["node", "bun", "npx", "bunx"]) {
        expect(cmd).not.toBe(bare);
        expect(args).not.toContain(bare);
      }
    }
  });

  test("the script path is resolved against the asking module, not the cwd", () => {
    const seen: string[] = [];
    aiBridgeDaemonLaunch({
      moduleDir: "/a/b/lib",
      execPath: "/bun",
      exists: (p) => { seen.push(p); return false; },
    });
    expect(seen).toEqual([join("/a/b/lib", AI_BRIDGE_SCRIPT_REL)]);
  });
});
