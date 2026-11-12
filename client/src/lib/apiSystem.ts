import type { ProvidersSnapshot, ProviderSnapshotEntry, Project, Worktree } from '../types';
import type { ToolGrant, DiscordDetailLevel, AgentRuntime } from '../../../shared/types';
import type { DirectEndpointInput, DirectEndpointView } from '../../../shared/direct-endpoints';
import type { CalendarAgenda } from '../../../shared/calendar';
import type { McpFleetStatus } from '../../../shared/session-environment';
import type { SessionEnvironment } from '../../../shared/session-environment';
import type { ProfileStats, DiscordPresenceStatus, DiscordActivity as DiscordActivityPreview } from '../../../shared/types';
import type { ProfilePrivacy, FollowCounts } from '../../../shared/profile';
import type { FriendshipState } from '../../../shared/friendship';
import { request } from './apiBase';

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

  /**
   * The endpoints somebody configured by hand. The token is write-only across
   * this boundary: it goes out in `saveEndpoint`, and what comes back says
   * `hasToken`, never the secret itself.
   */
  async listEndpoints(): Promise<{ endpoints: DirectEndpointView[] }> {
    return request<{ endpoints: DirectEndpointView[] }>('/providers/endpoints');
  },

  async testEndpoint(endpoint: DirectEndpointInput): Promise<{ ok: boolean; models: string[]; error?: string }> {
    return request<{ ok: boolean; models: string[]; error?: string }>('/providers/endpoints/test', {
      method: 'POST',
      body: JSON.stringify(endpoint),
    });
  },

  async saveEndpoint(endpoint: DirectEndpointInput): Promise<{ ok: boolean; endpoint: DirectEndpointView; models: string[] }> {
    return request<{ ok: boolean; endpoint: DirectEndpointView; models: string[] }>('/providers/endpoints', {
      method: 'POST',
      body: JSON.stringify(endpoint),
    });
  },

  async deleteEndpoint(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/providers/endpoints/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

  /** Which agent CLIs this machine has, and which ones were pointed at by hand. */
  async cliAgents(): Promise<{ agents: CliAgentPresence[] }> {
    return request<{ agents: CliAgentPresence[] }>('/providers/cli');
  },

  /**
   * Point an agent CLI at a path, or clear it with `path: null`. The server
   * validates it, re-registers the providers and answers with the fresh list, so
   * the caller never has to guess whether it worked.
   */
  async configureCliAgent(agent: string, path: string | null) {
    return request<{ ok: boolean; path: string | null; agents: CliAgentPresence[] }>(
      '/providers/cli/configure',
      { method: 'POST', body: JSON.stringify({ agent, path }) },
    );
  },
};

export const systemApi = {
  async agents(): Promise<{ agents: CliAgentPresence[] }> {
    return request<{ agents: CliAgentPresence[] }>('/system/agents');
  },
};

/** Mirror of `AgentPresence` in `server/lib/detect-agents.ts`. */
export interface CliAgentPresence {
  id: string;
  name: string;
  path: string | null;
  installed: boolean;
  install: string;
  url: string;
  manualPath: string | null;
  manualPathBroken: boolean;
  /** The file name the CLI installs itself as (`claude` for Claude Code). */
  bin: string;
}

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
  museModel: string | null;
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
  /** Topics snapshots the tree before every turn, onto a dedicated git ref.
   *  `null` or `false` = OFF: it writes objects into the user's repository on
   *  every turn, so it is turned on by hand or not at all. */
  turnCheckpointsEnabled: boolean | null;
  /** The calendar sync (card aa641133). `null` or `false` = off, and nothing
   *  is fetched. */
  calendarEnabled: boolean | null;
  /** The iCalendar feed address. It is a SECRET -- whoever holds it reads that
   *  calendar -- so it is shown masked and never leaves this machine. */
  calendarFeedUrl: string | null;
  /** Maximum age of the cached agenda, in minutes. `null` = the server's
   *  default. */
  calendarRefreshMinutes: number | null;
  /** How far ahead the agenda looks, in days. `null` = the server's default. */
  calendarHorizonDays: number | null;
  /** LEVEL 1 of the cleanup of closed browsers' data: empty the cache of the
   *  idle orphan stores, keep the logins. `null` = never touched = ON; only
   *  `false` stops it (`shared/browser-store-reap.ts`). */
  browserStoreCacheReapEnabled: boolean | null;
  /** LEVEL 2: remove the whole store too. `null` = never touched = OFF; only
   *  `true` turns it on, and it counts only while level 1 is on. */
  browserStoreReapEnabled: boolean | null;
  /** Days without use before a closed browser's data is cleaned up, 7..365.
   *  `null` = the default, 60. */
  browserStoreReapAfterDays: number | null;
  firstRunDoneAt: string | null;
}

