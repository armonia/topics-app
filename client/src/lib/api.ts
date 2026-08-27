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
  GitCommitDetail,
  GitHunkSummary,
  DetectedScript,
  ProvidersSnapshot,
  ProviderSnapshotEntry,
  Project,
  Worktree,
  TopicGoal,
  GoalStepStatus,
} from '../types';
import { serverHttpBase } from './shell/net';
import { markUnpaired } from './auth/session';

// Relative on web/PWA/Electron (same-origin). Under the Tauri desktop shell the
// UI is served locally (tauri://localhost), so a global fetch shim rewrites these
// relative paths to the data server origin — see installNetShim() in
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
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    // Il cookie di sessione viaggia da solo, ma solo se lo si chiede
    // esplicitamente su una fetch che potrebbe essere cross-origin (il guscio
    // Tauri lo è). Su same-origin è già il default; scriverlo qui rende il
    // percorso identico ovunque invece di dipendere dall'ospite.
    credentials: 'same-origin',
  });

  if (!response.ok) {
    const text = await response.text();
    let message = text || response.statusText;
    let extra: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        // Il server rifiuta per IDENTITÀ: questo dispositivo non è appaiato, o
        // è stato revocato, o la sessione è scaduta. Va detto una volta e a voce
        // alta — senza, l'unico sintomo sarebbe un «Reconnecting…» eterno,
        // perché il WebSocket non può leggere lo stato HTTP del proprio upgrade
        // e nessun altro guarda il 401. È il difetto per cui il pairing
        // precedente non è mai servito a nessuno.
        if (response.status === 401 && typeof obj.code === 'string' && obj.code !== 'forbidden') {
          markUnpaired(obj.code);
        }
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
//   • List methods that return the bare array (`dashboardApi.getTimeSeries`)
//     `await request<{ key: T[] }>`
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

  /* (Qui stava `adoptClaudeSession`, che adottava in una topic una sessione
     Claude avviata a mano in un terminale. L'unico gesto che la chiamava era il
     «Continua qui» del chip in barra della kanban, tolto il 13/08. L'endpoint
     `POST /topics/adopt-claude` esiste ancora ed è provato da ADOPT-01: il
     giorno in cui l'adozione torna ad avere una superficie, il client la
     richiama da lì. Un metodo senza chiamanti, invece, marcisce.) */

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

  /**
   * Ferma il turno in volo. `clearMessages` è una PROPOSTA: la chat si butta
   * solo se la risposta torna `cleared: true` — il server ricontrolla sul DB
   * (vedi `shared/clear-messages-policy.ts`) e vede anche le righe fuori dal
   * ramo attivo, che il client non ha.
   */
  async abort(sessionKey: string, clearMessages?: boolean): Promise<{ ok: boolean; cleared?: boolean }> {
    return request<{ ok: boolean; cleared?: boolean }>('/chat/abort', {
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

  /**
   * Recupera il `detail` completo di una singola chiamata tool.
   *
   * La rotta `/api/history` spedisce i detail CON i campi di testo grossi
   * (`output`, `content`, `result`) svuotati, e mette sul toolCall il contatore
   * dei byte tolti (`detailBytes`). Questa chiamata li recupera la prima volta
   * che la riga viene APERTA: la risposta resta in uno stato locale della riga
   * e non rientra nello store. Niente si perde, si paga solo quando serve.
   */
  async fetchToolDetail(messageId: string, toolCallId: string): Promise<{ detail: unknown }> {
    return request<{ detail: unknown }>(
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
  /**
   * `signal` c'è perché senza, aprire e chiudere rapidamente il pannello
   * lasciava una camminata dell'albero in volo per ogni giro — tutte sullo
   * stesso event loop del server. Misurato: 8 richieste concorrenti passano da
   * 0,20s a 8,31s ciascuna, cioè la raffica allunga di ~40× la finestra in cui
   * un riavvio del server può colpirne una.
   */
  async list(path: string, depth = 3, signal?: AbortSignal): Promise<FileNode[]> {
    return request<FileNode[]>(`/files?path=${encodeURIComponent(path)}&depth=${depth}`, { signal });
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

  /**
   * Gli script del progetto, da TUTTI i manifest (`server/lib/project-scripts.ts`).
   * Il nome della rotta e storico: non e piu solo `package.json`.
   *
   * `found` sono i manifest presenti, `looked` quelli che il server guarda: e
   * la differenza fra «qui non c'e niente» e «non ho guardato», cioe quello che
   * serve allo stato vuoto per non tacere.
   */
  async packageScripts(path: string): Promise<{ scripts: DetectedScript[]; found: string[]; looked: string[]; engines?: Record<string, string> }> {
    return request<{ scripts: DetectedScript[]; found: string[]; looked: string[]; engines?: Record<string, string> }>(`/files/package-scripts?path=${encodeURIComponent(path)}`);
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

  /** Aggiorna le ref remote-tracking: senza, `behind` resta 0 per sempre. */
  async fetch(path: string): Promise<{ ok: boolean; output: string }> {
    return request<{ ok: boolean; output: string }>('/git/fetch', {
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

  /**
   * Il contenuto di un file a una certa revisione. `rev` serve per la
   * cronologia: il diff di un commit passato e `<hash>^` contro `<hash>`.
   */
  async show(path: string, file: string, rev?: string, side?: 'index'): Promise<string> {
    // `side=index` è un parametro a parte e non un valore di `rev` perché il
    // server vieta i due punti nella revisione di proposito: `git show :0:<file>`
    // li vuole, e allargare quel cancello significherebbe smontarlo su una
    // rotta che interpola anche `file`.
    const q = (rev ? `&rev=${encodeURIComponent(rev)}` : '') + (side ? `&side=${side}` : '');
    const response = await fetch(
      `${API_BASE}/git/show?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}${q}`
    );
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text || response.statusText);
    }
    return response.text();
  },

  /** I file toccati da un commit, con quante righe ciascuno. */
  async commitFiles(path: string, hash: string): Promise<GitCommitDetail> {
    return request<GitCommitDetail>(`/git/commit-files?path=${encodeURIComponent(path)}&hash=${encodeURIComponent(hash)}`);
  },

  /**
   * I blocchi di un file. `side` sceglie il diff: `unstaged` è
   * albero-contro-indice (cosa si può mettere in stage), `staged` è
   * indice-contro-HEAD (cosa si può togliere).
   */
  async hunks(path: string, file: string, side: 'staged' | 'unstaged' = 'unstaged'): Promise<{ hunks: GitHunkSummary[] }> {
    return request<{ hunks: GitHunkSummary[] }>(
      `/git/hunks?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}&side=${side}`,
    );
  },

  /** Stage, unstage o scarto di SINGOLI blocchi. Gli indici vengono da `hunks`. */
  async applyHunks(path: string, file: string, hunks: number[], action: 'stage' | 'unstage' | 'discard'): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/git/apply-hunks', {
      method: 'POST',
      body: JSON.stringify({ path, file, hunks, action }),
    });
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

  /**
   * `source` dice CHI l'ha scritto: `ai` il modello, `rules` il ripiego dai soli
   * numeri quando non c'è nessun provider collegato. Non è un dettaglio da
   * inghiottire — un conteggio di file che passa per una descrizione scritta è
   * peggio di nessuna descrizione, perché è plausibile.
   */
  async aiCommitMessage(path: string): Promise<{ message: string; source?: 'ai' | 'rules'; reason?: string }> {
    return request<{ message: string; source?: 'ai' | 'rules'; reason?: string }>('/git/ai-commit-message', {
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
   *  not captured); 'shell' = shell lasciata in background dall'agente
   *  (`Bash(run_in_background)`), output dai suoi `BashOutput`;
   *  'script'/undefined = launched via Topics run_script/UI. */
  source?: 'script' | 'detected' | 'shell';
  /** Solo per `source: 'shell'`: l'id con cui l'agente la chiama. */
  shellId?: string;
  /** Solo per `source: 'shell'`: la topic da cui è partita, se nota. */
  topicId?: string | null;
  /** Chi sta ASPETTANDO la fine di questo processo (`wait_for_process`).
   *  Assente quando nessuno aspetta: e' il caso normale. */
  watchers?: { label: string; since: string; until?: string }[];
}

export const scriptsApi = {
  /** `scriptName` accetta l'id (`<manifest>#<nome>`) oppure il solo nome. */
  async run(projectPath: string, scriptName: string): Promise<{ processId: string; scriptName: string; pid: number; startedAt: string }> {
    return request<{ processId: string; scriptName: string; pid: number; startedAt: string }>('/scripts/run', {
      method: 'POST',
      body: JSON.stringify({ projectPath, scriptName }),
    });
  },

  async list(): Promise<{ scripts: ScriptProcessInfo[] }> {
    return request<{ scripts: ScriptProcessInfo[] }>('/scripts');
  },

  /**
   * `offset` è un cursore ASSOLUTO (righe dall'inizio del processo), non un
   * indice dentro il buffer: il buffer si accorcia da sotto. `pending` è
   * l'ultima riga non ancora terminata da `\n` — si mostra ma NON si accumula,
   * altrimenti si vedrebbe due volte quando arriva completa. `truncatedLines`
   * dice quante righe il ring buffer ha buttato senza che questo client le
   * vedesse.
   */
  async output(processId: string, offset = 0): Promise<{ output: string; offset: number; pending?: string; truncatedLines?: number; done: boolean; status: string; exitCode?: number }> {
    return request<{ output: string; offset: number; pending?: string; truncatedLines?: number; done: boolean; status: string; exitCode?: number }>(`/scripts/${processId}/output?offset=${offset}`);
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

/**
 * Cache di processo della lista comandi. La lista è GLOBALE — non dipende dalla
 * topic — ma a chiederla è `ChatInput`, che esiste una volta per pane: aprendo
 * dodici tab si facevano dodici richieste identiche, ognuna col suo parse e il
 * suo setState. Una sola promise condivisa le collassa, e siccome è anche la
 * promise in volo, N composer montati nello stesso tick aspettano tutti quella.
 *
 * La lista cambia solo quando l'utente aggiunge un comando o una skill su
 * disco: fuori dalla portata dell'app, e comunque roba da ricarica — che
 * ricrea il modulo e con esso la cache. Se un giorno servisse invalidarla a
 * caldo, basta azzerare `slashCommandsCache`.
 */
let slashCommandsCache: Promise<CustomSlashCommand[]> | null = null;

/** The user's custom slash commands + skills (for composer autocomplete). The
 *  headless CLI expands them; the composer only surfaces them. Best-effort. */
export const slashCommandsApi = {
  /**
   * Il CORPO di un comando, letto dal disco dal server.
   *
   * Serve alla riga che mostra quale comando ha aperto il turno: sul filo il
   * corpo non passa (la CLI espande lo slash prima del turno), ma il file c'è.
   * Non è in cache: un comando lo si apre di rado, e il file può cambiare.
   */
  async source(name: string): Promise<{ name: string; kind: 'command' | 'skill'; path: string; body: string }> {
    return request(`/slash-commands/${encodeURIComponent(name)}`);
  },

  async list(): Promise<CustomSlashCommand[]> {
    if (!slashCommandsCache) {
      // Una richiesta fallita non deve restare in cache come fallimento
      // permanente: si scarta la promise così il prossimo chiamante riprova.
      slashCommandsCache = request<CustomSlashCommand[]>('/slash-commands').catch((e) => {
        slashCommandsCache = null;
        throw e;
      });
    }
    return slashCommandsCache;
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

/**
 * Il goal della chat (3.4). Le rotte stanno in `server/routes/goals.ts`; il
 * server annuncia ogni cambiamento con `goal:updated`, quindi dopo una scrittura
 * NON serve rileggere: la barra si aggiorna dall'evento come si aggiornerebbe
 * per una scrittura fatta da un'altra finestra. Un unico percorso, un unico bug
 * possibile.
 */
export const goalApi = {
  async get(topicId: string): Promise<{ goal: TopicGoal | null; history: TopicGoal[] }> {
    return request(`/topics/${topicId}/goal`);
  },

  async set(topicId: string, content: string): Promise<{ goal: TopicGoal }> {
    return request(`/topics/${topicId}/goal`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    });
  },

  /** Chiude quello attivo. `achieved` e `abandoned` non sono la stessa cosa per
   *  chi rilegge lo storico, quindi la distinzione la fa chi chiude. */
  async close(topicId: string, status: 'achieved' | 'abandoned'): Promise<{ goal: TopicGoal | null }> {
    return request(`/topics/${topicId}/goal`, {
      method: 'DELETE',
      body: JSON.stringify({ status }),
    });
  },

  async reopen(goalId: string): Promise<{ goal: TopicGoal | null }> {
    return request(`/goals/${goalId}/reopen`, { method: 'POST' });
  },

  async setSteps(
    goalId: string,
    steps: Array<{ content: string; status?: GoalStepStatus }>,
  ): Promise<{ goal: TopicGoal | null }> {
    return request(`/goals/${goalId}/steps`, {
      method: 'PUT',
      body: JSON.stringify({ steps }),
    });
  },
};

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
//
// I tipi vengono da shared/context-envelope.ts: sono gli STESSI che il server
// costruisce. Fino al 29/07 erano ricopiati a mano qui sotto — sette interfacce
// rinominate `Envelope*` (perché `ChatMessage` era già preso da tutt'altro) con
// il `diagnostics` espanso inline e un commento "Mirrors server/…" per campo.
// I nomi vecchi restavano come alias: cambiare 40 import non era il punto.
//
// Di quegli alias ne sono rimasti DUE. Gli altri sette non li importava più
// nessuno da qui, e nessuno se n'era accorto: il cancello sul codice morto era
// cieco su questo file — un `import('../../lib/api')` opaco in CommandPalette
// rendeva usato per costruzione ogni suo export. Guardia contro il ritorno del
// buco: `bun run check:deadcode-blindspots`.
export type {
  HistoryEntryDiagnostic as EnvelopeHistoryEntry,
  ContextEnvelope,
} from '../../../shared/context-envelope';

import type { ContextEnvelope, ProviderPayload } from '../../../shared/context-envelope';

export interface ContextPreview {
  envelope: ContextEnvelope;
  payload: ProviderPayload;
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

// ── Dashboard ───────────────────────────────────────────────────────────────

export interface DashboardKPIs {
  throughputDay: number;
  throughputWeek: number;
  avgCycleTimeHours: number;
  wipCount: number;
  errorRate: number;
  tokenSpendDay: number;
  tokenSpendWeek: number;
  /** Quanti messaggi sono stati ESCLUSI dai due totali perche' il loro costo non
   *  e' attendibile (registrato prima dello scorporo della cache). */
  tokenSpendDayUncertain?: number;
  tokenSpendWeekUncertain?: number;
  approvalTurnaroundHours: number;
  pendingApprovals: number;
}

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export const dashboardApi = {
  async getKPIs(): Promise<DashboardKPIs> {
    return request<DashboardKPIs>('/dashboard/kpis');
  },
  async getTimeSeries(metric: string, range: string): Promise<TimeSeriesPoint[]> {
    const data = await request<{ points: TimeSeriesPoint[] }>(`/dashboard/timeseries?metric=${metric}&range=${range}`);
    return data.points;
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
  /** Topics pubblica il tuo stato su Discord (migration 102). `null` = mai
   *  toccato, che qui vale SPENTO — non «default acceso». */
  discordPresenceEnabled: boolean | null;
  /** Quanto se ne vede: `minimal` | `activity` | `detailed`. `null` = il
   *  default del server, `activity`. */
  discordDetailLevel: DiscordDetailLevel | null;
  /** Con quale meccanica gira un agente: `cli` (una CLI per sessione) o
   *  `jcode` (sessioni ACP dentro un demone condiviso). `null` = il default
   *  del server, `cli`. */
  agentRuntime: AgentRuntime | null;
  /** Mostrare la spesa in dollari sulla pagina pubblica del profilo. `null`
   *  o `false` = spesa non visibile (default sicuro: dato personale). */
  profilePublishCost: boolean | null;
  /** Token opaco nel percorso /public/profile/<token>. NULL = pagina spenta.
   *  Gestito da POST/DELETE /api/app-settings/profile-token, non da PUT. */
  profileShareToken: string | null;
}

/**
 * Le regole di «Consenti sempre» sugli strumenti.
 *
 * Esistono come API di client per una ragione sola: un permesso concesso per
 * sempre che non si può rileggere né togliere è una porta che si apre e basta.
 * La superficie è in Impostazioni → Permessi.
 */
export type { ToolGrant } from '../../../shared/types';
import type { ToolGrant, DiscordDetailLevel, AgentRuntime } from '../../../shared/types';
export type { DiscordDetailLevel, AgentRuntime } from '../../../shared/types';

export const toolGrantsApi = {
  async list(): Promise<ToolGrant[]> {
    const r = await request<{ grants: ToolGrant[] }>('/tool-grants');
    return r.grants ?? [];
  },
  async remove(pattern: string): Promise<ToolGrant[]> {
    const r = await request<{ ok: boolean; grants: ToolGrant[] }>(
      `/tool-grants/${encodeURIComponent(pattern)}`,
      { method: 'DELETE' },
    );
    return r.grants ?? [];
  },
};

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
  /** Genera il token di pubblicazione (idempotente: se esiste lo restituisce). */
  async publishProfile(): Promise<string> {
    const r = await request<{ ok: boolean; token: string }>('/app-settings/profile-token', {
      method: 'POST',
    });
    return r.token;
  },
  /** Revoca il token: il vecchio URL diventa 404 immediatamente. */
  async revokeProfile(): Promise<void> {
    await request<{ ok: boolean }>('/app-settings/profile-token', {
      method: 'DELETE',
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// The MCP fleet — what the native runtime has mounted right now.
//
// The shapes are `shared/types.ts`, re-exported here so a component imports its
// data type from the same module it imports the call from. Declaring them again
// on this side is the mirror `tests/unit/no-type-mirrors.test.ts` refuses.
// ─────────────────────────────────────────────────────────────────────────────
export type { McpFleetStatus, McpServerStatus } from '../../../shared/types';
import type { McpFleetStatus } from '../../../shared/types';

export const mcpApi = {
  /**
   * Read the fleet. The server MOUNTS ON READ, so this can take as long as the
   * slowest handshake: the answer is measured, not a cached guess.
   */
  async fleet(signal?: AbortSignal): Promise<McpFleetStatus> {
    return request<McpFleetStatus>('/mcp/fleet', { signal });
  },

  /** Drop every connection and mount again, then answer with the new state. */
  async refresh(): Promise<McpFleetStatus> {
    return request<McpFleetStatus>('/mcp/fleet/refresh', { method: 'POST' });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Profilo — chi sei qui dentro, cosa è passato di qui, e cosa ne vede Discord.
//
// Le statistiche NON vengono da `usage_records`/`agent_sessions`: quelle due
// tabelle non hanno un solo scrittore in tutto il server, e un numero letto da
// lì sarebbe zero per sempre. La fonte sono `messages`/`tasks`/`topics` — la
// storia sta in cima a `server/services/profile-stats.ts`.
// ─────────────────────────────────────────────────────────────────────────────

// Le forme vivono in `shared/types.ts` e si RI-ESPORTANO: sono le stesse che
// il server manda sul filo, e una copia di qua sarebbe l'ennesimo «KEEP IN
// SYNC» che non tiene in sync niente (`tests/unit/no-type-mirrors.test.ts`).
// `DiscordActivityPreview` è un alias locale: da questo lato l'attività è
// sempre e solo un'anteprima da disegnare, mai qualcosa da pubblicare.
export type {
  ProfileStats,
  DiscordPresenceStatus,
  DiscordActivity as DiscordActivityPreview,
} from '../../../shared/types';
import type {
  ProfileStats,
  DiscordPresenceStatus,
  DiscordActivity as DiscordActivityPreview,
} from '../../../shared/types';

export const profileApi = {
  async stats(): Promise<{ stats: ProfileStats; name: string | null }> {
    return request<{ stats: ProfileStats; name: string | null }>('/profile/stats');
  },
  /** Solo come si chiama chi usa l'app. Porta separata da `stats`, che per un
   *  nome scandirebbe sessioni, messaggi e token dell'intera installazione. */
  async owner(): Promise<{ name: string | null }> {
    return request<{ name: string | null }>('/profile/owner');
  },
  /** Stato del filo + l'anteprima di OGNI livello: la card le mostra tutte e
   *  tre, così la scelta si fa guardando il risultato invece di leggendo una
   *  descrizione. */
  async discord(): Promise<{
    status: DiscordPresenceStatus;
    preview: Record<DiscordDetailLevel, DiscordActivityPreview | null>;
  }> {
    return request('/profile/discord');
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
    patch: { name?: string; color?: string | null; icon?: string | null; incognito?: boolean },
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

// ─────────────────────────────────────────────────────────────────────────────
// PEOPLE, their GitHub profiles, and the follow graph.
//
// The reachable set is no longer "the members of my org": it is me, whoever I
// follow, whoever follows me, and the people I share an organisation with, the
// last group being a way to FIND somebody and nothing else. Nothing in these
// shapes names an organisation, on purpose.
//
// `stats` and `counts` are NULLABLE and that is the privacy: when a person
// switches a facet off the server omits the value, so a client that ignored the
// setting would have nothing to draw anyway.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfiloGitHubClient {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  blog: string | null;
  twitterUsername: string | null;
  publicRepos: number | null;
  followers: number | null;
  fetchedAt: number | null;
}

export interface StatistichePersonaClient {
  prompts: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  ultimoPrompt: string | null;
}

/** The five switches of `Profile > Privacy`. Every one of them is enforced by
 *  the server: this shape is what you SET, not what you are trusted to obey. */
/* The profile shapes are declared ONCE, in shared/, and re-exported here. A
 * hand-copied interface carries a "keep in sync" promise that no gate can
 * enforce, so the two sides read the same file instead. */
export type { ProfilePrivacy, FollowCounts } from "../../../shared/profile";
import type { ProfilePrivacy, FollowCounts } from "../../../shared/profile";

export interface PersonWithProfile {
  id: string;
  displayName: string;
  email: string | null;
  githubLogin: string | null;
  github: ProfiloGitHubClient | null;
  /** `null` when this person does not publish their figures. */
  stats: StatistichePersonaClient | null;
  isMe: boolean;
  /** `null` when this person does not publish their followers. */
  counts: FollowCounts | null;
  /** Whether I follow them. The relation is one way, so the other direction is
   *  a separate field and not the same one read backwards. */
  viewerFollows: boolean;
  followsViewer: boolean;
  /** `null` when this person does not publish their presence. */
  lastSeenAt: number | null;
  /** Only ever present on your own profile. */
  privacy?: ProfilePrivacy;
}

/** A row in a followers/following list: enough to draw a face and follow back. */
export interface PersonSummary {
  id: string;
  displayName: string;
  githubLogin: string | null;
  github: ProfiloGitHubClient | null;
  viewerFollows: boolean;
  isMe: boolean;
}

export const peopleApi = {
  /** The directory. Does NOT touch GitHub: the faces come from the server cache. */
  async list(): Promise<{ people: PersonWithProfile[] }> {
    return request<{ people: PersonWithProfile[] }>('/people');
  },
  /** One person: HERE the server goes and fetches the fresh GitHub profile. */
  async get(id: string): Promise<PersonWithProfile> {
    return request<PersonWithProfile>(`/people/${id}`);
  },
  async setGithubLogin(id: string, githubLogin: string | null) {
    return request<{ id: string; githubLogin: string | null; github: ProfiloGitHubClient | null }>(
      `/people/${id}`,
      { method: 'PATCH', body: JSON.stringify({ githubLogin }) },
    );
  },
  async follow(id: string): Promise<{ following: boolean; counts: FollowCounts }> {
    return request<{ following: boolean; counts: FollowCounts }>(`/people/${id}/follow`, { method: 'POST' });
  },
  async unfollow(id: string): Promise<{ following: boolean; counts: FollowCounts }> {
    return request<{ following: boolean; counts: FollowCounts }>(`/people/${id}/follow`, { method: 'DELETE' });
  },
  async followers(id: string): Promise<{ people: PersonSummary[] }> {
    return request<{ people: PersonSummary[] }>(`/people/${id}/followers`);
  },
  async following(id: string): Promise<{ people: PersonSummary[] }> {
    return request<{ people: PersonSummary[] }>(`/people/${id}/following`);
  },
  async privacy(id: string): Promise<{ privacy: ProfilePrivacy }> {
    return request<{ privacy: ProfilePrivacy }>(`/people/${id}/privacy`);
  },
  async setPrivacy(id: string, patch: Partial<ProfilePrivacy>): Promise<{ privacy: ProfilePrivacy }> {
    return request<{ privacy: ProfilePrivacy }>(`/people/${id}/privacy`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
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

