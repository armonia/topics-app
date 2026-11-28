/**
 * The readable name of a tool call. Today a row outside the specific detail
 * types (`shared/tool-detail.ts`) reads as "topics · task_get": the server
 * and the bare tool name. This turns that into a sentence (Italian, like the
 * rest of the chat UI) and a `ToolCategory` to pick the right icon from:
 * read, write, search, network, browser, shell. Board tool calls already get
 * their own `task_card` detail (`shared/tool-detail.ts`'s `taskToolCall`)
 * before they ever reach here, so this module only covers what is left generic.
 *
 * Covers the Topics bridge + browser tools deterministically: a closed,
 * known list, no model needed. A third-party MCP tool this does not name
 * gets a humanized version of its own name and `guessed: true`; the client
 * may then ask the cheap model ONCE per tool name (cached on the server) and
 * pass the answer back in as `learned`. With the fallback off nothing asks,
 * and the humanized name stays.
 */
import { classifyToolAction } from './agent-action';

export type ToolCategory = 'read' | 'write' | 'search' | 'network' | 'browser' | 'shell' | 'other';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
/** The short id a reader recognizes a card by, same cut as elsewhere in the chat. */
const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

export interface Phrase { text: string; category: ToolCategory; /** True when only the humanized name was available: the caller may ask the model once per tool name. */ guessed?: boolean }

/** One entry per Topics bridge/browser tool this can phrase from its own name alone. */
function knownTopicsPhrase(tool: string, a: Record<string, unknown>): Phrase | null {
  const taskId = str(a.task_id) ?? str(a.taskId) ?? str(a.id);
  switch (tool) {
    case 'get_task': return { text: taskId ? `Legge la card ${shortId(taskId)}` : 'Legge una card', category: 'read' };
    case 'list_tasks': return { text: 'Elenca le card', category: 'read' };
    case 'create_task': return { text: 'Crea una card', category: 'write' };
    case 'update_task': return { text: taskId ? `Aggiorna la card ${shortId(taskId)}` : 'Aggiorna una card', category: 'write' };
    case 'comment_task': return { text: taskId ? `Commenta la card ${shortId(taskId)}` : 'Commenta una card', category: 'write' };
    case 'label_task': return { text: taskId ? `Etichetta la card ${shortId(taskId)}` : 'Etichetta una card', category: 'write' };
    case 'get_goal': return { text: 'Legge l’obiettivo', category: 'read' };
    case 'set_goal': return { text: 'Imposta l’obiettivo', category: 'write' };
    case 'close_goal': return { text: 'Chiude l’obiettivo', category: 'write' };
    case 'update_goal_steps': return { text: 'Aggiorna i passi', category: 'write' };
    case 'wait_for_condition': return { text: 'Aspetta una condizione', category: 'other' };
    case 'send_mail': return { text: 'Invia una mail', category: 'network' };
    case 'google_call': return { text: 'Chiama Google', category: 'network' };
    case 'read_chat_messages': return { text: 'Legge i messaggi', category: 'read' };
    case 'send_chat_message': return { text: 'Scrive un messaggio', category: 'write' };
    case 'run_command': return { text: 'Lancia un comando', category: 'shell' };
    case 'run_script': return { text: 'Lancia uno script', category: 'shell' };
    case 'list_processes': return { text: 'Elenca i processi', category: 'shell' };
    case 'read_process_output': return { text: 'Legge l’output del processo', category: 'shell' };
    case 'stop_process': return { text: 'Ferma il processo', category: 'shell' };
    case 'open_browser_pane': return { text: 'Apre una pagina', category: 'browser' };
    case 'close_browser_pane': return { text: 'Chiude una pagina', category: 'browser' };
    case 'browser_list_tabs': return { text: 'Elenca le tab', category: 'browser' };
    case 'browser_focus_tab': return { text: 'Porta avanti la tab', category: 'browser' };
    case 'import_chrome': return { text: 'Importa da Chrome', category: 'browser' };
    case 'spawn_agent': return { text: 'Avvia un sotto-agente', category: 'other' };
    case 'send_to_agent': return { text: 'Scrive al sotto-agente', category: 'other' };
    case 'read_agent': return { text: 'Legge il sotto-agente', category: 'read' };
    case 'stop_agent': return { text: 'Ferma il sotto-agente', category: 'other' };
    case 'list_agents': return { text: 'Elenca gli agenti', category: 'read' };
    case 'move_session_to_project': return { text: 'Sposta la sessione', category: 'write' };
    case 'switch_topic': return { text: 'Cambia argomento', category: 'other' };
    case 'new_topic': return { text: 'Apre un argomento', category: 'write' };
    case 'create_project': return { text: 'Crea un progetto', category: 'write' };
    case 'open_project': return { text: 'Apre un progetto', category: 'read' };
    case 'resolve_tab': return { text: 'Trova la tab', category: 'search' };
    default: return null;
  }
}

