import type {
  TopicsData,
  Topic,
  CreateTopicRequest,
  UpdateTopicRequest,
  LinkTopicRequest,
  ChatRequest,
  HistoryRequest,
  HistoryResponse,
  HistoryMessage,
  UploadResponse,
  SearchResult,
  FileNode,
  GitStatus,
  GitBranch,
  GitLogEntry,
  ProvidersSnapshot,
  ProviderSnapshotEntry,
  Project,
  Worktree,
} from '../types';
import { serverHttpBase } from './shell/net';

// Relative on web/PWA/Electron (same-origin). Under the Tauri desktop shell the
// UI is served locally (tauri://localhost), so a global fetch shim rewrites these
// relative paths to the data server origin — see installDesktopFetchShim() in
// lib/shell/net.ts (PORTING-PLAN.md Tier 1). Callsites stay unchanged.
const API_BASE = '/api';

export class ApiError extends Error {
  [key: string]: unknown;
  constructor(public status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    if (extra) Object.assign(this, extra);
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text || response.statusText;
    let extra: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.error === 'string') message = obj.error;
        const { error: _, ...rest } = obj;
        if (Object.keys(rest).length) extra = rest;
      }
    } catch {}
    throw new ApiError(response.status, message, extra);
  }

  return response.json();
}

// ─── Response-envelope convention ─────────────────────────────────────────────
//
// The server wraps most collection responses in a single-key envelope
// (`{ tasks }`, `{ providers }`, `{ webhooks }`, `{ points }`, …). This file is
// deliberately mixed about how that envelope is surfaced to callers:
//
//   • List methods that return the bare array (`agentProfilesApi.list`,
//     `dashboardApi.getTimeSeries/getAgentStats`) `await request<{ key: T[] }>`
//     and return `.key` — the caller never sees the envelope.
//   • The remaining methods (`searchApi.search`, `providersApi.snapshot`, …)
//     return the envelope verbatim so the caller destructures
//     `{ results }` / `{ providers }` itself.
//
// Both are intentional and load-bearing for existing callers — do NOT
// "normalise" one into the other without updating every call site. When adding
// a new endpoint, match the convention already used by its sibling methods.

