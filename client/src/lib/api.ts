import type { 
  TopicsData, 
  Topic, 
  CreateTopicRequest, 
  UpdateTopicRequest, 
  LinkTopicRequest, 
  ChatRequest,
  HistoryRequest,
  HistoryResponse,
  UploadResponse,
  SearchResult,
  UnreadData,
  FileNode,
  GitStatus,
  ProcessInfo,
} from '../types';

const API_BASE = '/api';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
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
    throw new ApiError(response.status, text || response.statusText);
  }

  return response.json();
}

// Topics API
export const topicsApi = {
  async getAll(): Promise<TopicsData> {
    return request<TopicsData>('/topics');
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
  async sendMessage(data: ChatRequest): Promise<ReadableStream<Uint8Array> | null> {
    const response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }

    return response.body;
  },

  async getHistory(sessionKey: string, data: HistoryRequest = {}): Promise<HistoryResponse> {
    return request<HistoryResponse>(`/history/${encodeURIComponent(sessionKey)}`, {
      method: 'POST',
      body: JSON.stringify(data),
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

  async branches(path: string): Promise<any[]> {
    return request<any[]>(`/git/branches?path=${encodeURIComponent(path)}`);
  },

  async checkout(path: string, branch: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/checkout', {
      method: 'POST',
      body: JSON.stringify({ path, branch }),
    });
  },

  async log(path: string, limit = 20): Promise<any[]> {
    return request<any[]>(`/git/log?path=${encodeURIComponent(path)}&limit=${limit}`);
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
};

// Auto-name API
export const autoNameApi = {
  async autoName(topicId: string): Promise<{ title: string; icon: string; suggestedProject: string | null }> {
    return request<{ title: string; icon: string; suggestedProject: string | null }>(`/topics/${topicId}/auto-name`, {
      method: 'POST',
    });
  },
};

// Context Templates API (Feature 1)
export interface ContextTemplateFile {
  name: string;
  path: string;
  size: number;
  tokenEstimate: number;
  content: string;
}

export interface ContextTemplatesResponse {
  projectPath: string;
  files: ContextTemplateFile[];
  totalTokenEstimate: number;
}

export const contextTemplatesApi = {
  async getForTopic(topicId: string): Promise<ContextTemplatesResponse> {
    return request<ContextTemplatesResponse>(`/projects/${topicId}/context-templates`);
  },
  async setDisabled(topicId: string, disabledFiles: string[]): Promise<void> {
    await request(`/projects/${topicId}/context-templates/disabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabledFiles }),
    });
  },
};

// Task Board API (Feature 3)
export interface Task {
  id: string;
  text: string;
  status: 'todo' | 'in_progress' | 'done';
  createdAt: string;
  completedAt: string | null;
  chatId: string | null;
}

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

  async update(projectId: string, taskId: string, updates: { status?: string; text?: string }): Promise<Task> {
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

// Processes API
export const processesApi = {
  async list(topicId: string): Promise<ProcessInfo[]> {
    return request<ProcessInfo[]>(`/processes?topicId=${encodeURIComponent(topicId)}`);
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