/**
 * Le regole di «Consenti sempre» sugli strumenti.
 *
 * Esistono come API di client per una ragione sola: un permesso concesso per
 * sempre che non si può rileggere né togliere è una porta che si apre e basta.
 * La superficie è in Impostazioni → Permessi.
 */
export type { ToolGrant } from '../../../shared/types';
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
// The calendar. The agenda is READ from here and configured through
// `appSettingsApi`: the feed address goes in one way and never comes back out,
// so nothing on this side ever holds it except the field being typed.
// ─────────────────────────────────────────────────────────────────────────────
export type { CalendarAgenda } from '../../../shared/calendar';
export interface CalendarProbe {
  ok: boolean;
  name?: string;
  events?: number;
  error?: string;
}

export const calendarApi = {
  /** `force` is the refresh gesture: it skips the freshness check, not the
   *  rest of the path. */
  async agenda(force = false): Promise<CalendarAgenda> {
    return await request<CalendarAgenda>(`/calendar/agenda${force ? '?force=1' : ''}`);
  },
  /** Test an address BEFORE saving it: the answer is the calendar's own name,
   *  or the reason it did not answer. */
  async probe(url: string): Promise<CalendarProbe> {
    return await request<CalendarProbe>('/calendar/probe', {
      method: 'POST',
      body: JSON.stringify({ url }),
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
export type { McpFleetStatus, McpServerStatus } from '../../../shared/session-environment';
export const mcpApi = {
  /**
   * Read the fleet. The server MOUNTS ON READ, so this can take as long as the
   * slowest handshake: the answer is measured, not a cached guess.
   */
  async fleet(signal?: AbortSignal): Promise<McpFleetStatus> {
    return request<McpFleetStatus>('/mcp/fleet', { signal });
  },
  /** Mounted now, WITHOUT mounting: the Tools tail of the user menu. */
  async peek(signal?: AbortSignal): Promise<McpFleetStatus> {
    return request<McpFleetStatus>('/mcp/fleet?peek=1', { signal });
  },

  /** Drop every connection and mount again, then answer with the new state. */
  async refresh(): Promise<McpFleetStatus> {
    return request<McpFleetStatus>('/mcp/fleet/refresh', { method: 'POST' });
  },

  /**
   * Begin the OAuth sign-in for one server, and answer with where to send the
   * person.
   *
   * It does NOT wait for the sign-in: the server keeps a loopback listener open
   * for that, re-mounts the fleet when the person comes back, and the panel
   * learns about it from `fleet()` like it learns about everything else. There
   * is deliberately no second endpoint to ask "am I signed in yet".
   */
  async startOauth(server: string): Promise<{ authorizeUrl: string }> {
    return request<{ authorizeUrl: string }>('/mcp/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ server }),
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// The inherited environment of ONE session: hooks, skills, commands, MCP and
// permission rules that the spawned CLI already has because of
// `--setting-sources user,project,local`. Read-only, and it writes nothing.
// ─────────────────────────────────────────────────────────────────────────────
// Only what the screen names: an unused re-export is dead code, and the rest of
// the shapes travel inside `SessionEnvironment` anyway.
export type { SessionEnvironment, SessionEnvSource } from '../../../shared/session-environment';
export const sessionEnvironmentApi = {
  async get(topicId: string, signal?: AbortSignal): Promise<SessionEnvironment> {
    return request<SessionEnvironment>(`/topics/${encodeURIComponent(topicId)}/environment`, { signal });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Profilo — chi sei qui dentro, cosa è passato di qui, e cosa ne vede Discord.
//
// Le statistiche NON vengono da `usage_records`/`agent_sessions`: quelle due
// tabelle non coprono il lavoro vero (`usage_records` la scrivono solo le chiamate laterali), e un numero letto da
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

export interface StatsPersonClient {
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
/* The friendship states travel too, and for the same reason they are declared
 * once: five spellings copied by hand become four on one side the first time
 * somebody adds a sixth. `FriendshipEdge` is NOT re-exported here. It is the
 * server's own reading shape, nothing on this side holds one, and an export
 * with no consumer is a promise the next reader has to check. */
export type { FriendshipState } from "../../../shared/friendship";
export interface PersonWithProfile {
  id: string;
  displayName: string;
  email: string | null;
  githubLogin: string | null;
  github: ProfiloGitHubClient | null;
  /** `null` when this person does not publish their figures. */
  stats: StatsPersonClient | null;
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
  /** Where I stand with them, from `GET /api/people/:id` only. The address
   *  book does not carry it: a list has no button to draw. */
  friendship?: FriendshipState;
}

/** A person in one of the three friendship lists, with the moment the relation
 *  reached the state that put it in that list. */
export type FriendPerson = PersonWithProfile & { since: number };

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
  /**
   * The directory. Does NOT touch GitHub: the faces come from the server cache.
   *
   * `{ stats: false }` for a caller that does not draw the numbers: the
   * aggregates behind them read tens of MB per call, and the hooks that poll
   * this list every minute only draw a name and a face.
   */
  async list(opts: { stats?: boolean } = {}): Promise<{ people: PersonWithProfile[] }> {
    return request<{ people: PersonWithProfile[] }>(opts.stats === false ? '/people?stats=0' : '/people');
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
  async rename(id: string, name: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/auth/people/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ name }),
    });
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

/**
 * THE OTHER RELATION. A follow is "I read you" and lives in `peopleApi`; a
 * friendship is "we know each other", it is asked for and answered, and it is
 * the only one of the two that can be refused. Its own object rather than five
 * more methods on `peopleApi`, because one of the five is not about a person
 * at all: `list()` is about me.
 *
 * EVERY MUTATION ANSWERS WITH THE RESULTING STATE, so a caller can draw the new
 * button without waiting for a list to come back. A refused gesture throws
 * `ApiError` instead: 400 for befriending yourself, 409 for asking again after
 * a refusal or answering a request that is not there.
 */
export const friendsApi = {
  /** My friends, and the requests in both directions. */
  async list(): Promise<{ friends: FriendPerson[]; incoming: FriendPerson[]; outgoing: FriendPerson[] }> {
    return request<{ friends: FriendPerson[]; incoming: FriendPerson[]; outgoing: FriendPerson[] }>('/friendships');
  },
  /** Ask. If they have already asked me, this accepts instead: two people
   *  pressing the same button mean the same thing. */
  async request(id: string): Promise<{ state: FriendshipState }> {
    return request<{ state: FriendshipState }>(`/people/${id}/friend`, { method: 'POST' });
  },
  async accept(id: string): Promise<{ state: FriendshipState }> {
    return request<{ state: FriendshipState }>(`/people/${id}/friend/accept`, { method: 'POST' });
  },
  async decline(id: string): Promise<{ state: FriendshipState }> {
    return request<{ state: FriendshipState }>(`/people/${id}/friend/decline`, { method: 'POST' });
  },
  /** Withdraw my own request, or end a friendship. One call, because from the
   *  person pressing it there is one meaning: undo this. */
  async cancel(id: string): Promise<{ state: FriendshipState }> {
    return request<{ state: FriendshipState }>(`/people/${id}/friend`, { method: 'DELETE' });
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
