/**
 * WHICH CARD OF THE TRANSCRIPT STARTED A ROW OF THE STRIP (chat-strips-in-transcript).
 *
 * A command of the strip (`SubAgentsStrip`) is a `run_command` or a `run_script`
 * the agent called, and that call already has its card in the transcript: the
 * command, what it answered and, while it runs, its live log. On 08/10 a click on
 * Muse's row opened a second log docked over the strip instead («a new accordion
 * above instead of the one the agent already has»). The row now opens that card,
 * and only a command with no card here (another session's, or one whose call is
 * in the part of the history not loaded) keeps the docked log.
 *
 * The answer of the call names the process (`started · processId=…`,
 * `server/mcp/command-tools.ts`), but the history ships a closed row without its
 * output (`shared/lean-tool-call.ts`): a call loaded from history is recognised
 * by what it ran instead, the command line (or the script's name), and among
 * repeated launches of the same line by the one that started closest to the
 * process. Pure, so the rule has a test with no DOM.
 */
import type { ChatMessage, ToolCall } from '../../types';
import type { LiveCommandRow } from '../../../../shared/live-work';

export interface LaunchCard {
  messageId: string;
  toolCallId: string;
}

/** `run_command` / `run_script`, bare (native runtime) or behind an MCP prefix (`mcp__topics__run_command`). */
function launchKind(name: string): 'command' | 'script' | null {
  const n = name.toLowerCase();
  if (n === 'run_command' || n.endsWith('__run_command')) return 'command';
  if (n === 'run_script' || n.endsWith('__run_script')) return 'script';
  return null;
}

const LAUNCHED = /started · processId=([\w:.-]+)/;

/** The process a `run_command` / `run_script` answer says it started, or null. */
export function launchedProcessId(answer: string | undefined): string | null {
  return (answer && LAUNCHED.exec(answer)?.[1]) || null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Everything of the call that can hold its answer: the history blanks some of them. */
function answerOf(tc: ToolCall): string {
  const d = tc.detail as Record<string, unknown> | undefined;
  return [tc.result, d?.output, d?.result].map(str).join('\n');
}

/** An argument of the call, from `args` or from the detail's copy (`mcp` details keep them there). */
function argOf(tc: ToolCall, key: string): string {
  const d = tc.detail as { args?: Record<string, unknown>; command?: unknown } | undefined;
  return (str(tc.args?.[key]) || str(d?.args?.[key]) || (key === 'command' ? str(d?.command) : '')).trim();
}

/**
 * Whether the call ran what the row runs. The server stores the command
 * trimmed; the history cuts a long argument to its head and says so in
 * `argsBytes`, and then the head has to be the start of the command.
 */
function ranSame(kind: 'command' | 'script', tc: ToolCall, row: LiveCommandRow): boolean {
  if (kind === 'script') return argOf(tc, 'script') === row.name;
  const ran = argOf(tc, 'command');
  if (!ran) return false;
  return ran === row.command || ((tc.argsBytes ?? 0) > 0 && row.command.startsWith(ran));
}

function toolCallsOf(msg: ChatMessage): ToolCall[] {
  const fromBlocks = (msg.blocks ?? []).flatMap((b) => (b.kind === 'tool' ? [b.toolCall] : []));
  const seen = new Set(fromBlocks.map((tc) => tc.id));
  return [...fromBlocks, ...(msg.toolCalls ?? []).filter((tc) => !seen.has(tc.id))];
}

/** The card that started `row`, or null when this transcript does not hold it. */
export function findLaunchCard(messages: readonly ChatMessage[], row: LiveCommandRow): LaunchCard | null {
  const start = Date.parse(row.startedAt);
  let best: { card: LaunchCard; gap: number } | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    for (const tc of toolCallsOf(msg)) {
      const kind = launchKind(tc.name);
      if (!kind) continue;
      const card = { messageId: msg.id, toolCallId: tc.id };
      const named = launchedProcessId(answerOf(tc));
      // An answer that names a process settles it, either way.
      if (named) {
        if (named === row.id) return card;
        continue;
      }
      if (!ranSame(kind, tc, row)) continue;
      const gap = typeof tc.startedAt === 'number' && Number.isFinite(start) ? Math.abs(tc.startedAt - start) : Number.MAX_SAFE_INTEGER;
      if (!best || gap < best.gap) best = { card, gap };
    }
  }
  return best?.card ?? null;
}
