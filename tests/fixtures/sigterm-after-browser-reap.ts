/**
 * A server-shaped process that owns a SIGTERM handler, launches the browser
 * service's Chromium, lets it go, and then asks to be terminated.
 *
 * It is a fixture and not a test: nothing under `tests/fixtures` is in the
 * suite's path list. It is launched by path from
 * `server/browser-service-sigterm.test.ts`, which reads its exit code.
 *
 * WHY A SEPARATE PROCESS. What is being measured is whether a SIGTERM still
 * reaches the handler the server installed at boot, and a signal delivered to
 * the test runner itself would end the run. The fixture does, in miniature,
 * what production did between 16/09 and 24/09: boot with a handler, launch
 * Chromium on demand, close it again (the idle reaper), then take the SIGTERM
 * that asks for a restart.
 *
 * The browser is a stand-in: `/bin/sleep` handed over as `chromiumPath`.
 * Playwright spawns it, installs its own process handlers, and the launch then
 * fails because nothing answers on the pipe. That failure is the same event,
 * for the handlers, as the idle reaper closing a real Chromium: the child
 * exits and Playwright removes what it installed. No real browser runs.
 *
 * Exit codes: 0 when the handler ran (it exits 0 itself); 143 when the
 * signal killed the process with the default action; 3 when the handler never
 * ran and the process outlived the deadline.
 *
 * Env: DATA_DIR  where the service may create its folders (the test passes a
 *                temp dir, so the real app data dir is never touched).
 */
import { createBrowserService } from "../../server/browser-service";

process.on("SIGTERM", () => {
  console.log("handler ran");
  setTimeout(() => process.exit(0), 20);
});

const service = await createBrowserService({
  chromiumPath: "/bin/sleep",
  // The reaper has nothing to do here and must not keep the loop busy.
  cleanupIntervalMs: 60_000,
});
try {
  await service.createContext("sigterm-fixture");
  console.log("launch unexpectedly succeeded");
} catch {
  // Expected: `/bin/sleep` is not a browser.
}
// Give the child's `close` event, where Playwright drops its handlers, time
// to land before the signal is sent.
await new Promise((r) => setTimeout(r, 300));
process.kill(process.pid, "SIGTERM");
setTimeout(() => process.exit(3), 5_000);
