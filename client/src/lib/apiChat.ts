import type { TopicsData, Topic, CreateTopicRequest, UpdateTopicRequest, LinkTopicRequest, ChatRequest, HistoryRequest, HistoryResponse, HistoryMessage, UploadResponse, SearchResult } from '../types';
import { serverHttpBase, apiFetch } from './shell/net';
import { HISTORY_FIRST_PAGE } from '../../../shared/history-paging';
import type { ChatFindResult } from '../../../shared/chat-find';
import { adoptWarmRead, warmRead } from './warmReads';
import type { ResumablePage } from '../../../shared/resumable-sessions';
import type { SEND_NOW_STOP_CAUSE } from '../../../shared/types';
import { API_BASE, ApiError, readErrorBody, request } from './apiBase';

// Topics API
export const topicsApi = {
  /** The LIVE topics plus the workspace projects: the boot payload. */
  async getAll(signal?: AbortSignal): Promise<TopicsData> {
    return request<TopicsData>('/topics', { signal });
  },

  /**
   * The ARCHIVED topics, same list shape, asked for apart from the boot: on
   * a workspace of 1,554 topics they were 1,535 of them, 872 KB the first
   * frame never drew. Loaded in idle, or when a surface needs them (the
   * archived section of the sidebar, the search palette).
   */
  async getArchived(signal?: AbortSignal): Promise<TopicsData> {
    return request<TopicsData>('/topics?archived=1', { signal });
  },

  /**
   * ONE topic, whole: the only place the system prompt and the browser state
   * come from. `getAll` stopped carrying them - a quarter of the boot payload
   * for fields the list does not draw (see shared/types.ts).
   */
  async get(id: string, signal?: AbortSignal): Promise<Topic> {
    const r = await request<{ topic: Topic }>(`/topics/${encodeURIComponent(id)}`, { signal });
    return r.topic;
  },

  async create(data: CreateTopicRequest): Promise<Topic> {
    return request<Topic>('/topics', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  /**
   * Adopt a Claude Code session born outside Topics as a chat that continues
   * it (`/resume`, CMDUI-03). `transcriptPath` is the one `/resume` listed, so
   * the server does not walk every folder of the store to find it.
   */
  async adoptClaudeSession(data: { sessionId: string; transcriptPath?: string; name?: string }): Promise<Topic> {
    return request<Topic>('/topics/adopt-claude', { method: 'POST', body: JSON.stringify(data) });
  },

  /** One page of the project's Claude Code sessions no chat holds (`/resume`). */
  async resumableSessions(topicId: string, before?: string | null): Promise<ResumablePage> {
    const q = before ? `?before=${encodeURIComponent(before)}` : '';
    return request<ResumablePage>(`/topics/${encodeURIComponent(topicId)}/resumable-sessions${q}`);
  },

  /**
   * Fork a chat into a new one (CHAT-FORK-01): a topic with a copy of the
   * active branch up to the last finished answer. A refusal carries a `code`
   * (`turn_in_progress`, `fork_unsupported`, `nothing_to_fork`) for `apiErrorCode`.
   */
  async fork(id: string, data: { name?: string }): Promise<Topic> {
    return request<Topic>(`/topics/${encodeURIComponent(id)}/fork`, { method: 'POST', body: JSON.stringify(data) });
  },

  async sideQuestion(id: string): Promise<Topic> {
    return request<Topic>(`/topics/${encodeURIComponent(id)}/side-question`, { method: 'POST', body: '{}' });
  },

  async closeSideQuestion(id: string): Promise<void> {
    await request<{ ok: boolean }>(`/topics/${encodeURIComponent(id)}/side-question`, { method: 'DELETE' });
  },

  async update(id: string, data: UpdateTopicRequest): Promise<Topic> {
    return request<Topic>(`/topics/${id}`, {
      method: 'PATCH',
      // The server lets only the interface change a board agent's model.
      headers: { 'X-Topics-Action-Origin': 'interface' },
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
};

// Server-owned global orchestration conversation. The returned topic is still
// an ordinary Topic; this endpoint only resolves the durable singleton.
export const orchestratorSessionsApi = {
  ensureGlobal(): Promise<{ topicId: string; topic: Topic }> {
    return request<{ topicId: string; topic: Topic }>('/orchestrator-sessions/global/ensure', {
      method: 'POST',
    });
  },
};

// Chat API
const historyReadKey = (sessionKey: string, data: HistoryRequest): string => `history\n${sessionKey}\n${JSON.stringify(data)}`;

function readHistory(sessionKey: string, data: HistoryRequest): Promise<HistoryResponse> {
  return request<HistoryResponse>(`/history/${encodeURIComponent(sessionKey)}`, {
    method: 'POST',
    body: JSON.stringify(data),
    // The visible chat's skeleton comes down when THIS answers. At boot it
    // queued behind ~90 other /api requests on the six connections the browser
    // allows per host (measured 2026-09-05: 1.2 s of skeleton): the priority
    // hint tells Chromium to send it first. WebKit ignores it, harmlessly.
    priority: 'high',
  });
}

export const chatApi = {
  async sendMessage(data: ChatRequest, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    const response = await apiFetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
      signal,
    });

    if (!response.ok) {
      // The same envelope `request()` opens. A turn that never starts is never
      // stored, so this throw IS the verdict the chat shows: the raw body used
      // to land in the banner with its quotes escaped. `extra` carries `code`,
      // which `useChat` reads to tell `duplicate_message` from `stream_in_flight`.
      const { message, extra } = readErrorBody(await response.text(), response.statusText);
      throw new ApiError(response.status, message, extra);
    }

    return response.body;
  },

  /**
   * Ferma il turno in volo. `clearMessages` è una PROPOSTA: la chat si butta
   * solo se la risposta torna `cleared: true` — il server ricontrolla sul DB
   * (vedi `shared/clear-messages-policy.ts`) e vede anche le righe fuori dal
   * ramo attivo, che il client non ha.
   *
   * `cause: SEND_NOW_STOP_CAUSE` («Send now») stops the turn only: the
   * sub-agents it launched keep working.
   */
  async abort(sessionKey: string, clearMessages?: boolean, cause?: typeof SEND_NOW_STOP_CAUSE): Promise<{ ok: boolean; cleared?: boolean; reason?: string }> {
    return request<{ ok: boolean; cleared?: boolean }>('/chat/abort', {
      method: 'POST',
      body: JSON.stringify({ sessionKey, clearMessages, ...(cause ? { cause } : {}) }),
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
  /**
   * La decisione su un PERMESSO. Endpoint suo e payload tipizzato: un enum, non
   * un testo dentro una mappa di risposte come quando i permessi passavano per
   * il pannello delle domande.
   *
   * Stesso tetto a orologio di `toolResponse`, per lo stesso motivo: dall'altra
   * parte c'è un rendez-vous, e un rendez-vous che non si sblocca lascerebbe i
   * tre bottoni girare per sempre.
   */
  async permissionResponse(
    sessionKey: string,
    toolCallId: string,
    decision: import('../types').PermissionDecision,
  ): Promise<{ ok: boolean; decidedAt: string }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      return await request<{ ok: boolean; decidedAt: string }>(
        `/sessions/${encodeURIComponent(sessionKey)}/permission-response`,
        { method: 'POST', body: JSON.stringify({ toolCallId, decision }), signal: ac.signal },
      );
    } finally {
      clearTimeout(timer);
    }
  },

  async toolResponse(
    sessionKey: string,
    toolCallId: string,
    response: import('../types').ToolUserResponse,
  ): Promise<{ ok: boolean; submittedAt: string }> {
    // Un tetto a orologio, perché il ramo lento di questa POST è quello che
    // scrive sullo stdin del provider e aspetta che qualcuno legga: se
    // nessuno legge, la fetch non torna MAI e il pannello resta su «Invio…»
    // per sempre, con la risposta scritta e nessun modo di rimandarla.
    // Meglio un errore in faccia dopo trenta secondi — il testo resta nel
    // form, e si riprova.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      return await request<{ ok: boolean; submittedAt: string }>('/chat/tool-response', {
        method: 'POST',
        body: JSON.stringify({ sessionKey, toolCallId, response }),
        signal: ac.signal,
      });
    } catch (err) {
      if (ac.signal.aborted) {
        throw new Error("Il server non ha confermato entro 30 secondi: la risposta non è partita. Riprova.");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * Start the first-page history read NOW, ahead of the pane that will ask for
   * it: the palette's Enter used to send it only from the pane's mount effect,
   * after the whole synchronous render. The pane's `getHistory` adopts it.
   */
  warmHistory(sessionKey: string, data: HistoryRequest = { limit: HISTORY_FIRST_PAGE }): void {
    warmRead(historyReadKey(sessionKey, data), () => readHistory(sessionKey, data));
  },

  async getHistory(sessionKey: string, data: HistoryRequest = {}): Promise<HistoryResponse> {
    const early = await adoptWarmRead<HistoryResponse>(historyReadKey(sessionKey, data));
    // A read taken while a turn was running is not adopted: the caller orders
    // the answer against the turn events it sees from the moment it asks.
    if (early && !early.isStreaming) return early;
    return readHistory(sessionKey, data);
  },

  async editMessage(messageId: string, content: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    const response = await apiFetch(`${API_BASE}/messages/${encodeURIComponent(messageId)}/edit`, {
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
    const response = await apiFetch(`${API_BASE}/messages/${encodeURIComponent(messageId)}/regenerate`, {
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

  /**
   * The whole `detail` and the whole `args` of one tool call.
   *
   * `/api/history` ships every tool call in its closed-row form: the big text
   * fields of `detail` (`output`, `content`, `result`) blank, every other long
   * string of `detail` or `args` cut to its head, and the count of what was
   * removed on the call (`detailBytes`, `argsBytes`). This call brings the
   * whole thing back the first time the row is OPENED: the answer stays in the
   * row's local state and never enters the store. Nothing is lost, it is only
   * paid for when it is looked at.
   */
  async fetchToolDetail(messageId: string, toolCallId: string): Promise<{ detail: unknown; args: unknown }> {
    return request<{ detail: unknown; args: unknown }>(
      `/messages/${encodeURIComponent(messageId)}/tool/${encodeURIComponent(toolCallId)}/detail`,
    );
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
  /** Find inside ONE conversation, tool outputs included (CHAT-FIND-01). */
  async historyFind(sessionKey: string, query: string, matchCase: boolean, signal?: AbortSignal): Promise<ChatFindResult> {
    return request<ChatFindResult>('/history-find', {
      method: 'POST',
      body: JSON.stringify({ sessionKey, query, matchCase }),
      signal,
    });
  },
};

// Upload API
export const uploadApi = {
  async uploadFile(file: File): Promise<UploadResponse> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await apiFetch(`${API_BASE}/upload`, {
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

    const response = await apiFetch(`${API_BASE}/context-upload`, {
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

/**
 * URL of the `/preview/<absolute path>` route, which serves a file from a
 * project directory with its real MIME type (server.ts).
 *
 * Absolute for the same reason as `getMediaUrl`, and it cost more here: an
 * `<iframe src>`/`<img src>` does NOT go through the fetch shim, so under Tauri
 * the relative form resolved against `tauri://localhost` — where the asset
 * protocol answers an unknown path with the single-page app `index.html`. Opening a PDF
 * from the file tree therefore drew a whole second copy of Topics inside the
 * editor tab instead of the document (an image just broke). `serverHttpBase()`
 * is '' on the web, so that side is unchanged.
 */
export function getPreviewUrl(path: string): string {
  return `${serverHttpBase()}/preview${path}`;
}
