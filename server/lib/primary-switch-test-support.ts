/**
 * The receiving half of a primary switch, in the same process, for the tests
 * and the probe: the real commit with every check of the receiving route, and
 * the real boot restore run when the sender first asks for the confirmation
 * (the moment the receiver would have restarted).
 */
import {
  applyPendingPrimaryChange, clearRestoreStatus, commitIncoming, confirmsRestore, discardIncoming, readRestoreStatus,
  type ReceiveChecks, type SwitchManifest,
} from "./primary-switch";
import type { CommitAnswer, ConfirmAnswer } from "../services/primary-switch-run";

export interface ReceiverDirs { stateDir: string; secretsDir: string; appDataDir: string; dbPath: string; projectsDir: string }

export interface LocalReceiverOptions {
  hostname: string;
  epoch?: () => number;
  freeBytes?: (dir: string) => number;
  replica?: ReceiveChecks["replica"];
  holdersOf?: ReceiveChecks["holdersOf"];
  /** Runs right before the boot restore: what the receiver's computer does while it restarts. */
  beforeBoot?: () => void | Promise<void>;
  /** What the boot restore answered (or threw), for the caller to assert on. */
  onBoot?: (outcome: ReturnType<typeof applyPendingPrimaryChange> | Error) => void;
}

export function localReceiver(dirs: ReceiverDirs, opts: LocalReceiverOptions) {
  const replica = opts.replica ?? {};
  let booted = false;
  return {
    async commit(manifest: SwitchManifest): Promise<CommitAnswer> {
      booted = false;
      const v = await commitIncoming(dirs.stateDir, manifest, {
        hostname: opts.hostname, epoch: opts.epoch?.() ?? 0, freeBytes: opts.freeBytes,
        receive: { ...dirs, replica, holdersOf: opts.holdersOf },
      });
      if (!v.ok) discardIncoming(dirs.stateDir);
      return v.ok ? { kind: "accepted", counts: v.counts } : { kind: "refused", code: v.code, error: v.error };
    },
    async confirm(secret: string): Promise<ConfirmAnswer> {
      if (!booted) {
        booted = true;
        await opts.beforeBoot?.();
        try {
          // Evaluated first: an optional call skips its arguments when nobody listens.
          const outcome = applyPendingPrimaryChange({ ...dirs, replica, holdersOf: opts.holdersOf, log: () => {} });
          opts.onBoot?.(outcome);
        } catch (err) {
          opts.onBoot?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
      const status = readRestoreStatus(dirs.appDataDir);
      if (!status || !confirmsRestore(status, secret)) return { kind: "waiting" };
      if (status.state === "restored") return { kind: "restored", ...(status.warning ? { warning: status.warning } : {}) };
      if (status.state === "failed") return { kind: "failed", error: status.error ?? "the restore failed" };
      return { kind: "waiting" };
    },
    async abandon(secret: string): Promise<boolean> {
      const status = readRestoreStatus(dirs.appDataDir);
      if (!status || !confirmsRestore(status, secret) || status.state !== "failed") return false;
      discardIncoming(dirs.stateDir);
      clearRestoreStatus(dirs.appDataDir);
      return true;
    },
  };
}
