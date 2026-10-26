// Client dell'API delle sessioni cloud di Claude Code: la stessa che usa la CLI
// (`claude --cloud`, `claude -p --cloud <sid>`). Non è documentata: tutto ciò che
// dipende dalla sua forma sta in questo file, così se cambia si tocca un posto solo.
// Forma misurata il 26/10/2026 su sessioni vere (payload dal --debug-file della CLI).

export const CLOUD_BETA = "ccr-byoc-2025-07-29";
const DEFAULT_API = "https://api.anthropic.com";

/**
 * Where the sessions API answers. Only the e2e suite moves it (`POST /api/test/claude-cloud`),
 * to a fake that plays a session without reaching Anthropic.
 */
let apiBase = DEFAULT_API;
export function setCloudApiBase(base: string | null): void {
  apiBase = base?.replace(/\/$/, "") || DEFAULT_API;
}
export function cloudApiIsReal(): boolean {
  return apiBase === DEFAULT_API;
}

export interface CloudCreds {
  accessToken: string;
  orgUuid: string;
}
/** Ciò che riceve un'API finta al posto del token vero. */
const FAKE_CREDS: CloudCreds = { accessToken: "e2e-fake", orgUuid: "e2e-fake" };

export interface CloudSource {
  /** es. "armonia/topics-app" */
  repo: string;
  /** ramo da cui la VM clona: deve esistere su origin prima del lancio */
  revision: string;
}

export interface CreateSessionInput {
  title: string;
  prompt: string;
  source: CloudSource;
  /** ramo su cui la sessione consegna (la CLI lo chiama outcome) */
  deliveryBranch: string;
  model: string;
  effort?: string;
  environmentId: string;
}

/** Un evento della sessione: stessa forma dei messaggi stream-json della CLI. */
export interface CloudEvent {
  type: string;
  subtype?: string;
  uuid?: string;
  [k: string]: unknown;
}

export interface EventsPage {
  data: CloudEvent[];
  has_more: boolean;
  last_id?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class CloudApi {
  constructor(
    private readonly creds: () => Promise<CloudCreds>,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    // La base si legge PRIMA di chiedere le credenziali, e il token vero si chiede solo per
    // l'API vera: così nessun cambio di base a metà strada può portarlo altrove.
    const base = apiBase;
    const c = base === DEFAULT_API ? await this.creds() : FAKE_CREDS;
    const res = await this.fetchImpl(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${c.accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": CLOUD_BETA,
        "x-organization-uuid": c.orgUuid,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CloudApiError(res.status, `${method} ${path.split("?")[0]} → ${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  async defaultEnvironmentId(): Promise<string> {
    const r = await this.call<{ environments: Array<{ environment_id: string; kind: string; state: string }> }>(
      "GET",
      "/v1/environment_providers",
    );
    const env = r.environments.find((e) => e.kind === "anthropic_cloud" && e.state === "active");
    if (!env) throw new Error("nessun ambiente cloud attivo sull'account");
    return env.environment_id;
  }

  async createSession(input: CreateSessionInput): Promise<string> {
    const r = await this.call<{ id: string }>("POST", "/v1/sessions", {
      title: input.title,
      events: [
        {
          type: "event",
          data: {
            uuid: crypto.randomUUID(),
            session_id: "",
            type: "user",
            parent_tool_use_id: null,
            message: { role: "user", content: input.prompt },
          },
        },
      ],
      session_context: {
        sources: [{ type: "git_repository", url: `https://github.com/${input.source.repo}`, revision: input.source.revision }],
        outcomes: [
          { type: "git_repository", git_info: { type: "github", repo: input.source.repo, branches: [input.deliveryBranch] } },
        ],
        model: input.model,
        ...(input.effort ? { effort_level: input.effort } : {}),
      },
      environment_id: input.environmentId,
    });
    return r.id;
  }

  getSession(sid: string): Promise<{ id: string; session_status: string; title?: string }> {
    return this.call("GET", `/v1/sessions/${sid}`);
  }

  /** Eventi dopo `afterId` (uuid dell'ultimo visto). Pagina vuota = niente di nuovo. */
  events(sid: string, afterId?: string): Promise<EventsPage> {
    const q = `?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`;
    return this.call("GET", `/v1/sessions/${sid}/events${q}`);
  }

  async sendMessage(sid: string, text: string): Promise<void> {
    await this.call("POST", `/v1/sessions/${sid}/events`, {
      events: [
        { type: "user", uuid: crypto.randomUUID(), session_id: sid, parent_tool_use_id: null, message: { role: "user", content: text } },
      ],
    });
  }

  /**
   * Ferma la sessione: interrompe il turno in corso (lo stesso `interrupt` della CLI) e la
   * archivia, così non riparte se qualcuno le scrive. Le due chiamate valgono anche da sole.
   */
  async stopSession(sid: string): Promise<void> {
    const errors: unknown[] = [];
    await this.call("POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "control_request", uuid: crypto.randomUUID(), session_id: sid, request_id: crypto.randomUUID(), request: { subtype: "interrupt", cancel_queued: true } }],
    }).catch((e) => errors.push(e));
    // Come la CLI (`archiveSession`): 409 = già archiviata, va bene uguale.
    await this.call("POST", `/v1/sessions/${sid}/archive`, {}).catch((e) => {
      if (!(e instanceof CloudApiError && e.status === 409)) errors.push(e);
    });
    if (errors.length === 2) throw errors[1];
  }

  /** Risposta a un `control_request` (permesso di un tool). Stesso giro di `cloud-rispondi`. */
  async respondPermission(sid: string, requestId: string, allow: boolean, message?: string): Promise<void> {
    const response = allow ? { behavior: "allow" } : { behavior: "deny", message: message ?? "negato da Topics" };
    await this.call("POST", `/v1/sessions/${sid}/events`, {
      events: [
        {
          type: "control_response",
          uuid: crypto.randomUUID(),
          session_id: sid,
          response: { subtype: "success", request_id: requestId, response },
        },
      ],
    });
  }
}

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
