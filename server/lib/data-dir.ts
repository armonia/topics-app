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
 * The Electron launcher therefore sets TOPICS_DATA_DIR to a guaranteed-writable
 * per-user dir (app.getPath('userData')) and every mutable path resolves here.
 *
 * Resolution order:
 *   1. process.env.TOPICS_DATA_DIR — set by the packaged Electron launcher.
 *   2. `fallback` (the historical location: the repo dir in dev / LaunchAgent),
 *      IF it is actually writable.
 *   3. ~/.topics/app-data — self-heal so even a standalone bundled server run
 *      WITHOUT the Electron env on a read-only bundle still boots.
 */
export function resolveStateDir(fallback: string): string {
  const target = process.env.TOPICS_DATA_DIR || fallback;
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
