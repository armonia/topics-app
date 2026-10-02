/**
 * The renderer's side of a tool call's detail: validate what the server sent,
 * pick the card, write the one-line header.
 *
 * It derives NOTHING of its own. The mapping from a tool name + args to a
 * `ToolCallDetail` lives once, in `shared/tool-detail.ts`, which the server
 * runs at the provider boundary and this file runs only for a tool call that
 * reached it without a usable `detail` (rows stored before the boundary
 * existed). It used to be a second copy here, "kept in sync" by a comment, and
 * it had drifted: the goal-steps rule existed only on this side.
 */

import type { ToolCall, ToolCallDetail } from '../../types';
import { parseToolCallDetail } from '../../../../shared/tool-call-detail';
import { deriveToolDetail, goalStepsAsTodo, isGoalStepsTool, isSetGoalTool, pageHost } from '../../../../shared/tool-detail';

export function resolveToolDetail(tc: ToolCall): ToolCallDetail {
  // A failed call opened nothing. The SDK path keeps the detail it built at
  // tool start (no result yet, so `browser`), and a marker over an error would
  // say the page is there when it is not.
  if (tc.status === 'error' && tc.detail?.type === 'browser') {
    return deriveToolDetail(tc.name, { ...tc.args, url: tc.detail.url }, tc.result, { failed: true });
  }
  if (tc.detail) {
    // v3 foundations NORM-01: validate server-emitted detail at the renderer
    // boundary. On schema drift / malformed payload, fall back to client-side
    // derivation (graceful degradation — UI still renders, with a dev warning).
    const result = parseToolCallDetail(tc.detail);
    // Rows stored before the server adopted the goal-steps rule carry them as
    // `mcp` (arguments inside `detail.args`, top-level `args` emptied by the
    // history trim): the todo is derived from there, or that history stays JSON.
    if (result.ok && result.data.type === 'mcp' && isGoalStepsTool(tc.name)) {
      const todo = goalStepsAsTodo(result.data.args);
      if (todo) return todo;
    }
    // Same for the browser openings stored before they had a type of their own
    // (CHAT-BROWSER-03): the url is in `detail.args` when history trimmed `args`.
    if (result.ok && result.data.type === 'mcp') {
      const browser = deriveToolDetail(tc.name, { ...result.data.args, ...tc.args }, tc.result ?? result.data.result,
        { failed: tc.status === 'error' });
      if (browser.type === 'browser') return browser;
    }
    // A detail the server could not type is now KEPT as `unknown` instead of
    // being deleted (server/utils.ts), so nothing is lost on the wire. The
    // renderer still prefers what it can derive from the tool NAME: a generic
    // JSON blob is the last resort, not the first answer. Without this the
    // degradation would trade a dropped detail for a permanently generic row.
    if (result.ok && result.data.type !== 'unknown') return result.data;
    if (result.ok) {
      const derived = deriveToolDetail(tc.name, tc.args, tc.result, { failed: tc.status === 'error' });
      return derived.type === 'unknown' ? result.data : derived;
    }
    if (import.meta.env.DEV) {
      console.warn(`[toolDetail] Invalid detail for ${tc.name}: ${result.error}`);
    }
  }
  return deriveToolDetail(tc.name, tc.args, tc.result, { failed: tc.status === 'error' });
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

/**
 * Leading `cd <dir> && ` of a shell command, repeated as many times as needed.
 *
 * Agents open almost every Bash call with a `cd` into the project, and in the
 * closed row header that prefix ate the ~80 characters that get read: the real
 * command was cut off. Only `&&` (a `;` or a bare `cd` is something else) and
 * only in the HEADER: the open card shows the whole command.
 */
const LEADING_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/;
function stripLeadingCd(command: string): string {
  let out = command;
  for (let m = LEADING_CD.exec(out); m && m[0].length < out.length; m = LEADING_CD.exec(out)) {
    out = out.slice(m[0].length);
  }
  return out;
}

/**
 * `tooltip`: hover text for the summary, set only when the summary stands in
 * for something else (a Bash description in place of its command).
 */
export function buildToolDisplayLabel(detail: ToolCallDetail, rawName?: string): { name: string; summary?: string; tooltip?: string } {
  switch (detail.type) {
    case 'shell': {
      const name = detail.background ? 'Shell (background)' : 'Shell';
      // The model's own "Run unit tests" reads better than the command; the
      // command stays on hover and, whole, in the open card.
      if (detail.description) return { name, summary: detail.description, tooltip: detail.command };
      return { name, summary: stripLeadingCd(detail.command) };
    }
    case 'read':
      return { name: 'Read', summary: stripCwd(detail.filePath) };
    case 'edit':
      return { name: 'Edit', summary: stripCwd(detail.filePath) };
    case 'write':
      return { name: 'Write', summary: stripCwd(detail.filePath) };
    case 'search': {
      const map = { search: 'Search', grep: 'Grep', glob: 'Glob', web_search: 'WebSearch', tool_search: 'ToolSearch' } as const;
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
      return {
        name: rawName && isGoalStepsTool(rawName) ? 'Goal steps' : 'Todo',
        summary: `${done}/${detail.items.length}${activeText}`,
      };
    }
    case 'sub_agent':
      if (detail.via === 'spawn_agent') return { name: 'Sub-agent', summary: detail.name ?? detail.description };
      return {
        name: detail.subAgentType ?? 'Task',
        summary: detail.description,
      };
    case 'plan':
      return { name: 'Plan', summary: planSummary(detail.text) };
    case 'mcp':
      // The goal is a sentence: it reads whole, not as "content: ...".
      if (isSetGoalTool(detail.tool) && typeof detail.args?.content === 'string') {
        return { name: 'Goal', summary: detail.args.content };
      }
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
    case 'agent_message':
      return { name: 'SendMessage', summary: detail.summary ?? detail.to };
    case 'agent_control': {
      const names = { list: 'ListAgents', output: 'TaskOutput', stop: 'TaskStop' } as const;
      return { name: names[detail.op], ...(detail.target ? { summary: detail.target } : {}) };
    }
    case 'artifact':
      return { name: 'Artifact', summary: detail.title ?? detail.url ?? detail.action };
    case 'ask_user':
      // The question itself: the one tool whose purpose is to be read.
      return { name: 'AskUserQuestion', summary: detail.questions[0]?.question };
    case 'browser':
      // The page, the way the marker names it; the whole URL on hover.
      return { name: 'Browser', summary: browserPageLabel(detail), tooltip: detail.url };
    case 'unknown':
      // A bare "Tool" row is unreadable — surface the provider's actual tool
      // name plus a scalar-args digest so the collapsed row stands on its own.
      return { name: rawName || 'Tool', summary: summarizeArgs(detail.raw.args) };
  }
}

/** What a browser opening is called: the agent's name for the tab, else the
 *  page's title, else its host. */
export function browserPageLabel(detail: { url: string; name?: string; title?: string }): string {
  return detail.name || detail.title || pageHost(detail.url);
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
