/**
 * An MCP client for the native runtime.
 *
 * WHY IT HAD TO EXIST. From the day `DEFAULT_AGENT_RUNTIME` became `topics`,
 * opening a topic meant an agent with no MCP at all: the globally configured
 * servers were resolved, logged, and then read by nobody, because the only code
 * that ever mounted them lived on the CLI branch (`writeMcpConfigForSession`).
 * The fallback was to switch the runtime back to `cli`, which costs ~206 MB per
 * topic and is exactly what the native runtime exists to avoid.
 *
 * NO SDK, for the same reason `server/mcp/topics-mcp-server.ts` has none: the
 * protocol we speak is three methods (`initialize`, `tools/list`, `tools/call`,
 * plus `prompts/list` when the server offers it), and a dependency that ships a
 * transport layer, a schema validator and a framework would be a large surface
 * to carry for that. The server half of this repo already hand-rolls the same
 * JSON-RPC; this is its mirror.
 *
 * TWO TRANSPORTS, because the configured fleet has two kinds:
 *   · `http` -> Streamable HTTP. One POST per message, the answer is either
 *     JSON or an SSE stream to read until the response with our id shows up.
 *     Nothing to spawn, nothing to keep alive.
 *   · `stdio` -> a child process, newline-delimited JSON-RPC on stdin/stdout.
 *     Spawned ONCE per process and shared by every session, not once per topic:
 *     one Chrome or one `node` per open topic is the cost that made the CLI
 *     branch scope the fleet in the first place.
 */

import { spawn, type ChildProcess } from "child_process";
import type { McpServerDef } from "../mcp-inheritance";

/** The protocol revision we speak. Same one the Topics bridge answers with. */
const MCP_PROTOCOL_VERSION = "2024-11-05";
/** A server that does not finish the handshake in this long is not mounted. */
const CONNECT_TIMEOUT_MS = 15_000;
/** A tool call that never answers must not hold the agent's turn forever. */
const CALL_TIMEOUT_MS = 120_000;

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpPromptDescriptor {
  name: string;
  description?: string;
}

export interface McpConnection {
  readonly transport: "http" | "stdio";
  readonly serverInfo: { name?: string; version?: string } | null;
  /**
   * The server said its tool list can change while it runs.
   *
   * It is the value of a handshake we already perform: `initialize` answers
   * with `capabilities`, we store it, and until now we only ever read
   * `.prompts` out of it. Reading `.tools.listChanged` too costs no traffic and
   * is what tells the fleet which servers are worth re-listing.
   */
  readonly listChanged: boolean;
  listTools(): Promise<McpToolDescriptor[]>;
  listPrompts(): Promise<McpPromptDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  close(): void;
}

interface RpcError {
  code?: number;
  message?: string;
}

/**
 * How an http connection gets an `Authorization` header, when the server wants one.
 *
 * An INTERFACE and not a direct import of `mcp-oauth.ts`, so this file keeps
 * knowing only how to speak the protocol: the fleet is what decides that a
 * given server signs in, and a transport that reached into a token store would
 * be impossible to exercise without one.
 */
export interface McpAuthProvider {
  /** The header value to send, or null when nothing is stored for this server. */
  header(): Promise<string | null>;
  /** Spend the refresh token and answer with the new header value, or null. */
  refreshed(): Promise<string | null>;
}

/**
 * The server will not talk to us until somebody signs in.
 *
 * TYPED, because the fleet has to tell this apart from every other reason a
 * mount fails. "Not answering" and "waiting for you to sign in" are two
 * different sentences on screen with two different next moves, and a `401`
 * buried in a string is a distinction the panel cannot make.
 *
 * `challenge` is the raw `www-authenticate` value. It names the resource
 * metadata document and the scopes, and it carries no credential of any kind.
 */
export class McpAuthorizationRequiredError extends Error {
  readonly challenge: string | null;
  constructor(method: string, challenge: string | null) {
    super(`${method}: authorization required`);
    this.name = "McpAuthorizationRequiredError";
    this.challenge = challenge;
  }
}

/**
 * Did the server say its tool list can change while it runs?
 *
 * Shared by both transports because it reads the same handshake answer: the
 * two connection classes differ in how they talk, not in what `capabilities`
 * means.
 */
function declaresListChanged(capabilities: Record<string, unknown>): boolean {
  return Boolean((capabilities as { tools?: { listChanged?: boolean } }).tools?.listChanged);
}

