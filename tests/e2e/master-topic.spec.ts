import { test, expect } from "@playwright/test";

// Specs mirrored from openspec/changes/add-master-topic-mode/specs/master-topic/spec.md
// Gherkin sources: tests/features/master-topic-*.feature
//
// These tests are gated with `test.fixme` until Phase A-D land. Once each phase
// implements its scope, flip the matching test from `test.fixme` to `test` and
// fill in the assertions. The structure here is the contract the implementation
// must satisfy.

test.describe("MASTER-01 — Master Topic creation via CLI", () => {
  // Server-side API path is implemented (POST /api/topics/master).
  // This test exercises it end-to-end against the live test server.
  test(
    "POST /api/topics/master creates a lead topic (server-side smoke)",
    async ({ request }) => {
      const projectPath = `/tmp/topics-e2e-master-${Date.now()}`;
      const resp = await request.post("/api/topics/master", {
        data: { projectPath },
        headers: { "content-type": "application/json" },
      });
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();
      expect(body.id).toBeTruthy();
      expect(body.resumed).toBe(false);

      // Idempotency: second call returns the same id with resumed=true.
      const resume = await request.post("/api/topics/master", {
        data: { projectPath },
        headers: { "content-type": "application/json" },
      });
      expect(resume.ok()).toBeTruthy();
      const resumeBody = await resume.json();
      expect(resumeBody.id).toBe(body.id);
      expect(resumeBody.resumed).toBe(true);
    },
  );

  test.fixme(
    "Re-running the master command resumes the existing Master Topic",
    async ({ page }) => {
      // Pre: existing master topic for /tmp/demo-repo
      // Action: re-issue master command
      // Assert: focus existing, no duplicate, --resume in spawn args
      await page.goto("/");
    },
  );

  test(
    "Topics workspace loads and serves Master API (video proof of UAT toolchain)",
    async ({ page, request }) => {
      // 1. Boot a Master Topic via API so the server emits a topic:created WS message.
      const projectPath = `/tmp/topics-e2e-uat-${Date.now()}`;
      const resp = await request.post("/api/topics/master", {
        data: { projectPath },
        headers: { "content-type": "application/json" },
      });
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();

      // 2. Load the workspace — proves the SPA renders cleanly against current schema.
      await page.goto("/");
      await expect(page).toHaveTitle(/Topics/i);

      // 3. The created topic id is exposed via /api/topics; verify the round-trip.
      const list = await request.get("/api/topics");
      expect(list.ok()).toBeTruthy();
      const listBody = await list.json();
      expect(listBody.topics).toBeDefined();
      expect(listBody.topics[body.id]).toBeDefined();
    },
  );

  test.fixme(
    "Master Topic UI shows team-mode badge",
    async ({ page }) => {
      await page.goto("/");
      await expect(page.getByTestId("shared-task-list")).toBeVisible();
    },
  );
});

test.describe("MASTER-02 — Teammate spawn & binding", () => {
  test.fixme("Lead delegation spawns a teammate Topic", async ({ page }) => {
    // Pre: master active; simulate delegation event via API
    // Assert: teammate topic created with parent_topic_id, role=teammate, correct cwd
    await page.goto("/");
  });

  test.fixme(
    "Teammate pane displays the assigned task",
    async ({ page }) => {
      await page.goto("/");
    },
  );
});

test.describe("MASTER-03 — Token budget guardrail", () => {
  test.fixme(
    "Pro user spawning fourth teammate sees a budget warning",
    async ({ page }) => {
      await page.goto("/");
      await expect(page.getByTestId("token-budget-warning")).toBeVisible();
    },
  );
});

test.describe("KANBAN-DELTA-01 — Jump from board card to teammate pane", () => {
  test.fixme(
    "Click on assignment badge focuses teammate pane",
    async ({ page }) => {
      await page.goto("/");
    },
  );

  test.fixme(
    "Keyboard shortcut Cmd+J cycles through teammate panes",
    async ({ page }) => {
      await page.goto("/");
    },
  );
});

test.describe("KANBAN-DELTA-02 — Shared task list sync", () => {
  test.fixme(
    "Claude writes task → board renders within 2s",
    async ({ page }) => {
      await page.goto("/");
    },
  );

  test.fixme(
    "Board edit writes back to shared list",
    async ({ page }) => {
      await page.goto("/");
    },
  );

  test.fixme(
    "Conflict resolution prefers last-write-wins",
    async ({ page }) => {
      await page.goto("/");
    },
  );
});

test.describe("TERM-DELTA-01 — claude-code-team session type", () => {
  // Backend code path is implemented (terminal.ts handles 'claude-code-team').
  // E2E flag-verification is still gated until the bridge exposes env in API.
  test.fixme(
    "Team-mode session starts with AGENT_TEAMS=1 flag",
    async ({ request }) => {
      const _ = request;
    },
  );

  test.fixme(
    "Team-mode session resumes cleanly via --resume",
    async () => {},
  );
});

test.describe("TERM-DELTA-02 — Programmatic provider relabel", () => {
  test.fixme(
    "New topic dialog defaults to interactive PTY claude-code",
    async ({ page }) => {
      await page.goto("/");
    },
  );
});
