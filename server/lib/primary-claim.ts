/**
 * `bun run primary claim`: a node takes the primary over from a computer that
 * died without warning (track T9 of `openspec/changes/nodo-principale-a-mano`).
 *
 * Nothing can be shipped from a dead primary, so the state comes from the last
 * thing it left behind: the replica of its DB (Litestream, a process outside
 * the product), restored by a command the installation configures. The copy is
 * checked like a shipped one (`integrity_check`, counts) and committed through
 * the same staged manifest a planned switch uses, at the epoch above this
 * server's; the restart that follows swaps it in and sets this server's own DB
 * aside as `topics.db.prima-<epoch>`. Whatever the dead primary wrote after its
 * last replicated write is lost: the report says up to when the copy goes.
 *
 * When the old primary comes back, its first call to a node is refused with the
 * newer epoch and it stops writing (`primary-replaced.ts`).
 *
 * Secrets: the replica may be encrypted with age. The identity is read from the
 * secret store by the name the installation configures and handed to the
 * restore command in ITS environment only (Litestream expands `$VARS` in its
 * config), never on a command line, in a log or in a file of ours.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  commitIncoming, DB_NAME, discardIncoming, INCOMING_DIR, type ReceiveChecks, type RowCounts, sha256File,
  type SwitchManifest, verifyDatabaseFile,
} from "./primary-switch";
import type { PrimaryRole } from "./primary-role";

/** Instance settings, read from the environment; every default is empty and leaves the claim off. */
export const RESTORE_COMMAND_ENV = "TOPICS_REPLICA_RESTORE_COMMAND";
export const AGE_SECRET_ENV = "TOPICS_REPLICA_AGE_SECRET";
export const CHANNELS_COMMAND_ENV = "TOPICS_CLAIM_CHANNELS_COMMAND";
/** What the restore command receives in its environment. */
export const RESTORE_OUTPUT_ENV = "TOPICS_RESTORE_OUTPUT";
export const AGE_IDENTITY_ENV = "TOPICS_REPLICA_AGE_IDENTITY";

/** A primary heard from more recently than this is not presumed dead without `--force`. */
export const PRIMARY_ALIVE_WINDOW_MS = 10 * 60_000;
const CLAIM_COMMAND_TIMEOUT_MS = 10 * 60_000;

export interface ClaimSettings { restore?: string; ageSecret?: string; channels?: string }

export function claimSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ClaimSettings {
  return {
    restore: env[RESTORE_COMMAND_ENV]?.trim() || undefined,
    ageSecret: env[AGE_SECRET_ENV]?.trim() || undefined,
    channels: env[CHANNELS_COMMAND_ENV]?.trim() || undefined,
  };
}

/** Runs one configured command line through the shell with extra environment; returns why it failed, or null. */
export type ClaimCommandRunner = (command: string, extraEnv: Record<string, string>) => string | null;

export const runClaimCommand: ClaimCommandRunner = (command, extraEnv) => {
  const shell = process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command];
  try {
    // Output ignored: whatever the command prints is not ours to copy into a log.
    const r = spawnSync(shell[0]!, shell.slice(1), {
      stdio: "ignore", env: { ...process.env, ...extraEnv }, timeout: CLAIM_COMMAND_TIMEOUT_MS, killSignal: "SIGKILL",
      // `cmd /c` reads the rest of its line raw: quoting it again as one argument would break the command.
      windowsVerbatimArguments: process.platform === "win32",
    });
    return r.status === 0 && !r.error ? null : (r.error?.message ?? `exit ${r.status}, signal ${r.signal}`);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

export interface ClaimDeps {
  role: Pick<PrimaryRole, "isPrimary" | "epoch" | "state">;
  localMachineId: string;
  hostname: string;
  stateDir: string;
  /** The folders and replica the boot will write: the same checks a planned switch's receiver runs. */
  receive: ReceiveChecks;
  settings: ClaimSettings;
  readSecret: (name: string) => Promise<string | null>;
  /** When the primary's device last called this server, in ms since the epoch; null when unknown. */
  lastHeardFromPrimary: () => number | null;
  force: boolean;
  restart: () => void;
  run?: ClaimCommandRunner;
  now?: () => number;
  log?: (line: string) => void;
}

export type ClaimReport =
  | {
    ok: true; outcome: "claimed"; epoch: number; counts: RowCounts;
    /** The newest write found in the restored copy: everything after it was lost with the dead primary. */
    newestWrite: string | null;
    lastHeardFromPrimary: string | null;
    warning?: string;
  }
  | { ok: false; outcome: "refused"; code: string; error: string; lastHeardFromPrimary?: string | null };

/** The newest timestamp of a message or a card in a DB file, or null. */
export function newestWrite(path: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    let newest: string | null = null;
    for (const sql of ["SELECT MAX(timestamp) AS t FROM messages", "SELECT MAX(updated_at) AS t FROM tasks"]) {
      try {
        const t = (db.query(sql).get() as { t: string | null } | null)?.t ?? null;
        if (t && (!newest || t > newest)) newest = t;
      } catch {
        // A copy without that table or column: the other one still answers.
      }
    }
    return newest;
  } finally {
    db.close();
  }
}

