/**
 * THE ONE DOOR for "may this turn start?" (project quota brake).
 *
 * The rule lives here and nowhere else: a turn that does not come from a
 * person's message does not start while its project is paused. Every place a
 * turn is born or woken asks `turnGate`, naming WHO is starting it; a
 * caller never re-implements the check.
 *
 * - `person`: always passes. A message typed by a human is never held.
 * - `automation`: held while the project is paused. `fromAgent`, a channel
 *   turn, a scheduled job, a wake-up, a goal nudge and a boot resume are all
 *   automations. The project is the one of whoever LAUNCHES, never the folder
 *   the work is pointed at.
 *
 * FAIL OPEN: a pause that cannot be read blocks nobody.
 *
 * What a gate holds is not lost: `holdUntilResumed` parks a thunk under the
 * project and `releaseHeld` runs it when "Continua" (or any closing of the
 * pause) comes.
 */
import type { Database } from "bun:sqlite";
import { projectIsPaused } from "./project-pause";
import { projectIdOfFolder } from "../usage/project-folders";

export type AutomationSource =
  | "goal-nudge" | "boot-resume" | "process-exit-wake" | "subagent-wake" | "card-outcome-wake"
  | "child-send" | "agent-chat" | "agent-new-topic" | "dispatcher-resume" | "channel-turn"
  | "scheduled-job" | "agent-spawn" | "node-run";

export type TurnOrigin = { kind: "person" } | { kind: "automation"; source: AutomationSource };

export const PERSON: TurnOrigin = { kind: "person" };
export const automation = (source: AutomationSource): TurnOrigin => ({ kind: "automation", source });

export interface GateAnswer { allowed: boolean; reason: "project-paused" | null }

export function turnGate(db: Database, origin: TurnOrigin, projectId: string | null | undefined, nowMs: number = Date.now()): GateAnswer {
  if (origin.kind === "person" || !projectId) return { allowed: true, reason: null };
  return projectIsPaused(db, projectId, nowMs) ? { allowed: false, reason: "project-paused" } : { allowed: true, reason: null };
}

/** The project a topic belongs to (null when unknown): the one a gate asks about for a turn that wakes this topic. */
export function projectIdOfTopic(db: Database, topicId: string | null | undefined): string | null {
  if (!topicId) return null;
  try {
    const r = db.query("SELECT project_path FROM topics WHERE id = ?").get(topicId) as { project_path: string | null } | null;
    return r?.project_path ? projectIdOfFolder(db, r.project_path) : null;
  } catch { return null; }
}

/** `turnGate` for a turn aimed at a topic: resolves the topic's project first. Fail open. */
export function turnGateForTopic(db: Database, origin: TurnOrigin, topicId: string | null | undefined, nowMs: number = Date.now()): GateAnswer {
  if (origin.kind === "person") return { allowed: true, reason: null };
  return turnGate(db, origin, projectIdOfTopic(db, topicId), nowMs);
}

const held = new Map<string, Map<string, () => void | Promise<void>>>();

/** Parks `run` under the project; the same `key` replaces the earlier thunk, so a repeated wake-up is held once. */
export function holdUntilResumed(projectId: string, key: string, run: () => void | Promise<void>): void {
  let m = held.get(projectId);
  if (!m) held.set(projectId, (m = new Map()));
  m.set(key, run);
}

/** @internal Test seam: how many turns wait for "Continua". */
export function heldCount(projectId: string): number { return held.get(projectId)?.size ?? 0; }

/** Runs and clears everything parked for the project. A thunk that throws does not stop the others. */
export async function releaseHeld(projectId: string): Promise<number> {
  const m = held.get(projectId);
  if (!m) return 0;
  held.delete(projectId);
  let n = 0;
  for (const run of m.values()) {
    try { await run(); n++; } catch (err) { console.warn(`[turn-gate] held run failed: ${(err as Error).message}`); }
  }
  return n;
}

/** Callbacks for a project leaving pause (the dispatcher wakes its tick here). */
const resumeListeners = new Set<(projectId: string) => void>();
export function onProjectResumed(cb: (projectId: string) => void): () => void { resumeListeners.add(cb); return () => resumeListeners.delete(cb); }

/** Called on EVERY closing of a pause: "Continua", midnight, limit raised, window back under. */
export function fireProjectResumed(projectId: string): void {
  void releaseHeld(projectId);
  for (const cb of resumeListeners) { try { cb(projectId); } catch { /* best-effort */ } }
}

/** @internal Test seam. */
export function resetHeldForTests(): void { held.clear(); resumeListeners.clear(); }
