/**
 * OAuth 2.1 for the remote MCP servers the native runtime mounts.
 *
 * WHY THIS EXISTS. `mcp-client.ts` speaks Streamable HTTP to whatever url the
 * global config names, and until now that url had to be either public or
 * protected by a static header the person had pasted into their config by hand.
 * A remote server that authenticates the way remote servers actually do,
 * `https://api.wisprflow.ai/connect/mcp` for one, answers the very first
 * `initialize` with `401` and a `www-authenticate` challenge. The fleet showed
 * it as `failed` with `HTTP 401` next to it, and there was nothing a person
 * could do about that from inside the app: the only cure was to go and find a
 * token somewhere else. This module is the missing half of that conversation.
 *
 * NO DEPENDENCY, for the same reason `mcp-client.ts` has none. What the spec
 * asks for here is four HTTP calls and a SHA-256: protected resource metadata,
 * authorization server metadata, dynamic client registration, and the token
 * endpoint. An OAuth library would bring a framework, a JWT validator and a
 * session model to carry that, and we would still hand-roll the MCP-specific
 * parts (`resource` per RFC 8707, the challenge on the MCP url itself).
 *
 * WHY THERE IS A LOOPBACK LISTENER, which is the surprising part. The
 * redirect has to land somewhere this process can read it. The app's own port
 * is the obvious candidate and it is the wrong one: Topics may be served over
 * https with a self-signed certificate, and a browser refuses to follow an
 * OAuth redirect into a certificate it does not trust, so the person would
 * watch the sign-in succeed and the app never notice. An ephemeral
 * `http://127.0.0.1:<port>/callback` is plain http, is never reachable from
 * off the machine, and lives only for the length of one sign-in. RFC 8252
 * section 7.3 is what makes it safe to keep a registered client across a
 * changing port: for a loopback redirect the authorization server is required
 * to ignore the port when it matches the registered uri, which is why the
 * client id below is cached per issuer and not re-registered every time.
 *
 * NO TOKEN IS EVER LOGGED. Not in a console line, not in an `Error` message,
 * not in the `reason` the fleet puts on screen. A token that reaches a log
 * reaches a bug report, and a bug report is a place people paste freely.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { resolveInheritedMcp } from "../mcp-inheritance";

/** How long a person is given to finish the sign-in before the listener gives up. */
const AUTHORIZATION_WINDOW_MS = 5 * 60 * 1000;
/**
 * Refresh this long before the access token actually dies. A token that expires
 * mid-handshake costs a whole mount, and the clocks of two machines are never
 * the same anyway.
 */
const REFRESH_MARGIN_MS = 60_000;
/** Discovery and the token endpoint are one round trip each: none should hang a mount. */
const HTTP_TIMEOUT_MS = 15_000;

// ---- the store on disk ----------------------------------------------------

/** What we hold for one configured server, once its sign-in has completed. */
interface StoredServerToken {
  issuer: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. Zero when the server did not say. */
  expiresAt: number;
  /** The url the token was issued for, sent back as `resource` on a refresh. */
  resource: string;
  tokenEndpoint: string;
}

interface TokenStore {
  servers: Record<string, StoredServerToken>;
  /** One registered client per authorization server, reused by every server behind it. */
  issuers: Record<string, { clientId: string }>;
}

/**
 * The same resolution as `server/utils.ts:145` (`APP_DATA_DIR`, then
 * `OPENCLAW_DIR`, then `~/.openclaw`). Duplicated rather than imported because
 * that one lives inside the `createUtils` closure and is not an export, which
 * is the reason `server/services/known-project-dirs.ts` duplicates it too.
 *
 * Resolved on every call and not once at module load, so a test can point
 * `APP_DATA_DIR` at a temp directory in `beforeAll` and never touch the real
 * store.
 */
function storePath(): string {
  const dir =
    process.env.APP_DATA_DIR || process.env.OPENCLAW_DIR || join(process.env.HOME ?? ".", ".openclaw");
  return join(dir, "mcp-oauth.json");
}

function readStore(): TokenStore {
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf-8")) as Partial<TokenStore>;
    return { servers: raw.servers ?? {}, issuers: raw.issuers ?? {} };
  } catch {
    // Absent or unreadable is the machine of somebody who has never signed in.
    return { servers: {}, issuers: {} };
  }
}

/**
 * Write the store, atomically and readable only by its owner.
 *
 * The temp file is created NEXT TO the target rather than in `os.tmpdir()`:
 * `renameSync` is atomic only within one filesystem, and a home directory on a
 * different volume from the temp dir would turn every save into a cross-device
 * failure.
 */
