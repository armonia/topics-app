/**
 * external-session-adopt.spec.ts — HANDOFF: adopt a live Claude Code session
 * (started in a terminal) INTO a topic, with its history visible in chat.
 *
 * Attilio's ask: "ho appena passato questa sessione da app claude a terminale su
 * claude code, sarebbe figo che topic fosse nativo in questo". Today a topic
 * STARTS a session; this is the missing opposite direction — take a session
 * already running elsewhere and continue it inside a topic.
 *
 * The test seeds the transcript a bare `claude` would leave under the server's
 * isolated HOME (real scan path, no mocks), then:
 *   ADOPT-01 drives the endpoint directly — bind + import + idempotency.
 *   ADOPT-02 drives the UI — badge → popover → "Continua qui" → chat with history.
 * Each test owns its OWN session id and project so adopting in one never shadows
 * the census the other reads (an adopted session is "governed" and drops out of
 * the "outside the kanban" list). The actual `--resume` spawn that makes the
 * next turn continue the SAME conversation is covered by the provider unit tests;
 * here we prove the binding + the imported history the human sees.
 */
import { test } from "./fixtures/layout.fixture";
import { expect, type Page } from "@playwright/test";
import { createTopic, deleteTopic, resetPaneStore, seedProjectPane } from "./helpers/api-fixtures";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { claudeProjectDirName } from "../../server/lib/claude-transcript-path";

hermetic(test);

const BASE = E2E_BASE;
const TEST_HOME = E2E_HOME;

// Recognisable markers so we assert the imported history, not some other row.
const USER_MSG = "handoff-domanda-XYZ";
const ASSISTANT_MSG = "handoff-risposta-XYZ";

/** Il server usa questa, e la usa anche il fixture: una regola sola. */
const encode = claudeProjectDirName;

