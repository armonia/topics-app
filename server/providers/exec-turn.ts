/**
 * Pieces shared by the providers that run one `<cli> exec` child per turn
 * (Codex, Muse): the liveness probe, the wait for a previous turn's child, the
 * SIGINT-then-SIGKILL abort, and the spawn of a one-shot completion child.
 */
import { spawn, type ChildProcess } from "child_process";
import { PROVIDER_TURN_TIMEOUT_MS } from "../lib/turn-deadline";
import { childExited } from "./child-exit";

export const KILL_GRACE_MS = 3_000;

/** A send parked until the previous child of its session is gone; a Stop cancels it. */
export type SendTicket = { cancelled: boolean; wake?: () => void };

/** The child map entry plus an unreported exit is the whole ownership/liveness contract of a one-shot child. */
export function isChildAlive(child: ChildProcess | undefined): boolean {
  return !!child && child.exitCode === null && child.signalCode === null;
}

/** Resolves when no child of this session is alive (a resume fallback spawned on close counts), or the send is stopped. */
async function previousTurnGone(activeChildren: Map<string, ChildProcess>, sessionKey: string, ticket: SendTicket): Promise<void> {
  for (;;) {
    const child = activeChildren.get(sessionKey);
    if (!child || ticket.cancelled) return;
    await new Promise<void>((resolve) => { ticket.wake = resolve; child.once("close", () => resolve()); });
  }
}

/**
 * ONE CHILD PER SESSION AT A TIME. After a Stop the route closes the turn at
 * once while the child takes up to KILL_GRACE_MS to die; a send right after
 * would start a second child on the same session, the two writing the same
 * log. Waits for the previous child; returns true when the send was stopped
 * meanwhile (it must write nothing).
 */
export async function waitForPreviousTurn(
  activeChildren: Map<string, ChildProcess>,
  waitingSends: Map<string, SendTicket>,
  sessionKey: string,
): Promise<boolean> {
  if (!activeChildren.has(sessionKey)) return false;
  const ticket: SendTicket = { cancelled: false };
  waitingSends.set(sessionKey, ticket);
  try { await previousTurnGone(activeChildren, sessionKey, ticket); }
  finally { if (waitingSends.get(sessionKey) === ticket) waitingSends.delete(sessionKey); }
  return ticket.cancelled;
}

/**
 * Cancel the in-flight turn: SIGINT, let the CLI flush its events, SIGKILL
 * after a grace window. `markAborted` lets the close handler emit `onAborted`
 * instead of an error stub. `activeChildren` is deliberately NOT cleared:
 * `child.on("close")` owns cleanup, and clearing early would race the final
 * stdout drain.
 */
export function abortTurn(
  activeChildren: Map<string, ChildProcess>,
  waitingSends: Map<string, SendTicket>,
  sessionKey: string,
  markAborted: () => void,
): void {
  // A send waiting for the previous child to exit is the turn being stopped:
  // it never spawns. Its caller closes the stream.
  const waiting = waitingSends.get(sessionKey);
  if (waiting) { waiting.cancelled = true; waiting.wake?.(); }
  const child = activeChildren.get(sessionKey);
  if (!child) return;
  markAborted();
  try { child.kill("SIGINT"); } catch { /* best-effort: the child may already have exited */ }
  setTimeout(() => {
    // Still alive after the grace window? Force-kill so the close handler
    // runs and the user isn't stuck with a phantom stream.
    if (activeChildren.get(sessionKey) === child) {
      try { child.kill("SIGKILL"); } catch { /* best-effort: the child may already have exited */ }
    }
  }, KILL_GRACE_MS);
}

/**
 * Spawn a one-shot completion child that owns its process group (a CLI may be
 * a wrapper around a native child, so a deadline must close both and their
 * inherited pipes), buffer its output and arm the deadline. `timer` must be
 * cleared by the caller's close/error handlers.
 */
export function spawnCollected(bin: string, args: string[], cwd: string, env: Record<string, string>, timeoutMs: number | undefined) {
  const ownedGroup = process.platform !== "win32";
  const child = spawn(bin, args, {
    detached: ownedGroup,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  const out = { stdout: "", stderr: "", timedOut: false };
  child.stdout!.on("data", (d: Buffer) => { out.stdout += d.toString(); });
  child.stderr!.on("data", (d: Buffer) => { out.stderr += d.toString(); });
  const timer = setTimeout(() => {
    out.timedOut = true;
    try {
      if (ownedGroup && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch { /* The process may already have closed. */ }
  }, Math.min(PROVIDER_TURN_TIMEOUT_MS, Math.max(1, timeoutMs ?? PROVIDER_TURN_TIMEOUT_MS)));
  return { child, out, timer };
}

/** Terminates every running child (SIGTERM, then SIGKILL after the grace) and resolves once they have exited. */
export function stopAllChildren(children: Map<string, ChildProcess>): Promise<void> {
  const exits: Promise<void>[] = [];
  for (const child of children.values()) {
    try { child.kill("SIGTERM"); } catch { /* best-effort: the child may already have exited */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* best-effort: the child may already have exited */ } }, KILL_GRACE_MS);
    exits.push(childExited(child, KILL_GRACE_MS + 500));
  }
  children.clear();
  return Promise.all(exits).then(() => undefined);
}
