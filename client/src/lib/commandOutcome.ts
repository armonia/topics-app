/**
 * How a `run_command` process reads in the Processes panel.
 *
 * A command is launched for its outcome, so unlike a background shell its row
 * does not vanish at the end: it stays among the recent ones with what
 * happened. Three endings, kept apart because they ask different things of
 * whoever reads them: an exit code, a Stop somebody chose, and a process that
 * ended without recording anything (killed too hard, or while the server was
 * down), which is shown as unknown and never as a success.
 */
import type { ScriptProcessInfo } from './api';

export type CommandOutcome =
  | { kind: 'running' }
  | { kind: 'exit'; code: number }
  | { kind: 'stopped' }
  | { kind: 'unknown' };

export function commandOutcome(sp: Pick<ScriptProcessInfo, 'status' | 'exitCode' | 'stopped'>): CommandOutcome {
  if (sp.status === 'running') return { kind: 'running' };
  if (sp.stopped) return { kind: 'stopped' };
  return typeof sp.exitCode === 'number' ? { kind: 'exit', code: sp.exitCode } : { kind: 'unknown' };
}

/** The command rows of a project's process list: the live ones first. */
export function commandRows(scripts: readonly ScriptProcessInfo[]): ScriptProcessInfo[] {
  const commands = scripts.filter((s) => s.source === 'command');
  return [...commands.filter((s) => s.status === 'running'), ...commands.filter((s) => s.status !== 'running')];
}