function writeStore(store: TokenStore): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

// ---- the challenge on the MCP url -----------------------------------------

/** What a `401` told us: where the resource describes itself, and what to ask for. */
export interface BearerChallenge {
  resourceMetadataUrl: string | null;
  scope: string | null;
}

/**
 * Read a `www-authenticate` header, when it is a Bearer challenge.
 *
 * Returns null for any other scheme rather than guessing: a server that
 * answers `401` with Basic is not one we can sign into, and pretending
 * otherwise would send a person through a sign-in that cannot end.
 */
export function parseWwwAuthenticate(header: string | null | undefined): BearerChallenge | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^bearer\b/i.test(trimmed)) return null;
  const out: BearerChallenge = { resourceMetadataUrl: null, scope: null };
  const params = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = params.exec(trimmed)) !== null) {
    if (match[1] === "resource_metadata") out.resourceMetadataUrl = match[2] ?? null;
    else if (match[1] === "scope") out.scope = match[2] ?? null;
  }
  return out;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// ---- discovery ------------------------------------------------------------

interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

/**
 * Where an issuer's metadata can be, most specific first.
 *
 * RFC 8414 inserts the well-known segment between the host and the issuer's
 * PATH (`https://host/.well-known/oauth-authorization-server/tenant`), while
 * OpenID Connect appends it (`https://host/tenant/.well-known/...`). Deployed
 * servers do both, so both are tried; for the common issuer with no path the
 * four candidates collapse to two.
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
  ];
  if (path) {
    candidates.push(`${url.origin}${path}/.well-known/oauth-authorization-server`);
    candidates.push(`${url.origin}${path}/.well-known/openid-configuration`);
  }
  return [...new Set(candidates)];
}

async function discoverAuthorizationServer(issuer: string): Promise<AuthServerMetadata> {
  const tried: string[] = [];
  for (const candidate of authorizationServerMetadataUrls(issuer)) {
    try {
      const doc = (await fetchJson(candidate)) as Record<string, unknown>;
      const authorizationEndpoint = typeof doc.authorization_endpoint === "string" ? doc.authorization_endpoint : "";
      const tokenEndpoint = typeof doc.token_endpoint === "string" ? doc.token_endpoint : "";
      if (!authorizationEndpoint || !tokenEndpoint) continue;
      return {
        issuer: typeof doc.issuer === "string" ? doc.issuer : issuer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint:
          typeof doc.registration_endpoint === "string" ? doc.registration_endpoint : null,
      };
    } catch {
      tried.push(candidate);
    }
  }
  throw new Error(`no OAuth metadata at ${issuer} (tried ${tried.length || "every"} well-known path)`);
}

/**
 * The protected resource metadata for an MCP url.
 *
 * The challenge is the authority when the server sent one, because it is the
 * server naming its own document. The well-known path is the fallback for a
 * server that answers `401` with nothing useful, which RFC 9728 still lets a
 * client find on its own.
 */
async function discoverProtectedResource(
  mcpUrl: string,
  challenge: BearerChallenge | null,
): Promise<{ authorizationServer: string; scope: string }> {
  const metadataUrl =
    challenge?.resourceMetadataUrl || `${new URL(mcpUrl).origin}/.well-known/oauth-protected-resource`;
  const doc = (await fetchJson(metadataUrl)) as {
    authorization_servers?: unknown;
    scopes_supported?: unknown;
  };
  const servers = Array.isArray(doc.authorization_servers) ? doc.authorization_servers : [];
  const first = servers.find((s): s is string => typeof s === "string" && s.length > 0);
  if (!first) throw new Error(`${metadataUrl}: no authorization_servers`);
  const supported = Array.isArray(doc.scopes_supported)
    ? doc.scopes_supported.filter((s): s is string => typeof s === "string")
    : [];
  const scope = challenge?.scope || supported.join(" ") || "openid offline_access";
  return { authorizationServer: first, scope };
}

/** Ask the MCP url itself what it wants, by making the call that gets refused. */
async function challengeFromMcpUrl(mcpUrl: string): Promise<BearerChallenge | null> {
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return parseWwwAuthenticate(res.headers.get("www-authenticate"));
  } catch {
    // A server that will not talk to us at all is a mount failure, not a
    // sign-in failure. Discovery falls back to the well-known path and says so.
    return null;
  }
}

// ---- dynamic client registration ------------------------------------------

