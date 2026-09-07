/**
 * THE ENTRY POINT THE SHIPPED SERVER BINARY IS COMPILED FROM.
 *
 * `scripts/build-server-sidecar.sh` compiles THIS file, not `server.ts`, for one
 * reason: the installed app must be able to start its detached ai-bridge daemon
 * without a second runtime on the machine. In a checkout the daemon is a script
 * next to the server and Bun runs it; in the bundle there is no script and no
 * Bun, only this binary, so the binary has to be able to be the daemon too.
 * Given `--ai-bridge-daemon` it is. See `server/lib/ai-bridge-daemon-argv.ts`
 * for the measurement that made this necessary.
 *
 * Both branches are DYNAMIC imports on purpose: a static import of `server.ts`
 * would evaluate the whole server module graph (database, routes, watchers)
 * before we even look at argv, which is exactly what a 40 MB daemon must not do.
 *
 * Nothing imports this file: it is declared as an entry in `knip.jsonc`.
 */
import { AI_BRIDGE_DAEMON_FLAG } from "./lib/ai-bridge-daemon-argv";

if (process.argv.includes(AI_BRIDGE_DAEMON_FLAG)) {
  // runtime-dep-ok: a STATIC specifier, so the compiler embeds the daemon in
  // this same binary. Nothing is read from disk and no runtime is looked up.
  // The daemon reads its own flags (`--socket`, `--store-dir`, `--parent-pid`)
  // straight off process.argv and starts listening on import.
  await import("./ai-bridge.mjs");
} else {
  await import("../server.ts");
}
