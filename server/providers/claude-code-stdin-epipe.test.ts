/**
 * @covers CCLI-11
 *
 * A CLI that exits BEFORE reading the prompt must not take the server down with
 * it.
 *
 * The defect, seen in CI (run 33030011608): `complete()` does `write(prompt)` +
 * `end()` on the child's stdin. If the child has already exited the pipe is
 * closed and EPIPE arrives, but NOT inside the write: it arrives asynchronously
 * while the stream closes (`finishMaybe` then `destroy` then `end`). No
 * try/catch around the write can see it, and with no listener on `stdin` Bun
 * treats it as an unhandled exception and KILLS THE PROCESS. In that run the
 * test server died and left ~200 checks at 0ms.
 *
 * The test reproduces the only condition that matters (a pipe closed under the
 * write) in a child process, because that is the only way to tell "handled"
 * from "the process died": inside the runner an unhandled exception would be
 * blamed on the test instead of on the server.
 *
 * Counter-proof RUN: removing `proc.stdin.on("error")` from `complete()` makes
 * this child print "EPIPE" and exit 1; with the cure it exits 0 and clean. Note
 * that "VIVO" is printed in BOTH cases, since the async exception arrives after
 * it, so that line alone proves nothing: what separates the two worlds is the
 * EXIT CODE, and that is what this test insists on.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("claude-code complete(): CLI che esce prima di leggere", () => {
  test("EPIPE sullo stdin non uccide il processo", () => {
    const dir = mkdtempSync(join(tmpdir(), "epipe-"));

    // A CLI that exits AT ONCE without touching stdin: the real case of a
    // binary that crashes on start, or of a wrong path.
    const fakeCli = join(dir, "cli-che-esce-subito.sh");
    writeFileSync(fakeCli, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeCli, 0o755);

    // The prompt has to exceed the pipe capacity (64 KiB on Linux): below that
    // threshold the kernel absorbs the write into the buffer and the EPIPE never
    // shows up at all. With 1 MiB the write really reaches the closed pipe.
    const driver = join(dir, "driver.ts");
    writeFileSync(driver, `
      import { ClaudeCodeProvider } from ${JSON.stringify(join(import.meta.dir, "claude-code.ts"))};
      const provider = new ClaudeCodeProvider({});
      await provider.complete([{ role: "user", content: "x".repeat(1024 * 1024) }]);
      // Reaching this line means the EPIPE was handled and the process lives.
      console.log("VIVO");
    `);

    const run = spawnSync(process.execPath, [driver], {
      env: { ...process.env, TOPICS_CLAUDE_CLI_PATH: fakeCli },
      encoding: "utf8",
      timeout: 30_000,
    });

    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    expect(output).not.toContain("EPIPE");
    expect(run.stdout ?? "").toContain("VIVO");
    expect(run.status).toBe(0);
  }, 40_000);
});
