/**
 * A browser launch must never take the server's SIGTERM handler with it.
 *
 * Measured on the production log, 16/09 to 24/09: 11 of the 92 server exits
 * were code 143 (killed by the signal's default action, no "[Shutdown]" line,
 * a stale lock recovered at the next boot, orphaned tools finalized), and all
 * 11 came after a Chromium launch in that lifetime; 10 of them after the idle
 * reaper had closed it again, the 11th most likely after Chromium died on its
 * own (the reaper, which logs every close, was silent). The 4 graceful exits
 * with a Chromium still alive fit too: while it runs, Playwright's listener is
 * installed and the signal still has a native handler. The cause is two
 * libraries meeting:
 *
 *  - Playwright's `launch()` defaults `handleSIGTERM` (and SIGINT, SIGHUP) to
 *    true: it adds a process listener at launch and removes it with `off()`
 *    when the browser process exits, however it exits;
 *  - in Bun (1.3.8 here) removing a listener of a signal uninstalls the native
 *    handler for THAT signal, even with the server's own listener still
 *    registered (`process.listenerCount("SIGTERM")` still says 1). Removing a
 *    listener of another signal does not touch it.
 *
 * After that, the restart that `restart-when-idle` requested arrives as a bare
 * SIGTERM: `gracefulShutdown` never runs, live turns are cut without their
 * notice, and the start-prod watcher logs the exit as a hang.
 *
 * The server does its own shutdown (`browserService.close()` in
 * `gracefulShutdown`), so Playwright's handlers add nothing we need.
 *
 * @covers RGATE-07
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const FIXTURE = join(import.meta.dir, "..", "tests", "fixtures", "sigterm-after-browser-reap.ts");

describe("browser launch and the server's SIGTERM handler", () => {
  test("after the browser process is gone, SIGTERM still runs the server's handler", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "topics-sigterm-"));
    try {
      const proc = Bun.spawn([process.execPath, FIXTURE], {
        // APP_DATA_DIR moves the cookie and download folders the service
        // creates; without it they land in the real app data dir.
        env: { ...process.env, APP_DATA_DIR: dataDir, DATA_DIR: dataDir, TOPICS_DATA_DIR: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      const out = await new Response(proc.stdout).text();
      // 143 is the regression: the default action killed the process and the
      // handler never ran.
      expect({ code, handlerRan: out.includes("handler ran") }).toEqual({ code: 0, handlerRan: true });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
