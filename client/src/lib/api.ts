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
  UnreadData,
  FileNode,
  GitStatus,
  ProcessInfo,
  GitBranch,
  GitLogEntry,
  ProvidersSnapshot,
  ProviderSnapshotEntry,
} from '../types';

const API_BASE = '/api';

export class ApiError extends Error {
  [key: string]: any;
  constructor(public status: number, message: string, extra?: Record<string, any>) {
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
    let extra: Record<string, any> | undefined;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) message = parsed.error;
      const { error: _, ...rest } = parsed;
      if (Object.keys(rest).length) extra = rest;
    } catch {}
    throw new ApiError(response.status, message, extra);
  }

  return response.json();
}

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

  async switchBranch(messageId: string, branchIndex: number): Promise<{ messages: any[] }> {
    return request<{ messages: any[] }>(`/messages/${encodeURIComponent(messageId)}/switch-branch`, {
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

// Unread API
export const unreadApi = {
  async getAll(): Promise<UnreadData> {
    return request<UnreadData>('/unread');
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
  // /uploads/ paths are served directly by the Topics server
  if (path.startsWith('/uploads/')) return path;
  return `${API_BASE}/media?path=${encodeURIComponent(path)}`;
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

// Task Board API
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';

export interface Task {
  id: string;
  text: string;
  status: TaskStatus;
  kanbanOrder: number;
  createdAt: string;
  completedAt: string | null;
  chatId: string | null;
}

export interface BoardTask extends Task {
  projectId: string;
  description: string | null;
  priority: number;       // 0-4
  assignedTo: string | null;
  assignedAgentId: string | null;
  fingerprint: string | null;
  dueDate: string | null;
  inProgressAt: string | null;
  updatedAt: string;
  archived: boolean;
  blocks: string[];       // task IDs this blocks
  blockedBy: string[];    // task IDs blocking this
  tags: Tag[];
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt?: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  content: string;
  mentions: string[];
  createdAt: string;
}

export interface BoardSettings {
  projectId: string;
  requireApprovalForDone: boolean;
  requireReviewBeforeDone: boolean;
  blockStatusWithPending: boolean;
  onlyLeadCanChangeStatus: boolean;
  maxAgents: number;
  autoExpireHours: number;
}

// Legacy tasks API (backward compat for existing TaskBoard component)
export const tasksApi = {
  async list(projectId: string): Promise<{ tasks: Task[] }> {
    return request<{ tasks: Task[] }>(`/projects/${projectId}/tasks`);
  },

  async create(projectId: string, text: string, chatId?: string): Promise<Task> {
    return request<Task>(`/projects/${projectId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ text, chatId }),
    });
  },

  async update(projectId: string, taskId: string, updates: { status?: string; text?: string; kanbanOrder?: number }): Promise<Task> {
    return request<Task>(`/projects/${projectId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async remove(projectId: string, taskId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/projects/${projectId}/tasks/${taskId}`, {
      method: 'DELETE',
    });
  },

  async getProjectId(topicId: string): Promise<{ projectId: string }> {
    return request<{ projectId: string }>(`/topics/${topicId}/project-id`);
  },
};

// Enhanced Boards API (Phase 2)
export const boardsApi = {
  async listTasks(projectId: string, filters?: { status?: string; priority?: string; assignedTo?: string }): Promise<{ tasks: BoardTask[] }> {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    if (filters?.priority) params.set('priority', filters.priority);
    if (filters?.assignedTo) params.set('assigned_to', filters.assignedTo);
    const qs = params.toString();
    return request<{ tasks: BoardTask[] }>(`/boards/${projectId}/tasks${qs ? '?' + qs : ''}`);
  },

  async createTask(projectId: string, data: { text: string; description?: string; status?: TaskStatus; priority?: number; assignedTo?: string; dueDate?: string; chatId?: string; tagIds?: string[] }): Promise<BoardTask> {
    return request<BoardTask>(`/boards/${projectId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateTask(projectId: string, taskId: string, updates: Partial<{ text: string; description: string; status: TaskStatus; priority: number; kanbanOrder: number; assignedTo: string; dueDate: string; tagIds: string[] }>): Promise<BoardTask> {
    return request<BoardTask>(`/boards/${projectId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async deleteTask(projectId: string, taskId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/boards/${projectId}/tasks/${taskId}`, { method: 'DELETE' });
  },

  async moveTask(projectId: string, taskId: string, status: TaskStatus, kanbanOrder?: number): Promise<BoardTask> {
    return request<BoardTask>(`/boards/${projectId}/tasks/${taskId}/move`, {
      method: 'POST',
      body: JSON.stringify({ status, kanbanOrder }),
    });
  },

  // Archive
  async archiveTask(projectId: string, taskId: string): Promise<{ ok: boolean }> {
    return request(`/boards/${projectId}/tasks/${taskId}/archive`, { method: 'POST' });
  },

  async unarchiveTask(projectId: string, taskId: string): Promise<BoardTask> {
    return request(`/boards/${projectId}/tasks/${taskId}/unarchive`, { method: 'POST' });
  },

  async archiveAllForProject(projectId: string): Promise<{ ok: boolean; archivedCount: number }> {
    return request(`/boards/${projectId}/archive-all`, { method: 'POST' });
  },

  async getArchivedCount(projectId: string): Promise<{ count: number }> {
    return request(`/boards/${projectId}/archived-count`);
  },

  // Dependencies
  async getDependencies(projectId: string, taskId: string): Promise<{ blockers: string[]; blocking: string[] }> {
    return request(`/boards/${projectId}/tasks/${taskId}/dependencies`);
  },

  async addDependency(projectId: string, taskId: string, dep: { blockerId?: string; blockedId?: string }): Promise<{ ok: boolean }> {
    return request(`/boards/${projectId}/tasks/${taskId}/dependencies`, {
      method: 'POST',
      body: JSON.stringify(dep),
    });
  },

  async removeDependency(projectId: string, taskId: string, dep: { blockerId?: string; blockedId?: string }): Promise<{ ok: boolean }> {
    return request(`/boards/${projectId}/tasks/${taskId}/dependencies`, {
      method: 'DELETE',
      body: JSON.stringify(dep),
    });
  },

  // Comments
  async getComments(projectId: string, taskId: string): Promise<{ comments: TaskComment[] }> {
    return request(`/boards/${projectId}/tasks/${taskId}/comments`);
  },

  async addComment(projectId: string, taskId: string, data: { content: string; author?: string; mentions?: string[] }): Promise<TaskComment> {
    return request(`/boards/${projectId}/tasks/${taskId}/comments`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async deleteComment(projectId: string, taskId: string, commentId: string): Promise<{ ok: boolean }> {
    return request(`/boards/${projectId}/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' });
  },

  // Settings
  async getSettings(projectId: string): Promise<BoardSettings> {
    return request(`/boards/${projectId}/settings`);
  },

  async updateSettings(projectId: string, settings: Partial<BoardSettings>): Promise<{ ok: boolean }> {
    return request(`/boards/${projectId}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  },
};

// Approvals API
export interface Approval {
  id: string;
  taskId: string;
  taskText?: string;
  taskStatus?: string;
  approvalType: string;
  fromStatus: string | null;
  toStatus: string | null;
  confidenceScore: number | null;
  rubricScores: Record<string, number> | null;
  justification: string | null;
  requestedBy: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reviewedBy: string | null;
  reviewComment: string | null;
  createdAt: string;
  reviewedAt: string | null;
  expiresAt: string | null;
}

export const approvalsApi = {
  async list(projectId: string, status?: string): Promise<{ approvals: Approval[] }> {
    const qs = status ? `?status=${status}` : '';
    return request(`/boards/${projectId}/approvals${qs}`);
  },

  async create(projectId: string, data: { taskId: string; approvalType: string; fromStatus?: string; toStatus?: string; confidenceScore?: number; rubricScores?: Record<string, number>; justification?: string; requestedBy?: string }): Promise<Approval> {
    return request(`/boards/${projectId}/approvals`, { method: 'POST', body: JSON.stringify(data) });
  },

  async approve(approvalId: string, comment?: string): Promise<{ ok: boolean }> {
    return request(`/approvals/${approvalId}/approve`, { method: 'POST', body: JSON.stringify({ comment }) });
  },

  async reject(approvalId: string, comment?: string): Promise<{ ok: boolean }> {
    return request(`/approvals/${approvalId}/reject`, { method: 'POST', body: JSON.stringify({ comment }) });
  },
};

// Tags API
export const tagsApi = {
  async list(): Promise<{ tags: Tag[] }> {
    return request<{ tags: Tag[] }>('/tags');
  },

  async create(data: { name: string; color?: string }): Promise<Tag> {
    return request<Tag>('/tags', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async update(tagId: string, updates: { name?: string; color?: string }): Promise<Tag> {
    return request<Tag>(`/tags/${tagId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },

  async remove(tagId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/tags/${tagId}`, { method: 'DELETE' });
  },
};

// Processes API
export const processesApi = {
  async list(topicId: string): Promise<ProcessInfo[]> {
    return request<ProcessInfo[]>(`/processes?topicId=${encodeURIComponent(topicId)}`);
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

export const commandApi = {
  async execute(sessionKey: string, command: string, args?: Record<string, any>): Promise<CommandResult> {
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

// Usage API
export interface UsageRecord {
  timestamp: number;
  sessionKey: string;
  topicId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface DaySummary {
  date: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requestCount: number;
}

export interface UsageSummary {
  daily: Record<string, DaySummary>;
  byModel: Record<string, { model: string; totalTokens: number; costUsd: number; requestCount: number }>;
  byTopic: Record<string, { topicId: string; totalTokens: number; costUsd: number; requestCount: number }>;
  totalCostUsd: number;
  totalTokens: number;
  totalRequests: number;
}

export const usageApi = {
  async getToday(): Promise<{ records: UsageRecord[]; summary: DaySummary }> {
    return request<{ records: UsageRecord[]; summary: DaySummary }>('/usage/today');
  },

  async getSummary(): Promise<UsageSummary> {
    return request<UsageSummary>('/usage/summary');
  },

  async getRange(from: string, to: string): Promise<{ records: UsageRecord[] }> {
    return request<{ records: UsageRecord[] }>(`/usage/range?from=${from}&to=${to}`);
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

export interface TopicMessagesResponse {
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    thinking?: string;
    toolCalls?: any[];
    media?: string[];
  }>;
  total: number;
  topicName: string;
}

export const topicMessagesApi = {
  async get(topicId: string, limit = 200): Promise<TopicMessagesResponse> {
    return request<TopicMessagesResponse>(`/topics/${topicId}/messages?limit=${limit}`);
  },
};

export interface TimelineEvent {
  type: 'session_start' | 'session_end' | 'heartbeat' | 'action';
  timestamp: string;
  data: Record<string, any>;
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

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface Webhook {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  retryCount: number;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export const webhooksApi = {
  async list(): Promise<Webhook[]> {
    const data = await request<{ webhooks: Webhook[] }>('/webhooks');
    return data.webhooks;
  },
  async create(body: Partial<Webhook>): Promise<Webhook> {
    return request<Webhook>('/webhooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
  async update(id: string, body: Partial<Webhook>): Promise<Webhook> {
    return request<Webhook>(`/webhooks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
  async remove(id: string): Promise<void> {
    await request(`/webhooks/${id}`, { method: 'DELETE' });
  },
  async test(id: string): Promise<{ deliveryId: string; status: string; httpStatus: number | null; error?: string }> {
    return request(`/webhooks/${id}/test`, { method: 'POST' });
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
  detail: any;
  createdAt: string;
}

export const boardMemoryApi = {
  async list(projectId: string, opts?: { isChat?: boolean; limit?: number }): Promise<BoardMemory[]> {
    const params = new URLSearchParams();
    if (opts?.isChat !== undefined) params.set('is_chat', String(opts.isChat));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const data = await request<{ memory: BoardMemory[] }>(`/boards/${projectId}/memory${qs ? '?' + qs : ''}`);
    return data.memory;
  },
  async create(projectId: string, data: { content: string; tags?: string[]; isChat?: boolean; source?: string }): Promise<BoardMemory> {
    return request<BoardMemory>(`/boards/${projectId}/memory`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
};

export const agentActionsApi = {
  async list(projectId: string, opts?: { agentId?: string; limit?: number }): Promise<AgentActionLog[]> {
    const params = new URLSearchParams();
    if (opts?.agentId) params.set('agent_id', opts.agentId);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const data = await request<{ actions: AgentActionLog[] }>(`/agent/boards/${projectId}/actions${qs ? '?' + qs : ''}`);
    return data.actions;
  },
};

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
    return request<{ ok: boolean; provider: any }>('/providers/claude/configure', {
      method: 'POST',
      body: JSON.stringify({ apiKey, model, maxTokens }),
    });
  },

  async configureOpenAI(apiKey: string, model?: string, maxTokens?: number) {
    return request<{ ok: boolean; provider: any }>('/providers/openai/configure', {
      method: 'POST',
      body: JSON.stringify({ apiKey, model, maxTokens }),
    });
  },

  async remove(name: string) {
    return request<{ ok: boolean }>(`/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },
};

// Global board tasks API (across all projects)
export const globalBoardApi = {
  async listTasks(filters?: { status?: string }): Promise<{ tasks: BoardTask[] }> {
    const params = new URLSearchParams();
    if (filters?.status) params.set('status', filters.status);
    const qs = params.toString();
    return request<{ tasks: BoardTask[] }>(`/boards/tasks${qs ? '?' + qs : ''}`);
  },
};

