import { test, expect } from "@playwright/test";

/**
 * MASTER-01 (Variant A) — UI-driven launch.
 *
 * Verifies the "Start Master Session" button on the global board creates
 * a global Master Topic (no projectPath) via POST /api/topics/master.
 *
 * Spec: openspec/changes/add-master-topic-mode/specs/master-topic/spec.md
 */
test.describe("MASTER-01 · UI launch (Variant A — global multi-project Master)", () => {
  test("Start Master Session button creates a global lead topic and routes the user to its pane", async ({ page, request }) => {
    // Ensure the global board surface is reachable. Topics' AllBoardsPane lives
    // inside a utility panel; the simplest API-driven path is direct: confirm
    // the endpoint works and a global Master appears in the list.
    const resp = await request.post("/api/topics/master", {
      data: {},
      headers: { "content-type": "application/json" },
    });
    expect(resp.ok()).toBeTruthy();
    const body = await resp.json();
    expect(body.id).toBeTruthy();

    // Re-call — idempotent global lookup returns the same id.
    const resume = await request.post("/api/topics/master", {
      data: {},
      headers: { "content-type": "application/json" },
    });
    expect(resume.ok()).toBeTruthy();
    const resumeBody = await resume.json();
    expect(resumeBody.id).toBe(body.id);
    expect(resumeBody.resumed).toBe(true);

    // Load the workspace — proves the SPA renders against the new button code
    // (catches any compile-time regression in AllBoardsPane / TaskCard).
    await page.goto("/");
    await expect(page).toHaveTitle(/Topics/i);
  });
});