function rpcMessage(id: number, method: string, params?: unknown) {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

function failure(err: RpcError | undefined, method: string): Error {
  return new Error(`${method}: ${err?.message ?? "unknown MCP error"}${err?.code ? ` (${err.code})` : ""}`);
}

/**
 * The text a model gets back from a tool call.
 *
 * MCP answers with a list of typed content blocks; the native loop's tool
 * results are a single string. Text blocks are joined, and anything else is
 * announced rather than dropped: an agent that receives an empty result for an
 * image retries the same call forever.
 */
function flattenContent(result: unknown): string {
  const blocks = (result as { content?: unknown })?.content;
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return JSON.stringify(result ?? null);
  const parts: string[] = [];
  for (const b of blocks) {
    const block = b as { type?: string; text?: string };
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type) parts.push(`[${block.type} content]`);
  }
  return parts.join("\n");
}

// ---- HTTP (Streamable HTTP) transport ------------------------------------

/**
 * Read one JSON-RPC response out of an SSE body.
 *
 * A Streamable HTTP server may answer a POST with `text/event-stream` and push
 * notifications and progress events before the actual result. We read events
 * until the one carrying OUR id arrives, then stop: leaving the body open would
 * hold a socket per call.
 */
async function readSseResponse(res: Response, id: number): Promise<{ result?: unknown; error?: RpcError }> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("empty SSE body");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let msg: { id?: number; result?: unknown; error?: RpcError };
          try {
            msg = JSON.parse(payload);
          } catch {
            continue;
          }
          if (msg.id === id) return { result: msg.result, error: msg.error };
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* the stream may already be gone */ }
  }
  throw new Error("SSE stream ended without a response");
}

class HttpMcpConnection implements McpConnection {
  readonly transport = "http" as const;
  serverInfo: { name?: string; version?: string } | null = null;
  private nextId = 1;
  private sessionId: string | null = null;
  private capabilities: Record<string, unknown> = {};

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly auth: McpAuthProvider | null = null,
  ) {}

  /**
   * One POST, with the headers in the order that keeps today's behaviour.
   *
   * The configured `headers` are spread LAST on purpose. Somebody who pasted
   * their own `Authorization` into `~/.claude.json` is describing a server that
   * works that way, and an OAuth token we happen to hold must not quietly
   * replace it.
   */
  private post(id: number, method: string, params: unknown, timeoutMs: number, auth: string | null): Promise<Response> {
    return fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...(auth ? { authorization: auth } : {}),
        ...this.headers,
      },
      body: JSON.stringify(rpcMessage(id, method, params)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async send(method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    let res = await this.post(id, method, params, timeoutMs, this.auth ? await this.auth.header() : null);
    // ONE refresh and ONE retry. An access token that died mid-session is the
    // ordinary case and must not cost a mount; a second failure means the
    // refresh token is spent too, and retrying that in a loop would only spend
    // the rate limit of an endpoint that has already said no.
    if (res.status === 401 && this.auth) {
      // The unread body of the refused answer holds the socket open otherwise.
      try { await res.body?.cancel(); } catch { /* already drained */ }
      const refreshed = await this.auth.refreshed();
      if (refreshed) res = await this.post(id, method, params, timeoutMs, refreshed);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 401) {
      try { await res.body?.cancel(); } catch { /* already drained */ }
      throw new McpAuthorizationRequiredError(method, res.headers.get("www-authenticate"));
    }
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    const answer = contentType.includes("text/event-stream")
      ? await readSseResponse(res, id)
      : ((await res.json()) as { result?: unknown; error?: RpcError });
    if (answer.error) throw failure(answer.error, method);
    return answer.result;
  }

  /** A notification: no id, no answer, and a body we must not try to parse. */
  private async notify(method: string): Promise<void> {
    try {
      // Authenticated like every other message: a server that rejects an
      // anonymous notification would otherwise never see us finish the handshake.
      const auth = this.auth ? await this.auth.header() : null;
      await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
          ...(auth ? { authorization: auth } : {}),
          ...this.headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch { /* a server that refuses the notification is still usable */ }
  }

  async connect(): Promise<void> {
    const result = (await this.send(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "topics-app", version: "1.0.0" },
      },
      CONNECT_TIMEOUT_MS,
    )) as { serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> };
    this.serverInfo = result?.serverInfo ?? null;
    this.capabilities = result?.capabilities ?? {};
    await this.notify("notifications/initialized");
  }


  get listChanged(): boolean { return declaresListChanged(this.capabilities); }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.send("tools/list", {}, CONNECT_TIMEOUT_MS)) as { tools?: McpToolDescriptor[] };
    return result?.tools ?? [];
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    if (!this.capabilities.prompts) return [];
    try {
      const result = (await this.send("prompts/list", {}, CONNECT_TIMEOUT_MS)) as { prompts?: McpPromptDescriptor[] };
      return result?.prompts ?? [];
    } catch {
      return [];
    }
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const result = (await this.send("tools/call", { name, arguments: args })) as { isError?: boolean };
    return { content: flattenContent(result), isError: Boolean(result?.isError) };
  }

  close(): void {
    // Nothing to tear down: an http transport holds no process and no socket
    // between calls.
  }
}

