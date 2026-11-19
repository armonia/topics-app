/**
 * A CHILD THAT WAITS DOES NOT LOOK AT WORK, AND A HELD PROVIDER DOES NOT HIDE ITS RESULT.
 *
 * 18/11: fourteen native children had closed their turn and waited on their
 * own work, and the strip under the chat drew every one of them with a loader
 * for hours; and with the provider's plan spent, 63 results sat in memory
 * behind the hold while their parents went on working and never saw them.
 * Two fixes (commit 6b1c5e324): a child that waits is `awaiting` (a clock, no
 * loader), and a result is written as a row of the parent's chat at once, only
 * the model's turn waits for the hold to lift.
 *
 * Real pieces: the children are NATIVE (`runtime: topics`), spawned through
 * the route `spawn_agent` calls, with real turns on the native runtime; only
 * the model is fake (`helpers/fake-anthropic-api.ts`). The hold is the one the
 * chat route records on a spent plan (`/api/test/provider-hold`). The one thing
 * staged is the phase `waiting-results` of the long-running child
 * (`/api/test/subagent-phase`): reaching it for real takes a grandchild that
 * outlives the turn, and the state of the strip is what is under test here.
 *
 * Bar: while the hold is in force, the finished child's row is not `working`
 * and its result card is in the parent's chat; the waiting child's row is
 * `awaiting` with the clock and no loader. Both are on screen together, at
 * 1440 px, and that frame is the screenshot.
 *
 * @covers SUBAGENT-16
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { deleteTopic } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_DATA_DIR, E2E_HOME, daemonAuthHeaders } from "./helpers/test-server";
import { nativeRuntime, nativeTopic, openChat } from "./helpers/turn-end-sampler";
import { installFakeAnthropic, startFakeAnthropic, type FakeAnthropic } from "./helpers/fake-anthropic-api";

hermetic(test);
test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

const STAMP = Date.now();
const encode = encodeURIComponent;
const SHOT = join(homedir(), ".topics", "media", "subagents-strip-awaiting-1440.png");

const WAITING_NAME = `E2E in attesa ${STAMP}`;
const DONE_NAME = `E2E finito ${STAMP}`;
const ENDED_NAME = `E2E concluso ${STAMP}`;
const DONE_REPORT = `DONE-REPORT-${STAMP}`;

let fake: FakeAnthropic | null = null;
let undoFake: (() => void) | null = null;
let workspace = "";

test.beforeAll(async () => {
  fake = await startFakeAnthropic({
    // The turn stays open for minutes: this child is `running` when the spec moves its phase.
    kidlong: [{ text: "LONG-REPORT working", holdMs: 100_000 }],
    // A turn that ends at once and reports.
    kiddone: [{ text: DONE_REPORT }],
  });
  undoFake = installFakeAnthropic(E2E_HOME, fake.baseUrl);
  workspace = mkdtempSync(join(tmpdir(), "subagent-awaiting-"));
  expect(await nativeRuntime({ on: true, workspace })).toEqual({ ok: true, connected: true });
});

test.afterAll(async () => {
  await nativeRuntime({ on: false }).catch(() => {});
  undoFake?.();
  await fake?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

/** A native child of this chat that ended a minute ago: a row of the test server's own `subagents` table. */
function seedEndedChild(id: string, parentSessionKey: string, name: string): void {
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  execFileSync("sqlite3", [join(E2E_DATA_DIR, "topics.db"),
    `INSERT INTO subagents (id, parent_session_key, name, cwd, state, turns_reported, reported_at, created_at, ended_at, runtime)
       VALUES ('${id}', '${parentSessionKey}', '${name}', '/tmp', 'retired', 1, '${ago(20)}', '${ago(90)}', '${ago(20)}', 'topics');`]);
}

/** A native child of the chat, through the route the MCP `spawn_agent` tool calls. */
async function spawnNativeChild(request: APIRequestContext, sessionKey: string, name: string, prompt: string): Promise<string> {
  const spawned = await request.post(`${E2E_BASE}/api/sessions/${encode(sessionKey)}/agents/spawn`, {
    headers: daemonAuthHeaders(),
    data: { prompt, name, runtime: "topics" },
  });
  expect(spawned.ok(), `spawn refused: ${spawned.status()} ${await spawned.text()}`).toBe(true);
  const body = (await spawned.json()) as { agentId: string; runtime?: string };
  // The point of the spec is the NATIVE engine: a CLI child here would test another road.
  expect(body.runtime).toBe("topics");
  return body.agentId;
}

