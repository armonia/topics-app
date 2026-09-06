/**
 * How THIS machine talks to a paired node (MACHINE-02, KANBAN-76, KANBAN-77).
 *
 * A node is a second Topics installation that runs a card for us. We are one
 * of its DEVICES: the pairing is the same `/api/auth/pair/*` handshake a phone
 * goes through, and the credential we keep is the device cookie the node
 * minted. There is no second identity and no shared secret on our side.
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
import * as nodeFs from "node:fs";
import { join } from "node:path";

export type NodeFailureReason =
  | "unreachable"
  | "host_not_allowed"
  | "tls_untrusted"
  | "unauthorized"
  | "no_such_repo"
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

export interface CreateRunBody {
  originTaskId: string;
  originUrl: string;
  text: string;
  description: string;
  model: string | null;
  effort: string | null;
}

export interface NodeRunComment {
  id: string;
  author: string;
  content: string;
  kind: string;
  createdAt: string;
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
  createRun(input: { baseUrl: string; token: string; body: CreateRunBody }): Promise<{ runId: string }>;
  readRun(input: {
    baseUrl: string;
    token: string;
    runId: string;
    sinceCommentSeq?: number;
  }): Promise<NodeRunReport>;
  fetchBundle(input: { baseUrl: string; token: string; runId: string }): Promise<BundleResult>;
  cancelRun(input: { baseUrl: string; token: string; runId: string }): Promise<void>;
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
 * expected to do the same with `no_such_repo`: the code wins over the status
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
  if (body.code === "no_such_repo") return new NodeError("no_such_repo", msg, res.status);
  if (res.status === 401 || res.status === 403) return new NodeError("unauthorized", msg, res.status);
  if (res.status === 404) return new NodeError("not_found", msg, res.status);
  return new NodeError("server_error", msg, res.status);
}

export function createNodeClient(deps: NodeClientDeps): NodeClient {
  const userAgent = `Topics/${deps.version} (${deps.hostname})`;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const headersFor = (token: string | null, extra: Record<string, string> = {}): Record<string, string> => ({
    "User-Agent": userAgent,
    Accept: "application/json",
    ...(token ? { Cookie: `${NODE_SESSION_COOKIE}=${token}` } : {}),
    ...extra,
  });

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

  const runUrl = (baseUrl: string, runId: string) => `${baseUrl}/api/nodes/runs/${encodeURIComponent(runId)}`;

  return {
    async pairRequest(baseUrl) {
      const out = await callJson<Partial<PairRequestResult>>(
        `${baseUrl}/api/auth/pair/request`,
        { method: "POST", headers: headersFor(null) },
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

    async createRun({ baseUrl, token, body }) {
      const out = await callJson<{ runId?: unknown }>(
        `${baseUrl}/api/nodes/runs`,
        {
          method: "POST",
          headers: headersFor(token, { "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        },
        "create run",
      );
      if (typeof out.runId !== "string" || !out.runId) {
        throw new NodeError("server_error", "create run: answer has no runId", 200);
      }
      return { runId: out.runId };
    },

    async readRun({ baseUrl, token, runId, sinceCommentSeq }) {
      const qs = sinceCommentSeq !== undefined ? `?sinceCommentSeq=${encodeURIComponent(String(sinceCommentSeq))}` : "";
      const out = await callJson<Partial<NodeRunReport>>(
        `${runUrl(baseUrl, runId)}${qs}`,
        { method: "GET", headers: headersFor(token) },
        "read run",
      );
      return {
        status: typeof out.status === "string" ? out.status : "unknown",
        dispatchState: typeof out.dispatchState === "string" ? out.dispatchState : null,
        dispatchError: typeof out.dispatchError === "string" ? out.dispatchError : null,
        comments: Array.isArray(out.comments) ? out.comments : [],
        deliveryBranch: typeof out.deliveryBranch === "string" ? out.deliveryBranch : null,
        deliveryCommit: typeof out.deliveryCommit === "string" ? out.deliveryCommit : null,
        baseSha: typeof out.baseSha === "string" ? out.baseSha : null,
        stat: out.stat ?? null,
      };
    },

    async fetchBundle({ baseUrl, token, runId }) {
      const res = await call(
        `${runUrl(baseUrl, runId)}/bundle`,
        { method: "GET", headers: headersFor(token, { Accept: "application/octet-stream, application/json" }) },
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

    async cancelRun({ baseUrl, token, runId }) {
      await call(runUrl(baseUrl, runId), { method: "DELETE", headers: headersFor(token) }, "cancel run");
    },
  };
}

// ── The token file ──────────────────────────────────────────────────────────

/** The subset of `node:fs` the token helpers touch, so a test can watch it. */
export interface TokenFs {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: "utf8") => string;
  writeFileSync: (p: string, data: string, opts: { mode: number }) => void;
  mkdirSync: (p: string, opts: { recursive: true; mode: number }) => unknown;
  chmodSync: (p: string, mode: number) => void;
}

const MACHINE_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** `<stateDir>/nodes/<machineId>.token`; a machine id that is not a plain name is refused, it is a file name. */
export function nodeTokenPath(stateDir: string, machineId: string): string {
  if (!MACHINE_ID_SHAPE.test(machineId)) throw new Error(`nodeTokenPath: machine id "${machineId}" is not a file name`);
  return join(stateDir, "nodes", `${machineId}.token`);
}

/** `null` = never paired, or the file was tampered into a shape no cookie has. */
export function readNodeToken(stateDir: string, machineId: string, fs: TokenFs = nodeFs): string | null {
  const f = nodeTokenPath(stateDir, machineId);
  try {
    if (!fs.existsSync(f)) return null;
    const v = fs.readFileSync(f, "utf8").trim();
    return /^[A-Za-z0-9_.-]{16,1024}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Same discipline as `relay-secret` (server/services/relay-config.ts): a file
 * of its own, `0600`, in a `0700` folder. The `chmod` after the write is not
 * redundant: `writeFileSync`'s mode applies only when the file is CREATED, so
 * a re-pairing over an old file left at a wider mode would keep that mode.
 */
export function writeNodeToken(stateDir: string, machineId: string, token: string, fs: TokenFs = nodeFs): string {
  const f = nodeTokenPath(stateDir, machineId);
  const dir = join(stateDir, "nodes");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(f, token + "\n", { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return f;
}