/**
 * The client id for one issuer, registered on first use and then reused.
 *
 * Cached per ISSUER and not per server, because two MCP servers behind the same
 * authorization server are the same application asking twice. The cache is also
 * what keeps a re-sign-in from creating a new client on every attempt, which is
 * how a dynamic-registration endpoint ends up rate limiting us.
 */
async function clientIdFor(meta: AuthServerMetadata, redirectUri: string): Promise<string> {
  const store = readStore();
  const cached = store.issuers[meta.issuer]?.clientId;
  if (cached) return cached;
  if (!meta.registrationEndpoint) {
    throw new Error(`${meta.issuer}: no registration_endpoint and no client registered`);
  }
  const doc = (await fetchJson(meta.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Topics",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  })) as { client_id?: unknown };
  const clientId = typeof doc.client_id === "string" ? doc.client_id : "";
  if (!clientId) throw new Error(`${meta.registrationEndpoint}: registration returned no client_id`);
  const next = readStore();
  next.issuers[meta.issuer] = { clientId };
  writeStore(next);
  return clientId;
}

// ---- PKCE -----------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * A PKCE pair, S256 only.
 *
 * `plain` is the other method the spec allows and it protects nothing: the
 * verifier travels in the authorize url, so an attacker who can read that url
 * can complete the exchange. Every authorization server an MCP client meets
 * supports S256, so there is no fallback to write.
 */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

// ---- the token endpoint ---------------------------------------------------

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/**
 * Post to the token endpoint and read the answer.
 *
 * The error path deliberately reports the `error` code and nothing else: the
 * body of a failed token request can echo the code, and in a refresh it can
 * echo the refresh token itself.
 */
async function postToken(tokenEndpoint: string, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  let doc: Record<string, unknown> = {};
  try { doc = (await res.json()) as Record<string, unknown>; } catch { /* an empty body is still an error */ }
  if (!res.ok) {
    const code = typeof doc.error === "string" ? doc.error : `HTTP ${res.status}`;
    throw new Error(`token endpoint refused the request (${code})`);
  }
  const accessToken = typeof doc.access_token === "string" ? doc.access_token : "";
  if (!accessToken) throw new Error("token endpoint returned no access_token");
  const expiresIn = Number(doc.expires_in);
  return {
    accessToken,
    refreshToken: typeof doc.refresh_token === "string" ? doc.refresh_token : undefined,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
  };
}

// ---- the sign-in ----------------------------------------------------------

/** The page the browser lands on once the redirect has been consumed. */
function callbackPage(title: string, detail: string): Response {
  const html =
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Topics</title>" +
    "<style>body{font-family:system-ui,sans-serif;background:#101014;color:#e6e6ea;" +
    "display:flex;align-items:center;justify-content:center;height:100vh;margin:0}" +
    "div{text-align:center;max-width:28rem;padding:0 1.5rem}h1{font-size:1.05rem;font-weight:600;margin:0 0 .5rem}" +
    "p{font-size:.85rem;color:#9a9aa6;margin:0;line-height:1.5}</style></head>" +
    `<body><div><h1>${title}</h1><p>${detail}</p></div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export interface McpAuthorizationStart {
  /** Where the person has to go. The caller opens it, this module never does. */
  authorizeUrl: string;
  /** True once tokens are on disk, false when the window closed with nothing. */
  completion: Promise<boolean>;
}

/** The http url of one configured server, or null when it is not an http server. */
function configuredHttpUrl(serverName: string): string | null {
  const def = resolveInheritedMcp().servers?.[serverName] as { url?: unknown } | undefined;
  return typeof def?.url === "string" && def.url ? def.url : null;
}

/**
 * Run the whole dance for one server and hand back the url to send a person to.
 *
 * Everything before the authorize url is awaited here on purpose: discovery and
 * registration are exactly the steps that can fail for a reason worth showing,
 * and failing them inside a listener nobody is watching would turn a broken
 * configuration into a tab that never comes back.
 */
export async function startMcpAuthorization(serverName: string): Promise<McpAuthorizationStart> {
  const mcpUrl = configuredHttpUrl(serverName);
  if (!mcpUrl) throw new Error(`server '${serverName}' is not a configured http MCP server`);

  const challenge = await challengeFromMcpUrl(mcpUrl);
  const { authorizationServer, scope } = await discoverProtectedResource(mcpUrl, challenge);
  const meta = await discoverAuthorizationServer(authorizationServer);
  const { verifier, challenge: codeChallenge } = await createPkcePair();
  const state = randomToken(16);

  let settle: (ok: boolean) => void = () => {};
  const completion = new Promise<boolean>((resolve) => { settle = resolve; });

  /**
   * The handler is installed LATER, once the client id exists.
   *
   * The order is forced by the protocol and not by taste: the redirect uri
   * carries the port, the port only exists once the listener is up, and the
   * registration that needs the redirect uri therefore cannot run before it.
   * A callback that somehow arrives in that window gets a 404 instead of a
   * half-built exchange.
   */
  let onCallback: ((url: URL) => Promise<Response>) | null = null;

  // Port 0 lets the kernel pick: two sign-ins at once never collide, and the
  // listener is gone the moment either the callback or the deadline arrives.
  const listener = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/callback" || !onCallback) return new Response(null, { status: 404 });
      return onCallback(url);
    },
  });
  const redirectUri = `http://127.0.0.1:${listener.port}/callback`;

  let done = false;
  const deadline = setTimeout(() => finish(false), AUTHORIZATION_WINDOW_MS);
  // The deadline must not hold the process open: a person who never finishes a
  // sign-in should not be the reason the server refuses to exit.
  deadline.unref?.();
  function finish(ok: boolean): void {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    // Graceful `stop()`, never `stop(true)`: the callback response is still
    // being written when this runs, and closing active connections under it
    // would leave the person looking at a dead tab.
    try { listener.stop(); } catch { /* already stopped */ }
    settle(ok);
  }

  let clientId: string;
  try {
    clientId = await clientIdFor(meta, redirectUri);
  } catch (err) {
    finish(false);
    throw err;
  }

  onCallback = async (url: URL): Promise<Response> => {
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const failure = url.searchParams.get("error");
    // The state check is the whole defence against a forged callback: without
    // it, any page open on this machine could post a code of its own to this port.
    if (failure || !code || returnedState !== state) {
      finish(false);
      return callbackPage(
        "Sign-in did not complete",
        "You can close this tab and try again from the MCP servers panel.",
      );
    }
    try {
      const token = await postToken(meta.tokenEndpoint, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: mcpUrl,
      });
      const store = readStore();
      store.servers[serverName] = {
        issuer: meta.issuer,
        clientId,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        resource: mcpUrl,
        tokenEndpoint: meta.tokenEndpoint,
      };
      writeStore(store);
      finish(true);
      return callbackPage("You are signed in", "You can close this tab and go back to Topics.");
    } catch {
      // The reason stays out of the page: it is the one surface here a person
      // could screenshot, and a failed token exchange can quote the code back.
      finish(false);
      return callbackPage(
        "Sign-in did not complete",
        "You can close this tab and try again from the MCP servers panel.",
      );
    }
  };

  const authorize = new URL(meta.authorizationEndpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", codeChallenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("scope", scope);
  // RFC 8707: name the MCP url the token is for, so the authorization server
  // can issue an audience-bound token instead of one good for everything.
  authorize.searchParams.set("resource", mcpUrl);

  return { authorizeUrl: authorize.toString(), completion };
}

// ---- what the client asks for ---------------------------------------------

/**
 * The `Authorization` header for one server, or null when nothing is stored.
 *
 * Refreshes when the access token is spent, and on demand when the caller has
 * just been told `401` by a server that should have accepted the token it had.
 * A refresh that fails leaves the stored entry alone: the refresh token may
 * simply have expired, and the cure for that is the sign-in button, not
 * throwing away the record that a sign-in ever happened.
 */
export async function authorizationHeader(
  serverName: string,
  opts?: { forceRefresh?: boolean },
): Promise<string | null> {
  const entry = readStore().servers[serverName];
  if (!entry) return null;
  const spent = entry.expiresAt > 0 && entry.expiresAt - Date.now() <= REFRESH_MARGIN_MS;
  if (!opts?.forceRefresh && !spent) return `Bearer ${entry.accessToken}`;
  if (!entry.refreshToken) return opts?.forceRefresh ? null : `Bearer ${entry.accessToken}`;

  try {
    const token = await postToken(entry.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: entry.refreshToken,
      client_id: entry.clientId,
      resource: entry.resource,
    });
    const store = readStore();
    const current = store.servers[serverName];
    if (current) {
      current.accessToken = token.accessToken;
      // The refresh token ROTATES on some servers and not on others. Keeping
      // the old one when the answer carries a new one is how a store goes stale
      // eight hours later, with nothing in the logs to say why.
      if (token.refreshToken) current.refreshToken = token.refreshToken;
      current.expiresAt = token.expiresAt;
      writeStore(store);
    }
    return `Bearer ${token.accessToken}`;
  } catch {
    return null;
  }
}
