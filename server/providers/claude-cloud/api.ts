// Client for the Claude Code cloud sessions API: the same one the CLI uses
// (`claude --cloud`, `claude -p --cloud <sid>`). It is undocumented: everything that
// depends on its shape lives in this file, so if it changes only one place is touched.
// Shape measured on 26/10/2026 on real sessions (payloads from the CLI's --debug-file).

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

export interface CloudCredentials {
  accessToken: string;
  orgUuid: string;
}
/** What a fake API receives in place of the real token. */
const FAKE_CREDENTIALS: CloudCredentials = { accessToken: "e2e-fake", orgUuid: "e2e-fake" };

export interface CloudSource {
  /** e.g. "armonia/topics-app" */
  repo: string;
  /** branch the VM clones from: it must exist on origin before launch */
  revision: string;
}

export interface CreateSessionInput {
  title: string;
  prompt: string;
  source: CloudSource;
  /** branch the session delivers on (the CLI calls it outcome) */
  deliveryBranch: string;
  model: string;
  effort?: string;
  environmentId: string;
}

/** A session event: same shape as the CLI's stream-json messages. */
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
    private readonly creds: () => Promise<CloudCredentials>,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    // The base is read BEFORE asking for credentials, and the real token is requested only for
    // the real API: so no base change midway can carry it elsewhere.
    const base = apiBase;
    let c: CloudCredentials;
    try { c = base === DEFAULT_API ? await this.creds() : FAKE_CREDENTIALS; }
    catch (err) { throw new CloudSetupError(`credenziali del cloud non leggibili: ${err instanceof Error ? err.message : String(err)}`); }
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
      // A token the API refuses is the account, not a silent service: retrying in
      // five minutes gets the same answer (30/10/2026, a Keychain login switched).
      if (res.status === 401 || res.status === 403) {
        throw new CloudSetupError(`l'API del cloud rifiuta l'account (${res.status} su ${path.split("?")[0]})`);
      }
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
    if (!env) throw new CloudSetupError("nessun ambiente cloud attivo sull'account");
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

  /** Events after `afterId` (uuid of the last one seen). Empty page = nothing new. */
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
   * Stops the session: interrupts the running turn (the CLI's same `interrupt`) and
   * archives it, so it does not restart if someone writes to it. Either call also works alone.
   */
  async stopSession(sid: string): Promise<void> {
    const errors: unknown[] = [];
    await this.call("POST", `/v1/sessions/${sid}/events`, {
      events: [{ type: "control_request", uuid: crypto.randomUUID(), session_id: sid, request_id: crypto.randomUUID(), request: { subtype: "interrupt", cancel_queued: true } }],
    }).catch((e) => errors.push(e));
    // Like the CLI (`archiveSession`): 409 = already archived, which is fine.
    await this.call("POST", `/v1/sessions/${sid}/archive`, {}).catch((e) => {
      if (!(e instanceof CloudApiError && e.status === 409)) errors.push(e);
    });
    if (errors.length === 2) throw errors[1];
  }

  /** Reply to a `control_request` (a tool permission). Same flow as `cloud-rispondi`. */
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

/**
 * The cloud cannot run anything for THIS account: no active cloud environment,
 * credentials that do not read, a token the API refuses. Not a silent node: on
 * 30/10/2026 seven cards waited 31 minutes for "the node does not answer" while
 * the node answered and the Keychain login had moved to an account without
 * cloud environments. `reason` is what the remote lane reads (`nodeFailureReason`).
 */
export class CloudSetupError extends Error {
  readonly reason = "cloud_setup";
  constructor(message: string) {
    super(message);
    this.name = "CloudSetupError";
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