/** Write a transcript with a real user→assistant turn plus a tool call. */
function seedSession(cwd: string, sessionId: string): void {
  const dir = `${TEST_HOME}/.claude/projects/${encode(cwd)}`;
  mkdirSync(dir, { recursive: true });
  const base = { cwd, sessionId, entrypoint: "cli", gitBranch: "main", version: "1.0.0" };
  const lines = [
    { ...base, type: "user", uuid: "u1", timestamp: "2026-07-30T10:00:00Z", message: { role: "user", content: USER_MSG } },
    {
      ...base, type: "assistant", uuid: "a1", timestamp: "2026-07-30T10:00:01Z",
      message: { role: "assistant", content: [
        { type: "text", text: ASSISTANT_MSG },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ] },
    },
    {
      ...base, type: "user", uuid: "u2", timestamp: "2026-07-30T10:00:02Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }] },
    },
  ];
  writeFileSync(`${dir}/${sessionId}.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Poll until the TTL-cached census surfaces the seeded session. */
async function waitForCensus(request: import("@playwright/test").APIRequestContext, sessionId: string) {
  await expect.poll(async () => {
    const res = await request.get(`${BASE}/api/external-sessions`);
    if (!res.ok()) return null;
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    return body.sessions.find((s) => s.sessionId === sessionId) ?? null;
  }, { timeout: 45_000, intervals: [1000] }).not.toBeNull();
}

async function openTestProject(page: Page, projectMatch: RegExp) {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") await projectsSection.click();
  }
  const btn = page.locator('[aria-label="Topics sidebar"] button').filter({ hasText: projectMatch }).first();
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();
  await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 10000 });
}

async function openProjectBoard(page: Page, projectMatch: RegExp) {
  await openTestProject(page, projectMatch);
  const triggers = page.getByTestId("pane-add-menu-trigger");
  const count = await triggers.count();
  const item = page.getByTestId("pane-add-menu-kanban");
  for (let i = count - 1; i >= 0; i--) {
    await triggers.nth(i).click();
    const found = await item.waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
    if (found) break;
    await page.keyboard.press("Escape");
    if (i === 0) throw new Error("no + menu with a Board (kanban) entry found");
  }
  await item.click();
  await expect(page.getByTestId("kanban-board")).toBeVisible({ timeout: 10000 });
}

test.describe("Handoff: adottare una sessione Claude Code viva", () => {
  test.describe.configure({ timeout: 90_000 });

  // Independent fixtures per test — adopting one must not shadow the other.
  const API_PATH = `/tmp/e2e-adopt-api-${Date.now()}`;
  const API_SID = "ad0d7000-1111-2222-3333-444444444444";
  const UI_PATH = `/tmp/e2e-adopt-ui-${Date.now()}`;
  const UI_SID = "ad0d7000-aaaa-bbbb-cccc-555555555555";

  test.beforeAll(async ({ request }) => {
    for (const [p, name] of [[API_PATH, "e2e-adopt-api"], [UI_PATH, "e2e-adopt-ui"]] as const) {
      mkdirSync(p, { recursive: true });
      writeFileSync(`${p}/package.json`, JSON.stringify({ name }, null, 2));
      await createTopic(request, name, { projectPath: p });
    }
    seedSession(API_PATH, API_SID);
    seedSession(UI_PATH, UI_SID);
  });

  test.afterAll(async () => {
    for (const p of [API_PATH, UI_PATH]) {
      rmSync(`${TEST_HOME}/.claude/projects/${encode(p)}`, { recursive: true, force: true });
      rmSync(p, { recursive: true, force: true });
    }
  });

  test.beforeEach(async ({ page }) => {
    await resetPaneStore(page.request, []);
    await seedProjectPane(page.request, API_PATH).catch(() => {});
    await seedProjectPane(page.request, UI_PATH).catch(() => {});
  });

  test("ADOPT-01: the endpoint binds the session and imports its history", async ({ request }) => {
    await waitForCensus(request, API_SID);

    const res = await request.post(`${BASE}/api/topics/adopt-claude`, { data: { sessionId: API_SID } });
    expect(res.ok()).toBe(true);
    const topic = (await res.json()) as { id: string; sessionKey: string; provider: string; projectPath: string; importedMessages: number };
    expect(topic.provider).toBe("claude-code");
    expect(topic.projectPath).toBe(API_PATH);
    // user + assistant were imported; the tool_result-only line is not a turn.
    expect(topic.importedMessages).toBe(2);

    // History is queryable under the new topic's session — the user's own words,
    // and the assistant reply with its Bash tool call and result.
    const hist = await request.get(`${BASE}/api/history/${encodeURIComponent(topic.sessionKey)}`);
    expect(hist.ok()).toBe(true);
    const { messages } = (await hist.json()) as { messages: Array<{ role: string; content: string; toolCalls?: Array<{ name: string; result?: string }> }> };
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]!.content).toContain(USER_MSG);
    expect(messages[1]!.content).toContain(ASSISTANT_MSG);
    expect(messages[1]!.toolCalls?.[0]).toMatchObject({ name: "Bash", result: "file.txt" });

    // Idempotent: adopting again returns the same topic, no duplicate.
    const again = await request.post(`${BASE}/api/topics/adopt-claude`, { data: { sessionId: API_SID } });
    expect(again.ok()).toBe(true);
    expect(((await again.json()) as { id: string }).id).toBe(topic.id);

    await deleteTopic(request, topic.id);
  });

  test("ADOPT-02: 'Continua qui' from the board opens the topic with its history", async ({ page, request }) => {
    await waitForCensus(request, UI_SID);

    await page.goto("/");
    await openProjectBoard(page, /e2e-adopt-ui/);

    const badge = page.getByTestId("external-sessions-badge");
    await expect(badge).toBeVisible({ timeout: 45_000 });
    await badge.click();

    const adoptBtn = page.getByTestId("adopt-external-session").first();
    await expect(adoptBtn).toBeVisible();
    await adoptBtn.click();

    // The adopted topic opens as a chat and the imported history renders.
    await expect(page.getByTestId("message-content-user").filter({ hasText: USER_MSG })).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("message-content-assistant").filter({ hasText: ASSISTANT_MSG })).toBeVisible({ timeout: 20000 });

    // Clean up the topic the UI just created (GET /api/topics returns a map).
    const list = await request.get(`${BASE}/api/topics`);
    const body = (await list.json()) as { topics: Record<string, { id: string; name: string }> };
    for (const t of Object.values(body.topics ?? {})) {
      if (/e2e-adopt-ui/.test(t.name)) await deleteTopic(request, t.id).catch(() => {});
    }
  });
});
