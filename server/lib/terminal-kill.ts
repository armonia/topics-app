export const TERMINAL_KILL_REASONS = [
  'orphan-cleanup',
  'subagent-stop',
  'subagent-cascade',
  'user-close',
  'retirement-sweep',
  'park',
  'test-orphan-fixture',
  'test-park-fixture',
  'reload',
  'bridge-recycle',
  'bridge-shutdown',
  'probe-cleanup',
] as const;

export type TerminalKillReason = typeof TERMINAL_KILL_REASONS[number];

export interface TerminalKillLogInput {
  sessionId: string;
  reason: TerminalKillReason;
  caller: string;
  detail?: string;
}

export function formatTerminalKillLog(input: TerminalKillLogInput): string {
  const detail = input.detail ? ` detail=${JSON.stringify(input.detail)}` : '';
  return `[Terminal] kill ${input.sessionId.slice(0, 8)} reason=${input.reason} caller=${input.caller}${detail}`;
}
