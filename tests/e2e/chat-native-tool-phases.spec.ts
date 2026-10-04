/**
 * What a native-runtime tool row says while the call is NOT running yet.
 *
 * The native runtime announces a call when the model starts writing it and
 * runs the calls of one round one after the other (`agent-loop.ts`). The row
 * used to be "running", spinner and stopwatch, from the announcement on: a call
 * queued behind a long shell looked stuck on a command that had not started
 * (diagnosis of 04/10: 288 native calls queued over 1 s in three days, the
 * worst 1,135.6 s for 0.3 s of real work). And while the model wrote a long
 * command, the shell row stayed `$ ` with nothing after it until the last byte
 * of the input arrived (up to 37 s measured live).
 *
 * The turns here are REAL server turns on the native runtime with a real shell;
 * only the model is fake (`helpers/fake-anthropic-api.ts`).
 *
 * @covers CHAT-NTOOL-05
 * @covers CHAT-NTOOL-06
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { hermetic } from "./fixtures/hermetic";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE, E2E_HOME } from "./helpers/test-server";
import { installFakeAnthropic, startFakeAnthropic, type FakeAnthropic, type FakeRound } from "./helpers/fake-anthropic-api";

const HEREDOC = `cat > /dev/null <<'EOF'\n${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\nEOF\necho written`;

const SCRIPTS: Record<string, FakeRound[]> = {
  // Two calls in ONE round: the second waits for the first.
  pair: [{ tools: [
    { name: "bash", input: { command: "sleep 5; echo first" } },
    { name: "bash", input: { command: "echo second" } },
  ] }],
  // The model takes 10 s to write one long command.
  slowargs: [{ tools: [{ name: "bash", argStreamMs: 10_000, input: { command: HEREDOC } }] }],
};

let fake: FakeAnthropic | null = null;
let undoFake: (() => void) | null = null;
let workspace = "";

/** Registers or removes the native runtime on the running bench (`/api/test/native-runtime`). */
async function nativeRuntime(body: { on: boolean; workspace?: string }): Promise<unknown> {
  const res = await fetch(`${E2E_BASE}/api/test/native-runtime`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function nativeTopic(request: APIRequestContext, name: string) {
  const topic = await createTopic(request, `${name}-${Date.now()}`);
  await patchTopic(request, topic.id, { provider: "topics" });
  const sessionKey = (await (await request.get(`${E2E_BASE}/api/topics/${topic.id}`)).json()).topic.sessionKey as string;
  await resetPaneStore(request, [topic.id]);
  return { topic, sessionKey };
}

async function openChat(page: Page, messageInput: Locator, name: string) {
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(name));
  await messageInput.waitFor({ state: "visible", timeout: 15_000 });
}

type StoredCall = { id: string; status?: string; startedAt?: number; endedAt?: number };

async function storedCalls(request: APIRequestContext, sessionKey: string): Promise<StoredCall[]> {
  const body = await (await request.get(`${E2E_BASE}/api/history/${encodeURIComponent(sessionKey)}`)).json() as {
    messages: Array<{ role: string; toolCalls?: StoredCall[]; blocks?: Array<{ kind: string; toolCall?: StoredCall }> }>;
  };
  // The wire carries the timeline (`blocks`) and drops the legacy bucket beside it.
  return body.messages.filter((m) => m.role === "assistant").flatMap((m) =>
    m.blocks?.length ? m.blocks.flatMap((b) => (b.kind === "tool" && b.toolCall ? [b.toolCall] : [])) : (m.toolCalls ?? []));
}

hermetic(test);

test.describe("native runtime: a call that has not started is not shown running", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async () => {
    fake = await startFakeAnthropic(SCRIPTS);
    undoFake = installFakeAnthropic(E2E_HOME, fake.baseUrl);
    workspace = mkdtempSync(join(tmpdir(), "ntool-phases-"));
    expect(await nativeRuntime({ on: true, workspace })).toEqual({ ok: true, connected: true });
  });
  test.afterAll(async () => {
    await nativeRuntime({ on: false }).catch(() => {});
    undoFake?.();
    await fake?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  test("the second call of a round says it is queued until the first one ends", async ({ page, request, chatPage, context }) => {
    const { topic, sessionKey } = await nativeTopic(request, "ntool-pair");
    // Read in a second window, which gets the turn over the WebSocket. The
    // sender's own SSE carries the same fields, but in this WebKit the fetch
    // stream sometimes holds a burst back until the next byte, five seconds
    // later here (measured on 2026-10-04: 387 B delivered, 1,066 B held, while
    // a plain Bun client got the 1,453 B burst in one read every time).
    const viewer = await context.newPage();
    await openChat(viewer, viewer.getByRole("textbox", { name: /Campo del messaggio|Message input for/ }), topic.name);
    await openChat(page, chatPage.messageInput, topic.name);
    await chatPage.sendMessage("SCEN:pair go");

    const rows = viewer.locator('[data-testid^="tool-call-row-"]');
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    const first = rows.nth(0);
    const second = rows.nth(1);
    await expect(first).toHaveAttribute("data-status", "running", { timeout: 10_000 });

    // While the first shell sleeps, the second one is queued: no spinner, no stopwatch.
    await expect(second).toHaveAttribute("data-status", "pending");
    await expect(second.getByTestId("tool-queued")).toHaveAttribute("data-phase", "queued");
    await expect(second.getByTestId("tool-elapsed")).toHaveCount(0);
    await expect(first.getByTestId("tool-elapsed")).toBeVisible();
    // Three seconds into the first shell's sleep, nothing has changed for the second.
    await expect(first.getByTestId("tool-elapsed")).toHaveText(/^[34]\.\ds$/, { timeout: 5_000 });
    await expect(first).toHaveAttribute("data-status", "running");
    await expect(second).toHaveAttribute("data-status", "pending");
    await expect(second.getByTestId("tool-elapsed")).toHaveCount(0);

    // The turn ends (its rows fold behind the answer), and the stored record
    // says the second call started only once the first had ended: its stored
    // duration is its own run, not its wait.
    await expect(viewer.getByText("FINE-pair").first()).toBeVisible({ timeout: 30_000 });
    const calls = await storedCalls(request, sessionKey);
    expect(calls).toHaveLength(2);
    const [a, b] = calls as [StoredCall, StoredCall];
    expect([a.status, b.status]).toEqual(["success", "success"]);
    expect(typeof a.endedAt).toBe("number");
    expect(typeof b.startedAt).toBe("number");
    expect(b.startedAt!).toBeGreaterThanOrEqual(a.endedAt!);
    expect(b.endedAt! - b.startedAt!).toBeLessThan(3_000);
    await deleteTopic(request, topic.id).catch(() => {});
  });

  test("a long command shows on its row while the model is still writing it", async ({ page, request, chatPage }) => {
    const { topic } = await nativeTopic(request, "ntool-slowargs");
    await openChat(page, chatPage.messageInput, topic.name);
    await chatPage.sendMessage("SCEN:slowargs go");

    const row = page.locator('[data-testid^="tool-call-row-"]').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    // The input takes 10 s to arrive; the command has to be on the row well before.
    await expect(row).toContainText("cat > /dev/null", { timeout: 4_000 });
    await expect(row).toHaveAttribute("data-status", "pending");
    await expect(row.getByTestId("tool-queued")).toHaveAttribute("data-phase", "writing");
    const inputDone = [...fake!.inputDoneAt.keys()].filter((k) => k.startsWith("slowargs:"));
    expect(inputDone, "the input was still streaming when the command showed").toEqual([]);

    await expect(page.getByText("FINE-slowargs").first()).toBeVisible({ timeout: 30_000 });
    await deleteTopic(request, topic.id).catch(() => {});
  });
});
