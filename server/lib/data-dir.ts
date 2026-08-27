import { homedir } from "os";
import { accessSync, constants, mkdirSync } from "fs";
import { join } from "path";

/**
 * Resolve the WRITABLE root for all mutable server state (SQLite DB, messages,
 * uploads, context-files, journal, usage, memory, spaces, checkpoints, backups,
 * browser-state, vapid keys, process/activity persistence).
 *
 * WHY this exists — the "Launching the local engine" hang on a fresh machine:
 *   In dev and under the prod LaunchAgent the server runs from the writable repo
 *   dir, so `import.meta.dir` / `process.cwd()` ARE writable and every subsystem
 *   historically wrote next to the source. That is the `fallback` branch below,
 *   and it stays byte-identical when no env is set.
 *   But a DOWNLOADED packaged .app runs its bundled server from
 *   <App>.app/Contents/Resources/server, which on a quarantined / Gatekeeper-
 *   translocated / DMG-mounted copy is READ-ONLY. Every mkdir/write there throws
 *   EROFS and the server dies BEFORE it can listen → serverAlreadyUp() never
 *   turns true → the app spins forever on "Launching the local engine".
 *
 * The desktop launcher therefore sets TOPICS_DATA_DIR to a guaranteed-writable
 * per-user dir and every mutable path resolves here.
 *
 * THIS FILE IS THE ONLY PLACE THAT READS THE TWO VARIABLES, and that is a rule
 * with a receipt. State used to be found by two unrelated roads: DATA_DIR, read
 * by db.ts and a handful of others, and TOPICS_DATA_DIR, read here. A test
 * server that set only the first got an isolated SQLite and wrote everything
 * else (topics.json, uploads/, messages/, data/usage/) into the LIVE folder:
 * four e2e shards on one usage dir, an ENOENT on a temp rename, a server dead
 * at boot and 253 tests never run (25/08/2026). The cure of that day was a line
 * in start-test-server.sh copying one variable into the other, which held the
 * two names together by hand and left the next subsystem free to pick the wrong
 * one. `tests/unit/state-dir-single-door.test.ts` is what replaces that line: it
 * fails if any other server file reads either variable.
 *
 * Resolution order:
 *   1. process.env.TOPICS_DATA_DIR — set by the packaged desktop launcher.
 *   2. process.env.DATA_DIR — the older name, set by every test/bench server.
 *      It wins over the fallback: whoever isolates the DB means to isolate the
 *      state around it too, and the alternative (state in the repo, DB in /tmp)
 *      is the defect above. The desktop launcher sets BOTH, with DATA_DIR at
 *      <TOPICS_DATA_DIR>/data, so the declared precedence keeps it identical.
 *   3. `fallback` (the historical location: the repo dir in dev / LaunchAgent),
 *      IF it is actually writable.
 *   4. ~/.topics/app-data — self-heal so even a standalone bundled server run
 *      WITHOUT the launcher env on a read-only bundle still boots.
 */
export function resolveStateDir(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const target = env.TOPICS_DATA_DIR || env.DATA_DIR || fallback;
  try {
    mkdirSync(target, { recursive: true });
    accessSync(target, constants.W_OK);
    return target;
  } catch {
    const home = join(homedir(), ".topics", "app-data");
    try {
      mkdirSync(home, { recursive: true });
    } catch {
      /* last resort — return the path anyway; the caller's own write will surface a clear error */
    }
    return home;
  }
}

/**
 * The data folder INSIDE the state root: SQLite (`topics.db`), `browser-state/`,
 * `usage/`. Historically its own variable, DATA_DIR, which the launcher points
 * at <state>/data and a test server points at its whole isolated folder — both
 * shapes keep working, because an explicit DATA_DIR still wins here.
 */
export function resolveDataDir(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.DATA_DIR || join(stateDir, "data");
}

/**
 * The data folder AS DECLARED BY THE ENVIRONMENT, or undefined when nothing
 * declares one. Not a path to write to: it is the identity of a data instance,
 * used to derive per-instance socket paths (PTY bridge, ai-bridge, WebRTC
 * sidecar) so a test server can never attach to production's. Production
 * declares neither variable, so the basis stays cwd alone and the socket names
 * are byte-identical to before.
 */
export function envDataDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DATA_DIR || env.TOPICS_DATA_DIR || undefined;
}