// Topics API
export const topicsApi = {
  async getAll(signal?: AbortSignal): Promise<TopicsData> {
    return request<TopicsData>('/topics', { signal });
  },

  async create(data: CreateTopicRequest): Promise<Topic> {
    return request<Topic>('/topics', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  /**
   * Open a cloud (gateway) session as a first-class, interactive Topics chat.
   * Idempotent server-side: returns the existing topic if one already owns the
   * sessionKey, otherwise creates an openclaw-backed topic bound to it.
   */
  async adoptSession(sessionKey: string, name?: string): Promise<Topic> {
    return request<Topic>('/topics/adopt', {
      method: 'POST',
      body: JSON.stringify({ sessionKey, name }),
    });
  },

  async update(id: string, data: UpdateTopicRequest): Promise<Topic> {
    return request<Topic>(`/topics/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async archive(id: string, archived: boolean = true): Promise<Topic> {
    return request<Topic>(`/topics/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ archived }),
    });
  },

  async bulkArchive(projectPath: string, archived: boolean): Promise<{ ok: boolean; count: number; topics: Topic[] }> {
    return request<{ ok: boolean; count: number; topics: Topic[] }>('/topics/bulk-archive', {
      method: 'POST',
      body: JSON.stringify({ projectPath, archived }),
    });
  },

  async link(id: string, data: LinkTopicRequest): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/topics/${id}/link`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async unlink(id: string, targetId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/topics/${id}/link/${targetId}`, {
      method: 'DELETE',
    });
  },

  async reorder(order: string[]): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/topics/reorder', {
      method: 'POST',
      body: JSON.stringify({ order }),
    });
  },

  async markRead(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/topics/${id}/read`, {
      method: 'POST',
    });
  },
};

// Chat API
export const chatApi = {
  async sendMessage(data: ChatRequest, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    const response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }

    return response.body;
  },

  async abort(sessionKey: string, clearMessages?: boolean): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/chat/abort', {
      method: 'POST',
      body: JSON.stringify({ sessionKey, clearMessages }),
    });
  },

  /**
   * Submit the user's answer to a tool that paused the stream (the
   * `AskUserQuestion`/elicitation flow). The server validates against
   * its in-memory pending-input registry, persists the response onto
   * the assistant message, and re-injects the result into the provider
   * stream so the existing turn resumes — no new model round-trip.
   *
   * Errors map to specific HTTP codes:
   *   - 404 `no pending input` — already submitted, or aborted
   *   - 503                    — provider missing the capability
   *   - 502                    — provider rejected the resume
   * Callers should surface these inline (form stays editable on 502,
   * collapses with a "already answered" hint on 404).
   */
  async toolResponse(
    sessionKey: string,
    toolCallId: string,
    response: import('../types').ToolUserResponse,
  ): Promise<{ ok: boolean; submittedAt: string }> {
    return request<{ ok: boolean; submittedAt: string }>('/chat/tool-response', {
      method: 'POST',
      body: JSON.stringify({ sessionKey, toolCallId, response }),
    });
  },

  async getHistory(sessionKey: string, data: HistoryRequest = {}): Promise<HistoryResponse> {
    return request<HistoryResponse>(`/history/${encodeURIComponent(sessionKey)}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async editMessage(messageId: string, content: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    const response = await fetch(`${API_BASE}/messages/${encodeURIComponent(messageId)}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }
    return response.body;
  },

  /** Regenerate an assistant reply — same SSE contract as editMessage. */
  async regenerateMessage(messageId: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    const response = await fetch(`${API_BASE}/messages/${encodeURIComponent(messageId)}/regenerate`, {
      method: 'POST',
      signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }
    return response.body;
  },

  /** Delete a message + its descendant branches; returns the repaired thread. */
  async deleteMessage(messageId: string): Promise<{ messages: HistoryMessage[] }> {
    return request<{ messages: HistoryMessage[] }>(`/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
  },

  async switchBranch(messageId: string, branchIndex: number): Promise<{ messages: HistoryMessage[] }> {
    return request<{ messages: HistoryMessage[] }>(`/messages/${encodeURIComponent(messageId)}/switch-branch`, {
      method: 'POST',
      body: JSON.stringify({ branchIndex }),
    });
  },
};

// Search API
export const searchApi = {
  async search(query: string, limit = 50): Promise<{ results: SearchResult[] }> {
    return request<{ results: SearchResult[] }>('/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    });
  },
};

// Upload API
export const uploadApi = {
  async uploadFile(file: File): Promise<UploadResponse> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${API_BASE}/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }

    return response.json();
  },

  async uploadContextFile(file: File, topicId: string): Promise<UploadResponse> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('topicId', topicId);

    const response = await fetch(`${API_BASE}/context-upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }

    return response.json();
  },

  async deleteContextFile(topicId: string, filePath: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/context-file', {
      method: 'DELETE',
      body: JSON.stringify({ topicId, filePath }),
    });
  },
};

// Media API
export function getMediaUrl(path: string): string {
  // Absolute verso il data server: gli <img src> NON passano dal fetch shim
  // (riscrive solo fetch()), quindi sotto Tauri un URL relativo si risolve
  // contro tauri://localhost → 404 dell'asset protocol → immagine rotta "?".
  // serverHttpBase() = '' sul web (comportamento invariato), proxy loopback
  // sul desktop.
  // /uploads/ paths are served directly by the Topics server
  if (path.startsWith('/uploads/')) return `${serverHttpBase()}${path}`;
  return `${serverHttpBase()}${API_BASE}/media?path=${encodeURIComponent(path)}`;
}

// Files API
export const filesApi = {
  async list(path: string, depth = 3): Promise<FileNode[]> {
    return request<FileNode[]>(`/files?path=${encodeURIComponent(path)}&depth=${depth}`);
  },

  async content(path: string): Promise<string> {
    const response = await fetch(`${API_BASE}/files/content?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }
    return response.text();
  },

  async search(path: string, query: string, regex = false, caseSensitive = false): Promise<{ results: { file: string; line: string; lineNumber: number; match: string }[] }> {
    const params = new URLSearchParams({ q: query, path, regex: String(regex), caseSensitive: String(caseSensitive) });
    return request<{ results: { file: string; line: string; lineNumber: number; match: string }[] }>(`/files/search?${params}`);
  },

  async save(path: string, content: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/files/save', {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    });
  },

  async applyEdit(filePath: string, searchText: string, replaceText: string): Promise<{ ok: boolean; method?: string; error?: string }> {
    return request<{ ok: boolean; method?: string; error?: string }>('/files/apply-edit', {
      method: 'POST',
      body: JSON.stringify({ filePath, searchText, replaceText }),
    });
  },

  async undoEdit(filePath: string): Promise<{ ok: boolean; error?: string }> {
    return request<{ ok: boolean; error?: string }>('/files/undo-edit', {
      method: 'POST',
      body: JSON.stringify({ filePath }),
    });
  },

  async create(path: string, type: 'file' | 'dir' = 'file'): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/files/create', {
      method: 'POST',
      body: JSON.stringify({ path, type }),
    });
  },

  async rename(oldPath: string, newPath: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/files/rename', {
      method: 'POST',
      body: JSON.stringify({ oldPath, newPath }),
    });
  },

  async remove(path: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/files/delete', {
      method: 'DELETE',
      body: JSON.stringify({ path }),
    });
  },

  async move(from: string, to: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/files/move', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    });
  },

  async copy(from: string, to: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/files/copy', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    });
  },

  async duplicate(path: string): Promise<{ ok: boolean; newPath: string }> {
    return request<{ ok: boolean; newPath: string }>('/files/duplicate', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async flatList(path: string, maxFiles = 2000): Promise<{ files: string[] }> {
    return request<{ files: string[] }>(`/files/flat?path=${encodeURIComponent(path)}&maxFiles=${maxFiles}`);
  },

  async reveal(path: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/files/reveal', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async packageScripts(path: string): Promise<{ scripts: Record<string, string>; engines?: Record<string, string> }> {
    return request<{ scripts: Record<string, string>; engines?: Record<string, string> }>(`/files/package-scripts?path=${encodeURIComponent(path)}`);
  },

  async uploadFiles(targetDir: string, files: File[], relativePaths?: string[], emptyDirs?: string[]): Promise<{ ok: boolean; uploaded: string[] }> {
    const formData = new FormData();
    formData.append('targetDir', targetDir);
    files.forEach(f => formData.append('files', f));
    if (relativePaths) formData.append('relativePaths', JSON.stringify(relativePaths));
    if (emptyDirs && emptyDirs.length > 0) formData.append('emptyDirs', JSON.stringify(emptyDirs));
    const response = await fetch(`${API_BASE}/files/upload`, { method: 'POST', body: formData });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }
    return response.json();
  },
};

