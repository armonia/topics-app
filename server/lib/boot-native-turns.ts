// boot-native-turns.ts - what the boot does with the native turns the broker
// still holds, and which provider owns a session's surviving turn. Pure, so the
// two decisions can be tested without a broker or a server.

export type TurnOwnerName = "topics" | "claude-code";

/** One provider's answer about a session: does it claim a turn, is that turn's process alive. */
export interface TurnOwnerClaim {
  name: TurnOwnerName;
  claims: boolean;
  alive: boolean;
}

/**
 * The provider that owns a session's surviving turn.
 *
 * Two can claim the same session: the native runtime also claims a DEAD store
 * whose row is still open (a turn that ended while no server listened). When a
 * native host died without its ending and the session's next turn ran on the
 * CLI, both claim after a restart; trusting the first asked attached the
 * dispatcher to the old journal and the live CLI turn was never adopted. A live
 * process is the turn running now, so it wins; a dead claim is taken only when
 * nobody runs one.
 */
export function pickTurnOwner(claims: readonly TurnOwnerClaim[]): TurnOwnerName | null {
  const claimed = claims.filter((c) => c.claims);
  return (claimed.find((c) => c.alive) ?? claimed[0])?.name ?? null;
}

/** A broker session seen at boot, already mapped to its session key when it is a native turn's. */
export interface NativeBrokerSession {
  id: string;
  sessionKey: string;
  alive: boolean;
  endOffset: number;
}

/**
 * How the boot treats the native turns in the broker.
 *
 * With detached turns on, an alive one goes on and a dead one with a journal
 * ended while the server was down: both keep their row for the reattach. With
 * them off, nothing re-adopts them (`reattach` answers "dead" and leaves the
 * row and its stream open), so the boot must not keep their rows: the partial
 * sweep closes them with its notice and the resume picks the chat up. A host
 * still running is killed, or it would keep editing files beside the resumed
 * turn.
 */
export function classifyNativeBootSessions(
  sessions: readonly NativeBrokerSession[],
  detachedOn: boolean,
): { alive: string[]; endedWhileDown: string[]; kill: string[] } {
  const out = { alive: [] as string[], endedWhileDown: [] as string[], kill: [] as string[] };
  for (const s of sessions) {
    if (!detachedOn) { if (s.alive) out.kill.push(s.id); continue; }
    if (s.alive) out.alive.push(s.sessionKey);
    else if (s.endOffset > 0) out.endedWhileDown.push(s.sessionKey);
  }
  return out;
}
