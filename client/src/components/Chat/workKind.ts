/**
 * WHAT KIND OF WORK A TOOL ROW STANDS FOR, when it is not just a tool.
 *
 * Two things look alike in a transcript and are not the same:
 *
 *  - a SUB-AGENT (`Task` / `Agent` / `spawn_agent`): another chat that works on
 *    its own and comes back with a result;
 *  - BACKGROUND work (`run_command`, `run_script`, a Bash with
 *    `run_in_background`): a process that keeps running and wakes the chat when
 *    it ends.
 *
 * The row says which one it is with its icon and its label, nothing else.
 * Pure, so the rule has a test with no DOM.
 */
import type { ToolCallDetail } from '../../types';

export type WorkKind = 'subagent' | 'background';

/** The Topics tools that start a process: the bare tool name, whatever MCP server carries it. */
const BACKGROUND_TOOLS = new Set(['run_command', 'run_script']);

function bareName(name: string): string {
  const parts = name.toLowerCase().trim().split('__');
  return parts[parts.length - 1] ?? '';
}

export function workKindOf(name: string, detail: ToolCallDetail): WorkKind | undefined {
  if (detail.type === 'sub_agent') return 'subagent';
  if (detail.type === 'shell' && detail.background) return 'background';
  if (BACKGROUND_TOOLS.has(bareName(name))) return 'background';
  return undefined;
}