// Git API
export const gitApi = {
  async status(path: string): Promise<GitStatus> {
    return request<GitStatus>(`/git/status?path=${encodeURIComponent(path)}`);
  },

  async diff(path: string, file: string): Promise<string> {
    const response = await fetch(
      `${API_BASE}/git/diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }
    return response.text();
  },

  async branches(path: string): Promise<GitBranch[]> {
    return request<GitBranch[]>(`/git/branches?path=${encodeURIComponent(path)}`);
  },

  async checkout(path: string, branch: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/checkout', {
      method: 'POST',
      body: JSON.stringify({ path, branch }),
    });
  },

  async log(path: string, limit = 20): Promise<GitLogEntry[]> {
    return request<GitLogEntry[]>(`/git/log?path=${encodeURIComponent(path)}&limit=${limit}`);
  },

  async stage(path: string, file: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/stage', {
      method: 'POST',
      body: JSON.stringify({ path, file }),
    });
  },

  async unstage(path: string, file: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/unstage', {
      method: 'POST',
      body: JSON.stringify({ path, file }),
    });
  },

  async commit(path: string, message: string, files?: string[]): Promise<{ ok: boolean; output: string }> {
    return request<{ ok: boolean; output: string }>('/git/commit', {
      method: 'POST',
      body: JSON.stringify({ path, message, files }),
    });
  },

  async pull(path: string): Promise<{ ok: boolean; output: string }> {
    return request<{ ok: boolean; output: string }>('/git/pull', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async push(path: string): Promise<{ ok: boolean; output: string }> {
    return request<{ ok: boolean; output: string }>('/git/push', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async show(path: string, file: string): Promise<string> {
    const response = await fetch(
      `${API_BASE}/git/show?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }
    return response.text();
  },

  async lineChanges(path: string, file: string): Promise<{ changes: { from: number; to: number; type: 'added' | 'modified' | 'deleted' }[] }> {
    return request<{ changes: { from: number; to: number; type: 'added' | 'modified' | 'deleted' }[] }>(`/git/line-changes?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`);
  },

  async stageAll(path: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/stage-all', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async unstageAll(path: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/unstage-all', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async discard(path: string, file: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/discard', {
      method: 'POST',
      body: JSON.stringify({ path, file }),
    });
  },

  async stageFiles(path: string, files: string[]): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/stage', {
      method: 'POST',
      body: JSON.stringify({ path, files }),
    });
  },

  async unstageFiles(path: string, files: string[]): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/unstage', {
      method: 'POST',
      body: JSON.stringify({ path, files }),
    });
  },

  async discardFiles(path: string, files: string[]): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/discard', {
      method: 'POST',
      body: JSON.stringify({ path, files }),
    });
  },

  async diffSummary(path: string): Promise<{ message: string; stat: string; files: { added: string[]; modified: string[]; deleted: string[]; untracked: string[] } }> {
    return request<{ message: string; stat: string; files: { added: string[]; modified: string[]; deleted: string[]; untracked: string[] } }>(`/git/diff-summary?path=${encodeURIComponent(path)}`);
  },

  async aiCommitMessage(path: string): Promise<{ message: string }> {
    return request<{ message: string }>('/git/ai-commit-message', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async init(path: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/init', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  },

  async createBranch(path: string, name: string, checkout = true): Promise<{ ok: boolean; branch: string }> {
    return request<{ ok: boolean; branch: string }>('/git/create-branch', {
      method: 'POST',
      body: JSON.stringify({ path, name, checkout }),
    });
  },

  async deleteBranch(path: string, name: string, force = false): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/delete-branch', {
      method: 'POST',
      body: JSON.stringify({ path, name, force }),
    });
  },

  async remotes(path: string): Promise<{ name: string; fetchUrl: string; pushUrl: string }[]> {
    return request<{ name: string; fetchUrl: string; pushUrl: string }[]>(`/git/remotes?path=${encodeURIComponent(path)}`);
  },

  async addRemote(path: string, name: string, url: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/remote-add', {
      method: 'POST',
      body: JSON.stringify({ path, name, url }),
    });
  },

  async removeRemote(path: string, name: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/remote-remove', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    });
  },
};