export async function claimPrimary(deps: ClaimDeps): Promise<ClaimReport> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const run = deps.run ?? runClaimCommand;
  const heard = deps.lastHeardFromPrimary();
  const lastHeardFromPrimary = heard === null ? null : new Date(heard).toISOString();
  const refuse = (code: string, error: string): ClaimReport => ({ ok: false, outcome: "refused", code, error, lastHeardFromPrimary });

  if (deps.role.isPrimary()) return refuse("already_primary", "this server already is the primary");
  if (!deps.settings.restore) {
    return refuse("no_restore_command", `${RESTORE_COMMAND_ENV} is not set: there is no replica to take the primary from`);
  }
  if (heard !== null && now() - heard < PRIMARY_ALIVE_WINDOW_MS && !deps.force) {
    const seconds = Math.round((now() - heard) / 1000);
    return refuse("primary_alive", `the primary called this server ${seconds} s ago, so it may not be dead: check it, then claim with --force`);
  }
  let identity: string | null = null;
  if (deps.settings.ageSecret) {
    identity = await deps.readSecret(deps.settings.ageSecret);
    if (!identity) return refuse("no_age_identity", `the secret ${deps.settings.ageSecret} is not in the secret store`);
  }

  discardIncoming(deps.stateDir);
  mkdirSync(join(deps.stateDir, INCOMING_DIR), { recursive: true, mode: 0o700 });
  const restored = join(deps.stateDir, INCOMING_DIR, DB_NAME);
  const dropped = (code: string, error: string): ClaimReport => {
    discardIncoming(deps.stateDir);
    log(`[primary] claim refused (${code}): ${error}`);
    return refuse(code, error);
  };
  const failed = run(deps.settings.restore, { [RESTORE_OUTPUT_ENV]: restored, ...(identity ? { [AGE_IDENTITY_ENV]: identity } : {}) });
  if (failed) return dropped("restore_failed", `the restore command failed: ${failed}`);
  if (!existsSync(restored)) return dropped("restore_empty", `the restore command wrote nothing at ${RESTORE_OUTPUT_ENV}`);
  let counts: RowCounts;
  try {
    counts = verifyDatabaseFile(restored);
  } catch (err) {
    return dropped("integrity", err instanceof Error ? err.message : String(err));
  }
  const newest = newestWrite(restored);

  const epoch = deps.role.epoch() + 1;
  const manifest: SwitchManifest = {
    version: 1,
    epoch,
    toMachineId: deps.localMachineId,
    toHostname: deps.hostname,
    fromMachineId: deps.role.state().primaryMachineId ?? "unknown",
    createdAt: new Date(now()).toISOString(),
    counts,
    files: [{ name: DB_NAME, size: statSync(restored).size, sha256: await sha256File(restored) }],
    // Nobody waits on this restore; the hash only satisfies the receiver's checks and names its status file.
    confirmSha256: createHash("sha256").update(randomBytes(32)).digest("hex"),
  };
  const verdict = await commitIncoming(deps.stateDir, manifest, { hostname: deps.hostname, epoch: deps.role.epoch(), receive: deps.receive });
  if (!verdict.ok) return dropped(verdict.code, verdict.error);
  log(`[primary] claimed the primary at epoch ${epoch} from the replica of ${manifest.fromMachineId}: ${JSON.stringify(counts)}, newest write ${newest ?? "none"}`);

  let warning: string | undefined;
  if (deps.settings.channels) {
    const channelsFailed = run(deps.settings.channels, {});
    if (channelsFailed) {
      warning = `the channels command failed (${channelsFailed}): this primary runs without them until they are brought up by hand`;
      log(`[primary] ${warning}`);
    }
  }
  deps.restart();
  return { ok: true, outcome: "claimed", epoch, counts, newestWrite: newest, lastHeardFromPrimary, ...(warning ? { warning } : {}) };
}
