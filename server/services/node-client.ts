/**
 * How THIS machine talks to a paired node (MACHINE-02, KANBAN-76, KANBAN-77).
 *
 * A node is a second Topics installation that runs a card for us. Legacy runs
 * use the historical device pairing. Delegated runs use a purpose-specific
 * request/claim handshake and a credential scoped to one node authorization;
 * it never becomes an interactive device or an installation-owner session.
 *
 * Pure on purpose: `fetch`, the clock, the wait and the machine's own name
 * come in through `deps`. The file-system side (the token file) is in the two
 * helpers at the bottom, which also accept their `fs` so a test can watch the
 * mode bits without touching the real state dir.
 *
 * The failure NAMES are the contract, not a nicety. "host_not_allowed" is fixed
 * on the node (its allowlist), "tls_untrusted" is fixed on this machine (trust
 * the certificate), "unreachable" is fixed with a cable. One word for all three
 * sends the person to the wrong machine, and that is the defect MACHINE-02 is
 * written against.
 */
import type { ProvidersSnapshot } from "../../shared/types";
import { CLAUDE_CODING_PROVIDERS } from "../../shared/task-coding-models";
import { getPrimaryRole } from "../lib/primary-role";
import type { WorktreePlanEntryPayload } from "../../shared/worktree-plan";
import type { WorktreePolicy, WorktreeSummary } from "../../shared/worktree-summary";
export {
  readNodeToken,
  readDelegatedNodeToken,
  writeNodeToken,
  writeDelegatedNodeToken,
  removeDelegatedNodeToken,
} from "./node-client-token";

export type NodeFailureReason =
  | "unreachable"
  | "host_not_allowed"
  | "tls_untrusted"
  | "unauthorized"
  | "no_such_repo"
  | "branch_unreachable"
  | "payload_too_large"
  | "rejected"
  | "model_rejected"
  | "not_found"
  | "server_error";

export class NodeError extends Error {
  readonly reason: NodeFailureReason;
  /** The HTTP status the node answered with, when it answered at all. */
  readonly status: number | null;
  constructor(reason: NodeFailureReason, message: string, status: number | null = null) {
    super(message);
    this.name = "NodeError";
    this.reason = reason;
    this.status = status;
  }
}

export function isNodeError(err: unknown): err is NodeError {
  return err instanceof NodeError;
}

/** The cookie name the node's `buildSessionCookie` uses (server/lib/device-auth.ts). */
export const NODE_SESSION_COOKIE = "topics_device";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface NodeClientDeps {
  fetch: FetchLike;
  now: () => number;
  /** Resolves after `ms`: the only way `pairWait` pauses between polls. */
  wait: (ms: number) => Promise<void>;
  /** Goes in the User-Agent, so the node's approval card names a machine. */
  version: string;
  hostname: string;
  /** Between two status polls while the node has not answered yet. */
  pollIntervalMs?: number;
}

export interface PairRequestResult {
  requestId: string;
  code: string;
  claim: string;
  name: string;
  expiresInMs: number;
}

export type PairState = "pending" | "approved" | "denied" | "expired";

export interface PairWaitResult {
  state: PairState;
  token?: string;
  name?: string;
}

export interface DelegatedAuthorizationHandshakeBody extends DelegatedNodeBinding {
  purpose: "authorization";
  originPersonId: string | null;
  originDeviceId: string;
  originMachineId: string;
}
export interface DelegatedCatalogHandshakeBody {
  purpose: "catalog";
  repositoryKey: string;
  originMachineId: string;
}
export type DelegatedHandshakeBody = DelegatedAuthorizationHandshakeBody | DelegatedCatalogHandshakeBody;

export interface DelegatedHandshakeState {
  state: "pending" | "approved" | "active" | "denied" | "expired" | "revoked";
  token?: string;
  authorizationId?: string;
  expiresAt?: number;
  models?: string[];
}

