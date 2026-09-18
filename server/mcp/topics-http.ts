/**
 * THE ONE HTTP CALL THE BRIDGE TOOLS MAKE, and the two facts it needs.
 *
 * Split out of `topics-mcp-server.ts` to break an import CYCLE, not for tidiness:
 * the outbound tools live in their own module (they arrive with their own
 * contract and their own poll loop) and they need this helper, while the
 * dispatcher needs their schemas to build its tool list. In ESM that circle
 * happens to work as long as neither side reads the other at module scope,
 * which is a property of today's code and not of the design: `GATE-08`
 * (`tests/unit/no-import-cycles.test.ts`) refuses it, and it is right to, since
 * the failure it prevents is a silent `undefined` at boot rather than an error.
 *
 * So the shared thing moved to where both sides can import it from: one
 * direction, no circle.
 */

/** The argv contract of the bridge process, parsed once at startup. */
export interface ParsedArgs {
  baseUrl: string;
  sessionKey: string;
  gatewayToken?: string;
  /** Tool profile. "dispatch" scopes Claude task agents; "codex-dispatch" omits Claude-only spawning; "global-orchestrator" is the registry-gated global board surface. */
  profile?: string;
}

/**
 * How long ONE bridge request may stay open before we call it lost.
 *
 * `fetch` has no timeout of its own: a server that accepts the connection and
 * then says nothing (paused process, half-open socket after a sleep/wake) held
 * the call open forever, and with it the turn of whoever was waiting for the
 * answer. Generous on purpose - it is the "this will never arrive" line, not a
 * latency budget. The calls that stay open BY CONSTRUCTION (waiting on a
 * process, on a human's answer) pass their own signal and keep it.
 */
export const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Extra fetch init that disables TLS cert verification. topics-app serves a
 * self-signed cert over https on a loopback origin (127.0.0.1); the default
 * verifier would reject it with "self signed certificate in certificate
 * chain". We only ever connect to that single local origin, so skipping
 * verification is safe. `tls` is a Bun-specific fetch extension; cast to keep
 * the standard fetch types happy.
 */
export function loopbackInit(): RequestInit {
  return { tls: { rejectUnauthorized: false } } as RequestInit;
}

/**
 * THE SERVER ANSWERED, and the answer was a refusal.
 *
 * A caller that retries has exactly one question to ask about a failure: did
 * the request ARRIVE? A dropped socket may be repeated, because nothing
 * happened on the other side; a 400 or a 502 may not, because something did.
 * Both left this module as a plain `Error`, so the one caller that retries
 * (`pollOutbound`) could not tell them apart and re-POSTED a message the server
 * had already processed - which, past the confirmation, is a second mail.
 *
 * The distinction is a CLASS and not a parsed message on purpose: "HTTP 400: "
 * as a prefix to grep for is a contract nobody declared.
 */
export class HttpAnswerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpAnswerError";
    this.status = status;
  }
}

/**
 * A request that never came back, said as such. Bare, an aborted fetch reads
 * "The operation was aborted", which names the mechanism and hides both the
 * cause and the call - and it is the message the agent reads.
 */
export function lostRequestError(err: unknown, method: string, path: string): Error {
  const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
  const detail = timedOut
    ? `no answer in ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`
    : err instanceof Error ? err.message : String(err);
  return new Error(`${method} ${path}: ${detail} (topics-app unreachable?)`);
}

export async function httpJson<T>(
  args: ParsedArgs,
  method: string,
  path: string,
  body: unknown | undefined,
  fetchImpl: typeof fetch,
  /** Only for the calls that stay open BY CONSTRUCTION (waiting on a process):
   *  the transport must give up after our own timer, never before it. */
  signal?: AbortSignal,
  /**
   * `retryOnLostRequest`: send it a SECOND time (once) if the first attempt
   * never got an answer. Only for requests that change nothing - a GET, or a
   * browser endpoint the tool spec calls read-only. A reply that arrived, even
   * a 500, is an answer and is never retried: repeating a request the server
   * did receive is how one comment becomes two.
   */
  opts?: { retryOnLostRequest?: boolean },
): Promise<T | undefined> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (args.gatewayToken) headers["X-Gateway-Token"] = args.gatewayToken;
  // Assigned at the adapter boundary: a direct caller of the same session API
  // is still API traffic and must not inherit MCP attribution from the path.
  headers["X-Topics-Action-Origin"] = "mcp";

  const send = (): Promise<Response> => fetchImpl(`${args.baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    // Our own deadline, unless the caller brought a longer one of its own.
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...loopbackInit(),
  });

  // A caller-supplied signal is a budget somebody already reasoned about: it is
  // not ours to spend twice.
  const mayRetry = !signal && (opts?.retryOnLostRequest ?? method === "GET");
  let resp: Response;
  try {
    resp = await send();
  } catch (err: unknown) {
    if (!mayRetry) throw lostRequestError(err, method, path);
    try {
      resp = await send();
    } catch (err2: unknown) {
      throw lostRequestError(err2, method, path);
    }
  }

  const text = await resp.text().catch(() => "");
  let parsed: (T & { error?: unknown; available?: unknown; duplicates?: unknown }) | undefined;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }

  if (!resp.ok) {
    const msg = parsed?.error || text || resp.statusText;
    const extra = Array.isArray(parsed?.available) ? ` (available: ${parsed.available.join(", ")})` : "";
    // `error` is the ONLY thing the agent reads: the rest of the body goes in
    // the bin. A duplicate 409 that says "comment on that card" without saying
    // WHICH one leaves exactly one move available, rewriting the title until it
    // gets through. So the ids go into the string, as `available` already does.
    const dupes = Array.isArray(parsed?.duplicates)
      ? (parsed.duplicates as Array<{ id?: unknown; text?: unknown }>)
          .map((d) => (typeof d?.id === "string" ? `${d.id}${typeof d?.text === "string" ? ` «${d.text}»` : ""}` : null))
          .filter((s): s is string => !!s)
      : [];
    const twins = dupes.length ? `. Card già aperte: ${dupes.join("; ")}` : "";
    throw new HttpAnswerError(resp.status, `HTTP ${resp.status}: ${msg}${extra}${twins}`);
  }
  // A 2xx whose body carries `error` is an answer too: the server read the
  // request and said no in the body instead of in the status line.
  if (parsed?.error) throw new HttpAnswerError(resp.status, String(parsed.error));
  return parsed;
}
