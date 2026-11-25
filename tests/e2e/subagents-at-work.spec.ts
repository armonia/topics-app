/**
 * AN AGENT AT WORK IS AT WORK ON EVERY SURFACE, WITH HOW MANY (23/11).
 *
 * Seen live: a sub-agent whose turn had closed while three children of its
 * own worked showed "waiting", a clock, in its parent's strip, while its own
 * tab played the slow wait movement and its parent's row said it waited on a
 * sub-agent. Nothing said that four agents were working under that chat.
 * The rule now: work running is work (ATTN-02), the same loader as a turn,
 * and the number of agents at work at any depth (`agentsAtWorkUnder`) is on
 * the parent's tab, its sidebar row and the strip row of the child that waits.
 * The clock stays for a child with nothing running under it (SUBAGENT-16).
 *
 * Real pieces: native children spawned through the route `spawn_agent` calls,
 * a grandchild spawned by the child's own session, real turns on the native
 * runtime with a fake model (`helpers/fake-anthropic-api.ts`) that holds them
 * open. Staged: the child's phase `waiting-results` (`/api/test/subagent-phase`),
 * as in `subagent-awaiting-hold.spec.ts`.
 *
 * @covers SUBAGENT-30
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { deleteTopic } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME, daemonAuthHeaders } from "./helpers/test-server";
import { nativeRuntime, nativeTopic, openChat } from "./helpers/turn-end-sampler";
import { installFakeAnthropic, startFakeAnthropic, type FakeAnthropic } from "./helpers/fake-anthropic-api";

hermetic(test);
test.use({ viewport: { width: 1440, height: 900 }, video: "on" });
test.describe.configure({ timeout: 150_000 });

const STAMP = Date.now();
const encode = encodeURIComponent;
const CHILD_NAME = `E2E figlio ${STAMP}`;
const GRANDCHILD_NAME = `E2E nipote ${STAMP}`;

let fake: FakeAnthropic | null = null;
let undoFake: (() => void) | null = null;
let workspace = "";

test.beforeAll(async () => {
  // Both turns stay open well past the test: they are `working` until stopped.
  fake = await startFakeAnthropic({ kidlong: [{ text: "LONG-REPORT working", holdMs: 140_000 }] });
  undoFake = installFakeAnthropic(E2E_HOME, fake.baseUrl);
  workspace = mkdtempSync(join(tmpdir(), "subagents-at-work-"));
  expect(await nativeRuntime({ on: true, workspace })).toEqual({ ok: true, connected: true });
});

test.afterAll(async () => {
  await nativeRuntime({ on: false }).catch(() => {});
  undoFake?.();
  await fake?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/** A native child of `sessionKey`, through the route the MCP `spawn_agent` tool calls. */
async function spawnNative(request: APIRequestContext, sessionKey: string, name: string): Promise<string> {
  const spawned = await request.post(`${E2E_BASE}/api/sessions/${encode(sessionKey)}/agents/spawn`, {
    headers: daemonAuthHeaders(),
    data: { prompt: "SCEN:kidlong work for a long time", name, runtime: "topics" },
  });
  expect(spawned.ok(), `spawn refused: ${spawned.status()} ${await spawned.text()}`).toBe(true);
  const body = (await spawned.json()) as { agentId: string; runtime?: string };
  expect(body.runtime).toBe("topics");
  return body.agentId;
}

/** The session key of a live child, as `GET /api/live-work` lists it. */
async function sessionKeyOfChild(request: APIRequestContext, id: string): Promise<string> {
  let key = "";
  await expect.poll(async () => {
    const res = await request.get(`${E2E_BASE}/api/live-work`);
    const { agents } = (await res.json()) as { agents: { id: string; sessionKey?: string }[] };
    key = agents.find((a) => a.id === id)?.sessionKey ?? "";
    return key;
  }, { timeout: 30_000 }).not.toBe("");
  return key;
}