export interface CreateRunBody {
  originTaskId: string;
  originUrl: string;
  text: string;
  description: string;
  model: string | null;
  effort: string | null;
  /**
   * The branch the run starts FROM, already on origin: the card's own branch
   * (`carriedBranch`: its delivery branch, or the one kept as `prior_branch`
   * when a review sent it back to the queue). Absent = the default branch,
   * which for such a card throws its commits away (df5fd8c5, 30/10/2026).
   */
  baseBranch?: string | null;
  /**
   * `baseBranch` itself as a base64 git bundle, for a node that cannot reach
   * origin (answered `branch_unreachable`): the branch travels with the run, the
   * way `BundleResult` brings the delivery back.
   */
  branchBundle?: string;
}

/** Immutable authority envelope for the confined delegated-node path. */
export interface DelegatedNodeBinding {
  capabilityId: string;
  subjectPersonId: string | null;
  subjectDeviceId: string;
  machineId: string;
  repositoryKey: string;
  model: string;
  effort: string;
  maxDurationMinutes: number;
  maxAttempts: 1;
  fanout: 1;
}

/** The subset needed to prove ownership of an existing node run. */
export type NodeRunBinding = Pick<
  DelegatedNodeBinding,
  "capabilityId" | "subjectPersonId" | "subjectDeviceId"
>;

export interface NodeRunComment {
  id: string;
  author: string;
  content: string;
  kind: string;
  createdAt: string;
  /** Absolute paths on the NODE's own disk. Fetched back by `fetchMedia`, one at a time. */
  media?: string[];
}

export interface NodeRunReport {
  status: string;
  dispatchState: string | null;
  dispatchError: string | null;
  comments: NodeRunComment[];
  deliveryBranch: string | null;
  deliveryCommit: string | null;
  baseSha: string | null;
  stat: unknown;
  /**
   * Why a run in review brings no branch, in words for the card. A paired node never sends
   * it; the Claude cloud does (error, silence, refused origin), and without it the card
   * would read «the node delivered no branch» over a session that failed.
   */
  reason?: string | null;
  /**
   * The run's card was ARCHIVED on the node (its board DELETE archives the subtree and
   * leaves the status alone, so an archived run still reports `in_progress`). Without this
   * bit a reattach after a restart follows a card nobody will ever move again. An older
   * node, or the Claude cloud, does not send it: absent reads as "not archived", which is
   * what every caller assumed before.
   */
  archived?: boolean;
  /**
   * What the run has spent on the node so far, absolute (a floor, like the local
   * counters). An older node does not send it: absent reads as "unknown".
   */
  usage?: { tokens: number; cacheReadTokens: number; costCents: number } | null;
}

export type BundleResult = { empty: true } | { empty: false; bytes: Uint8Array };

