/**
 * System-prompt fragment appended to every Topics-launched Claude session
 * (interactive PTY terminals AND the headless chat provider).
 *
 * It steers the agent to drive long-running processes THROUGH Topics — where
 * they're tracked, shown in the Processes panel with live logs/ports/stop, and
 * survive reloads — instead of backgrounding them in the bare shell. The Topics
 * MCP (`mcp__topics__*`) is already wired into every session. Kept short and
 * additive: it nudges; the user's project CLAUDE.md still governs everything else.
 *
 * Note: even when the agent ignores this and starts a server with a bare shell
 * command, Topics auto-detects the listening process under the session's PTY and
 * registers it (see the process detector in routes/processes.ts) — so this prompt
 * is the preferred path, not the only safety net.
 */
export const TOPICS_AGENT_SYSTEM_PROMPT = [
  'You are running inside Topics, a workspace that tracks long-running processes.',
  'To start a long-running dev server, watcher, or build process, ALWAYS prefer the',
  'Topics MCP tool `mcp__topics__run_script` (it runs a script declared in the',
  "project's package.json) instead of backgrounding the command in the shell.",
  'Processes started this way appear in the Topics Processes panel with live logs,',
  'status, port links, and a stop button, and are managed across restarts.',
  'Use `mcp__topics__list_processes` to see what is running, `mcp__topics__read_process_output`',
  'to read a process’s logs, and `mcp__topics__stop_process` to stop one.',
  'Only fall back to a bare shell command when no matching package.json script exists',
  'or the command is a short one-off.',
].join(' ');

/**
 * Effort tier for Topics-launched Claude sessions — the "ultracode" tier in the
 * TUI is just the top effort (`xhigh`) plus dynamic workflows.
 *
 * `claude` resolves effort from `--effort` flag → `CLAUDE_EFFORT` env →
 * settings.json `effortLevel`. Topics spawns `claude` directly: under launchd
 * the server's env carries no `CLAUDE_EFFORT`, and the user's global
 * `effortLevel` defaults to "low", so without help every Topics session starts
 * at low effort — unlike a Warp shell, which exports `CLAUDE_EFFORT=xhigh` and
 * therefore "starts in ultracode". We pass `--effort` explicitly so the tier is
 * deterministic and independent of the spawn environment.
 *
 * Resolution order: `TOPICS_CLAUDE_EFFORT` (Topics override; "off"/"none"/
 * "default" disables and lets the CLI's own settings win) → `CLAUDE_EFFORT`
 * (mirror the shell when present) → `"xhigh"` (the Warp default). Returns null
 * when disabled or the value is not a recognised tier, in which case no flag is
 * passed.
 */
const VALID_CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function resolveClaudeEffort(): string | null {
  const override = (process.env.TOPICS_CLAUDE_EFFORT ?? '').trim().toLowerCase();
  if (override === 'off' || override === 'none' || override === 'default') return null;
  const candidate =
    override || (process.env.CLAUDE_EFFORT ?? '').trim().toLowerCase() || 'xhigh';
  return VALID_CLAUDE_EFFORTS.has(candidate) ? candidate : null;
}