test("a child waiting on a grandchild at work is drawn at work, and the parent's tab, row and header say how many", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "SUBAGENT-30" });
  const topic = await nativeTopic(request, "subagents-at-work");
  const list = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await list.json()) as { topics: Record<string, { sessionKey: string }> };
  const sessionKey = topics[topic.id]?.sessionKey ?? "";
  expect(sessionKey, "the chat has a session key").toBeTruthy();
  const stops: Array<[string, string]> = [];

  try {
    await openChat(page, topic.name);
    const tab = page.locator('[role="tab"][data-pane-id]', { hasText: topic.name });
    const row = page.getByRole("treeitem", { name: new RegExp(topic.name) }).first();
    const strip = page.getByTestId("subagents-strip");

    // 1. A child, then a grandchild spawned by the child: two agents at work under the chat.
    const childId = await spawnNative(request, sessionKey, CHILD_NAME);
    stops.push([sessionKey, childId]);
    const childKey = await sessionKeyOfChild(request, childId);
    const grandchildId = await spawnNative(request, childKey, GRANDCHILD_NAME);
    stops.push([childKey, grandchildId]);
    const childRow = strip.locator(`[data-testid="subagent-row"][data-subagent-id="${childId}"]`);
    await expect(childRow).toHaveAttribute("data-state", "working", { timeout: 30_000 });
    await expect(tab.getByTestId("pane-tab-agents"), "the tab does not say two agents work").toHaveAttribute("data-agents", "2", { timeout: 30_000 });

    // 2. The child closes its turn and waits on its grandchild: still at work, with 1 under it.
    const staged = await request.post(`${E2E_BASE}/api/test/subagent-phase`, { data: { id: childId, phase: "waiting-results" } });
    expect(staged.ok(), await staged.text()).toBe(true);
    await expect(childRow, "a child whose grandchild works reads as waiting").toHaveAttribute("data-state", "working", { timeout: 15_000 });
    await expect(childRow).toHaveAttribute("data-agents", "1");
    await expect(childRow.locator("canvas"), "no loader on a child at work through its grandchild").toHaveCount(1);
    await expect(childRow.locator("svg.lucide-clock")).toHaveCount(0);
    await expect(childRow.getByTestId("live-work-preview")).toHaveText(/1 (sottoagente al lavoro|sub-agent at work)/);
    await expect(tab.getByTestId("pane-tab-agents")).toHaveAttribute("data-agents", "1", { timeout: 15_000 });
    await expect(tab.getByTestId("pane-tab-agents")).toHaveText("1");
    // The sidebar row of the parent: the loader, not the wait movement, and the number in words.
    await expect(row.getByTestId("topic-waiting-on")).toHaveAttribute("data-agents", "1", { timeout: 15_000 });
    await expect(row.getByTestId("topic-waiting-on")).toHaveText(/1 (sottoagente al lavoro|sub-agent at work)/);
    // The parent's row IS the accordion (25/11): its chevron, no header row under it.
    const toggle = row.getByTestId("subagents-accordion");
    await expect(toggle).toHaveAttribute("data-agents", "1");
    await expect(page.getByTestId("subagents-accordion")).toHaveCount(1);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("treeitem", { name: new RegExp(CHILD_NAME) }).first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: test.info().outputPath("at-work-1440.png") });

    // 3. The grandchild stops: nothing runs under the child any more, the clock is back, the number leaves.
    await request.post(`${E2E_BASE}/api/sessions/${encode(childKey)}/agents/${grandchildId}/stop`, { headers: daemonAuthHeaders() });
    await expect(childRow, "a child with nothing running under it still draws a loader").toHaveAttribute("data-state", "awaiting", { timeout: 30_000 });
    await expect(childRow.locator("canvas")).toHaveCount(0);
    await expect(childRow.locator("svg.lucide-clock")).toHaveCount(1);
    await expect(tab.getByTestId("pane-tab-agents")).toHaveCount(0, { timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath("nothing-under-1440.png") });
  } finally {
    for (const [key, id] of stops.reverse()) {
      await request.post(`${E2E_BASE}/api/sessions/${encode(key)}/agents/${id}/stop`, { headers: daemonAuthHeaders() }).catch(() => {});
    }
    await deleteTopic(request, topic.id).catch(() => {});
  }
});