// Auto-name API
export const autoNameApi = {
  async autoName(topicId: string): Promise<{ title: string; icon: string; suggestedProject: string | null }> {
    return request<{ title: string; icon: string; suggestedProject: string | null }>(`/topics/${topicId}/auto-name`, {
      method: 'POST',
    });
  },
};

// OpenClaw Control API
export const openclawControlApi = {
  async restart(): Promise<{ ok: boolean; output?: string; error?: string }> {
    return request<{ ok: boolean; output?: string; error?: string }>('/openclaw/restart', {
      method: 'POST',
    });
  },
};

// Scripts API (npm scripts run in background)
export interface ScriptProcessInfo {
  processId: string;
  scriptName: string;
  command: string;
  projectPath: string;
  status: 'running' | 'done' | 'error';
  pid: number | null;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  ports: number[];
  /** 'detected' = auto-discovered server started inside a Claude session (logs
   *  not captured); 'script'/undefined = launched via Topics run_script/UI. */
  source?: 'script' | 'detected';
}

export const scriptsApi = {
  async run(projectPath: string, scriptName: string): Promise<{ processId: string; scriptName: string; pid: number; startedAt: string }> {
    return request<{ processId: string; scriptName: string; pid: number; startedAt: string }>('/scripts/run', {
      method: 'POST',
      body: JSON.stringify({ projectPath, scriptName }),
    });
  },

  async list(): Promise<{ scripts: ScriptProcessInfo[] }> {
    return request<{ scripts: ScriptProcessInfo[] }>('/scripts');
  },

  async output(processId: string, offset = 0): Promise<{ output: string; offset: number; done: boolean; status: string; exitCode?: number }> {
    return request<{ output: string; offset: number; done: boolean; status: string; exitCode?: number }>(`/scripts/${processId}/output?offset=${offset}`);
  },

  async stop(processId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/scripts/${processId}/stop`, {
      method: 'POST',
    });
  },
};

// Command API (slash commands)
export interface CommandResult {
  ok: boolean;
  command: string;
  output?: string;
  message?: string;
  model?: string;
  error?: string;
}

export interface CustomSlashCommand { name: string; description: string; kind: 'command' | 'skill'; }

/** The user's custom slash commands + skills (for composer autocomplete). The
 *  headless CLI expands them; the composer only surfaces them. Best-effort. */
export const slashCommandsApi = {
  async list(): Promise<CustomSlashCommand[]> {
    return request<CustomSlashCommand[]>('/slash-commands');
  },
};

export const commandApi = {
  async execute(sessionKey: string, command: string, args?: Record<string, unknown>): Promise<CommandResult> {
    return request<CommandResult>('/command', {
      method: 'POST',
      body: JSON.stringify({ sessionKey, command, args }),
    });
  },

  async status(sessionKey: string): Promise<CommandResult> {
    return this.execute(sessionKey, 'status');
  },

  async clear(sessionKey: string): Promise<CommandResult> {
    return this.execute(sessionKey, 'clear');
  },

  async setModel(sessionKey: string, model: string): Promise<CommandResult> {
    return this.execute(sessionKey, 'model', { model });
  },

  async toggleReasoning(sessionKey: string): Promise<CommandResult> {
    return this.execute(sessionKey, 'reasoning');
  },

  async setEffort(sessionKey: string, level: string): Promise<CommandResult> {
    return this.execute(sessionKey, 'effort', { level });
  },

  async project(sessionKey: string, sub: 'create' | 'open' | 'info' = 'info', value?: string): Promise<CommandResult> {
    return this.execute(sessionKey, 'project', { sub, value });
  },
};

// Memory API
export interface MemoryData {
  topicContent: string;
  globalContent: string;
  topicId: string;
}

export const memoryApi = {
  async getForTopic(topicId: string): Promise<MemoryData> {
    return request<MemoryData>(`/memory/${topicId}`);
  },

  async updateTopic(topicId: string, content: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/memory/${topicId}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  async appendToTopic(topicId: string, content: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/memory/${topicId}/append`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  },

  async getGlobal(): Promise<{ content: string }> {
    return request<{ content: string }>('/memory');
  },

  async updateGlobal(content: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/memory', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  async deleteTopic(topicId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/memory/topic/${topicId}`, {
      method: 'DELETE',
    });
  },

  async deleteGlobal(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/memory/global', {
      method: 'DELETE',
    });
  },
};

