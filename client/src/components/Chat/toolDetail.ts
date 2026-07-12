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
import { parseToolCallDetail } from '../../schemas/tool-call-detail';

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
    return {
      type: 'write',
      filePath: s(a.file_path) ?? s(a.filePath) ?? s(a.path) ?? '',
      ...(s(a.content) ? { content: s(a.content)! } : {}),
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

  if (c === 'todowrite' || c === 'todo_write') {
    if (Array.isArray(a.todos)) {
      const items = (a.todos as Array<Record<string, unknown>>).map((t) => ({
        content: s(t.content) ?? '',
        status: ((s(t.status) ?? 'pending') as 'pending' | 'in_progress' | 'completed'),
        ...(s(t.activeForm) ? { activeForm: s(t.activeForm)! } : {}),
      }));
      return { type: 'todo', items };
    }
  }

  if (c === 'exitplanmode' || c === 'exit_plan_mode') {
    return { type: 'plan', text: s(a.plan) ?? s(a.text) ?? '' };
  }

  if (c === 'task') {
    return {
      type: 'sub_agent',
      ...(s(a.subagent_type) ? { subAgentType: s(a.subagent_type)! } : {}),
      ...(s(a.description) ? { description: s(a.description)! } : {}),
      actions: [],
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
      return { name: 'Shell', summary: detail.command };
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
      return { name: 'Plan', summary: detail.text.slice(0, 80) };
    case 'mcp':
      return { name: `${detail.server} · ${detail.tool}`, summary: summarizeArgs(detail.args) };
    case 'unknown':
      // A bare "Tool" row is unreadable — surface the provider's actual tool
      // name plus a scalar-args digest so the collapsed row stands on its own.
      return { name: rawName || 'Tool', summary: summarizeArgs(detail.raw.args) };
  }
}

function stripCwd(path: string): string {
  if (!path) return path;
  const projectsIdx = path.indexOf('/Projects/');
  if (projectsIdx >= 0) {
    const rest = path.slice(projectsIdx + 10);
    const slash = rest.indexOf('/');
    return slash >= 0 ? rest.slice(slash + 1) : rest;
  }
  const m = /^\/Users\/[^/]+\/(.+)$/.exec(path);
  if (m) return m[1];
  return path;
}
