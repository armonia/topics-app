/**
 * The primary that was replaced while it was away (track T9 of
 * `openspec/changes/nodo-principale-a-mano`).
 *
 * A computer that died without warning cannot hand anything over: a node
 * claims the primary from the last replica of its DB (`primary-claim.ts`) at a
 * higher epoch. When the old primary comes back it still believes it is the
 * primary, and the first call it makes to a node is answered
 * `stale_primary_epoch` with the newer epoch. That answer is the proof: from
 * that moment this server writes nothing more. Its DB turns read-only at once,
 * the retired marker says `pending-set-aside`, and the restart that follows
 * renames the DB `topics.db.prima-<epoch>` (`applyPendingPrimaryChange`). Two
 * DBs are never merged: whatever this server wrote since the last replica stays
 * in that file, for a person to read.
 */
import { onStaleAnswer, type PrimaryRole, STALE_EPOCH_CODE } from "./primary-role";
import { readRetired, type RetiredState, writeRetired } from "./primary-switch-markers";
import { setPrimaryFence } from "./primary-fence";

export interface ReplacedPrimaryDeps {
  appDataDir: string;
  role: Pick<PrimaryRole, "isPrimary" | "epoch">;
  /** The node behind a URL, only when this server paired it and holds its token; null for any other URL. */
  machineFor: (url: string) => { id: string; name: string } | null;
  /**
   * Stops the replica of the DB (Litestream) through the service manager, before the restart
   * renames the DB it watches; returns why it failed, or null. Absent: no replica managed.
   */
  stopReplica?: () => string | null;
  restart: () => void;
  now?: () => string;
  log?: (line: string) => void;
}

/** The node whose base URL the call went to: the same origin and a path at or under its base. */
export function nodeForUrl<T extends { baseUrl: string }>(nodes: T[], url: string): T | null {
  return nodes.find((m) => {
    const base = m.baseUrl.replace(/\/+$/, "");
    return url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);
  }) ?? null;
}

/**
 * The reaction to a 409 from a node. Acts only on `stale_primary_epoch` with an
 * epoch ABOVE this server's, from a node this server paired and holds a token
 * for, and only while this server believes it is the primary and has no
 * retired marker yet. An answer from any other URL is logged and changes
 * nothing: setting the production DB aside cannot be undone by a command, so
 * a URL nobody vouched for must never be able to trigger it.
 * Returns the marker it wrote, or null.
 */
export function retireOnStaleAnswer(deps: ReplacedPrimaryDeps, url: string, body: unknown): RetiredState | null {
  const answer = body && typeof body === "object" ? body as { code?: unknown; epoch?: unknown } : null;
  if (answer?.code !== STALE_EPOCH_CODE) return null;
  const epoch = answer.epoch;
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch <= deps.role.epoch()) return null;
  if (!deps.role.isPrimary() || readRetired(deps.appDataDir)) return null;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const machine = deps.machineFor(url);
  if (!machine) {
    log(`[primary] a server that is not a paired node answered at epoch ${epoch}, above this server's ${deps.role.epoch()}: ignored`);
    return null;
  }
  const marker: RetiredState = {
    epoch,
    toMachineId: machine.id,
    toName: machine.name,
    at: (deps.now ?? (() => new Date().toISOString()))(),
    phase: "pending-set-aside",
  };
  let written = true;
  try {
    // The marker first: a crash right after it still boots as a secondary that sets its DB aside.
    writeRetired(deps.appDataDir, marker);
  } catch (err) {
    written = false;
    log(`[primary] the retired marker could not be written (${err instanceof Error ? err.message : String(err)}): writes stay refused until a person looks`);
  }
  // Up whatever happened above: refusing writes is what keeps the two DBs apart.
  setPrimaryFence(marker);
  log(`[primary] ${marker.toName} answered at epoch ${epoch}, above this server's ${deps.role.epoch()}: the primary was claimed while this server was away, writes are refused`);
  // The replica stops before the DB it watches is renamed: what it publishes from here on would be
  // a generation the node that claimed the primary never restored.
  const replicaFailed = deps.stopReplica?.() ?? null;
  if (replicaFailed) log(`[primary] the replica of the DB did not stop (${replicaFailed}): stop it by hand before it publishes again`);
  // Without the marker a restart would boot back as the primary: the server stays up, fenced, instead.
  if (written) deps.restart();
  return marker;
}

/** Wires the reaction into the node client, once at boot. */
export function wireReplacedPrimary(deps: ReplacedPrimaryDeps): void {
  onStaleAnswer((url, body) => { retireOnStaleAnswer(deps, url, body); });
}
