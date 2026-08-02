import { test, expect } from "@playwright/test";
import { createTopic, deleteTopic, closeAllBrowserContexts } from "./helpers/api-fixtures";
import { readFile } from "fs/promises";
import { join } from "path";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

// Phase 30.1 polish — server/browser-state-store.ts resolves BASE_DIR as
// `process.env.DATA_DIR ? join(DATA_DIR, "browser-state") : join(cwd, "data", "browser-state")`,
// e la DATA_DIR del server di test è quella dello shard (helpers/test-server.ts),
// non un percorso fisso: con più shard in parallelo ognuno scrive nella sua.
const BROWSER_STATE_DIR = join(E2E_DATA_DIR, "browser-state");

// B1 FIX: mirror server/browser-state-store.ts:16-19 sanitize regex.
function sanitize(topicId: string): string {
  return topicId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function storagePathFor(ctxId: string): string {
  return join(BROWSER_STATE_DIR, sanitize(ctxId), "storage.json");
}

// Chi sporca pulisce: vedi la docstring di `closeAllBrowserContexts`.
test.afterAll(async ({ request }) => {
  await closeAllBrowserContexts(request);
});

test.describe("BROWSER-CHAT-01 persistence", () => {
  test.beforeEach(({}, testInfo) => {
    testInfo.annotations.push({ type: "spec", description: "BROWSER-CHAT-01" });
    testInfo.annotations.push({ type: "plan", description: "@plan-30-05" });
  });

  test("restart server restores URL + cookies for topic with browserState [BROWSER-CHAT-01 / @plan-30-05]", async ({ request }) => {
    const topic = await createTopic(request, `E2E-Persistence-${Date.now()}`);
    const ctxId = topic.id;
    try {
      // 1. Spawn a context + navigate (REST opens & navigates via Playwright server-side)
      const openRes = await request.post(`${BASE}/api/browsers/${ctxId}/agent/open`, {
        data: { url: "https://example.com" },
        headers: { "Content-Type": "application/json" },
      });
      expect(openRes.ok()).toBe(true);

      // 2. Force a state flush by closing the context. B3 NOTE: destroyContext in
      // server/browser-service.ts:377-379 explicitly awaits
      // `context.storageState()` -> `saveStorageState()` BEFORE
      // `context.close()` — this is the synchronous flush path (option b).
      // The DELETE handler awaits this chain before responding 200, so
      // storage.json IS written by the time we read it.
      const closeRes = await request.delete(`${BASE}/api/browsers/${ctxId}`);
      expect(closeRes.ok()).toBe(true);

      // 3. Read storage.json from the canonical path. 5s polling is generous
      // given the synchronous-flush guarantee but absorbs FS sync latency on
      // slow CI machines.
      const storagePath = storagePathFor(ctxId);
      let storage: { cookies?: unknown[]; origins?: unknown[] } | null = null;
      for (let i = 0; i < 25; i++) {
        try {
          const buf = await readFile(storagePath, "utf-8");
          storage = JSON.parse(buf);
          break;
        } catch { /* not yet — back off */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(storage).not.toBeNull();
      expect(Array.isArray(storage!.cookies)).toBe(true);
      expect(Array.isArray(storage!.origins)).toBe(true);

      // 4. Reopen — BrowserService.createContext (called by agent/screenshot
      // via getOrCreate) loads storageState if data/browser-state/<sanitize(id)>/storage.json
      // exists. The screenshot endpoint will only succeed if the context
      // round-tripped successfully through the persisted state.
      const reopenRes = await request.post(`${BASE}/api/browsers/${ctxId}/agent/screenshot`, {
        data: {},
        headers: { "Content-Type": "application/json" },
      });
      expect(reopenRes.ok()).toBe(true);
      // NON `data` (base64): dallo screenshot-su-file l'endpoint torna un PATH.
      // Il base64 inline costava ~5.6k token inservibili per immagine nel
      // contesto dell'agente ed era la causa degli stall "Response stalled
      // mid-stream" — asserire di nuovo `data` significherebbe reintrodurlo.
      // Contratto: server/browser-tools-handler.ts:570-599.
      const reopenBody = (await reopenRes.json()) as {
        path?: string;
        bytes?: number;
        error?: string;
      };
      expect(reopenBody.error).toBeUndefined();
      expect(typeof reopenBody.path).toBe("string");
      expect(reopenBody.bytes ?? 0).toBeGreaterThan(0);
      const shot = await readFile(reopenBody.path!);
      expect(shot.length).toBe(reopenBody.bytes);

      // 4b. The reopen above recreated the context from scratch (it was DELETEd
      // at step 2) — the same cold path a post-restart lazy creation takes.
      // createContext restores the persisted last-url from disk, so the fresh
      // context must be sitting on example.com, not about:blank. This is the
      // load-bearing "restore" assertion the test's title promises; without it
      // the spec never actually verified that the URL came BACK.
      const stateRes = await request.get(`${BASE}/api/browsers/${ctxId}`);
      expect(stateRes.ok()).toBe(true);
      const state = (await stateRes.json()) as { url?: string };
      expect(state.url ?? "").toContain("example.com");

      // 5. Topic.browserState.url MUST reflect the last navigation. The
      // onNavigate hook fires on service.navigate (agent/open path) and resolves
      // the topic by its full id (ctxId === topic.id), so browserState is
      // populated. HARD assert — the old `if (…url)` guard made this dead: it
      // silently passed whenever the hook failed to populate, which is exactly
      // the regression it was meant to catch.
      const topicRes = await request.get(`${BASE}/api/topics`);
      const topicData = (await topicRes.json()) as {
        topics?: Record<string, { browserState?: { url?: string } }>;
      };
      const restoredTopic = topicData.topics?.[ctxId];
      expect(restoredTopic?.browserState?.url).toBeTruthy();
      expect(restoredTopic!.browserState!.url).toContain("example.com");
    } finally {
      await request.delete(`${BASE}/api/browsers/${ctxId}`).catch(() => {});
      await deleteTopic(request, ctxId).catch(() => {});
    }
  });

  test("data/browser-state/<topicId>/storage.json exists after navigation [BROWSER-CHAT-01 / @plan-30-05]", async ({ request }) => {
    const topic = await createTopic(request, `E2E-StorageFile-${Date.now()}`);
    const ctxId = topic.id;
    try {
      // 1. Open context + navigate
      const openRes = await request.post(`${BASE}/api/browsers/${ctxId}/agent/open`, {
        data: { url: "https://example.com" },
        headers: { "Content-Type": "application/json" },
      });
      expect(openRes.ok()).toBe(true);

      // 2. Close context — destroyContext explicitly awaits saveStorageState
      // BEFORE context.close() (server/browser-service.ts:377-379 — synchronous
      // flush path, option b).
      const closeRes = await request.delete(`${BASE}/api/browsers/${ctxId}`);
      expect(closeRes.ok()).toBe(true);

      // 3. Verify storage.json exists at the canonical hardcoded path:
      //    {repoRoot}/data/browser-state/{sanitize(ctxId)}/storage.json
      const storagePath = storagePathFor(ctxId);
      let exists = false;
      for (let i = 0; i < 25; i++) {
        try {
          await readFile(storagePath, "utf-8");
          exists = true;
          break;
        } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(exists).toBe(true);
    } finally {
      await request.delete(`${BASE}/api/browsers/${ctxId}`).catch(() => {});
      await deleteTopic(request, ctxId).catch(() => {});
    }
  });
});