test("with the provider held, a finished child is not working and its result is a row now; a waiting child is awaiting, with a clock", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "SUBAGENT-16" });
  const topic = await nativeTopic(request, "subagent-awaiting");
  const list = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await list.json()) as { topics: Record<string, { sessionKey: string }> };
  const sessionKey = topics[topic.id]?.sessionKey ?? "";
  expect(sessionKey, "the chat has a session key").toBeTruthy();
  const agents: string[] = [];

  try {
    // The finished child's row stays long enough to share the frame with the other.
    expect((await request.post(`${E2E_BASE}/api/test/live-work-ttl`, { data: { ttlMs: 110_000 } })).ok()).toBe(true);
    await openChat(page, topic.name);

    // The provider's wall, as the chat route records it on a spent five-hour window; the notice in the
    // sidebar says it is in force (the client draws only the plan windows).
    const hold = await request.post(`${E2E_BASE}/api/test/provider-hold`, { data: { provider: "claude", untilMs: Date.now() + 3_600_000, window: "five_hour" } });
    expect(hold.ok()).toBe(true);
    const notice = page.getByTestId("provider-hold-notice");
    await expect(notice).toBeVisible({ timeout: 15_000 });

    const waitingId = await spawnNativeChild(request, sessionKey, WAITING_NAME, "SCEN:kidlong work for a long time");
    agents.push(waitingId);
    const doneId = await spawnNativeChild(request, sessionKey, DONE_NAME, "SCEN:kiddone report at once");
    agents.push(doneId);

    const strip = page.getByTestId("subagents-strip");
    const waitingRow = strip.locator(`[data-testid="subagent-row"][data-subagent-id="${waitingId}"]`);

    // 1. The child that closed its turn: its result is a row of the parent's chat NOW, while the hold
    //    is still in force: the card written ahead of the turn, not the late line that says it was
    //    shown (`data-shown`). A child whose card is in the chat is told there, once, and leaves the
    //    strip (`told` in `SubAgentsStrip`): what is checked is that no row of it says `working`.
    const resultCard = page.locator(`[data-testid="subagent-result-row"]:not([data-shown]) [data-testid="subagent-result-card"][data-agent-id="${doneId}"]`);
    await expect(resultCard).toBeVisible({ timeout: 30_000 });
    await expect(resultCard).toContainText(DONE_REPORT);
    await expect(notice, "the hold is still in force when the card shows").toBeVisible();
    await expect(strip.locator(`[data-subagent-id="${doneId}"][data-state="working"]`)).toHaveCount(0);

    // The check mark of a finished row needs a row that ended with no card in the chat (a finished
    // child with one leaves the strip, step 1): a child of this chat that ended a minute ago, written
    // as the server's own table keeps it, for the frame below.
    const endedId = `e2e-ended-${STAMP}`;
    seedEndedChild(endedId, sessionKey, ENDED_NAME);
    const endedRow = strip.locator(`[data-testid="subagent-row"][data-subagent-id="${endedId}"]`);

    // 2. The long-running child closes its turn and waits on its own work: `awaiting`.
    await expect(waitingRow).toHaveAttribute("data-state", "working", { timeout: 30_000 });
    const staged = await request.post(`${E2E_BASE}/api/test/subagent-phase`, { data: { id: waitingId, phase: "waiting-results" } });
    expect(staged.ok(), await staged.text()).toBe(true);
    await expect(waitingRow).toHaveAttribute("data-state", "awaiting", { timeout: 15_000 });
    // The clock, no loader: nothing of its own runs.
    await expect(waitingRow.locator("svg.lucide-clock")).toHaveCount(1);
    // The loader is a canvas (`SparkLoader`): the row of a child at work has one, this has none.
    await expect(waitingRow.locator("canvas")).toHaveCount(0);
    // The ended row keeps its mark, and both rows are on screen together.
    await expect(strip.getByTestId("subagent-row")).toHaveCount(2);
    await expect(endedRow).toHaveAttribute("data-state", "ended");
    await expect(endedRow.locator("svg").first()).toBeVisible();
    await expect(notice).toBeVisible();

    // The frame: chat and strip at 1440, the awaiting row, the ended row and the finished child's result card.
    mkdirSync(join(homedir(), ".topics", "media"), { recursive: true });
    await page.screenshot({ path: SHOT });
  } finally {
    // Cleanup: the child that still holds a turn, the hold, the stay of the ended rows, the chat.
    for (const id of agents) {
      await request.post(`${E2E_BASE}/api/sessions/${encode(sessionKey)}/agents/${id}/stop`, { headers: daemonAuthHeaders() }).catch(() => {});
    }
    await request.post(`${E2E_BASE}/api/test/provider-hold`, { data: { provider: "claude", clear: true } }).catch(() => {});
    await request.post(`${E2E_BASE}/api/test/live-work-ttl`, { data: {} }).catch(() => {});
    await deleteTopic(request, topic.id).catch(() => {});
  }
});
