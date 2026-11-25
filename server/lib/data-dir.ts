import { homedir } from "os";
import { accessSync, constants, mkdirSync } from "fs";
import { join, resolve } from "path";
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
  const target = stateDirTarget(fallback, env);
  // The gate sits here and not in the callers: every module that writes state
  // (browser-state, push, ai-bridge, file backups, processes…) goes through
  // this door, so nobody can forget it.
  assertNotLiveStateUnderTest(target, LIVE_REPO_ROOT, env);
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
 * The folder `resolveStateDir` tries first, off the environment alone: no
 * mkdir, no probe. What a caller that remembers the resolved folder keys it
 * on, so a change of either variable resolves it again and nothing else does.
 */
export function stateDirTarget(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.TOPICS_DATA_DIR || env.DATA_DIR || fallback;
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
 * The folder of the server's private keys (the relay signing identity, the
 * installation id). `TOPICS_SECRETS_DIR` wins; otherwise `<stateDir>/.topics-secrets`.
 *
 * WHY a variable and not just the default. Under the production LaunchAgent the
 * state root IS the checkout (see `resolveStateDir`), so a key kept under it is
 * served by `/preview` as a project file and deleted by `git clean -fdx`. Pinning
 * this one variable moves the keys to `~/.topics/.topics-secrets` without moving
 * the database and every other file around them. The last path segment keeps the
 * name `isTopicsSecretPath` already refuses, wherever the folder ends up.
 *
 * THE PIN BELONGS TO THE LIVE SERVER ALONE. A child of that server inherits its
 * environment, and a child with state of its own (a test server, any process with
 * `DATA_DIR` or `TOPICS_DATA_DIR` set, a test run) must keep its keys inside that
 * state: otherwise it would adopt or write them over the live ones, and the live
 * server would later find its destination taken by a test key. Measured with a
 * test server started under the production environment.
 *
 * No mkdir here: whoever writes creates it 0700. This file is the only place that
 * reads the variable, like the other two (`tests/unit/state-dir-single-door.test.ts`).
 */
export function resolveSecretsDir(stateDir: string, env: NodeJS.ProcessEnv = process.env, main?: string): string {
  const ownState = Boolean(env.TOPICS_DATA_DIR || env.DATA_DIR) || isTestProcess(env, main);
  return (!ownState && env.TOPICS_SECRETS_DIR) || join(stateDir, ".topics-secrets");
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
}

/**
 * The APP DATA ROOT: the folder holding `media/`, `workspace/`, `mcp-oauth.json`,
 * `orchestrator-cwd/` and `agents/<id>/`, the homes of the always-on agents:
 * the things the app writes FOR the user, as opposed to the internal state
 * resolved by `resolveStateDir` above.
 *
 * Two branches, the whole rule:
 *   1. `APP_DATA_DIR`, an explicit instruction, used by the test servers and by
 *      anyone pinning the root by hand.
 *   2. `topicsHome()`, `${TOPICS_HOME:-~/.topics}`: the home the daemon state,
 *      the logs and the worktrees already live in. One home for the app.
 *
 * WHY there is no third branch (change `agents-in-topics-home`): a root under
 * the product's older name used to win whenever that folder existed, so a
 * machine that had one kept a second home for the app, shared with the
 * agents, and the agents could not move without the app moving with them. The
 * data and the agents' homes moved into the Topics home, and the paths saved
 * in the DB followed with `scripts/rewrite-root-paths.ts`; a machine that still
 * has an old root migrates the same way.
 *
 * Pure on its inputs and side-effect free: resolving creates no directory, so
 * calling it twice answers the same thing and probes nothing into existence.
 */
export function resolveAppDataDir(inputs: AppDataDirInputs = {}): string {
  const env = inputs.env ?? process.env;
  return env.APP_DATA_DIR || topicsHome(env, inputs.home ?? env.HOME ?? homedir());
}

/**
 * The roots a saved path may belong to: the live one and the Topics home,
 * which differ when `APP_DATA_DIR` pins the root elsewhere. Read by the file
 * and preview allowlists.
 */
export function appDataRoots(inputs: AppDataDirInputs = {}): string[] {
  const env = inputs.env ?? process.env;
  const home = inputs.home ?? env.HOME ?? homedir();
  return [...new Set([resolveAppDataDir(inputs), topicsHome(env, home)])];
}

/** The repo this server runs from: in dev and under the prod LaunchAgent, the live state root. */
export const LIVE_REPO_ROOT = resolve(import.meta.dir, "..", "..");

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Is this process `bun test`? NODE_ENV alone is not enough: bun sets it to
 * "test" only when it is unset, so a shell with NODE_ENV=development ran the
 * whole suite unguarded. Under `bun test` the entry point (`Bun.main`) is the
 * test file itself, and that holds whatever the environment says.
 */
export function isTestProcess(
  env: NodeJS.ProcessEnv = process.env,
  main: string = typeof Bun !== "undefined" ? Bun.main : "",
): boolean {
  return env.NODE_ENV === "test" || TEST_FILE.test(main);
}

/**
 * A test process never opens the live state.
 *
 * Under test, a state dir equal to the repo the server runs from, or inside it,
 * is the LIVE layout (dev and the prod LaunchAgent write there): DB,
 * topics.json, memory/, browser-state, vapid keys. Twice something got through
 * before this gate existed: three test-bench project topics on 16/08 and a global
 * memory holding a test string from 25/08 to 02/10. It runs inside
 * `resolveStateDir`, the one door every subsystem resolves its state through,
 * so a test that forgets to isolate fails loudly instead of passing by writing
 * to the user's data.
 */
export function assertNotLiveStateUnderTest(
  stateDir: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  main?: string,
): void {
  if (!isTestProcess(env, main)) return;
  const dir = resolve(stateDir);
  const repo = resolve(repoRoot);
  if (dir !== repo && !dir.startsWith(repo + "/")) return;
  throw new Error(
    `test process opened the live state dir (${stateDir}): set DATA_DIR to a ` +
      `testTmpDir() before creating the context`,
  );
}