// OpenClaw Context API
export interface OpenClawContextFile {
  content: string;
  tokens: number;
}

export interface MemoryTreeNode {
  path: string;
  name: string;
  type: 'file' | 'dir';
  tokens?: number;
  children?: MemoryTreeNode[];
}

export interface OpenClawContextResponse {
  soul: OpenClawContextFile | null;
  memory: OpenClawContextFile | null;
  agents: OpenClawContextFile | null;
  tools: OpenClawContextFile | null;
  identity: OpenClawContextFile | null;
  user: OpenClawContextFile | null;
  memoryIndex: MemoryTreeNode[];
  memoryTokens: number;
  totalTokens: number;
  workspacePath: string;
}

export interface ContextSource {
  id: string;
  label: string;
  category: 'openclaw' | 'memory' | 'prompt' | 'template' | 'file' | 'pinned';
  tokens: number;
  enabled: boolean;
  editable: boolean;
  preview?: string;
  countInBudget: boolean;
}

export interface ContextWarning {
  type: string;
  detail: string;
}

export interface ContextAnalysis {
  sources: ContextSource[];
  totalTokens: number;
  budgetLimit: number;
  budgetPercent: number;
  warnings: ContextWarning[];
}

export const openclawContextApi = {
  async getAll(): Promise<OpenClawContextResponse> {
    return request<OpenClawContextResponse>('/openclaw/context');
  },

  async readFile(path: string): Promise<{ content: string; tokens: number; path: string }> {
    return request<{ content: string; tokens: number; path: string }>(`/openclaw/context/file?path=${encodeURIComponent(path)}`);
  },
};

export const contextAnalysisApi = {
  async analyze(topicId: string): Promise<ContextAnalysis> {
    return request<ContextAnalysis>(`/context/analyze?topicId=${encodeURIComponent(topicId)}`);
  },
};

// ─── Canonical Context Envelope (introduced by `topic-context-canonical`) ──
//
// Preview endpoint returns the *exact* envelope the chat streaming path
// would build right now, plus the `payload` that would be handed to
// `provider.sendChat`. The legacy `contextAnalysisApi.analyze` is a thin
// projection of this same data — both are produced by `assembleTopicContext`
// server-side. Inspector components SHOULD prefer the preview API for any
// new functionality (history visibility, adaptation notes, last-sent diff)
// while the legacy `analyze` keeps existing behaviour.

export type EnvelopeSystemBlockCategory =
  | 'openclaw' | 'memory' | 'prompt' | 'template' | 'file' | 'pinned' | 'synthetic';
export type EnvelopeProviderStrategy =
  | 'history-aware' | 'inline-system' | 'gateway-stateful';

export interface EnvelopeSystemBlock {
  id: string;
  label: string;
  category: EnvelopeSystemBlockCategory;
  content: string;
  tokens: number;
  enabled: boolean;
  countInBudget: boolean;
  sourceUri?: string;
  editable: boolean;
  injectedByTopicsApp: boolean;
  adapterHints?: Record<string, string>;
}

export interface EnvelopeChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EnvelopeHistoryEntry {
  storedMessageId: string;
  role: 'user' | 'assistant';
  strippedMarkers: string[];
  bytesDropped: number;
  excluded: boolean;
  excludeReason?: 'limit' | 'context-message' | 'partial' | 'empty-after-strip' | 'duplicate-last-user';
}

export interface EnvelopeSessionMeta {
  topicName?: string;
  modelName?: string | null;
  projectPath?: string | null;
  workingDir?: string | null;
  worktreeId?: string | null;
  totalStoredMessages?: number;
  planMode?: boolean;
  /**
   * Whether Fast Mode was active when the envelope was assembled. Mirrors
   * `server/context/envelope.ts:SessionMeta.fastMode`. Useful for the
   * inspector "Last sent" tab to label the effective model.
   */
  fastMode?: boolean;
}

