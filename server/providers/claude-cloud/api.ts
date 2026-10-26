// Client dell'API delle sessioni cloud di Claude Code: la stessa che usa la CLI
// (`claude --cloud`, `claude -p --cloud <sid>`). Non è documentata: tutto ciò che
// dipende dalla sua forma sta in questo file, così se cambia si tocca un posto solo.
// Forma misurata il 26/10/2026 su sessioni vere (payload dal --debug-file della CLI).

export const CLOUD_BETA = "ccr-byoc-2025-07-29";
const API = "https://api.anthropic.com";

export interface CloudCreds {
  accessToken: string;
  orgUuid: string;
}

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
    const c = await this.creds();
    const res = await this.fetchImpl(API + path, {
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
