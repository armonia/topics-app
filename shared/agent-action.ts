/**
 * WHAT AN AGENT IS DOING RIGHT NOW, as one word every "working" surface reads.
 *
 * The tab, the sidebar row, the project folder, the board card and the tray all
 * draw the same loader; this is the vocabulary that tells them which movement
 * to play. It is the contract between whoever observes the agent (stream frames,
 * Claude Code hook phases) and whoever draws it (`squareLoader`, the tray), so
 * it lives in `shared/` and the server, the client and the shell agree on it.
 *
 *   think    reasoning, or working with nothing more specific to say
 *   write    writing the answer (text streaming)
 *   read     reading or searching code and files
 *   edit     changing files
 *   run      running commands
 *   web      searching or reading the web
 *   browse   driving a browser
 *   delegate handing work to sub-agents
 *   tool     any other tool
 *   wait     waiting for the person (a permission, a question)
 *   error    the turn failed
 */
export type AgentAction =
  | 'think'
  | 'write'
  | 'read'
  | 'edit'
  | 'run'
  | 'web'
  | 'browse'
  | 'delegate'
  | 'tool'
  | 'wait'
  | 'error';

export const AGENT_ACTIONS: readonly AgentAction[] = [
  'think', 'write', 'read', 'edit', 'run', 'web', 'browse', 'delegate', 'tool', 'wait', 'error',
];

/** Narrow an untrusted string (a wire field, a stored value) to an action. */
export function isAgentAction(v: unknown): v is AgentAction {
  return typeof v === 'string' && (AGENT_ACTIONS as readonly string[]).includes(v);
}

/**
 * Names are compared folded: lower case, without `_`, `-`, `.` or spaces. The
 * providers spell the same tool several ways (`WebSearch`, `web_search`,
 * `web-search`; `MultiEdit`, `multi_edit`), and one folded table covers them all.
 */
function fold(s: string): string {
  return s.toLowerCase().replace(/[\s_.-]/g, '');
}

// Every table holds FOLDED names. Sources: Claude Code's built-in tools, the
// Codex item types (`command_execution`, `file_change`, `web_search`), the
// native engine's snake_case tools and the Topics MCP tools (`mcp__topics__*`).

const READ = new Set([
  'read', 'grep', 'glob', 'ls', 'notebookread', 'readfile', 'readfiles', 'readmultiplefiles',
  'listdir', 'listdirectory', 'listfiles', 'searchfiles', 'filesearch', 'grepsearch', 'codebasesearch',
  'findfiles', 'directorytree', 'getfileinfo', 'viewfile', 'view', 'lsp',
]);

const EDIT = new Set([
  'edit', 'write', 'multiedit', 'notebookedit', 'filechange', 'applypatch', 'writefile', 'editfile',
  'createfile', 'deletefile', 'movefile', 'strreplaceeditor', 'strreplace', 'strreplacebasededittool',
  'applydiff', 'patch',
]);

const RUN = new Set([
  'bash', 'bashoutput', 'killshell', 'killbash', 'shell', 'exec', 'execcommand', 'commandexecution',
  'localshell', 'localshellcall', 'runcommand', 'runscript', 'runterminalcmd', 'terminal', 'writestdin',
  'readprocessoutput', 'waitforprocess', 'stopprocess', 'monitor', 'powershell',
]);

const WEB = new Set([
  'websearch', 'webfetch', 'websearchcall', 'fetch', 'fetchurl', 'websearchexa', 'websearchadvancedexa',
  'querydocs', 'resolvelibraryid', 'getlibrarydocs',
]);

const BROWSE = new Set([
  'openbrowserpane', 'requestlogin', 'closebrowserpane', 'importchrome', 'computer', 'computeruse',
]);

const DELEGATE = new Set([
  'task', 'agent', 'spawnagent', 'subagent', 'sendtoagent', 'readagent', 'stopagent', 'listagents',
  'delegate', 'sendchatmessage',
]);

const WAIT = new Set([
  'askuserquestion', 'askuser', 'requestuserinput', 'exitplanmode',
]);

const THINK = new Set(['think', 'sequentialthinking', 'reasoning']);

/** MCP servers whose every tool is a web lookup, matched on the folded server name. */
const WEB_SERVER = /exa|wigolo|context7|fetch|tavily|brave|perplexity|firecrawl|websearch/;
/** MCP servers whose every tool drives a browser. */
const BROWSE_SERVER = /browser|playwright|puppeteer|chrome|chromium|webkit/;