export interface ContextEnvelope {
  topicId: string;
  sessionKey: string;
  providerName: string;
  providerStrategy: EnvelopeProviderStrategy;
  sessionMeta?: EnvelopeSessionMeta;
  systemBlocks: EnvelopeSystemBlock[];
  history: EnvelopeChatMessage[];
  userMessage: { content: string; messageId?: string };
  diagnostics: {
    totalTokens: number;
    budgetLimit: number;
    budgetPercent: number;
    droppedHistoryTurns: number;
    historyEntries: EnvelopeHistoryEntry[];
    warnings: { type: string; detail: string }[];
    assembledAt: number;
    /**
     * Whether Fast Mode was active when the envelope was assembled
     * (openspec change `chat-fast-mode`). Mirrors
     * `server/context/envelope.ts:ContextDiagnostics.fastMode`.
     */
    fastMode?: boolean;
  };
}

export interface EnvelopeProviderPayload {
  userContent: string;
  history?: EnvelopeChatMessage[];
  options?: { model?: string };
  adaptationNotes: string[];
}

export interface ContextPreview {
  envelope: ContextEnvelope;
  payload: EnvelopeProviderPayload;
}

export const contextPreviewApi = {
  async fetch(topicId: string, providerName?: string): Promise<ContextPreview> {
    const qp = providerName ? `?provider=${encodeURIComponent(providerName)}` : '';
    return request<ContextPreview>(`/topics/${encodeURIComponent(topicId)}/context-preview${qp}`);
  },
};

export const contextSnapshotsApi = {
  async list(topicId: string): Promise<{ snapshots: ContextEnvelope[] }> {
    return request<{ snapshots: ContextEnvelope[] }>(`/topics/${encodeURIComponent(topicId)}/context-snapshots`);
  },
  async clear(topicId: string): Promise<{ ok: boolean; removed: number }> {
    return request<{ ok: boolean; removed: number }>(
      `/topics/${encodeURIComponent(topicId)}/context-snapshots`,
      { method: 'DELETE' },
    );
  },
};

// ── Agent Profiles ──────────────────────────────────────────────────────────

