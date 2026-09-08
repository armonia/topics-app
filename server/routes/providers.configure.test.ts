/** @covers MP-SETUP-01 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../types";
import { createProvidersRouter } from "./providers";
import { readApiProviderKey } from "../services/api-provider-credentials";
import { getProvider, removeProvider } from "../providers";
import { getSnapshotManager } from "../providers/snapshot-manager";

let root: string;
let router: ReturnType<typeof createProvidersRouter>;
let fetchSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "topics-provider-route-"));
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: RequestInfo | URL, options?: RequestInit) => {
    const auth = new Headers(options?.headers).get("authorization");
    return auth === "Bearer rejected-test-key"
      ? Response.json({ error: "never echo rejected-test-key" }, { status: 401 })
      : Response.json({ data: [{ id: "gpt-4o" }] });
  }) as typeof fetch);
  router = createProvidersRouter({ STATE_DIR: root, json: (data: unknown, status = 200) => Response.json(data, { status }) } as AppContext);
});

afterAll(() => {
  removeProvider("openai");
  fetchSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

async function configure(apiKey: string) {
  const req = new Request("http://localhost/api/providers/openai/configure", { method: "POST", body: JSON.stringify({ apiKey }) });
  return (await router(req, new URL(req.url), new URL(req.url).pathname, "POST"))!;
}

test("fresh setup persists privately, publishes status, and rejects bad replacement without changing the instance", async () => {
  const response = await configure("valid-test-key");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, provider: { name: "openai", connected: true }, persisted: true });
  expect(readApiProviderKey("openai", root, {})).toBe("valid-test-key");
  const instance = getProvider("openai");
  await getSnapshotManager().refresh("openai");
  const publicSnapshot = JSON.stringify(getSnapshotManager().getSnapshot());
  expect(publicSnapshot).not.toContain("valid-test-key");
  const rejected = await configure("rejected-test-key");
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).not.toContain("rejected-test-key");
  expect(readApiProviderKey("openai", root, {})).toBe("valid-test-key");
  expect(getProvider("openai")).toBe(instance);
  const replacement = await configure("replacement-test-key");
  expect(replacement.status).toBe(200);
  expect(readApiProviderKey("openai", root, {})).toBe("replacement-test-key");
  expect(getProvider("openai")).toBe(instance);
  await getSnapshotManager().refresh("openai");
});
