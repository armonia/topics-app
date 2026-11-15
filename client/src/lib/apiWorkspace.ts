import type { FileNode, GitStatus, GitBranch, GitLogEntry, GitCommitDetail, GitHunkSummary, DetectedScript, TopicGoal, GoalStepStatus } from '../types';
import { apiFetch } from './shell/net';
import type { CommandRun as CommandRunInfo } from '../../../shared/command-runs';
import type { LiveWork } from '../../../shared/live-work';
import type { ContextEnvelope, ProviderPayload } from '../../../shared/context-envelope';
import { API_BASE, ApiError, readErrorBody, request } from './apiBase';

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
    const response = await apiFetch(`${API_BASE}/files/content?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      const { message, extra } = readErrorBody(await response.text(), response.statusText);
      throw new ApiError(response.status, message, extra);
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
    const response = await apiFetch(`${API_BASE}/files/upload`, { method: 'POST', body: formData });
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
    const response = await apiFetch(
      `${API_BASE}/git/diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`
    );
    if (!response.ok) {
      const { message, extra } = readErrorBody(await response.text(), response.statusText);
      throw new ApiError(response.status, message, extra);
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
    const response = await apiFetch(
      `${API_BASE}/git/show?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}${q}`
    );
    if (!response.ok) {
      const { message, extra } = readErrorBody(await response.text(), response.statusText);
      throw new ApiError(response.status, message, extra);
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
   *  (`Bash(run_in_background)`), output from the file the CLI writes;
   *  'command' = any command an agent started with `run_command`;
   *  'script'/undefined = launched via Topics run_script/UI. */
  source?: 'script' | 'detected' | 'shell' | 'command';
  /** Solo per `source: 'shell'`: l'id con cui l'agente la chiama. */
  shellId?: string;
  /** For `source: 'shell'` and `'command'`: the topic it came from, if known. */
  topicId?: string | null;
  /** For `source: 'command'`: ended by a Stop, not by itself. */
  stopped?: boolean;
  /** The registered process group is receiving TERM. */
  closing?: boolean;
  /** The registered group could not be verified dead. */
  stopFailed?: boolean;
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

  /**
   * `ports`: each running row's listening ports, which cost the server an
   * lsof, and the process detection at full cadence. Only the Processes panel
   * draws them; without it the rows come with no ports.
   */
  async list(opts: { ports?: boolean } = {}): Promise<{ scripts: ScriptProcessInfo[] }> {
    return request<{ scripts: ScriptProcessInfo[] }>(opts.ports ? '/scripts?ports=1' : '/scripts');
  },

  /**
   * `offset` è un cursore ASSOLUTO (righe dall'inizio del processo), non un
   * indice dentro il buffer: il buffer si accorcia da sotto. `pending` è
   * l'ultima riga non ancora terminata da `\n` — si mostra ma NON si accumula,
   * altrimenti si vedrebbe due volte quando arriva completa. `truncatedLines`
   * dice quante righe il ring buffer ha buttato senza che questo client le
   * vedesse.
   */
  async output(processId: string, offset = 0): Promise<ScriptOutput> {
    return request<ScriptOutput>(`/scripts/${processId}/output?offset=${offset}`);
  },

  async stop(processId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/scripts/${processId}/stop`, {
      method: 'POST',
    });
  },
};

/**
 * A piece of a process's log. `startedAt`, `follows` and `unfollowed` say what
 * an empty log is waiting for (chat-live-work): since when, the file the
 * command sends its stdout to, or the one nobody can follow and why.
 */
export interface ScriptOutput {
  output: string; offset: number; pending?: string; truncatedLines?: number; done: boolean; status: string; exitCode?: number;
  startedAt?: string; follows?: string; unfollowed?: { target: string; reason: 'variable' | 'pattern' | 'cwd' };
}

/** What a chat has at work now: the rows of the strip under it (chat-live-work). */
export const liveWorkApi = {
  get: (topicId: string) => request<LiveWork>(`/topics/${encodeURIComponent(topicId)}/live-work`),
};
/** A run of a command from the chat (CHAT-RUN-03): the server's row, one shape on both sides. */
export type { CommandRun as CommandRunInfo } from '../../../shared/command-runs';

