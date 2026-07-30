/**
 * terminalAgents — ONE place that knows which interactive agents can run in a
 * terminal pane and how to spawn them.
 *
 * The add-menu offers three pty flavours: a plain Shell, Claude Code
 * (default agent) and Codex (OpenAI's CLI). Before this module the
 * `subType → session-create body` dance was copy-pasted at three call sites
 * (usePanelLifecycle.handleQuickCreateTerminal, useProjectLayout's
 * handleAddPaneToGroup + handleAddPaneWhenEmpty) with hardcoded
 * `'claude-code' ? … : 'shell'` ternaries — which is exactly the kind of
 * drift that made adding Codex require N edits. Now: normalize the requested
 * type here, build the POST /api/terminal/sessions body here, read the
 * display name here.
 *
 * Server counterpart: server/routes/terminal.ts accepts `type` verbatim and
 * spawns `claude` / `codex` / $SHELL accordingly. Absent or unknown type =
 * shell on the wire too, so old clients stay compatible.
 */

// La lista dei tipi vive in `shared/terminal-session-types.ts`: la conosce anche
// il server, e il CHECK di SQLite le e' legato da un test. Qui si ri-esporta il
// sottoinsieme creabile dal menu, che e' la domanda di questo modulo.
export { TERMINAL_AGENT_TYPES } from '../../../shared/terminal-session-types';
export type { TerminalAgentType } from '../../../shared/terminal-session-types';
import { TERMINAL_AGENT_TYPES, type TerminalAgentType } from '../../../shared/terminal-session-types';

/** Display name → also the default session/pane title. */
export const TERMINAL_AGENT_LABELS: Record<TerminalAgentType, string> = {
  shell: 'Shell',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'opencode',
};

/**
 * Normalize a free-form pane `subType` (threaded through onAddPane handlers)
 * to a spawnable agent type. Unknown / absent values fall back to 'shell' —
 * the same default the server applies, so client and server always agree.
 */
export function normalizeTerminalAgent(subType?: string): TerminalAgentType {
  return (TERMINAL_AGENT_TYPES as readonly string[]).includes(subType ?? '')
    ? (subType as TerminalAgentType)
    : 'shell';
}

/**
 * Build the POST /api/terminal/sessions JSON body for an agent type.
 * `skipPermissions` is a Claude-only flag (--dangerously-skip-permissions);
 * it is deliberately NOT sent for shell/codex so the body stays minimal and
 * the server's `skipPermissions !== false` default isn't poked needlessly.
 */
export function buildTerminalSessionBody(
  agent: TerminalAgentType,
  opts: { cwd?: string; skipPermissions?: boolean } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: agent,
    name: TERMINAL_AGENT_LABELS[agent],
  };
  if (opts.cwd) body.cwd = opts.cwd;
  if (agent === 'claude-code' && opts.skipPermissions !== undefined) {
    body.skipPermissions = opts.skipPermissions;
  }
  return body;
}
