/**
 * Is a scheduled command's process still alive? (rule R12)
 *
 * The witness is the identity of its process group (leader pid, group id and
 * start time as the kernel reports them), the same one the registry of command
 * groups records at spawn. It is NOT `ps -o lstart` under a 3 second timeout:
 * under swap the probe times out and a live command read as dead, so the engine
 * started it a second time.
 *
 * Three answers, because «the probe did not answer» is not «it is dead»:
 *  - `alive`: the group answers and its identity is the recorded one;
 *  - `dead`: the group is gone, or the leader pid now belongs to somebody else;
 *  - `unknown`: the group answers but its identity cannot be read. Never started again.
 */
import { processGroupAlive, readProcessGroupIdentity, type ProcessGroupIdentity } from "../lib/command-process-groups";

export type CommandLife = "alive" | "dead" | "unknown";

export interface RecordedGroup { pgid: number; leaderPid: number; leaderStartTime: string }

export interface LifeProbes {
  groupAlive(pgid: number): boolean;
  identityOf(pid: number): ProcessGroupIdentity | null;
}

export const kernelProbes: LifeProbes = { groupAlive: processGroupAlive, identityOf: readProcessGroupIdentity };

export function commandLife(group: RecordedGroup | undefined, probes: LifeProbes = kernelProbes): CommandLife {
  if (!group) return "dead";
  let answers: boolean;
  try { answers = probes.groupAlive(group.pgid); } catch { return "unknown"; }
  if (!answers) return "dead";
  let identity: ProcessGroupIdentity | null;
  try { identity = probes.identityOf(group.leaderPid); } catch { return "unknown"; }
  // The leader is gone but a member of the group still lives (the wrapper drains it): the command is not over.
  if (!identity) return "unknown";
  return identity.pgid === group.pgid && identity.pid === group.leaderPid && identity.startTime === group.leaderStartTime ? "alive" : "dead";
}