export interface NodeClient {
  pairRequest(baseUrl: string): Promise<PairRequestResult>;
  pairWait(input: {
    baseUrl: string;
    requestId: string;
    claim: string;
    /** How long the node keeps the request alive: after this, `expired`. */
    expiresInMs?: number;
    /** `1` = a single non-blocking poll, `pending` comes back as-is. */
    maxPolls?: number;
  }): Promise<PairWaitResult>;
  openDelegatedRequest(baseUrl: string, body: DelegatedHandshakeBody): Promise<{
    requestId: string; claim: string; code: string; expiresInMs: number;
  }>;
  claimDelegatedRequest(input: { baseUrl: string; requestId: string; claim: string }): Promise<DelegatedHandshakeState>;
  acknowledgeDelegatedRequest(input: { baseUrl: string; requestId: string; claim: string }): Promise<void>;
  revokeDelegatedRequest(input: { baseUrl: string; requestId: string; token?: string; capabilityId?: string; claim?: string }): Promise<void>;
  createRun(input: {
    baseUrl: string;
    token: string;
    body: CreateRunBody;
    delegation?: NodeRunBinding;
  }): Promise<{ runId: string }>;
  readRun(input: {
    baseUrl: string;
    token: string;
    runId: string;
    /**
     * Cursor: the `createdAt` of the last comment already seen. The node
     * returns the comments created AT OR AFTER it (`?since=`), so the caller
     * dedupes by comment id. Nodes have no comment sequence number.
     */
    since?: string;
    delegation?: NodeRunBinding;
  }): Promise<NodeRunReport>;
  fetchBundle(input: { baseUrl: string; token: string; runId: string; delegation?: NodeRunBinding }): Promise<BundleResult>;
  /** One attachment's bytes, by the exact path the node's own comment declared. `null` = the node has nothing there (gone, or never had it). */
  fetchMedia(input: { baseUrl: string; token: string; runId: string; path: string; delegation?: NodeRunBinding }): Promise<Uint8Array | null>;
  cancelRun(input: { baseUrl: string; token: string; runId: string; delegation?: NodeRunBinding }): Promise<void>;
  /** The Claude ids the node's ready Claude coding runtimes list: what its cards can run. */
  codingModels(input: { baseUrl: string; token: string }): Promise<string[]>;
  /**
   * The app version the node really runs (`/api/version`), `null` when it does not say, and
   * what it speaks: `worktreeStandard` is false on a node built before the worktree routes.
   */
  readVersion(input: { baseUrl: string; token: string }): Promise<NodeVersion>;
  /** The node's worktree summary (`null` until its first measure), with its folders when `list`. */
  worktreeSummary(input: { baseUrl: string; token: string; list?: boolean }): Promise<NodeWorktreeReport>;
  /** Sends a worktree policy; `dryRun` answers before/after and writes nothing. A refused value is `rejected`. */
  putWorktreePolicy(input: { baseUrl: string; token: string; policy: WorktreePolicy; dryRun?: boolean }): Promise<NodePolicyResult>;
  /** One cleanup pass on the node now, or (`dryRun`) its preview. */
  worktreeGc(input: { baseUrl: string; token: string; dryRun?: boolean }): Promise<Record<string, unknown>>;
}

export interface NodeVersion {
  version: string | null;
  worktreeStandard: boolean;
}

export interface NodeWorktreeReport {
  summary: WorktreeSummary | null;
  entries?: WorktreePlanEntryPayload[] | null;
}

export interface NodePolicyResult {
  dryRun: boolean;
  before: WorktreePolicy;
  after: WorktreePolicy;
}

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_PAIR_TTL_MS = 3 * 60_000;

