/**
 * The shell a `run_command` runs in, per platform, and the wrapper that leaves
 * its exit code in a file. The sidecar server ships for macOS, Linux and
 * Windows; only macOS has `/bin/zsh` by default (the CI's Ubuntu runner does
 * not), and Windows has no POSIX shell at all.
 *
 * @covers CARDPROCESS-01, CMDRUN-01, CMDRUN-03
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commandArgv, commandGroupArgv } from "./command-process";

const DIR = mkdtempSync(join(tmpdir(), "topics-command-argv-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

let n = 0;
/** Runs the argv for real; returns the exit code the wrapper wrote, and the process's. */
function runArgv(build: (exitPath: string, stopPath: string) => string[] | null): { written: string; code: number; out: string } {
  const exitPath = join(DIR, `${++n}.exit`);
  const argv = build(exitPath, join(DIR, `${n}.stop`));
  if (!argv) throw new Error("no argv");
  const res = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { written: readFileSync(exitPath, "utf8").trim(), code: res.exitCode, out: res.stdout.toString() };
}

describe("the shell a command runs in", () => {
  test("zsh on macOS, the shell the agent's own Bash tool uses there", () => {
    expect(commandArgv("true", "/x.exit", "/x.stop", "darwin")?.[0]).toBe("/bin/zsh");
  });

  test("sh on Linux, where zsh is not installed by default", () => {
    expect(commandArgv("true", "/x.exit", "/x.stop", "linux")?.[0]).toBe("/bin/sh");
  });

  test("none on Windows: there is no POSIX shell to wrap the command in", () => {
    expect(commandArgv("true", "/x.exit", "/x.stop", "win32")).toBeNull();
  });

  test("selects process groups with the native ps option", () => {
    expect(commandArgv("true", "/x.exit", "/x.stop", "linux")?.[2]).toContain('ps -o pid=,pgid= "-$$"');
    expect(commandArgv("true", "/x.exit", "/x.stop", "darwin")?.[2]).toContain('ps -o pid=,pgid= -g "$$"');
    expect(commandArgv("true", "/x.exit", "/x.stop", "linux")?.[2]).toContain('"$_topics_pgid" = "$$"');
    expect(commandArgv("true", "/x.exit", "/x.stop", "darwin")?.[2]).toContain('"$_topics_pgid" = "$$"');
  });
});

describe("the wrapper leaves the exit code beside the log", () => {
  test("an early exit in the command still writes its code", () => {
    const r = runArgv((exitPath, stopPath) => commandArgv("echo tick 1; exit 3; echo never", exitPath, stopPath));
    expect(r).toMatchObject({ written: "3", code: 3 });
    expect(r.out).toBe("tick 1\n");
  });

  test("the shell of this platform: exit 0 is written as 0", () => {
    const r = runArgv((exitPath, stopPath) => commandArgv("echo ok", exitPath, stopPath));
    expect(r).toMatchObject({ written: "0", code: 0, out: "ok\n" });
  });
});

// Il registro scrive il file di stop prima del SIGTERM al gruppo: un TERM
// arrivato fra il trap del leader e l'exec del comando si perdeva, e il comando
// partiva lo stesso fino al SIGKILL dopo la grazia.
describe("a stop requested while the command is starting", () => {
  test("the command never runs, and the wrapper writes the TERM status", () => {
    const ran = join(DIR, "ran-command");
    const r = runArgv((exitPath, stopPath) => {
      writeFileSync(stopPath, "");
      return commandArgv(`touch ${ran}`, exitPath, stopPath);
    });
    expect(r).toMatchObject({ written: "143", code: 143 });
    expect(existsSync(ran)).toBe(false);
  });

  test("the group wrapper of a script never starts it either", () => {
    const ran = join(DIR, "ran-script");
    const stopPath = join(DIR, "script.stop");
    writeFileSync(stopPath, "");
    const res = Bun.spawnSync(commandGroupArgv(["/bin/sh", "-c", `touch ${ran}`], stopPath), { stdout: "pipe", stderr: "pipe" });
    expect(res.exitCode).toBe(143);
    expect(existsSync(ran)).toBe(false);
  });

  test("without a stop the arguments reach the command unchanged", () => {
    const stopPath = join(DIR, "absent.stop");
    const res = Bun.spawnSync(commandGroupArgv(["/bin/sh", "-c", 'printf "%s|" "$@"', "_", "a b", "", "$HOME"], stopPath), { stdout: "pipe" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString()).toBe("a b||$HOME|");
  });
});
