/**
 * The OAuth sign-in for a remote MCP server, end to end and off the network.
 *
 * WHAT IS FAKED AND WHAT IS NOT. Two real http servers on port 0 (an
 * authorization server and a protected MCP server) speak the real protocol:
 * a `401` with a real `www-authenticate` challenge, real protected resource
 * metadata, real dynamic client registration, a real token endpoint that
 * VERIFIES the PKCE verifier against the challenge it was given. What is
 * simulated is only the browser: instead of a person following the authorize
 * url, the test fetches the loopback callback itself, which is exactly what
 * the browser would have done with the redirect.
 *
 * NOTHING TOUCHES THE MACHINE. `APP_DATA_DIR` points the token store at a temp
 * directory for the whole file, so the real `~/.openclaw/mcp-oauth.json` is
 * never read and never written, and `TOPICS_MCP_CONFIG_FILE` is what lets the
 * fleet mount at all under `NODE_ENV=test`.
 *
 * @covers MCPSRV-04
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseWwwAuthenticate,
  authorizationServerMetadataUrls,
  createPkcePair,
  startMcpAuthorization,
  authorizationHeader,
} from "./mcp-oauth";
import { remountMcpFleet, closeMcpFleet, mcpFleetStatus, mcpToolSpecs } from "./mcp-fleet";

const PROTOCOL = "2024-11-05";
const AUTHORIZATION_CODE = "the-one-code";

/** The same S256 the module computes, written independently so the test can check it. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(new Uint8Array(digest))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---- the fake authorization server ----------------------------------------

/** Which well-known document exists, so the discovery fallback can be exercised. */
let metadataMode: "rfc8414" | "oidc" = "rfc8414";
let registerHits = 0;
/** The challenge the test read out of the authorize url, verified at the token endpoint. */
let expectedChallenge = "";
/** What the last token request was asked to prove, so assertions can read it back. */
let lastTokenForm: Record<string, string> = {};
let tokenSerial = 0;
let currentRefreshToken = "";
/** Access tokens the protected MCP server will accept right now. */
const liveTokens = new Set<string>();

function startAuthServer() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const metadata = {
        issuer: `http://127.0.0.1:${url.port}`,
        authorization_endpoint: `http://127.0.0.1:${url.port}/oauth2/authorize`,
        token_endpoint: `http://127.0.0.1:${url.port}/oauth2/token`,
        registration_endpoint: `http://127.0.0.1:${url.port}/oauth2/register`,
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      };
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (metadataMode !== "rfc8414") return new Response("not here", { status: 404 });
        return Response.json(metadata);
      }
      if (url.pathname === "/.well-known/openid-configuration") {
        if (metadataMode !== "oidc") return new Response("not here", { status: 404 });
        return Response.json(metadata);
      }
      if (url.pathname === "/oauth2/register" && req.method === "POST") {
        registerHits += 1;
        const body = (await req.json()) as Record<string, unknown>;
        // A public client is the whole point: a desktop app cannot keep a secret.
        if (body.token_endpoint_auth_method !== "none") {
          return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
        }
        return Response.json({ client_id: `client-${registerHits}` });
      }
      if (url.pathname === "/oauth2/token" && req.method === "POST") {
        const form = Object.fromEntries(new URLSearchParams(await req.text()));
        lastTokenForm = form;
        if (form.grant_type === "authorization_code") {
          if (form.code !== AUTHORIZATION_CODE) return Response.json({ error: "invalid_grant" }, { status: 400 });
          // THE PKCE CHECK, done for real: a verifier that does not hash to the
          // challenge sent to /authorize is refused, the way a server refuses it.
          if ((await s256(form.code_verifier ?? "")) !== expectedChallenge) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
        } else if (form.grant_type === "refresh_token") {
          if (form.refresh_token !== currentRefreshToken) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
        } else {
          return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
        }
        tokenSerial += 1;
        const accessToken = `access-${tokenSerial}`;
        // The refresh token ROTATES, like the servers that do it in the wild.
        currentRefreshToken = `refresh-${tokenSerial}`;
        liveTokens.clear();
        liveTokens.add(accessToken);
        return Response.json({
          access_token: accessToken,
          refresh_token: currentRefreshToken,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return new Response("no", { status: 404 });
    },
  });
}

// ---- the fake protected MCP server ----------------------------------------

