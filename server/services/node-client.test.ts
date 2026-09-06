/**
 * The client that talks to a paired node, with a fake `fetch` and no network.
 *
 * @covers MACHINE-02
 * @covers KANBAN-77
 *
 * Three things the contract demands that a generic mock does not prove: the
 * token is read from the `Set-Cookie` and not from the body, the token file is
 * born at `0600`, and the three walls (host refused, certificate, no network)
 * have three different names. The rest: every authenticated call carries the
 * cookie, and an empty bundle is told apart from bytes.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeClient, NodeError, readNodeToken, writeNodeToken, nodeTokenPath, tokenFromSetCookie,
  normalizeNodeBaseUrl, type FetchLike, type NodeFailureReason,
} from "./node-client";

const BASE = "https://node.example:8443";
const TOKEN = "dGhpcy1pcy1hLXRva2VuLXZhbHVl0123456789";

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a queue and remembers what it was asked. */
function fakeFetch(answers: Array<Response | Error | (() => Response | Error)>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error(`fakeFetch: no answer queued for ${url}`);
    const answer = typeof next === "function" ? next() : next;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(fetch: FetchLike, overrides: Partial<Parameters<typeof createNodeClient>[0]> = {}) {
  let clock = 1_000;
  return createNodeClient({
    fetch,
    now: () => clock,
    // A fake wait that only moves the clock: no timer, no sleep.
    wait: async (ms) => { clock += ms; },
    version: "9.9.9",
    hostname: "this-machine",
    pollIntervalMs: 100,
    ...overrides,
  });
}

const headerOf = (call: Call, name: string): string | null => {
  const h = new Headers(call.init.headers);
  return h.get(name);
};

describe("node-client · pairing", () => {
  test("pairRequest si presenta con User-Agent Topics/<version> (<hostname>) e riporta requestId, code, claim", async () => {
    const { fetch, calls } = fakeFetch([
      jsonResponse({ requestId: "r1", code: "123456", claim: "c".repeat(64), name: "Mac", expiresInMs: 180_000 }),
    ]);
    const out = await client(fetch).pairRequest(BASE);
    expect(out).toEqual({ requestId: "r1", code: "123456", claim: "c".repeat(64), name: "Mac", expiresInMs: 180_000 });
    expect(calls[0].url).toBe(`${BASE}/api/auth/pair/request`);
    expect(calls[0].init.method).toBe("POST");
    expect(headerOf(calls[0], "user-agent")).toBe("Topics/9.9.9 (this-machine)");
    expect(headerOf(calls[0], "cookie")).toBeNull();
  });

  test("pairWait legge il gettone dal Set-Cookie, non dal corpo", async () => {
    const { fetch, calls } = fakeFetch([
      jsonResponse({ state: "pending" }),
      jsonResponse({ state: "approved", name: "Mac" }, 200, {
        "set-cookie": `topics_device=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000; Secure`,
      }),
    ]);
    const out = await client(fetch).pairWait({ baseUrl: BASE, requestId: "r1", claim: "abc" });
    expect(out).toEqual({ state: "approved", token: TOKEN, name: "Mac" });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${BASE}/api/auth/pair/status?requestId=r1&claim=abc`);
  });

  test("approvato senza cookie e' un errore, non un gettone vuoto", async () => {
    const { fetch } = fakeFetch([jsonResponse({ state: "approved", token: "in-the-body-by-mistake" })]);
    let caught: unknown = null;
    try {
      await client(fetch).pairWait({ baseUrl: BASE, requestId: "r1", claim: "abc" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NodeError);
    expect((caught as NodeError).reason).toBe("server_error");
  });

  test("maxPolls: 1 restituisce pending senza attendere; denied ed expired sono terminali", async () => {
    const pending = fakeFetch([jsonResponse({ state: "pending" })]);
    expect(await client(pending.fetch).pairWait({ baseUrl: BASE, requestId: "r", claim: "c", maxPolls: 1 }))
      .toEqual({ state: "pending" });
    expect(pending.calls).toHaveLength(1);

    const denied = fakeFetch([jsonResponse({ state: "denied" })]);
    expect(await client(denied.fetch).pairWait({ baseUrl: BASE, requestId: "r", claim: "c" })).toEqual({ state: "denied" });

    const expired = fakeFetch([jsonResponse({ state: "expired" })]);
    expect(await client(expired.fetch).pairWait({ baseUrl: BASE, requestId: "r", claim: "c" })).toEqual({ state: "expired" });
  });

  test("l'orologio scade la richiesta anche se il nodo continua a dire pending", async () => {
    const { fetch, calls } = fakeFetch(Array.from({ length: 50 }, () => () => jsonResponse({ state: "pending" })));
    const out = await client(fetch).pairWait({ baseUrl: BASE, requestId: "r", claim: "c", expiresInMs: 350 });
    expect(out).toEqual({ state: "expired" });
    // 350 ms of TTL at 100 ms per poll: four polls, never fifty.
    expect(calls.length).toBeLessThanOrEqual(5);
  });

  test("tokenFromSetCookie trova topics_device fra altri cookie e ignora un nome simile", () => {
    const h = new Headers();
    h.append("set-cookie", "other=1; Path=/");
    h.append("set-cookie", `topics_device=${TOKEN}; HttpOnly`);
    expect(tokenFromSetCookie(h)).toBe(TOKEN);
    expect(tokenFromSetCookie(new Headers({ "set-cookie": "not_topics_device=x; Path=/" }))).toBeNull();
    expect(tokenFromSetCookie(new Headers())).toBeNull();
  });
});

describe("node-client · token file", () => {
  test("writeNodeToken crea <stateDir>/nodes/<id>.token a 0600 dentro una cartella 0700, e readNodeToken lo rilegge", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "node-token-"));
    try {
      const f = writeNodeToken(stateDir, "machine-1", TOKEN);
      expect(f).toBe(join(stateDir, "nodes", "machine-1.token"));
      expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(statSync(join(stateDir, "nodes")).mode & 0o777).toBe(0o700);
      expect(readFileSync(f, "utf8")).toBe(TOKEN + "\n");
      expect(readNodeToken(stateDir, "machine-1")).toBe(TOKEN);
      expect(readNodeToken(stateDir, "never-paired")).toBeNull();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("ri-accoppiare sopra un file lasciato largo lo riporta a 0600", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "node-token-"));
    try {
      const f = writeNodeToken(stateDir, "m", "old-token-value-0123456789");
      chmodSync(f, 0o644);
      writeNodeToken(stateDir, "m", TOKEN);
      expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(readNodeToken(stateDir, "m")).toBe(TOKEN);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("un id che non e' un nome di file viene rifiutato, e un file manomesso legge null", () => {
    expect(() => nodeTokenPath("/state", "../etc/passwd")).toThrow();
    expect(() => nodeTokenPath("/state", "a/b")).toThrow();
    const stateDir = mkdtempSync(join(tmpdir(), "node-token-"));
    try {
      writeNodeToken(stateDir, "m", TOKEN);
      writeFileSync(join(stateDir, "nodes", "m.token"), "not a cookie value\n");
      expect(readNodeToken(stateDir, "m")).toBeNull();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("node-client · i guasti hanno un nome", () => {
  const reasonOf = async (answer: Response | Error): Promise<NodeFailureReason> => {
    const { fetch } = fakeFetch([answer]);
    try {
      await client(fetch).pairRequest(BASE);
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      return (err as NodeError).reason;
    }
    throw new Error("expected a NodeError");
  };

  test("403 host rifiutato, TypeError di certificato e TypeError di rete: tre nomi diversi", async () => {
    const hostRefused = await reasonOf(jsonResponse({ error: "host not allowed", code: "host_not_allowed" }, 403));
    const certificate = await reasonOf(new TypeError("fetch failed", {
      cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
    }));
    const network = await reasonOf(new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:8443"), { code: "ECONNREFUSED" }),
    }));
    expect(hostRefused).toBe("host_not_allowed");
    expect(certificate).toBe("tls_untrusted");
    expect(network).toBe("unreachable");
    expect(new Set([hostRefused, certificate, network]).size).toBe(3);
  });

  test("un errore di certificato riconosciuto dal solo codice, senza la parola nel messaggio", async () => {
    const err = Object.assign(new Error("fetch failed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    expect(await reasonOf(err)).toBe("tls_untrusted");
  });

  test("401 e 403 non-host sono unauthorized, 404 e' not_found, 500 e' server_error, no_such_repo vince sullo status", async () => {
    expect(await reasonOf(jsonResponse({ error: "device revoked", code: "device_revoked" }, 401))).toBe("unauthorized");
    expect(await reasonOf(jsonResponse({ error: "cross-site origin blocked", code: "forbidden" }, 403))).toBe("unauthorized");
    expect(await reasonOf(new Response("nope", { status: 404 }))).toBe("not_found");
    expect(await reasonOf(new Response("boom", { status: 500 }))).toBe("server_error");
    expect(await reasonOf(jsonResponse({ error: "no repo for that origin", code: "no_such_repo" }, 404))).toBe("no_such_repo");
  });
});

describe("node-client · corse", () => {
  const body = {
    originTaskId: "t1", originUrl: "https://board.local/tasks/t1", text: "Do the thing",
    description: "long form", model: "opus", effort: "high",
  };

  test("createRun, readRun e cancelRun mandano Cookie: topics_device=<token> e lo User-Agent", async () => {
    const { fetch, calls } = fakeFetch([
      jsonResponse({ runId: "run-9" }),
      jsonResponse({
        status: "working", dispatchState: "running", dispatchError: null,
        comments: [{ id: "c1", author: "system", content: "started", kind: "system", createdAt: "2026-09-06T10:00:00Z" }],
        deliveryBranch: null, deliveryCommit: null, baseSha: "abc", stat: null,
      }),
      jsonResponse({ ok: true }),
    ]);
    const c = client(fetch);
    expect(await c.createRun({ baseUrl: BASE, token: TOKEN, body })).toEqual({ runId: "run-9" });
    const report = await c.readRun({ baseUrl: BASE, token: TOKEN, runId: "run-9", sinceCommentSeq: 3 });
    expect(report.status).toBe("working");
    expect(report.comments).toHaveLength(1);
    await c.cancelRun({ baseUrl: BASE, token: TOKEN, runId: "run-9" });

    expect(calls.map((x) => [x.init.method, x.url])).toEqual([
      ["POST", `${BASE}/api/nodes/runs`],
      ["GET", `${BASE}/api/nodes/runs/run-9?sinceCommentSeq=3`],
      ["DELETE", `${BASE}/api/nodes/runs/run-9`],
    ]);
    for (const call of calls) {
      expect(headerOf(call, "cookie")).toBe(`topics_device=${TOKEN}`);
      expect(headerOf(call, "user-agent")).toBe("Topics/9.9.9 (this-machine)");
    }
    expect(JSON.parse(String(calls[0].init.body))).toEqual(body);
  });

  test("fetchBundle distingue {empty:true} dai byte del bundle", async () => {
    const bytes = new Uint8Array([0x23, 0x20, 0x76, 0x32, 0x20, 0x67, 0x69, 0x74]);
    const { fetch, calls } = fakeFetch([
      jsonResponse({ empty: true }),
      new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    ]);
    const c = client(fetch);
    expect(await c.fetchBundle({ baseUrl: BASE, token: TOKEN, runId: "run-9" })).toEqual({ empty: true });
    const full = await c.fetchBundle({ baseUrl: BASE, token: TOKEN, runId: "run-9" });
    expect(full.empty).toBe(false);
    if (!full.empty) expect(Array.from(full.bytes)).toEqual(Array.from(bytes));
    expect(calls[0].url).toBe(`${BASE}/api/nodes/runs/run-9/bundle`);
    expect(headerOf(calls[1], "cookie")).toBe(`topics_device=${TOKEN}`);
  });
});

describe("node-client · normalizeNodeBaseUrl", () => {
  test("toglie la barra finale, rifiuta schemi non http(s) e stringhe storte", () => {
    expect(normalizeNodeBaseUrl("https://node.example:8443/")).toBe("https://node.example:8443");
    expect(normalizeNodeBaseUrl("  http://10.0.0.9:3000/topics/ ")).toBe("http://10.0.0.9:3000/topics");
    expect(normalizeNodeBaseUrl("ftp://node.example")).toBeNull();
    expect(normalizeNodeBaseUrl("not a url")).toBeNull();
    expect(normalizeNodeBaseUrl(42)).toBeNull();
  });
});