export interface AgentProfile {
  id: string;
  name: string;
  role: 'lead' | 'worker' | 'specialist';
  modelPreference: string | null;
  maxConcurrentTasks: number;
  capabilities: string[];
  avatarEmoji: string;
  status: 'available' | 'busy' | 'paused' | 'offline';
  hasToken?: boolean;
  isBoardLead?: boolean;
  identityTemplate?: string | null;
  soulTemplate?: string | null;
  lastSeenAt?: string | null;
  gatewaySessionId?: string | null;
  assignments?: AgentAssignment[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentAssignment {
  agentId: string;
  topicId: string;
  role: 'lead' | 'worker';
  assignedAt: string;
}

export interface AgentSession {
  id: string;
  agentId: string;
  sessionKey: string;
  topicId: string | null;
  status: string;
  taskId: string | null;
  startedAt: string;
  lastHeartbeat: string | null;
  completedAt: string | null;
  totalTokens: number;
  errorMessage: string | null;
}

export interface SessionHistoryItem extends AgentSession {
  agentName: string | null;
  agentAvatar: string | null;
  agentRole: string | null;
  topicName: string | null;
}

export interface TimelineEvent {
  type: 'session_start' | 'session_end' | 'heartbeat' | 'action';
  timestamp: string;
  data: Record<string, unknown>;
}

export interface SessionTimelineResponse {
  session: AgentSession | null;
  events: TimelineEvent[];
  heartbeatCount: number;
  actionCount: number;
}

export interface SessionHistoryResponse {
  sessions: SessionHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export const agentProfilesApi = {
  async list(): Promise<AgentProfile[]> {
    const data = await request<{ profiles: AgentProfile[] }>('/agents/profiles');
    return data.profiles;
  },
  async get(id: string): Promise<AgentProfile> {
    return request<AgentProfile>(`/agents/profiles/${id}`);
  },
  async create(body: Partial<AgentProfile>): Promise<AgentProfile> {
    return request<AgentProfile>('/agents/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
  async update(id: string, body: Partial<AgentProfile>): Promise<AgentProfile> {
    return request<AgentProfile>(`/agents/profiles/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
  async remove(id: string): Promise<void> {
    await request(`/agents/profiles/${id}`, { method: 'DELETE' });
  },
  async assign(id: string, topicId: string, role?: string): Promise<AgentAssignment> {
    return request<AgentAssignment>(`/agents/profiles/${id}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicId, role }) });
  },
  async unassign(id: string, topicId: string): Promise<void> {
    await request(`/agents/profiles/${id}/unassign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicId }) });
  },
  async sessions(id: string): Promise<AgentSession[]> {
    const data = await request<{ sessions: AgentSession[] }>(`/agents/profiles/${id}/sessions`);
    return data.sessions;
  },
  async heartbeat(sessionKey: string, body: { status?: string; tokensUsed?: number; currentTask?: string }): Promise<void> {
    await request(`/agents/sessions/${encodeURIComponent(sessionKey)}/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
  async pause(sessionKey: string): Promise<void> {
    await request(`/agents/sessions/${encodeURIComponent(sessionKey)}/pause`, { method: 'POST' });
  },
  async resume(sessionKey: string): Promise<void> {
    await request(`/agents/sessions/${encodeURIComponent(sessionKey)}/resume`, { method: 'POST' });
  },
  async timeline(sessionKey: string): Promise<SessionTimelineResponse> {
    return request<SessionTimelineResponse>(`/agents/sessions/${encodeURIComponent(sessionKey)}/timeline`);
  },
  async sessionHistory(sessionKey: string, limit = 100): Promise<{ messages: HistoryMessage[] }> {
    return request<{ messages: HistoryMessage[] }>(`/agents/sessions/${encodeURIComponent(sessionKey)}/history?limit=${limit}`);
  },
  async history(params: { status?: string; agentId?: string; search?: string; limit?: number; offset?: number } = {}): Promise<SessionHistoryResponse> {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.agentId) qs.set('agentId', params.agentId);
    if (params.search) qs.set('search', params.search);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset) qs.set('offset', String(params.offset));
    const q = qs.toString();
    return request<SessionHistoryResponse>(`/agents/sessions/history${q ? `?${q}` : ''}`);
  },
};

// ── Dashboard ───────────────────────────────────────────────────────────────

export interface DashboardKPIs {
  throughputDay: number;
  throughputWeek: number;
  avgCycleTimeHours: number;
  wipCount: number;
  errorRate: number;
  tokenSpendDay: number;
  tokenSpendWeek: number;
  agentUtilization: number;
  approvalTurnaroundHours: number;
  pendingApprovals: number;
}

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export interface AgentStat {
  agentId: string;
  agentName: string;
  avatarEmoji: string;
  tasksCompleted: number;
  totalTokens: number;
  avgCycleTimeHours: number;
  errorRate: number;
  sessionsCount: number;
}

export const dashboardApi = {
  async getKPIs(): Promise<DashboardKPIs> {
    return request<DashboardKPIs>('/dashboard/kpis');
  },
  async getTimeSeries(metric: string, range: string): Promise<TimeSeriesPoint[]> {
    const data = await request<{ points: TimeSeriesPoint[] }>(`/dashboard/timeseries?metric=${metric}&range=${range}`);
    return data.points;
  },
  async getAgentStats(): Promise<AgentStat[]> {
    const data = await request<{ agents: AgentStat[] }>('/dashboard/agent-stats');
    return data.agents;
  },
};

// ── Board Memory ─────────────────────────────────────────────────────────────

export interface BoardMemory {
  id: string;
  projectId: string;
  content: string;
  tags: string[];
  isChat: boolean;
  source: string | null;
  agentId: string | null;
  createdAt: string;
}

export interface AgentActionLog {
  id: string;
  agentId: string;
  actionType: string;
  entityType: string | null;
  entityId: string | null;
  detail: unknown;
  createdAt: string;
}

// Providers API
export interface ProviderListEntry {
  name: string;
  connected: boolean;
  capabilities: string[];
  isDefault: boolean;
}

/**
 * Cheap runtime guard for `ProvidersSnapshot`. We don't pull in Zod just for
 * this — the wire format is owned by us and stable, so a structural check is
 * enough to catch wire drift without paying the dep cost.
 */
function isProviderSnapshotEntry(v: unknown): v is ProviderSnapshotEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === 'string' &&
    (o.status === 'ready' || o.status === 'loading' || o.status === 'error' || o.status === 'unavailable') &&
    typeof o.isDefault === 'boolean' &&
    Array.isArray(o.models) &&
    Array.isArray(o.requirements) &&
    typeof o.fetchedAt === 'string'
  );
}

export function isProvidersSnapshot(v: unknown): v is ProvidersSnapshot {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    Array.isArray(o.providers) &&
    o.providers.every(isProviderSnapshotEntry) &&
    (o.defaultProvider === null || typeof o.defaultProvider === 'string') &&
    typeof o.generatedAt === 'string'
  );
}