/**
 * The action a tool call stands for, from its name as the provider reports it.
 *
 * PURE and total: any string maps to an action, an unknown one to `tool`.
 *
 * Two provider quirks are folded here, so no caller has to know them:
 *   - Codex names a `command_execution` after the COMMAND itself
 *     (`server/providers/codex.ts`, `item.command`): a name with whitespace is
 *     a command line, never a tool identifier, so it is `run`. A bare command
 *     (`pwd`, `make`) has no whitespace to tell it apart, so the caller says so
 *     with `{ command: true }` (see `isCommandCall`).
 *   - Muse reports a tool as `tool.<name>` or `tool:<name>`: the prefix goes.
 *
 * MCP names are split on `__`: `mcp__server__tool`, and through the gateway
 * `mcp__gateway__child__tool`. The tool part is classified first (so
 * `mcp__topics__spawn_agent` is `delegate`, not a generic tool), then the
 * server names (so every tool of an `exa` or `playwright` server is `web` or
 * `browse` whatever its own name says).
 */
export function classifyToolAction(name: string, opts?: { command?: boolean }): AgentAction {
  if (opts?.command) return 'run';
  const raw = (name ?? '').trim().replace(/^tool[.:]/i, '');
  if (!raw) return 'tool';
  const parts = raw.split('__').filter(Boolean);
  const isMcp = parts.length >= 2 && parts[0].toLowerCase() === 'mcp';
  if (!isMcp && /\s/.test(raw)) return 'run';
  const tool = fold(parts[parts.length - 1] ?? raw);
  const servers = isMcp ? parts.slice(1, -1).map(fold) : [];

  const byName = classifyBare(tool);
  if (byName) return byName;
  // A bare `search` is the web search of the native loop (`shared/tool-detail.ts`
  // SEARCH_NAMES); behind an MCP server it is that server's own search.
  if (!isMcp && tool === 'search') return 'web';
  for (const server of servers) {
    if (BROWSE_SERVER.test(server)) return 'browse';
    if (WEB_SERVER.test(server)) return 'web';
  }
  return 'tool';
}

/**
 * Is this tool call a shell command, named after itself?
 *
 * Codex reports a `command_execution` with the command line as the tool NAME and
 * the same string as `args.command` (`server/providers/codex.ts`). Both sides of
 * the wire can tell it from any other tool by that equality, so nothing new
 * travels and the name the person reads stays the command. PURE.
 */
export function isCommandCall(name: string | undefined, args: unknown): boolean {
  if (!name || !args || typeof args !== 'object') return false;
  const command = (args as { command?: unknown }).command;
  return typeof command === 'string' && command.trim() !== '' && command.trim() === name.trim();
}

function classifyBare(tool: string): AgentAction | null {
  if (tool.startsWith('browser') || BROWSE.has(tool)) return 'browse';
  if (DELEGATE.has(tool)) return 'delegate';
  if (WAIT.has(tool)) return 'wait';
  if (EDIT.has(tool)) return 'edit';
  if (READ.has(tool)) return 'read';
  if (RUN.has(tool)) return 'run';
  if (WEB.has(tool)) return 'web';
  if (THINK.has(tool)) return 'think';
  return null;
}

/** The fields of a stream frame `streamFrameAction` reads. */
export interface StreamFrameLite {
  type: string;
  late?: boolean;
  toolCall?: { name?: string; args?: unknown };
}

/**
 * What a chat stream frame says the agent is doing.
 *   - an action: the agent moved to it;
 *   - 'clear': the turn ended, the subject has no action any more;
 *   - null: the frame says nothing about the action (usage, alive, a partial
 *     tool output, a late frame of a turn already closed).
 * `lastTool` is the action of the last tool call of that subject: a granted
 * permission resumes THAT tool, and the frame does not carry its name.
 *
 * `stream:start` says nothing: it opens the turn before the agent does anything
 * (hooks may still be running), so showing `think` there would be a guess.
 * PURE: the server derives `stream:action` from it and the client reads the
 * frames of the chat it holds with the very same rule.
 */
export function streamFrameAction(frame: StreamFrameLite, lastTool?: AgentAction): AgentAction | 'clear' | null {
  if (frame.late) return null;
  switch (frame.type) {
    case 'stream:thinking_start':
    case 'stream:thinking_chunk':
    case 'stream:tool_result':
      return 'think';
    case 'stream:content_chunk':
      return 'write';
    case 'stream:tool_call': {
      const name = frame.toolCall?.name ?? '';
      return classifyToolAction(name, { command: isCommandCall(name, frame.toolCall?.args) });
    }
    case 'stream:tool_permission_required':
    case 'stream:tool_user_input_required':
      return 'wait';
    case 'stream:tool_permission_resolved':
      return lastTool ?? 'think';
    case 'stream:error':
      return 'error';
    case 'stream:end':
      return 'clear';
    default:
      return null;
  }
}
