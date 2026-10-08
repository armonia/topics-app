/**
 * A server-shaped process for `bounded-spawn.test.ts`: it launches a long child
 * with `spawnBounded` (or, with `plain`, with `Bun.spawn`), prints the child's pid,
 * and exits cleanly on SIGTERM the way `server.ts` does (`process.exit(0)`).
 * The test sends the SIGTERM to this process's whole GROUP, as the host does.
 */
import { spawnBounded } from "./bounded-spawn";

const plain = process.argv[2] === "plain";
const child = plain
  ? Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" })
  : spawnBounded(["sleep", "60"], { stdout: "ignore", stderr: "ignore", timeoutMs: 120_000 });
// The handler goes in before the pid is printed: the test sends the SIGTERM as
// soon as it reads the pid, and one that lands before the handler kills this
// process with the default action, which runs no exit hook (red in CI once).
process.on("SIGTERM", () => process.exit(0));
console.log(`CHILD ${child.pid}`);
setInterval(() => {}, 1000);