export const commandRunsApi = {
  async start(sessionKey: string, run: { messageId: string; blockKey: number; command: string }): Promise<{ runId: string; processId: string; cwd: string; startedAt: string }> {
    return request<{ runId: string; processId: string; cwd: string; startedAt: string }>(`/sessions/${encodeURIComponent(sessionKey)}/command-runs`, {
      method: 'POST',
      body: JSON.stringify(run),
    });
  },

  /** For each block of the message, its last run. */
  async list(sessionKey: string, messageId: string): Promise<CommandRunInfo[]> {
    const { runs } = await request<{ runs: CommandRunInfo[] }>(`/sessions/${encodeURIComponent(sessionKey)}/command-runs?messageId=${encodeURIComponent(messageId)}`);
    return runs;
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
  /** The change waits for the chat's background work to end (`/model`, `/effort`). */
  pending?: 'background-work';
}

export interface CustomSlashCommand {
  name: string;
  description: string;
  kind: 'command' | 'skill';
  /** `engine` = the engine's own command, `skills` = the person's commands and skills (CMDUI-01). */
  group?: 'engine' | 'skills';
  argumentHint?: string;
}

/** A row of `/resume` (`GET /topics/:id/resumable-sessions`). */
export type { ResumableSession } from '../../../shared/resumable-sessions';

/**
 * Cache di processo della lista comandi, per topic: a chiederla è `ChatInput`,
 * che esiste una volta per pane, e una sola promise condivisa collassa le
 * richieste di dodici tab aperte nello stesso tick.
 *
 * DURA POCO, adesso. La lista non è più solo il disco: il gruppo del motore è
 * quello che la CLI dice al suo primo turno (CMDUI-01), quindi una chat nuova
 * la vede vuota e, un turno dopo, piena. Tenuta per sempre restava vuota fino
 * alla ricarica. Il menu la richiede quando si apre; dentro `SLASH_LIST_TTL_MS`
 * risponde la promise già in mano.
 */
const SLASH_LIST_TTL_MS = 30_000;
/** One list per topic (or per draft's provider): the menu reads the topic's engine and project. */
const slashCommandsCache = new Map<string, { at: number; list: Promise<CustomSlashCommand[]> }>();

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
  async source(name: string, topicId?: string): Promise<{ name: string; kind: 'command' | 'skill'; path: string; body: string }> {
    const q = topicId ? `?topicId=${encodeURIComponent(topicId)}` : '';
    return request(`/slash-commands/${encodeURIComponent(name)}${q}`);
  },

  /**
   * The list for a topic (`topicId`), or for a draft that declares `provider`.
   * `fresh` skips the cache: the menu opening asks it, because the engine's
   * group arrives with the chat's first turn, after the mount already read.
   */
  async list(topicId?: string, provider?: string | null, fresh = false): Promise<CustomSlashCommand[]> {
    const key = topicId ? `t:${topicId}` : `p:${provider ?? ''}`;
    const hit = slashCommandsCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < SLASH_LIST_TTL_MS) return hit.list;
    const q = topicId ? `?topicId=${encodeURIComponent(topicId)}` : provider ? `?provider=${encodeURIComponent(provider)}` : '';
    // A failed request must not stay cached: the next caller retries.
    const list = request<CustomSlashCommand[]>(`/slash-commands${q}`).catch((e) => {
      slashCommandsCache.delete(key);
      throw e;
    });
    slashCommandsCache.set(key, { at: Date.now(), list });
    return list;
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

  /** The server answers with where reasoning is set on the declared provider (`/effort`). */
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

  /** The person adopts a goal the agent proposed: same row, same steps, it just
   *  stops being a proposal (and the agent can no longer replace it). */
  async promote(goalId: string): Promise<{ goal: TopicGoal | null }> {
    return request(`/goals/${goalId}/promote`, { method: 'POST' });
  },

  /** Chiude quello attivo. `achieved` e `abandoned` non sono la stessa cosa per
   *  chi rilegge lo storico, quindi la distinzione la fa chi chiude. */
  async close(topicId: string, status: 'achieved' | 'abandoned'): Promise<{ goal: TopicGoal | null }> {
    return request(`/topics/${topicId}/goal`, {
      method: 'DELETE',
      body: JSON.stringify({ status }),
    });
  },

  /** Stop (or restart) the auto-continuation WITHOUT closing the goal: "stop
   *  chasing it by yourself" is not "drop the objective". */
  async setLoop(topicId: string, state: 'running' | 'stopped'): Promise<{ goal: TopicGoal | null }> {
    return request(`/topics/${topicId}/goal/loop`, {
      method: 'POST',
      body: JSON.stringify({ state }),
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

  async deleteTopic(topicId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/memory/topic/${topicId}`, {
      method: 'DELETE',
    });
  },
};

export interface ContextSource {
  id: string;
  label: string;
  category: 'memory' | 'prompt' | 'template' | 'file' | 'pinned';
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
