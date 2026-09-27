/**
 * The shell a `run_command` runs in, per platform, and the wrapper that leaves
 * its exit code in a file. The sidecar server ships for macOS, Linux and
 * Windows; only macOS has `/bin/zsh` by default (the CI's Ubuntu runner does
 * not), and Windows has no POSIX shell at all.
 *
 * @covers CMDRUN-01, CMDRUN-03
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commandArgv } from "./command-process";

const DIR = mkdtempSync(join(tmpdir(), "topics-command-argv-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let n = 0;
/** Runs the argv for real; returns the exit code the wrapper wrote, and the process's. */
function runArgv(build: (exitPath: string) => string[] | null): { written: string; code: number; out: string } {
  const exitPath = join(DIR, `${++n}.exit`);
  const argv = build(exitPath);
  if (!argv) throw new Error("no argv");
  const res = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { written: readFileSync(exitPath, "utf8").trim(), code: res.exitCode, out: res.stdout.toString() };
}

describe("the shell a command runs in", () => {
  test("zsh on macOS, the shell the agent's own Bash tool uses there", () => {
    expect(commandArgv("true", "/x.exit", "darwin")?.[0]).toBe("/bin/zsh");
  });

  test("sh on Linux, where zsh is not installed by default", () => {
    expect(commandArgv("true", "/x.exit", "linux")?.[0]).toBe("/bin/sh");
  });

  test("none on Windows: there is no POSIX shell to wrap the command in", () => {
    expect(commandArgv("true", "/x.exit", "win32")).toBeNull();
  });
});

describe("the wrapper leaves the exit code beside the log", () => {
  // The Linux wrapper is plain POSIX sh, so it runs on this machine too.
  test("sh: an early exit in the command still writes its code", () => {
    const r = runArgv((exitPath) => commandArgv("echo tick 1; exit 3; echo never", exitPath, "linux"));
    expect(r).toMatchObject({ written: "3", code: 3 });
    expect(r.out).toBe("tick 1\n");
  });

  test("the shell of this platform: exit 0 is written as 0", () => {
    const r = runArgv((exitPath) => commandArgv("echo ok", exitPath));
    expect(r).toMatchObject({ written: "0", code: 0, out: "ok\n" });
  });
});
