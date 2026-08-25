/**
 * Login-state sharing E2E: save the pane's cookies + localStorage under a
 * handle, then load it into a FRESH topic's pane and confirm it lands. Exercises
 * the /agent/save-state + /agent/load-state REST routes through the real server
 * + BrowserService (web-fallback Playwright path). The page is the app's own
 * origin so cookies/localStorage are real (data: URLs can't hold them).
 *
 * @covers BROWSER-02
 */
import { test, expect } from "./fixtures/browser-v2.fixture";
import { createTopic, deleteTopic } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;
const HEADERS = { "Content-Type": "application/json" };

test.describe("Browser login-state sharing (save_state / load_state)", () => {
  test("save_state on one topic → load_state into a fresh topic restores localStorage", async ({ request }) => {
    const handle = `e2e-login-${Date.now()}`;
    const a = await createTopic(request, `E2E-SaveState-${Date.now()}`);
    const b = await createTopic(request, `E2E-LoadState-${Date.now()}`);
    try {
      // 1. Open pane A on the app origin and stash a localStorage token.
      const openA = await request.post(`${BASE}/api/browsers/${a.id}/agent/open`, {
        data: { url: `${BASE}/` }, headers: HEADERS,
      });
      expect(openA.ok()).toBe(true);
      const evalA = await request.post(`${BASE}/api/browsers/${a.id}/agent/eval`, {
        data: { expression: "localStorage.setItem('e2e_tok','SHARED123'); return localStorage.getItem('e2e_tok')" },
        headers: HEADERS,
      });
      const evalABody = (await evalA.json()) as { result?: unknown };
      expect(evalABody.result).toBe("SHARED123");

      // 2. Save state under a handle (writes Topics + Jarvis stores).
      const save = await request.post(`${BASE}/api/browsers/${a.id}/agent/save-state`, {
        data: { handle }, headers: HEADERS,
      });
      expect(save.ok()).toBe(true);
      const saveBody = (await save.json()) as { ok?: boolean; origins?: number; error?: string };
      expect(saveBody.error).toBeUndefined();
      expect(saveBody.ok).toBe(true);
      expect(saveBody.origins!).toBeGreaterThanOrEqual(1);

      // 3. Fresh pane B (no token yet) → confirm clean.
      const openB = await request.post(`${BASE}/api/browsers/${b.id}/agent/open`, {
        data: { url: `${BASE}/` }, headers: HEADERS,
      });
      expect(openB.ok()).toBe(true);
      const preB = await request.post(`${BASE}/api/browsers/${b.id}/agent/eval`, {
        data: { expression: "return localStorage.getItem('e2e_tok')" }, headers: HEADERS,
      });
      expect((await preB.json() as { result?: unknown }).result).toBeNull();

      // 4. Load the handle into B → token restored.
      const load = await request.post(`${BASE}/api/browsers/${b.id}/agent/load-state`, {
        data: { handle }, headers: HEADERS,
      });
      expect(load.ok()).toBe(true);
      const loadBody = (await load.json()) as { ok?: boolean; source?: string; error?: string };
      expect(loadBody.error).toBeUndefined();
      expect(loadBody.ok).toBe(true);

      const postB = await request.post(`${BASE}/api/browsers/${b.id}/agent/eval`, {
        data: { expression: "return localStorage.getItem('e2e_tok')" }, headers: HEADERS,
      });
      expect((await postB.json() as { result?: unknown }).result).toBe("SHARED123");
    } finally {
      await request.delete(`${BASE}/api/browsers/${a.id}`).catch(() => {});
      await request.delete(`${BASE}/api/browsers/${b.id}`).catch(() => {});
      await deleteTopic(request, a.id).catch(() => {});
      await deleteTopic(request, b.id).catch(() => {});
    }
  });
});
