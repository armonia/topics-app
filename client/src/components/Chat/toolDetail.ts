/**
 * Client-side mirror of `server/providers/claude/tool-detail.ts`.
 *
 * Used as a fallback when a `ToolCall` arrives WITHOUT a server-provided
 * `detail` field — for example: legacy messages persisted before the
 * normalization layer existed, or providers that haven't been wired through
 * the route boundary yet (codex, openai, claude API).
 *
 * Keep this in sync with the server implementation. The server is the source
 * of truth at the streaming boundary; this is a defensive backup.
 */

import type { ToolCall, ToolCallDetail } from '../../types';
import { parseToolCallDetail } from '../../../../shared/tool-call-detail';
import { isPlanFile } from '../../../../shared/plan-file';

function canon(name: string): string {
  return (name || '').toLowerCase().trim();
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function n(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const SHELL_NAMES = new Set(['bash', 'shell', 'exec_command', 'run_command', 'terminal', 'exec']);
const READ_NAMES = new Set(['read', 'read_file', 'view_file', 'view']);
const EDIT_NAMES = new Set(['edit', 'multiedit', 'apply_patch', 'apply_diff', 'str_replace_editor', 'str_replace']);
const WRITE_NAMES = new Set(['write', 'write_file', 'create_file']);
const SEARCH_NAMES = new Set(['search', 'websearch', 'web_search']);
const FETCH_NAMES = new Set(['webfetch', 'web_fetch', 'fetch']);
/** The whole-list form: one call carries the ENTIRE todo list. */
const TODO_LIST_NAMES = new Set(['todowrite', 'todo_write']);
/** The per-item form the CLI 2.1.220 added: one call, one task. */
const TODO_ITEM_NAMES = new Set(['taskcreate', 'task_create', 'taskupdate', 'task_update']);
/**
 * Every name that can produce a `detail.type === 'todo'` here.
 *
 * Exported because `selectLatestTodo` needs the same list as a cheap pre-filter
 * (it runs on the whole transcript at every streaming frame, and Zod-parsing a
 * detail per tool call to answer "no" was the cost it avoids). That list used to
 * be a SECOND copy held in sync by a comment: a name added to the branches below
 * and not to the copy silently lost its strip. One set, two readers.
 */
export const TODO_TOOL_NAMES: ReadonlySet<string> = new Set([...TODO_LIST_NAMES, ...TODO_ITEM_NAMES]);

export function deriveToolDetail(
  name: string,
  args: Record<string, unknown> | undefined,
  result?: string,
): ToolCallDetail {
  const c = canon(name);
  const a = asRecord(args);

  if (SHELL_NAMES.has(c)) {
    return {
      type: 'shell',
      command: s(a.command) ?? s(a.cmd) ?? s(a.input) ?? '',
      ...(s(a.cwd) ? { cwd: s(a.cwd)! } : {}),
      ...(a.run_in_background === true ? { background: true } : {}),
      ...(result ? { output: result } : {}),
    };
  }

  if (READ_NAMES.has(c)) {
    return {
      type: 'read',
      filePath: s(a.file_path) ?? s(a.filePath) ?? s(a.path) ?? '',
      ...(result ? { content: result } : {}),
      ...(n(a.offset) != null ? { offset: n(a.offset)! } : {}),
      ...(n(a.limit) != null ? { limit: n(a.limit)! } : {}),
    };
  }

  if (EDIT_NAMES.has(c)) {
    if (c === 'multiedit' && Array.isArray(a.edits)) {
      const edits = a.edits as Array<Record<string, unknown>>;
      const first = edits[0] ?? {};
      const tail = edits.length > 1 ? `\n… and ${edits.length - 1} more edit(s)` : '';
      return {
        type: 'edit',
        filePath: s(a.file_path) ?? s(a.filePath) ?? '',
        ...(s(first.old_string) ? { oldString: (s(first.old_string) ?? '') + tail } : {}),
        ...(s(first.new_string) ? { newString: (s(first.new_string) ?? '') + tail } : {}),
      };
    }
    return {
      type: 'edit',
      filePath: s(a.file_path) ?? s(a.filePath) ?? s(a.path) ?? '',
      ...(s(a.old_string) ? { oldString: s(a.old_string)! } : {}),
      ...(s(a.new_string) ? { newString: s(a.new_string)! } : {}),
      ...(s(a.unified_diff) ? { unifiedDiff: s(a.unified_diff)! } : {}),
    };
  }

  if (WRITE_NAMES.has(c)) {
    const filePath = s(a.file_path) ?? s(a.filePath) ?? s(a.path) ?? '';
    const content = s(a.content);
    // Vedi il gemello lato server: una scrittura in `.claude/plans/` è il
    // PIANO, non una scrittura — è l'unico canale rimasto al modello da quando
    // la CLI non espone più `ExitPlanMode` in plan mode.
    if (content && isPlanFile(filePath)) return { type: 'plan', text: content };
    return {
      type: 'write',
      filePath,
      ...(content ? { content } : {}),
    };
  }

  if (c === 'grep') {
    const mode = s(a.output_mode);
    return {
      type: 'search',
      toolName: 'grep',
      query: s(a.pattern) ?? s(a.query) ?? '',
      ...(mode === 'files_with_matches' || mode === 'count' || mode === 'content' ? { mode } : {}),
      ...(result ? { content: result } : {}),
    };
  }
  if (c === 'glob') {
    return {
      type: 'search',
      toolName: 'glob',
      query: s(a.pattern) ?? s(a.query) ?? '',
      ...(result ? { content: result } : {}),
    };
  }
  if (SEARCH_NAMES.has(c)) {
    return {
      type: 'search',
      toolName: 'web_search',
      query: s(a.query) ?? s(a.q) ?? '',
      ...(result ? { content: result } : {}),
    };
  }

  if (FETCH_NAMES.has(c)) {
    return {
      type: 'fetch',
      url: s(a.url) ?? '',
      ...(s(a.prompt) ? { prompt: s(a.prompt)! } : {}),
      ...(result ? { result } : {}),
    };
  }

  if (TODO_LIST_NAMES.has(c)) {
    if (Array.isArray(a.todos)) {
      const items = (a.todos as Array<Record<string, unknown>>).map((t) => ({
        content: s(t.content) ?? '',
        status: ((s(t.status) ?? 'pending') as 'pending' | 'in_progress' | 'completed'),
        ...(s(t.activeForm) ? { activeForm: s(t.activeForm)! } : {}),
      }));
      return { type: 'todo', items };
    }
  }

  // TaskCreate / TaskUpdate — la CLI 2.1.220 ha affiancato al vecchio
  // `TodoWrite` (che portava l'INTERA lista in un colpo) due tool che agiscono
  // su UN task per volta. Senza questi case la todo non veniva riconosciuta e
  // cadeva nella card generica: JSON grezzo a schermo al posto della TodoCard.
  //
  // Si mappano sulla stessa forma `todo` con una voce sola — la card esiste già
  // e sa renderla, non serve un tipo nuovo.
  //
  // Ma NON sempre: una `TaskUpdate` che porta solo `{taskId, status}` non ha un
  // testo da mostrare, e una voce con etichetta vuota è PEGGIO della card
  // generica (una riga di todo senza todo). In quel caso si lascia passare
  // invece di fingere. Stessa scelta per `status: "deleted"`, che non è uno
  // stato di avanzamento: mapparlo su "completed" direbbe una cosa falsa.
  if (TODO_ITEM_NAMES.has(c)) {
    const content = s(a.subject);
    const rawStatus = s(a.status);
    const known = rawStatus === 'in_progress' || rawStatus === 'completed' || rawStatus === 'pending';
    if (content && (rawStatus === undefined || known)) {
      return {
        type: 'todo',
        items: [{
          content,
          // Un task nasce sempre `pending`: TaskCreate non porta uno status.
          status: (known ? rawStatus : 'pending') as 'pending' | 'in_progress' | 'completed',
          ...(s(a.activeForm) ? { activeForm: s(a.activeForm)! } : {}),
        }],
      };
    }
  }

  if (c === 'exitplanmode' || c === 'exit_plan_mode' || c === 'enterplanmode' || c === 'enter_plan_mode') {
    return { type: 'plan', text: s(a.plan) ?? s(a.text) ?? '' };
  }

  if (c === 'task' || c === 'agent') {
    return {
      type: 'sub_agent',
      ...(s(a.subagent_type) ? { subAgentType: s(a.subagent_type)! } : {}),
      ...(s(a.description) ? { description: s(a.description)! } : {}),
      actions: [],
      ...(result ? { result } : {}),
    };
  }

  if (c === 'monitor') {
    const ws = asRecord(a.ws);
    return {
      type: 'monitor',
      description: s(a.description) ?? '',
      ...(s(a.command) ? { command: s(a.command)! } : {}),
      ...(s(ws.url) ? { wsUrl: s(ws.url)! } : {}),
      ...(a.persistent === true ? { persistent: true } : {}),
      ...(result ? { result } : {}),
    };
  }
  if (c === 'bashoutput' || c === 'bash_output') {
    return {
      type: 'bash_output',
      shellId: s(a.bash_id) ?? s(a.shell_id) ?? s(a.id) ?? '',
      ...(s(a.filter) ? { filter: s(a.filter)! } : {}),
      ...(result ? { output: result } : {}),
    };
  }
  if (c === 'killshell' || c === 'killbash' || c === 'kill_shell' || c === 'kill_bash') {
    return {
      type: 'kill_shell',
      shellId: s(a.shell_id) ?? s(a.bash_id) ?? s(a.id) ?? '',
      ...(result ? { result } : {}),
    };
  }
  if (c === 'notebookedit' || c === 'notebook_edit') {
    return {
      type: 'notebook_edit',
      notebookPath: s(a.notebook_path) ?? s(a.notebookPath) ?? s(a.path) ?? '',
      ...(s(a.cell_id) ? { cellId: s(a.cell_id)! } : {}),
      ...(s(a.edit_mode) ? { editMode: s(a.edit_mode)! } : {}),
      ...(s(a.cell_type) ? { cellType: s(a.cell_type)! } : {}),
    };
  }
  if (c === 'skill') {
    return {
      type: 'skill',
      skill: s(a.skill) ?? s(a.name) ?? '',
      ...(s(a.args) ? { args: s(a.args)! } : {}),
      ...(result ? { result } : {}),
    };
  }
  if (c === 'slashcommand' || c === 'slash_command') {
    return {
      type: 'slash_command',
      command: s(a.command) ?? s(a.slash) ?? '',
      ...(result ? { result } : {}),
    };
  }
  if (c === 'lsp') {
    const filePath = s(a.filePath) ?? s(a.file_path);
    return {
      type: 'lsp',
      operation: s(a.operation) ?? '',
      ...(filePath ? { filePath } : {}),
      ...(s(a.query) ? { symbol: s(a.query)! } : {}),
      ...(result ? { result } : {}),
    };
  }

  if (c === 'wait_for_process' || c.endsWith('__wait_for_process')) {
    const timeout = typeof a.timeout_ms === 'number' ? a.timeout_ms : undefined;
    return {
      type: 'wait',
      processId: s(a.process_id) ?? s(a.processId) ?? '',
      ...(s(a.until) ? { until: s(a.until)! } : {}),
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
      ...(result ? { result } : {}),
    };
  }

  if (c.startsWith('mcp__')) {
    const parts = name.split('__');
    return {
      type: 'mcp',
      server: parts[1] ?? 'mcp',
      tool: parts.slice(2).join('__') || name,
      ...(args ? { args: a } : {}),
      ...(result ? { result } : {}),
    };
  }

  return {
    type: 'unknown',
    raw: {
      ...(args ? { args: a } : {}),
      ...(result ? { result } : {}),
    },
  };
}

export function resolveToolDetail(tc: ToolCall): ToolCallDetail {
  if (tc.detail) {
    // v3 foundations NORM-01: validate server-emitted detail at the renderer
    // boundary. On schema drift / malformed payload, fall back to client-side
    // derivation (graceful degradation — UI still renders, with a dev warning).
    const result = parseToolCallDetail(tc.detail);
    if (result.ok) return result.data;
    if (import.meta.env.DEV) {
      console.warn(`[toolDetail] Invalid detail for ${tc.name}: ${result.error}`);
    }
  }
  return deriveToolDetail(tc.name, tc.args, tc.result);
}

/**
 * Il piano in UNA riga, per la testata della riga chiusa.
 *
 * Il testo grezzo ci finiva com'era scritto — `# Piano 1. **Primo passo** — …`:
 * a card chiusa la punteggiatura del markdown non struttura niente, è solo
 * rumore che consuma gli 80 caratteri che si leggono davvero. Qui si toglie la
 * sintassi e si tiene il testo, che è l'unica cosa che quella riga può dire.
 */
function planSummary(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*|__|[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * One-line human summary of a tool's arguments for the collapsed row header:
 * scalar values joined as `key: value`, long strings truncated, objects and
 * arrays skipped. Keeps MCP/unknown rows self-explanatory without expanding.
 */
function summarizeArgs(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null || typeof v === 'object' || typeof v === 'function') continue;
    let s = String(v);
    if (s.length > 48) s = s.slice(0, 45) + '…';
    parts.push(`${k}: ${s}`);
    if (parts.join(' · ').length > 80) break;
  }
  return parts.length ? parts.join(' · ') : undefined;
}

export function buildToolDisplayLabel(detail: ToolCallDetail, rawName?: string): { name: string; summary?: string } {
  switch (detail.type) {
    case 'shell':
      return { name: detail.background ? 'Shell (background)' : 'Shell', summary: detail.command };
    case 'read':
      return { name: 'Read', summary: stripCwd(detail.filePath) };
    case 'edit':
      return { name: 'Edit', summary: stripCwd(detail.filePath) };
    case 'write':
      return { name: 'Write', summary: stripCwd(detail.filePath) };
    case 'search': {
      const map = { search: 'Search', grep: 'Grep', glob: 'Glob', web_search: 'WebSearch' } as const;
      return { name: detail.toolName ? map[detail.toolName] : 'Search', summary: detail.query };
    }
    case 'fetch':
      return { name: 'Fetch', summary: detail.url };
    case 'todo': {
      // Progress + the item being worked on right now — "3 items" told the
      // reader nothing without expanding.
      const done = detail.items.filter((t) => t.status === 'completed').length;
      const active = detail.items.find((t) => t.status === 'in_progress');
      const activeText = active ? ` · ${active.activeForm ?? active.content}` : '';
      return { name: 'Todo', summary: `${done}/${detail.items.length}${activeText}` };
    }
    case 'sub_agent':
      return {
        name: detail.subAgentType ?? 'Task',
        summary: detail.description,
      };
    case 'plan':
      return { name: 'Plan', summary: planSummary(detail.text) };
    case 'mcp':
      return { name: `${detail.server} · ${detail.tool}`, summary: summarizeArgs(detail.args) };
    case 'monitor':
      return { name: 'Monitor', summary: detail.description || detail.command || detail.wsUrl };
    case 'wait':
      return {
        name: 'Wait',
        summary: detail.until ? `${detail.processId} · /${detail.until}/` : detail.processId,
      };
    case 'bash_output':
      return { name: 'BashOutput', summary: detail.filter ? `${detail.shellId} · /${detail.filter}/` : detail.shellId };
    case 'kill_shell':
      return { name: 'KillShell', summary: detail.shellId };
    case 'notebook_edit':
      return { name: 'NotebookEdit', summary: stripCwd(detail.notebookPath) };
    case 'skill':
      // Con la barra: è come la si invoca e come la si nomina parlando, e
      // distingue a colpo d'occhio il nome di una skill da un argomento.
      return { name: 'Skill', summary: detail.args ? `/${detail.skill} ${detail.args}` : `/${detail.skill}` };
    case 'slash_command':
      return { name: 'SlashCommand', summary: detail.command };
    case 'lsp':
      return { name: 'LSP', summary: detail.symbol ? `${detail.operation} · ${detail.symbol}` : detail.operation };
    case 'unknown':
      // A bare "Tool" row is unreadable — surface the provider's actual tool
      // name plus a scalar-args digest so the collapsed row stands on its own.
      return { name: rawName || 'Tool', summary: summarizeArgs(detail.raw.args) };
  }
}

/** Oltre questa lunghezza il percorso si accorcia IN MEZZO. */
const PATH_MAX = 44;

/**
 * Il percorso senza la parte che è uguale per tutti, e — se resta ancora
 * lungo — accorciato nel MEZZO invece che in coda.
 *
 * L'ellissi la metteva il CSS (`truncate`), che taglia a destra: su
 * `client/src/components/Chat/MessageMetaFooter.tsx` restava
 * `client/src/components/Ch…`, cioè si perdeva l'unica parte che distingue una
 * riga dall'altra — il nome del file. Meglio sacrificare il mezzo: la cartella
 * di testa dice dove sei, il nome dice cosa hai toccato.
 */
function stripCwd(path: string): string {
  if (!path) return path;
  let out = path;
  const projectsIdx = path.indexOf('/Projects/');
  if (projectsIdx >= 0) {
    const rest = path.slice(projectsIdx + 10);
    const slash = rest.indexOf('/');
    out = slash >= 0 ? rest.slice(slash + 1) : rest;
  } else {
    const m = /^\/Users\/[^/]+\/(.+)$/.exec(path);
    if (m) out = m[1];
  }
  return elideMiddle(out);
}

/** `a/b/c/d/e/file.ts` → `a/…/e/file.ts`: si tolgono i segmenti di mezzo, mai
 *  il primo e mai gli ultimi due. Se non basta, si lascia com'è: un percorso
 *  lungo e leggibile batte un moncone. */
export function elideMiddle(p: string, max: number = PATH_MAX): string {
  if (p.length <= max) return p;
  const parts = p.split('/');
  if (parts.length < 4) return p;
  const head = parts[0];
  const tail = parts.slice(-2).join('/');
  const short = `${head}/…/${tail}`;
  return short.length < p.length ? short : p;
}
