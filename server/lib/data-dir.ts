import { homedir } from "os";
import { accessSync, constants, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { topicsHome } from "../services/daemon-state";

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

/** Injectable inputs of `resolveAppDataDir`, so the rule can be tested without a real home. */
export interface AppDataDirInputs {
  env?: NodeJS.ProcessEnv;
  /** The user's home. Defaults to `$HOME`, then the OS answer. */
  home?: string;
  /** Directory probe. Injected in tests; the resolution never creates anything. */
  exists?: (path: string) => boolean;
}

/**
 * The APP DATA ROOT: the folder holding `media/`, `workspace/`,
 * `agents/main/sessions/`, `mcp-oauth.json`, `orchestrator-cwd/` — the things
 * the app writes FOR the user, as opposed to the internal state resolved by
 * `resolveStateDir` above.
 *
 * WHY the rule has three branches (card ef26c310 / 211605ee):
 *   The root used to be `${HOME}/.openclaw`, hardcoded as the last resort in
 *   four copies of the same expression. The desktop shell exports TOPICS_HOME,
 *   TOPICS_DATA_DIR and DATA_DIR but not APP_DATA_DIR, so a freshly installed
 *   Topics created `~/.openclaw/media` and `~/.openclaw/workspace` in the home
 *   of somebody who never ran the product under its previous name: a second
 *   home for the app, under an obsolete name.
 *
 *   Every installation that already has `~/.openclaw` keeps it. Its data, the
 *   paths recorded in the DB and the preview allowlist all point there, and
 *   moving them is a migration with a card of its own, not a side effect of
 *   this one. So the legacy root wins whenever it EXISTS, and only a machine
 *   that never had one gets the new default.
 *
 * Resolution order:
 *   1. `APP_DATA_DIR`, then `OPENCLAW_DIR` — an explicit instruction, used by
 *      the test servers and by anyone pinning the root by hand.
 *   2. `${home}/.openclaw` IF that directory already exists (legacy install).
 *   3. `topicsHome()` — `${TOPICS_HOME:-~/.topics}`, the same home the daemon
 *      state, the logs and the worktrees already live in. Not a fourth
 *      convention: `~/.topics/media` is already the preferred media base of the
 *      file allowlist and where agent screenshots are written.
 *
 * Pure on its inputs and side-effect free: resolving creates no directory, so
 * calling it twice answers the same thing and probes nothing into existence.
 */
export function resolveAppDataDir(inputs: AppDataDirInputs = {}): string {
  const env = inputs.env ?? process.env;
  const home = inputs.home ?? env.HOME ?? homedir();
  const exists = inputs.exists ?? existsSync;
  const explicit = env.APP_DATA_DIR || env.OPENCLAW_DIR;
  if (explicit) return explicit;
  const legacy = join(home, ".openclaw");
  if (exists(legacy)) return legacy;
  return topicsHome(env, home);
}

/**
 * Both roots an already-saved path may belong to, legacy first when it is the
 * live one. Read by the file and preview allowlists: a media path written when
 * the app data root was `~/.openclaw` must stay readable on a machine that
 * resolves to `~/.topics` today, and the other way round.
 */
export function appDataRoots(inputs: AppDataDirInputs = {}): string[] {
  const env = inputs.env ?? process.env;
  const home = inputs.home ?? env.HOME ?? homedir();
  const roots = [resolveAppDataDir(inputs), join(home, ".openclaw"), topicsHome(env, home)];
  return [...new Set(roots)];
}
