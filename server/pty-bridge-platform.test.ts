/**
 * The PTY bridge's platform choices, checked for BOTH platforms from either one.
 *
 * The Windows branches were wrong for months and no test could have said so: the
 * daemon runs on the machine that runs it, and the only Windows evidence was a
 * line in a log file on somebody's PC («Self-test failed: File not found: .»,
 * where the missing name is the empty string and the dot is ours). Passing the
 * platform in as an argument is what turns that into an assertion a Mac can make.
 *
 * @covers TERM-01
 */
import { describe, test, expect } from "bun:test";
import {
  augmentedPath,
  pidPathFor,
  socketIsFile,
  trivialSpawn,
} from "./pty-bridge-platform.mjs";

const WIN_TMP = "C:\\Users\\agent\\AppData\\Local\\Temp";
const PIPE = "\\\\.\\pipe\\topics-pty-bridge-1a2b3c4d";

describe("trivial spawn", () => {
  test("on Windows it is a command that exists there", () => {
    const cmd = trivialSpawn("win32", WIN_TMP);
    expect(cmd.shell).toBe("cmd.exe");
    expect(cmd.args).toEqual(["/c", "exit"]);
    expect(cmd.cwd).toBe(WIN_TMP);
  });

  test("on unix it is /bin/sh, not /bin/true (gone on macOS 26)", () => {
    const cmd = trivialSpawn("darwin", WIN_TMP);
    expect(cmd.shell).toBe("/bin/sh");
    expect(cmd.args).toEqual(["-c", ":"]);
    expect(cmd.cwd).toBe("/tmp");
  });

  test("nothing unix leaks into the Windows branch", () => {
    const cmd = trivialSpawn("win32", WIN_TMP);
    expect(`${cmd.shell} ${cmd.args.join(" ")} ${cmd.cwd}`).not.toContain("/bin");
  });
});

describe("pidfile path", () => {
  test("a named pipe gets its pidfile in TEMP, not on the pipe itself", () => {
    const p = pidPathFor(PIPE, "win32", WIN_TMP);
    expect(p).not.toBe(PIPE);
    expect(p.startsWith(WIN_TMP)).toBe(true);
    // The pipe name stays inside, so two instances never share a pidfile.
    expect(p).toContain("topics-pty-bridge-1a2b3c4d");
    expect(p.endsWith(".pid")).toBe(true);
  });

  test("on unix it sits beside the socket", () => {
    expect(pidPathFor("/tmp/topics-pty-bridge-1a2b3c4d.sock", "darwin")).toBe(
      "/tmp/topics-pty-bridge-1a2b3c4d.pid",
    );
  });
});

describe("socket existence", () => {
  test("a named pipe cannot be answered by existsSync", () => {
    expect(socketIsFile("win32")).toBe(false);
    expect(socketIsFile("darwin")).toBe(true);
  });
});

describe("PATH augmentation", () => {
  test("Windows joins with ; and keeps system entries whole", () => {
    const { key, value } = augmentedPath(
      { Path: "C:\\WINDOWS\\system32;C:\\WINDOWS" },
      "C:\\Users\\agent",
      "win32",
    );
    expect(key).toBe("Path"); // the spelling the parent used, not a second one
    expect(value.split(";")).toContain("C:\\WINDOWS\\system32");
    expect(value).not.toContain(":\\WINDOWS\\system32:");
    expect(value.startsWith("C:\\Users\\agent\\.local\\bin;")).toBe(true);
  });

  test("Windows drops the duplicate spelling instead of leaving two in conflict", () => {
    const { key, drop } = augmentedPath(
      { Path: "C:\\WINDOWS", PATH: "C:\\other" },
      "C:\\Users\\agent",
      "win32",
    );
    expect(key).toBe("Path");
    expect(drop).toEqual(["PATH"]);
  });

  test("Windows de-duplicates case-insensitively", () => {
    const { value } = augmentedPath(
      { Path: "c:\\users\\agent\\.bun\\bin;C:\\WINDOWS" },
      "C:\\Users\\agent",
      "win32",
    );
    const entries = value.split(";").map((e) => e.toLowerCase());
    expect(entries.filter((e) => e === "c:\\users\\agent\\.bun\\bin")).toHaveLength(1);
  });

  test("unix keeps its own separator and directories", () => {
    const { key, value } = augmentedPath({ PATH: "/usr/bin:/bin" }, "/home/agent", "linux");
    expect(key).toBe("PATH");
    expect(value.startsWith("/home/agent/.local/bin:")).toBe(true);
    expect(value.split(":")).toContain("/opt/homebrew/bin");
    // Already present ahead of it, so the inherited copy is not repeated.
    expect(value.split(":").filter((e) => e === "/usr/bin")).toHaveLength(1);
  });

  test("an empty inherited PATH still yields the extra directories", () => {
    expect(augmentedPath({}, "C:\\Users\\agent", "win32").value).toContain(
      "C:\\Users\\agent\\.bun\\bin",
    );
    expect(augmentedPath({}, "/home/agent", "linux").value).toContain("/home/agent/.bun/bin");
  });
});
