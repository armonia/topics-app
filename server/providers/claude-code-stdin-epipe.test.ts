/**
 * @covers CCLI-12
 *
 * A CLI that exits BEFORE reading the prompt must not take the server with it.
 *
 * The defect, seen in CI (run 33030011608): `complete()` does `write(prompt)`
 * then `end()` on the child's stdin. If the child already exited, the pipe is
 * closed and EPIPE is raised — but NOT inside the write: it surfaces
 * asynchronously while the stream tears down (`finishMaybe` → `destroy` →
 * `end`). No try/catch around the write can see it, and with no listener on
 * `stdin` Bun treats it as an unhandled exception and KILLS THE PROCESS. In
 * that run the test server died and left ~200 tests failing at 0ms.
 *
 * The check runs in a child process on purpose: inside the test runner an
 * unhandled exception would be blamed on the test rather than proving the
 * server process died, which is the only thing worth asserting here.
 *
 * Counter-proof, actually run: removing `proc.stdin.on("error")` from
 * `complete()` makes this child print "EPIPE" and exit 1; with the fix it
 * exits 0 and clean. Note "ALIVE" is printed in BOTH cases — the async
 * exception lands afterwards — so the line alone proves nothing. What
 * separates the two worlds is the EXIT CODE, and that is what this asserts.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("claude-code complete(): CLI exiting before it reads stdin", () => {
  test("EPIPE on stdin does not kill the process", () => {
    const dir = mkdtempSync(join(tmpdir(), "epipe-"));

    // A CLI that exits immediately without touching stdin: the real-world case
    // of a binary that crashes on startup or a wrong path.
    const fakeCli = join(dir, "cli-that-exits-now.sh");
    writeFileSync(fakeCli, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeCli, 0o755);

    // The prompt must exceed the pipe capacity (64 KiB on Linux): below that
    // the kernel buffers the write and no EPIPE ever occurs. At 1 MiB the
    // write really reaches the closed pipe.
    const driver = join(dir, "driver.ts");
    writeFileSync(driver, `
      import { ClaudeCodeProvider } from ${JSON.stringify(join(import.meta.dir, "claude-code.ts"))};
      const provider = new ClaudeCodeProvider({});
      await provider.complete([{ role: "user", content: "x".repeat(1024 * 1024) }]);
      console.log("ALIVE");
    `);

    const run = spawnSync(process.execPath, [driver], {
      env: { ...process.env, TOPICS_CLAUDE_CLI_PATH: fakeCli },
      encoding: "utf8",
      timeout: 30_000,
    });

    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    expect(output).not.toContain("EPIPE");
    expect(run.stdout ?? "").toContain("ALIVE");
    expect(run.status).toBe(0);
  }, 40_000);
});
