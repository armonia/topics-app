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
console.log(`CHILD ${child.pid}`);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