// ---- stdio transport ------------------------------------------------------

class StdioMcpConnection implements McpConnection {
  readonly transport = "stdio" as const;
  serverInfo: { name?: string; version?: string } | null = null;
  private nextId = 1;
  private child: ChildProcess | null = null;
  private buffer = "";
  private capabilities: Record<string, unknown> = {};
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
  ) {}

  private onLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: RpcError };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // servers that print to stdout are common; ignore the noise
    }
    if (typeof msg.id !== "number") return;
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(failure(msg.error, `id ${msg.id}`));
    else waiter.resolve(msg.result);
  }

  private send(method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new Error(`${method}: server is not running`));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      child.stdin!.write(JSON.stringify(rpcMessage(id, method, params)) + "\n");
    });
  }

  async connect(): Promise<void> {
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });
    this.child = child;
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });
    // A server that dies must not leave a turn hanging on a promise nobody will
    // ever resolve: every waiter is failed with the reason.
    const die = (why: string) => {
      for (const [, waiter] of this.pending) waiter.reject(new Error(why));
      this.pending.clear();
      this.child = null;
    };
    child.on("error", (e) => die(`MCP server failed to start: ${e.message}`));
    child.on("exit", (code) => die(`MCP server exited (code ${code ?? "null"})`));

    const result = (await this.send(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "topics-app", version: "1.0.0" },
      },
      CONNECT_TIMEOUT_MS,
    )) as { serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> };
    this.serverInfo = result?.serverInfo ?? null;
    this.capabilities = result?.capabilities ?? {};
    try {
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    } catch { /* best-effort */ }
  }


  get listChanged(): boolean { return declaresListChanged(this.capabilities); }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.send("tools/list", {}, CONNECT_TIMEOUT_MS)) as { tools?: McpToolDescriptor[] };
    return result?.tools ?? [];
  }

  async listPrompts(): Promise<McpPromptDescriptor[]> {
    if (!this.capabilities.prompts) return [];
    try {
      const result = (await this.send("prompts/list", {}, CONNECT_TIMEOUT_MS)) as { prompts?: McpPromptDescriptor[] };
      return result?.prompts ?? [];
    } catch {
      return [];
    }
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const result = (await this.send("tools/call", { name, arguments: args })) as { isError?: boolean };
    return { content: flattenContent(result), isError: Boolean(result?.isError) };
  }

  close(): void {
    try { this.child?.kill(); } catch { /* already gone */ }
    this.child = null;
  }
}

/**
 * Open a connection to one configured server, handshake included.
 *
 * Rejects with a readable reason: that string is what the mounted-tools screen
 * shows next to a server that is not there, and "connection refused" tells the
 * person what to do while "false" does not.
 */
export async function connectMcpServer(
  name: string,
  def: McpServerDef,
  auth: McpAuthProvider | null = null,
): Promise<McpConnection> {
  const d = def as {
    type?: string;
    url?: string;
    command?: string;
    args?: unknown;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
  const kind = d.type || (d.url ? "http" : "stdio");
  if (kind === "http" || kind === "sse") {
    if (!d.url) throw new Error(`server '${name}': type '${kind}' without a url`);
    const conn = new HttpMcpConnection(d.url, d.headers ?? {}, auth);
    await conn.connect();
    return conn;
  }
  if (kind === "stdio") {
    if (!d.command) throw new Error(`server '${name}': type 'stdio' without a command`);
    const conn = new StdioMcpConnection(
      d.command,
      Array.isArray(d.args) ? d.args.map(String) : [],
      d.env ?? {},
    );
    await conn.connect();
    return conn;
  }
  throw new Error(`server '${name}': unsupported transport '${kind}'`);
}