const AGENT_ACTION_TO_CATEGORY: Partial<Record<ReturnType<typeof classifyToolAction>, ToolCategory>> = {
  read: 'read', edit: 'write', run: 'shell', web: 'network', browse: 'browser',
};

/** `send_mail` -> "Send mail", `getFileInfo` -> "Get file info" — not a sentence, but readable. */
function humanize(name: string): string {
  const words = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (!words.length) return name;
  return words[0].charAt(0).toUpperCase() + words[0].slice(1) + (words.length > 1 ? ' ' + words.slice(1).join(' ') : '');
}

const NOUNS_IT: Record<string, string> = {
  status: 'lo stato', task: 'la card', tasks: 'le card', goal: 'l’obiettivo', agent: 'l’agente', agents: 'gli agenti',
  project: 'il progetto', projects: 'i progetti', process: 'il processo', processes: 'i processi', file: 'il file', files: 'i file',
};

/** `get_x` / `x_get` is a read, `list_x` / `x_list` a listing: the name alone says so, whatever the server. */
function readPhrase(tool: string, a: Record<string, unknown>): Phrase | null {
  const m = /^(get|list|read|show|describe)[_-](.+)$/i.exec(tool) ?? /^(.+)[_-](get|list|read|show)$/i.exec(tool);
  if (!m) return null;
  const front = /^(get|list|read|show|describe)$/i.test(m[1]);
  const verb = (front ? m[1] : m[2]).toLowerCase();
  const noun = (front ? m[2] : m[1]).toLowerCase();
  const id = str(a.task_id) ?? str(a.taskId) ?? str(a.id);
  const target = str(a.project) ?? str(a.name) ?? str(a.topic);
  const label = NOUNS_IT[noun] ?? humanize(noun).toLowerCase();
  const listing = verb === 'list';
  let text = `${listing ? 'Elenca' : 'Legge'} ${label}`;
  if (noun === 'task' && id) text += ` ${shortId(id)}`;
  else if (!listing && target) text += ` di ${target}`;
  return { text, category: 'read' };
}

/** A tool name that reads as a lookup even outside the fixed table. */
const SEARCH_HINT = /search|find|lookup|query|resolve/i;

/**
 * The readable phrase + icon category for a tool call outside the dedicated
 * `ToolCallDetail` types — the generic `mcp` and `unknown` rows. PURE.
 */
export function toolPhrase(rawName: string, tool: string, args: Record<string, unknown> | undefined, learned?: Phrase | null): Phrase {
  const a = args ?? {};
  const known = knownTopicsPhrase(tool, a);
  if (known) return known;
  const read = readPhrase(tool, a);
  if (read) return read;
  if (SEARCH_HINT.test(tool)) return { text: humanize(tool), category: 'search' };
  if (learned) return { text: learned.text, category: learned.category };
  const action = classifyToolAction(rawName);
  return { text: humanize(tool), category: AGENT_ACTION_TO_CATEGORY[action] ?? 'other', guessed: true };
}
