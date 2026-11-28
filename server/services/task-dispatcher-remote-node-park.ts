/**
 * What a primary switch asks of the remote node lane: which runs are in the air
 * on a machine, and how to stop one for good. Split out of
 * `task-dispatcher-remote-node.ts`, which keeps the launch itself; everything
 * the lane owns (the launching map, the card's node run link, the host) comes
 * in as an argument.
 */
import type { NodeDeps, RemoteNodeHost } from "./task-dispatcher-remote-node";

/**
 * One launch this process started and has not finished yet, with the machine it is launching on.
 * `parked` is set when a primary switch put the card back in the queue: the launch is still in
 * the air but no longer counts, and it must stop at the first point where it would claim the card.
 */
export type LaunchEntry = { machineId: string; parked: boolean };

/** The session key of a slot whose run the node has not named yet; the same shape as `nodeSessionKey(machineId, "pending")`. */
function pendingKeyOf(machineId: string): string {
  return `node:${machineId}:pending`;
}

/** The machine of a slot whose run the node has not named yet (`node:<machine>:pending`), else null. */
function pendingMachineOf(sessionKey: string): string | null {
  return sessionKey.startsWith("node:") && sessionKey.endsWith(":pending") ? sessionKey.slice("node:".length, -":pending".length) : null;
}

/** What `runsOn` and `parkRun` read from the lane. */
export interface ParkDeps {
  host: Pick<RemoteNodeHost, "svc" | "log" | "inFlight" | "endRun" | "releaseAndEmit"> & { client?: NodeDeps };
  /** The launches this process has in the air, by card. */
  launching: Map<string, LaunchEntry>;
  /** The card's link to the last run created on a node (persisted on the card). */
  lastNodeRun: { delete(taskId: string): void };
}

/**
 * A launch counts as running on its machine FROM THE MOMENT IT STARTS: the slot carries a
 * `node:<machine>:pending` key until the node names the run, and the window before the slot
 * (origin lookup, branch push) is `launching`. Waiting only for slots with a run id let a switch
 * snapshot and fence while `createRun` was still answering.
 */
export function runsOn(deps: ParkDeps, machineId: string): Array<{ taskId: string; sessionKey: string }> {
  const { inFlight } = deps.host;
  const rows = [...inFlight.entries()]
    .filter(([, slot]) => (slot.node?.machineId ?? pendingMachineOf(slot.sessionKey)) === machineId)
    .map(([taskId, slot]) => ({ taskId, sessionKey: slot.sessionKey }));
  for (const [taskId, entry] of deps.launching) {
    if (entry.machineId === machineId && !entry.parked && !inFlight.has(taskId)) rows.push({ taskId, sessionKey: pendingKeyOf(machineId) });
  }
  return rows;
}

/**
 * Every launch whose node has not named its run yet, on ANY machine (the target, a third node,
 * the cloud lane). Such a card has no run id the new primary could reattach to: its DB copy says
 * `in_progress` with no run, and nothing on the new primary ever moves it again. A switch parks
 * them before the snapshot, so the card travels back in the queue.
 */
export function launchesInFlight(deps: ParkDeps): Array<{ taskId: string; sessionKey: string }> {
  const { inFlight } = deps.host;
  const rows = [...inFlight.entries()]
    .filter(([, slot]) => !slot.node && pendingMachineOf(slot.sessionKey) !== null)
    .map(([taskId, slot]) => ({ taskId, sessionKey: slot.sessionKey }));
  for (const [taskId, entry] of deps.launching) {
    if (!entry.parked && !inFlight.has(taskId)) rows.push({ taskId, sessionKey: pendingKeyOf(entry.machineId) });
  }
  return rows;
}

export async function parkRun(deps: ParkDeps, taskId: string, note: string): Promise<boolean | null> {
  const { svc, log, inFlight, releaseAndEmit } = deps.host;
  const slot = inFlight.get(taskId);
  const node = slot?.node;
  const client = deps.host.client;
  if (node) {
    if (client) {
      try {
        await client.cancelRun({ baseUrl: node.baseUrl, token: node.token, runId: node.runId, delegation: node.delegation });
      } catch (err) { log(`node: run ${node.runId} of card ${taskId} was not cancelled while parking it`, err); }
    }
    inFlight.delete(taskId);
  } else {
    // A launch still on its way to the node: no run id to cancel yet. The launch notices it no
    // longer owns the card and cancels the run it creates (`createRun` answering after the park).
    const entry = deps.launching.get(taskId);
    const machineId = (slot ? pendingMachineOf(slot.sessionKey) : null) ?? entry?.machineId ?? null;
    if (!machineId) return null;
    if (entry) entry.parked = true;
    if (slot) deps.host.endRun(taskId, slot.runId);
    // The previous run of the card is still linked when the launch has not got to cancel it.
    const previous = svc.nodeRunOf(taskId);
    const baseUrl = client?.baseUrlOf(machineId);
    const token = client?.tokenOf(machineId);
    if (client && previous && baseUrl && token) {
      try { await client.cancelRun({ baseUrl, token, runId: previous }); }
      catch (err) { log(`node: previous run ${previous} of card ${taskId} was not cancelled while parking it`, err); }
    }
  }
  // The id goes with the run: the card must never point at a run that no longer exists.
  deps.lastNodeRun.delete(taskId);
  try {
    svc.claimInterruption({ taskId, note });
    releaseAndEmit({ taskId, requeue: true, rollbackAttempt: true });
    return true;
  } catch (err) {
    log(`node: card ${taskId} was not put back in the queue`, err);
    return false;
  }
}
