/**
 * The CRUD in front of the configured endpoints: what it refuses to save, and
 * what it refuses to hand back.
 *
 * @covers MP-DIRECT-01
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectEndpointsRouter } from "./direct-endpoints";
import { readEndpointSecret } from "../services/direct-endpoint-store";

const roots: string[] = [];
let realFetch: typeof fetch;
beforeEach(() => { realFetch = globalThis.fetch; });

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "endpoint-routes-"));
  roots.push(root);
  return root;
}

function router(root: string) {
  const synced: number[] = [];
  const handler = createDirectEndpointsRouter({
    json: (body, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    stateDir: root,
    sync: () => { synced.push(1); },
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://localhost${path}`);
    const request = new Request(url, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await handler(request, url, url.pathname, method);
    if (!response) return null;
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { call, syncs: synced };
}

/** An endpoint that answers `/v1/models` like llama-server does. */
function endpointIsUp(models: Array<Record<string, unknown>> = [{ id: "qwen38-27b-200k", meta: { n_ctx: 200_192 } }]) {
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: models }), { status: 200 })) as unknown as typeof fetch;
}

const valid = { label: "Local llama", baseUrl: "http://127.0.0.1:18080/v1" };

describe("saving an endpoint", () => {
  test("a working endpoint is probed, stored and the registry is resynced", async () => {
    endpointIsUp();
    const root = newRoot();
    const { call, syncs } = router(root);

    const created = await call("POST", "/api/providers/endpoints", valid);
    expect(created?.status).toBe(200);
    expect(created?.body.ok).toBe(true);
    expect(created?.body.models).toEqual(["qwen38-27b-200k"]);
    expect(syncs.length).toBe(1);

    const listed = await call("GET", "/api/providers/endpoints");
    expect((listed?.body.endpoints as unknown[]).length).toBe(1);
  });

  test("an endpoint that does not answer is refused instead of being stored", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const root = newRoot();
    const { call, syncs } = router(root);

    const created = await call("POST", "/api/providers/endpoints", valid);
    expect(created?.status).toBe(502);
    expect(syncs.length).toBe(0);

    const listed = await call("GET", "/api/providers/endpoints");
    expect((listed?.body.endpoints as unknown[]).length).toBe(0);
  });

  test("an address on the metadata network never reaches the network at all", async () => {
    let called = 0;
    globalThis.fetch = (async () => { called += 1; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const { call } = router(newRoot());
    const created = await call("POST", "/api/providers/endpoints", {
      label: "Sneaky", baseUrl: "http://169.254.169.254/v1",
    });
    expect(created?.status).toBe(502);
    expect(called).toBe(0);
  });

  test("a malformed endpoint is a 400, with a sentence the form can show", async () => {
    const { call } = router(newRoot());
    const created = await call("POST", "/api/providers/endpoints", { label: "", baseUrl: "nope" });
    expect(created?.status).toBe(400);
    expect(typeof created?.body.error).toBe("string");
  });

  test("bearer auth without a token is refused before any request goes out", async () => {
    let called = 0;
    globalThis.fetch = (async () => { called += 1; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const { call } = router(newRoot());
    const created = await call("POST", "/api/providers/endpoints", { ...valid, auth: "bearer" });
    expect(created?.status).toBe(400);
    expect(called).toBe(0);
  });
});

describe("the token", () => {
  test("it is stored apart and never sent back to the client", async () => {
    endpointIsUp();
    const root = newRoot();
    const { call } = router(root);

    const created = await call("POST", "/api/providers/endpoints", {
      ...valid, auth: "bearer", token: "tok-secret",
    });
    expect(created?.status).toBe(200);
    expect(JSON.stringify(created?.body)).not.toContain("tok-secret");
    expect((created?.body.endpoint as Record<string, unknown>).hasToken).toBe(true);

    const listed = await call("GET", "/api/providers/endpoints");
    expect(JSON.stringify(listed?.body)).not.toContain("tok-secret");
    expect((listed?.body.endpoints as Array<Record<string, unknown>>)[0]!.hasToken).toBe(true);
  });

  test("saving again without a token keeps the one already stored", async () => {
    endpointIsUp();
    const root = newRoot();
    const { call } = router(root);

    const first = await call("POST", "/api/providers/endpoints", { ...valid, auth: "bearer", token: "tok-secret" });
    const id = (first?.body.endpoint as Record<string, string>).id;

    const again = await call("POST", "/api/providers/endpoints", { ...valid, id, auth: "bearer" });
    expect(again?.status).toBe(200);
    expect(readEndpointSecret(id, root)).toBe("tok-secret");
  });
});

describe("deleting an endpoint", () => {
  test("it disappears, its token goes with it, and the registry resyncs", async () => {
    endpointIsUp();
    const root = newRoot();
    const { call, syncs } = router(root);

    const created = await call("POST", "/api/providers/endpoints", { ...valid, auth: "bearer", token: "tok-secret" });
    const id = (created?.body.endpoint as Record<string, string>).id;

    const removed = await call("DELETE", `/api/providers/endpoints/${id}`);
    expect(removed?.status).toBe(200);
    expect(readEndpointSecret(id, root)).toBeUndefined();
    expect(syncs.length).toBe(2);

    const listed = await call("GET", "/api/providers/endpoints");
    expect((listed?.body.endpoints as unknown[]).length).toBe(0);
  });

  test("deleting one that is not there is a 404, not a silent success", async () => {
    const { call } = router(newRoot());
    const removed = await call("DELETE", "/api/providers/endpoints/ghost");
    expect(removed?.status).toBe(404);
  });
});

describe("the test button", () => {
  test("it reports the models without storing anything", async () => {
    endpointIsUp();
    const root = newRoot();
    const { call } = router(root);

    const probe = await call("POST", "/api/providers/endpoints/test", valid);
    expect(probe?.status).toBe(200);
    expect(probe?.body.models).toEqual(["qwen38-27b-200k"]);

    const listed = await call("GET", "/api/providers/endpoints");
    expect((listed?.body.endpoints as unknown[]).length).toBe(0);
  });
});