/** A base URL is `origin + path` with no trailing slash, http(s) only. `null` = not one. */
export function normalizeNodeBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** `topics_device=<value>` out of one or more Set-Cookie lines. `null` = the node sent none. */
export function tokenFromSetCookie(headers: Headers): string | null {
  const lines: string[] = typeof (headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
    ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
    : [];
  if (lines.length === 0) {
    const single = headers.get("set-cookie");
    if (single) lines.push(single);
  }
  for (const line of lines) {
    const m = new RegExp(`(?:^|,\\s*)${NODE_SESSION_COOKIE}=([^;,\\s]+)`).exec(line);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * A thrown fetch is one of TWO things, and they are fixed in two places.
 *
 * Bun surfaces a certificate it cannot verify as an error whose code or cause
 * names the certificate (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT`,
 * `DEPTH_ZERO_SELF_SIGNED_CERT`, "certificate"). Everything else that never got
 * an HTTP status is the network: refused, reset, no route, no DNS.
 */
function reasonFromThrown(err: unknown): NodeFailureReason {
  const parts: string[] = [];
  const visit = (e: unknown, depth: number) => {
    if (!e || depth > 4) return;
    if (typeof e === "string") { parts.push(e); return; }
    if (typeof e === "object") {
      const o = e as { message?: unknown; code?: unknown; cause?: unknown; name?: unknown };
      if (typeof o.message === "string") parts.push(o.message);
      if (typeof o.code === "string") parts.push(o.code);
      if (typeof o.name === "string") parts.push(o.name);
      visit(o.cause, depth + 1);
    }
  };
  visit(err, 0);
  const text = parts.join(" ");
  if (/certificate|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ERR_TLS|TLS handshake|SSL routines/i.test(text)) {
    return "tls_untrusted";
  }
  return "unreachable";
}

function messageOf(err: unknown): string {
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

async function readErrorBody(res: Response): Promise<{ error?: string; code?: string }> {
  try {
    const text = await res.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * An HTTP answer that is not ok, named. The node's gate writes `code` next to
 * `error` (server.ts, the `host_not_allowed` branch), and the runs route is
 * does the same with `no_such_repo` (older nodes send only `error`): the code wins over the status
 * whenever it is there, because the status alone cannot tell a wrong host
 * from a revoked device (both 403).
 */
async function nodeErrorFromResponse(res: Response, what: string): Promise<NodeError> {
  const body = await readErrorBody(res);
  const detail = body.error ? `: ${body.error}` : "";
  const msg = `${what} answered ${res.status}${detail}`;
  if (body.code === "host_not_allowed" || (res.status === 403 && body.error === "host not allowed")) {
    return new NodeError("host_not_allowed", msg, res.status);
  }
  // A released 2.3.30 node answers `{ error: "no_such_repo" }` with no `code`.
  if (body.code === "no_such_repo" || body.error === "no_such_repo") return new NodeError("no_such_repo", msg, res.status);
  // The node cannot get the carried branch from origin: the caller retries with the branch as a bundle.
  if (body.code === "branch_unreachable") return new NodeError("branch_unreachable", msg, res.status);
  if (res.status === 401 || res.status === 403) return new NodeError("unauthorized", msg, res.status);
  // The node (or a proxy in front of it) refused the request body for its size: waiting never shrinks it.
  if (res.status === 413) return new NodeError("payload_too_large", msg, res.status);
  if (res.status === 404) return new NodeError("not_found", msg, res.status);
  // The node read the request and refused its content (a model outside its
  // catalog, an invalid field): the same body is refused every time, so this is
  // a verdict, not a silence.
  if (body.code === "invalid_task_model") return new NodeError("model_rejected", msg, res.status);
  if (res.status === 400 || res.status === 422) return new NodeError("rejected", msg, res.status);
  return new NodeError("server_error", msg, res.status);
}

export function createNodeClient(deps: NodeClientDeps): NodeClient {
  const userAgent = `Topics/${deps.version} (${deps.hostname})`;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const headersFor = (token: string | null, extra: Record<string, string> = {}): Record<string, string> => ({
    "User-Agent": userAgent,
    Accept: "application/json",
    ...(token ? { Cookie: `${NODE_SESSION_COOKIE}=${token}` } : {}),
    // Every call to a node carries the primary's epoch, so the node learns the highest one and
    // refuses a replaced primary. Read here, once for every client: no caller can forget it.
    ...(getPrimaryRole()?.outgoingHeaders() ?? {}),
    ...extra,
  });
  const delegatedHeaders = (delegation: NodeRunBinding | undefined): Record<string, string> =>
    delegation ? { "X-Topics-Delegated-Capability": delegation.capabilityId } : {};

  /** One request, with the thrown-vs-answered split applied once for everybody. */
  const call = async (url: string, init: RequestInit, what: string): Promise<Response> => {
    let res: Response;
    try {
      res = await deps.fetch(url, init);
    } catch (err) {
      throw new NodeError(reasonFromThrown(err), `${what}: ${messageOf(err)}`);
    }
    if (!res.ok) throw await nodeErrorFromResponse(res, what);
    return res;
  };

  const callJson = async <T>(url: string, init: RequestInit, what: string): Promise<T> => {
    const res = await call(url, init, what);
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new NodeError("server_error", `${what}: body is not JSON (${messageOf(err)})`, res.status);
    }
  };

  const runUrl = (baseUrl: string, runId: string, delegated = false) =>
    `${baseUrl}/api/nodes/${delegated ? "delegated-runs" : "runs"}/${encodeURIComponent(runId)}`;

  return {
    async pairRequest(baseUrl) {
      const out = await callJson<Partial<PairRequestResult>>(
        `${baseUrl}/api/auth/pair/request`,
        // The node records this machine as the primary that paired it (its channel).
        { method: "POST", headers: headersFor(null, getPrimaryRole()?.pairingHeaders()) },
        "pair request",
      );
      if (typeof out.requestId !== "string" || typeof out.claim !== "string" || typeof out.code !== "string") {
        throw new NodeError("server_error", "pair request: answer is missing requestId, code or claim", 200);
      }
      return {
        requestId: out.requestId,
        code: out.code,
        claim: out.claim,
        name: typeof out.name === "string" ? out.name : "",
        expiresInMs: typeof out.expiresInMs === "number" ? out.expiresInMs : DEFAULT_PAIR_TTL_MS,
      };
    },

    async pairWait({ baseUrl, requestId, claim, expiresInMs, maxPolls }) {
      const deadline = deps.now() + (expiresInMs ?? DEFAULT_PAIR_TTL_MS);
      const url = `${baseUrl}/api/auth/pair/status?requestId=${encodeURIComponent(requestId)}&claim=${encodeURIComponent(claim)}`;
      let polls = 0;
      for (;;) {
        polls += 1;
        const res = await call(url, { method: "GET", headers: headersFor(null) }, "pair status");
        let body: { state?: unknown; name?: unknown };
        try {
          body = (await res.json()) as { state?: unknown; name?: unknown };
        } catch (err) {
          throw new NodeError("server_error", `pair status: body is not JSON (${messageOf(err)})`, res.status);
        }
        const state = body.state;
        if (state === "approved") {
          // The token travels ONLY as the cookie, once: a body field would be
          // one more place for it to leak into a log.
          const token = tokenFromSetCookie(res.headers);
          if (!token) throw new NodeError("server_error", "pair status: approved without a session cookie", res.status);
          return { state: "approved", token, name: typeof body.name === "string" ? body.name : undefined };
        }
        if (state === "denied" || state === "expired") return { state };
        if (maxPolls !== undefined && polls >= maxPolls) return { state: "pending" };
        // The clock, not a poll count, decides expiry: the node's own TTL is
        // what the request dies of, and this mirrors it without a network hit.
        if (deps.now() >= deadline) return { state: "expired" };
        await deps.wait(pollIntervalMs);
      }
    },

    async openDelegatedRequest(baseUrl, body) {
      const out = await callJson<Record<string, unknown>>(
        `${baseUrl}/api/nodes/delegated-requests`,
        { method: "POST", headers: headersFor(null, { "Content-Type": "application/json" }), body: JSON.stringify(body) },
        "delegated request",
      );
      if (typeof out.requestId !== "string" || typeof out.claim !== "string" || typeof out.code !== "string") {
        throw new NodeError("server_error", "delegated request: answer is incomplete", 200);
      }
      return {
        requestId: out.requestId,
        claim: out.claim,
        code: out.code,
        expiresInMs: typeof out.expiresInMs === "number" ? out.expiresInMs : DEFAULT_PAIR_TTL_MS,
      };
    },

    async claimDelegatedRequest({ baseUrl, requestId, claim }) {
      const res = await call(
        `${baseUrl}/api/nodes/delegated-requests/${encodeURIComponent(requestId)}/claim?claim=${encodeURIComponent(claim)}`,
        { method: "GET", headers: headersFor(null) },
        "delegated claim",
      );
      const out = await res.json() as Record<string, unknown>;
      const state = out.state;
      if (!["pending", "approved", "active", "denied", "expired", "revoked"].includes(String(state))) {
        throw new NodeError("server_error", "delegated claim: invalid state", res.status);
      }
      if (state !== "approved") return { state } as DelegatedHandshakeState;
      const token = tokenFromSetCookie(res.headers);
      const models = Array.isArray(out.models) ? out.models.filter((model): model is string => typeof model === "string") : undefined;
      if (!token && models) return {
        state: "approved", models,
        expiresAt: typeof out.expiresAt === "number" ? out.expiresAt : undefined,
      };
      if (!token || typeof out.authorizationId !== "string") {
        throw new NodeError("server_error", "delegated claim: approved without confined credential", res.status);
      }
      return {
        state: "approved", token, authorizationId: out.authorizationId,
        expiresAt: typeof out.expiresAt === "number" ? out.expiresAt : undefined,
        models,
      };
    },

    async acknowledgeDelegatedRequest({ baseUrl, requestId, claim }) {
      await call(
        `${baseUrl}/api/nodes/delegated-requests/${encodeURIComponent(requestId)}/ack?claim=${encodeURIComponent(claim)}`,
        { method: "POST", headers: headersFor(null) },
        "delegated acknowledgement",
      );
    },

    async revokeDelegatedRequest({ baseUrl, requestId, token, capabilityId, claim }) {
      const query = claim ? `?claim=${encodeURIComponent(claim)}` : "";
      await call(
        `${baseUrl}/api/nodes/delegated-requests/${encodeURIComponent(requestId)}${query}`,
        {
          method: "DELETE",
          headers: headersFor(token ?? null, capabilityId ? { "X-Topics-Delegated-Capability": capabilityId } : {}),
        },
        "delegated revoke",
      );
    },

    async createRun({ baseUrl, token, body, delegation }) {
      const wireBody = delegation
        ? { originTaskId: body.originTaskId, originUrl: body.originUrl, text: body.text, description: body.description }
        : body;
      const payload = JSON.stringify(wireBody);
      const out = await callJson<{ runId?: unknown }>(
        `${baseUrl}/api/nodes/${delegation ? "delegated-runs" : "runs"}`,
        {
          method: "POST",
          headers: headersFor(token, {
            "Content-Type": "application/json",
            ...delegatedHeaders(delegation),
          }),
          body: payload,
        },
        "create run",
      ).catch((err: unknown) => {
        if (isNodeError(err) && err.reason === "payload_too_large") {
          const bytes = new TextEncoder().encode(payload).length;
          throw new NodeError("payload_too_large", `${err.message} (request body ${bytes} bytes)`, err.status);
        }
        throw err;
      });
      if (typeof out.runId !== "string" || !out.runId) {
        throw new NodeError("server_error", "create run: answer has no runId", 200);
      }
      return { runId: out.runId };
    },

    async readRun({ baseUrl, token, runId, since, delegation }) {
      const qs = since ? `?since=${encodeURIComponent(since)}` : "";
      const out = await callJson<Partial<NodeRunReport>>(
        `${runUrl(baseUrl, runId, !!delegation)}${qs}`,
        { method: "GET", headers: headersFor(token, delegatedHeaders(delegation)) },
        "read run",
      );
      return {
        status: typeof out.status === "string" ? out.status : "unknown",
        dispatchState: typeof out.dispatchState === "string" ? out.dispatchState : null,
        dispatchError: typeof out.dispatchError === "string" ? out.dispatchError : null,
        comments: Array.isArray(out.comments)
          ? out.comments.map((c) => ({
              ...c,
              media: Array.isArray((c as { media?: unknown }).media)
                ? (c as { media: unknown[] }).media.filter((p): p is string => typeof p === "string")
                : undefined,
            }))
          : [],
        deliveryBranch: typeof out.deliveryBranch === "string" ? out.deliveryBranch : null,
        deliveryCommit: typeof out.deliveryCommit === "string" ? out.deliveryCommit : null,
        baseSha: typeof out.baseSha === "string" ? out.baseSha : null,
        stat: out.stat ?? null,
        reason: typeof out.reason === "string" ? out.reason : null,
        archived: out.archived === true,
        usage: parseRunUsage(out.usage),
      };
    },

    async fetchBundle({ baseUrl, token, runId, delegation }) {
      const res = await call(
        `${runUrl(baseUrl, runId, !!delegation)}/bundle`,
        { method: "GET", headers: headersFor(token, {
          Accept: "application/octet-stream, application/json",
          ...delegatedHeaders(delegation),
        }) },
        "fetch bundle",
      );
      // "Nothing to deliver" is a JSON answer, the branch is raw bytes: the
      // content type is what tells them apart, not the length (an empty bundle
      // body would otherwise be verified as a bundle and fail with git's words).
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("application/json")) {
        let body: { empty?: unknown };
        try {
          body = (await res.json()) as { empty?: unknown };
        } catch (err) {
          throw new NodeError("server_error", `fetch bundle: body is not JSON (${messageOf(err)})`, res.status);
        }
        if (body.empty === true) return { empty: true };
        throw new NodeError("server_error", "fetch bundle: JSON answer that is not {empty:true}", res.status);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { empty: false, bytes };
    },

    async fetchMedia({ baseUrl, token, runId, path, delegation }) {
      try {
        const res = await call(
          `${runUrl(baseUrl, runId, !!delegation)}/media?path=${encodeURIComponent(path)}`,
          { method: "GET", headers: headersFor(token, delegatedHeaders(delegation)) },
          "fetch media",
        );
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        if (isNodeError(err) && (err.status === 403 || err.status === 404)) return null;
        throw err;
      }
    },

    async cancelRun({ baseUrl, token, runId, delegation }) {
      await call(
        runUrl(baseUrl, runId, !!delegation),
        { method: "DELETE", headers: headersFor(token, delegatedHeaders(delegation)) },
        "cancel run",
      );
    },

    async readVersion({ baseUrl, token }) {
      const out = await callJson<{ version?: unknown; worktreeStandard?: unknown }>(
        `${baseUrl}/api/version`,
        { method: "GET", headers: headersFor(token) },
        "read version",
      );
      return {
        version: typeof out.version === "string" && out.version ? out.version : null,
        worktreeStandard: out.worktreeStandard === 1,
      };
    },

    // The three worktree calls never carry a delegation: they are the primary's, on its channel.
    async worktreeSummary({ baseUrl, token, list }) {
      const out = await callJson<{ summary?: unknown; entries?: unknown }>(
        `${baseUrl}/api/nodes/worktrees${list ? "?list=1" : ""}`,
        { method: "GET", headers: headersFor(token) },
        "worktree summary",
      );
      const summary = out.summary && typeof out.summary === "object" ? out.summary as WorktreeSummary : null;
      return list ? { summary, entries: Array.isArray(out.entries) ? out.entries as WorktreePlanEntryPayload[] : null } : { summary };
    },

    async putWorktreePolicy({ baseUrl, token, policy, dryRun }) {
      const out = await callJson<{ dryRun?: unknown; before?: unknown; after?: unknown }>(
        `${baseUrl}/api/nodes/worktree-policy`,
        {
          method: "PUT",
          headers: headersFor(token, { "Content-Type": "application/json" }),
          body: JSON.stringify({ ...policy, ...(dryRun ? { dryRun: true } : {}) }),
        },
        "worktree policy",
      );
      return {
        dryRun: out.dryRun === true,
        before: (out.before ?? {}) as WorktreePolicy,
        after: (out.after ?? {}) as WorktreePolicy,
      };
    },

    async worktreeGc({ baseUrl, token, dryRun }) {
      return callJson<Record<string, unknown>>(
        `${baseUrl}/api/nodes/worktrees/gc${dryRun ? "?dryRun=1" : ""}`,
        { method: "POST", headers: headersFor(token) },
        "worktree cleanup",
      );
    },

    async codingModels({ baseUrl, token }) {
      const out = await callJson<Partial<ProvidersSnapshot>>(
        `${baseUrl}/api/providers/snapshot`,
        { method: "GET", headers: headersFor(token) },
        "read models",
      );
      const ready = (out.providers ?? []).filter((p) => p?.status === "ready" && CLAUDE_CODING_PROVIDERS.includes(p.name));
      return [...new Set(ready.flatMap((p) => (Array.isArray(p.models) ? p.models.filter((m) => typeof m === "string") : [])))];
    },
  };
}

/** The usage block of a run report; anything that is not three finite numbers reads as unknown. */
function parseRunUsage(raw: unknown): NodeRunReport["usage"] {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
  return { tokens: n(u.tokens), cacheReadTokens: n(u.cacheReadTokens), costCents: n(u.costCents) };
}