export const providersApi = {
  async list(): Promise<{ providers: ProviderListEntry[]; default: string | null }> {
    return request<{ providers: ProviderListEntry[]; default: string | null }>('/providers');
  },

  /**
   * Server-authoritative snapshot. Used by `useProvidersSnapshot` for the
   * initial fetch; subsequent updates arrive via WS as `providers:snapshot`.
   */
  async snapshot(): Promise<ProvidersSnapshot> {
    const raw = await request<unknown>('/providers/snapshot');
    if (!isProvidersSnapshot(raw)) {
      throw new Error('Invalid /providers/snapshot response shape');
    }
    return raw;
  },

  /**
   * Forces a fresh probe of all providers (or a single provider when name is
   * supplied). Server then broadcasts the new snapshot to every WS client.
   */
  async refreshSnapshot(name?: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/providers/snapshot/refresh', {
      method: 'POST',
      body: JSON.stringify(name ? { provider: name } : {}),
    });
  },

  async setDefault(name: string): Promise<{ ok: boolean; default: string }> {
    return request<{ ok: boolean; default: string }>('/providers/default', {
      method: 'PUT',
      body: JSON.stringify({ provider: name }),
    });
  },

  async configureClaude(apiKey: string, model?: string, maxTokens?: number) {
    return request<{ ok: boolean; provider: unknown }>('/providers/claude/configure', {
      method: 'POST',
      body: JSON.stringify({ apiKey, model, maxTokens }),
    });
  },

  async configureOpenAI(apiKey: string, model?: string, maxTokens?: number) {
    return request<{ ok: boolean; provider: unknown }>('/providers/openai/configure', {
      method: 'POST',
      body: JSON.stringify({ apiKey, model, maxTokens }),
    });
  },

  async configureClaudeCode(model: string) {
    return request<{ ok: boolean; provider: unknown }>('/providers/claude-code/configure', {
      method: 'POST',
      body: JSON.stringify({ model }),
    });
  },

  async remove(name: string) {
    return request<{ ok: boolean }>(`/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// App-settings — promoted behaviour toggles (env-var audit, Phase B).
// NON-secret defaults; `null` on any field means "not set → env/default wins".
// ─────────────────────────────────────────────────────────────────────────────

export interface AppBehaviorSettings {
  aiProvider: string | null;
  claudeModel: string | null;
  claudeMaxTokens: number | null;
  claudeEffort: string | null;
  openaiModel: string | null;
  openaiMaxTokens: number | null;
  codexModel: string | null;
  codexReasoningEffort: string | null;
  claudeCodePermissionMode: string | null;
  codexApprovalMode: string | null;
  claudeCodeEnabled: boolean | null;
}

export const appSettingsApi = {
  async get(): Promise<AppBehaviorSettings> {
    const r = await request<{ settings: AppBehaviorSettings }>('/app-settings');
    return r.settings;
  },
  async update(patch: Partial<AppBehaviorSettings>): Promise<AppBehaviorSettings> {
    const r = await request<{ ok: boolean; settings: AppBehaviorSettings }>('/app-settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    return r.settings;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase A — Project + Worktree domain (migrations 016-018)
// ─────────────────────────────────────────────────────────────────────────────

export const projectsApi = {
  async list(opts?: { archived?: boolean }): Promise<{ projects: Project[] }> {
    const qs = opts?.archived !== undefined ? `?archived=${opts.archived}` : '';
    return request<{ projects: Project[] }>(`/projects${qs}`);
  },
  async byPath(path: string): Promise<Project | null> {
    // Server returns 200 with body=null on miss (lookup-or-null contract).
    return request<Project | null>(`/projects?path=${encodeURIComponent(path)}`);
  },
  async get(id: string): Promise<Project> {
    return request<Project>(`/projects/${id}`);
  },
  async create(data: {
    name: string;
    path: string;
    slug?: string;
    color?: string | null;
    icon?: string | null;
  }): Promise<Project> {
    return request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) });
  },
  async update(
    id: string,
    patch: { name?: string; color?: string | null; icon?: string | null },
  ): Promise<Project> {
    return request<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },
  async archive(id: string): Promise<Project> {
    return request<Project>(`/projects/${id}/archive`, { method: 'POST' });
  },
  async restore(id: string): Promise<Project> {
    return request<Project>(`/projects/${id}/restore`, { method: 'POST' });
  },
  async delete(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' });
  },
};

export const worktreesApi = {
  async list(filters?: {
    projectId?: string;
    status?: 'pending' | 'ready' | 'error';
  }): Promise<{ worktrees: Worktree[] }> {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set('project_id', filters.projectId);
    if (filters?.status) params.set('status', filters.status);
    const qs = params.toString();
    return request<{ worktrees: Worktree[] }>(`/worktrees${qs ? '?' + qs : ''}`);
  },
  async get(id: string): Promise<Worktree> {
    return request<Worktree>(`/worktrees/${id}`);
  },
  async create(data: {
    project_id: string;
    mode: 'branch' | 'reuse' | 'detached';
    base_ref: string;
    name?: string;
  }): Promise<Worktree> {
    // Returns 202 with the row in `pending` status; the UI listens for
    // `worktree:updated` over WS to flip to `ready` or `error`.
    return request<Worktree>('/worktrees', { method: 'POST', body: JSON.stringify(data) });
  },
  async rename(id: string, name: string): Promise<Worktree> {
    return request<Worktree>(`/worktrees/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  },
  async delete(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/worktrees/${id}`, { method: 'DELETE' });
  },
};