function startProtectedMcpServer(authOrigin: () => string) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: `http://127.0.0.1:${url.port}/mcp`,
          authorization_servers: [authOrigin()],
          scopes_supported: ["openid", "offline_access"],
        });
      }
      if (url.pathname !== "/mcp") return new Response("no", { status: 404 });

      const header = req.headers.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!liveTokens.has(token)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate":
              `Bearer resource_metadata="http://127.0.0.1:${url.port}/.well-known/oauth-protected-resource", ` +
              'scope="openid offline_access"',
          },
        });
      }

      const msg = (await req.json()) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, result });
      switch (msg.method) {
        case "initialize":
          return reply({
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "wispr-like", version: "1" },
          });
        case "tools/list":
          return reply({
            tools: [{ name: "dictate", description: "Speaks.", inputSchema: { type: "object", properties: {} } }],
          });
        default:
          return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
      }
    },
  });
}

let authServer: ReturnType<typeof startAuthServer>;
let mcpServer: ReturnType<typeof startProtectedMcpServer>;
let dir: string;
let mcpUrl: string;
const envBackup: Record<string, string | undefined> = {};

function writeConfig(servers: Record<string, unknown>): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ mcpServers: servers }));
}

function storeFile(): string {
  return join(dir, "mcp-oauth.json");
}

function readStoreFile(): {
  servers: Record<string, Record<string, string | number>>;
  issuers: Record<string, { clientId: string }>;
} {
  return JSON.parse(readFileSync(storeFile(), "utf-8"));
}

/**
 * Play the browser: read the authorize url, then call the loopback redirect the
 * way the authorization server would have after the person said yes.
 */
async function completeSignIn(
  start: { authorizeUrl: string; completion: Promise<boolean> },
  opts?: { state?: string; code?: string },
): Promise<boolean> {
  const authorize = new URL(start.authorizeUrl);
  expectedChallenge = authorize.searchParams.get("code_challenge") ?? "";
  const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
  redirect.searchParams.set("code", opts?.code ?? AUTHORIZATION_CODE);
  redirect.searchParams.set("state", opts?.state ?? authorize.searchParams.get("state") ?? "");
  await fetch(redirect.toString());
  return start.completion;
}

beforeAll(() => {
  for (const k of [
    "APP_DATA_DIR", "OPENCLAW_DIR", "TOPICS_MCP_CONFIG_FILE", "TOPICS_NATIVE_MCP",
    "TOPICS_SESSION_MCP_ALLOW", "TOPICS_SESSION_MCP_DENY", "TOPICS_SESSION_MCP_INHERIT_ALL",
  ]) {
    envBackup[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "mcp-oauth-"));
  // THE WHOLE ISOLATION, in one line: the store resolves `APP_DATA_DIR` on
  // every call, so nothing in this file can reach the real one.
  process.env.APP_DATA_DIR = dir;
  process.env.TOPICS_MCP_CONFIG_FILE = join(dir, "config.json");
  authServer = startAuthServer();
  mcpServer = startProtectedMcpServer(() => authServer.url.origin);
  mcpUrl = `${mcpServer.url.origin}/mcp`;
  writeConfig({ protected: { type: "http", url: mcpUrl } });
});

afterAll(() => {
  closeMcpFleet();
  mcpServer.stop(true);
  authServer.stop(true);
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  metadataMode = "rfc8414";
  registerHits = 0;
  tokenSerial = 0;
  currentRefreshToken = "";
  liveTokens.clear();
  lastTokenForm = {};
  rmSync(storeFile(), { force: true });
  writeConfig({ protected: { type: "http", url: mcpUrl } });
});

describe("the Bearer challenge", () => {
  test("reads the resource metadata url and the scope out of the header", () => {
    const parsed = parseWwwAuthenticate(
      'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource", scope="openid offline_access"',
    );
    expect(parsed?.resourceMetadataUrl).toBe("https://api.example.com/.well-known/oauth-protected-resource");
    expect(parsed?.scope).toBe("openid offline_access");
  });

  test("a bare Bearer is still a challenge, with nothing in it", () => {
    expect(parseWwwAuthenticate("Bearer")).toEqual({ resourceMetadataUrl: null, scope: null });
  });

  test("another scheme is not ours, and saying so is the point", () => {
    // Answering `Basic` with a sign-in flow would send a person through a
    // dance that cannot end.
    expect(parseWwwAuthenticate('Basic realm="x"')).toBeNull();
    expect(parseWwwAuthenticate(null)).toBeNull();
    expect(parseWwwAuthenticate("")).toBeNull();
  });
});

