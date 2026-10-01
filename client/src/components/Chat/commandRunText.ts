/**
 * The words around a command run: its duration, its folder, and what «Send to
 * agent» puts at the end of the draft (CHAT-RUN-04).
 */
import { plainLines } from './ansiSpans';

/** How many lines of the output go to the agent: chosen by the person, who reads them in the draft first. */
export const AGENT_TAIL_LINES = 50;

export function formatRunDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A folder under a home directory, written from `~`. */
export function shortenHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

/**
 * The text «Send to agent» appends to the draft: a `console` fence with the
 * command behind a prompt, one line with the outcome, the duration and the
 * folder, and the last lines of the output without any escape sequence.
 */
export function runDraftText(run: { command: string; output: string; outcome: string; duration: string; cwd: string }, summary: (vars: { outcome: string; duration: string; cwd: string }) => string): string {
  const command = run.command.split('\n').map((line, i) => (i === 0 ? `$ ${line}` : `> ${line}`)).join('\n');
  const lines = plainLines(run.output).slice(-AGENT_TAIL_LINES);
  const body = [command, summary({ outcome: run.outcome, duration: run.duration, cwd: shortenHome(run.cwd) }), ...lines].join('\n');
  // A fence longer than any run of backticks in the body, so the output cannot close it.
  const inner = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(inner + 1);
  return `${fence}console\n${body}\n${fence}`;
}