describe("finding the authorization server", () => {
  test("an issuer without a path asks the two well-known documents", () => {
    expect(authorizationServerMetadataUrls("https://auth.example.com")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
  });

  test("an issuer WITH a path tries the RFC 8414 shape first, then the appended one", () => {
    // The two specifications disagree about where the segment goes, and both
    // shapes are deployed: RFC 8414 inserts it, OpenID Connect appends it.
    expect(authorizationServerMetadataUrls("https://auth.example.com/tenant-a")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant-a",
      "https://auth.example.com/.well-known/openid-configuration/tenant-a",
      "https://auth.example.com/tenant-a/.well-known/oauth-authorization-server",
      "https://auth.example.com/tenant-a/.well-known/openid-configuration",
    ]);
  });

  test("a server with only openid-configuration is still found", async () => {
    metadataMode = "oidc";
    const start = await startMcpAuthorization("protected");
    expect(start.authorizeUrl).toContain("/oauth2/authorize");
    // Leave nothing listening behind: the state will not match, so the
    // listener closes and the promise settles false.
    expect(await completeSignIn(start, { state: "wrong" })).toBe(false);
  });
});

describe("PKCE", () => {
  test("the challenge is the S256 of the verifier, base64url and unpadded", async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(challenge).toBe(await s256(verifier));
    expect(challenge).not.toContain("=");
    expect(challenge).not.toContain("+");
    expect(challenge).not.toContain("/");
  });

  test("two pairs are not the same pair", async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("the sign-in, from the challenge to a stored token", () => {
  test("the authorize url carries everything the spec asks for", async () => {
    const start = await startMcpAuthorization("protected");
    const url = new URL(start.authorizeUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBe("openid offline_access");
    // RFC 8707: the token is asked for THIS resource, not for everything.
    expect(url.searchParams.get("resource")).toBe(mcpUrl);
    // The redirect is a loopback on a port the kernel picked, never the app's.
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    expect(redirect.protocol).toBe("http:");
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(redirect.pathname).toBe("/callback");
    expect(Number(redirect.port)).toBeGreaterThan(0);

    expect(await completeSignIn(start, { state: "wrong" })).toBe(false);
  });

  test("the callback exchanges the code and writes the tokens down", async () => {
    const start = await startMcpAuthorization("protected");
    expect(await completeSignIn(start)).toBe(true);

    const stored = readStoreFile();
    expect(stored.servers.protected?.accessToken).toBe("access-1");
    expect(stored.servers.protected?.refreshToken).toBe("refresh-1");
    expect(stored.servers.protected?.resource).toBe(mcpUrl);
    expect(Number(stored.servers.protected?.expiresAt)).toBeGreaterThan(Date.now());
    // The exchange proved possession of the verifier and named the resource.
    expect(lastTokenForm.grant_type).toBe("authorization_code");
    expect(lastTokenForm.resource).toBe(mcpUrl);
    expect(lastTokenForm.code_verifier).toBeTruthy();

    expect(await authorizationHeader("protected")).toBe("Bearer access-1");
  });

  test("the store is not readable by anybody else", async () => {
    const start = await startMcpAuthorization("protected");
    expect(await completeSignIn(start)).toBe(true);
    // A token file the rest of the machine can read is a token file that leaks.
    expect(statSync(storeFile()).mode & 0o777).toBe(0o600);
  });

  test("a callback with the wrong state is refused and stores nothing", async () => {
    const start = await startMcpAuthorization("protected");
    // Without the state check any page open on this machine could post a code
    // of its own to the loopback port and have it exchanged.
    expect(await completeSignIn(start, { state: "not-the-state" })).toBe(false);
    // The registered client IS on disk by now, and should be: registration
    // happened before the redirect and is worth keeping for the next attempt.
    // What must not be there is a token.
    expect(readStoreFile().servers.protected).toBeUndefined();
    expect(await authorizationHeader("protected")).toBeNull();
  });

  test("a code the authorization server refuses leaves the store empty", async () => {
    const start = await startMcpAuthorization("protected");
    expect(await completeSignIn(start, { code: "stolen" })).toBe(false);
    expect(readStoreFile().servers.protected).toBeUndefined();
  });

  test("nothing stored means no header, and that is not an error", async () => {
    expect(await authorizationHeader("never-signed-in")).toBeNull();
  });
});

describe("the registered client", () => {
  test("is registered once per issuer and reused by the next server behind it", async () => {
    writeConfig({
      protected: { type: "http", url: mcpUrl },
      second: { type: "http", url: mcpUrl },
    });

    const first = await startMcpAuthorization("protected");
    expect(await completeSignIn(first)).toBe(true);
    expect(registerHits).toBe(1);

    const second = await startMcpAuthorization("second");
    expect(await completeSignIn(second)).toBe(true);
    // A dynamic registration endpoint that we hit on every sign-in is a
    // registration endpoint that starts rate limiting us.
    expect(registerHits).toBe(1);

    const stored = readStoreFile();
    expect(Object.keys(stored.issuers)).toHaveLength(1);
    expect(stored.servers.protected?.clientId).toBe("client-1");
    expect(stored.servers.second?.clientId).toBe("client-1");
  });

  test("a server that is not configured cannot be signed into", async () => {
    await expect(startMcpAuthorization("ghost")).rejects.toThrow(/not a configured http MCP server/);
  });
});

describe("the refresh", () => {
  test("a spent access token is renewed on the next request for a header", async () => {
    const start = await startMcpAuthorization("protected");
    expect(await completeSignIn(start)).toBe(true);

    // Age the token the way eight hours would, without waiting for them.
    const stored = readStoreFile();
    stored.servers.protected!.expiresAt = Date.now() - 1_000;
    writeFileSync(storeFile(), JSON.stringify(stored));

    expect(await authorizationHeader("protected")).toBe("Bearer access-2");
    expect(lastTokenForm.grant_type).toBe("refresh_token");
    expect(lastTokenForm.refresh_token).toBe("refresh-1");
  });

  test("a rotated refresh token replaces the one on disk", async () => {
    const start = await startMcpAuthorization("protected");
    expect(await completeSignIn(start)).toBe(true);

    const stored = readStoreFile();
    stored.servers.protected!.expiresAt = Date.now() - 1_000;
    writeFileSync(storeFile(), JSON.stringify(stored));
    await authorizationHeader("protected");

    // Keeping the dead one is how a store goes stale hours later with nothing
    // in the logs to say why: the second refresh would be refused.
    expect(readStoreFile().servers.protected?.refreshToken).toBe("refresh-2");
    expect(await authorizationHeader("protected", { forceRefresh: true })).toBe("Bearer access-3");
  });

  test("a refresh the server refuses answers null and keeps the record", async () => {
    const start = await startMcpAuthorization("protected");
    expect(await completeSignIn(start)).toBe(true);

    const stored = readStoreFile();
    stored.servers.protected!.refreshToken = "not-a-refresh-token";
    writeFileSync(storeFile(), JSON.stringify(stored));

    expect(await authorizationHeader("protected", { forceRefresh: true })).toBeNull();
    // The entry survives: the cure for a dead refresh token is the sign-in
    // button, not forgetting that a sign-in ever happened.
    expect(readStoreFile().servers.protected).toBeTruthy();
  });
});

describe("the fleet, seen from the panel", () => {
  test("a protected server with nothing stored is needs-auth, not failed", async () => {
    await remountMcpFleet();
    const server = mcpFleetStatus().servers.find((s) => s.name === "protected")!;
    // `failed` would send a person looking for a broken server. This state has
    // a button instead.
    expect(server.state).toBe("needs-auth");
    expect(server.reason).toContain("sign-in");
    // The reason is rendered, so it must never carry anything off the wire.
    expect(server.reason).not.toContain("Bearer");
    expect(mcpToolSpecs().map((t) => t.name)).not.toContain("mcp__protected__dictate");
  });

  test("after the sign-in the same server mounts and its tools are callable", async () => {
    const start = await startMcpAuthorization("protected");
    expect(await completeSignIn(start)).toBe(true);

    await remountMcpFleet();
    const server = mcpFleetStatus().servers.find((s) => s.name === "protected")!;
    expect(server.state).toBe("ready");
    expect(server.transport).toBe("http");
    expect(mcpToolSpecs().map((t) => t.name)).toContain("mcp__protected__dictate");
  });

  test("a token that died under the connection is refreshed once, and the mount survives", async () => {
    const start = await startMcpAuthorization("protected");
    expect(await completeSignIn(start)).toBe(true);

    // The server forgets the token while the store still believes in it: this
    // is the ordinary case of an access token expiring between two mounts, and
    // the only cure that does not cost the mount is the retry inside send().
    liveTokens.clear();
    await remountMcpFleet();

    expect(mcpFleetStatus().servers.find((s) => s.name === "protected")!.state).toBe("ready");
    expect(lastTokenForm.grant_type).toBe("refresh_token");
  });

  test("a spent refresh token puts the server back to needs-auth, not failed", async () => {
    const start = await startMcpAuthorization("protected");
    expect(await completeSignIn(start)).toBe(true);

    liveTokens.clear();
    const stored = readStoreFile();
    stored.servers.protected!.refreshToken = "long-dead";
    writeFileSync(storeFile(), JSON.stringify(stored));
    await remountMcpFleet();

    // Everything has been tried and the answer is still "sign in again", which
    // is the state whose button says exactly that.
    expect(mcpFleetStatus().servers.find((s) => s.name === "protected")!.state).toBe("needs-auth");
  });
});
