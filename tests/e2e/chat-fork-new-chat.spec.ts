import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic, openTopicByClick } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";

/**
 * «Fork into a new chat» and `/fork`, in the real UI against the isolated
 * server (CHAT-FORK-03, CHAT-FORK-04, CHAT-FORK-05).
 *
 * The histories are seeded, and the bench's `claude` stub does not read its
 * argv: what is proven here is the CHAT (a new topic with the same history,
 * opened with the focus, the original untouched, the text as the branch's
 * first message, the «Forked from» line). The argv of the fork is proven by
 * `server/providers/claude/args.test.ts` and `claude-code-fork-spawn.test.ts`.
 */

// Hermetic: this file starts from the globalSetup baseline. See fixtures/hermetic.ts.
hermetic(test);

type Msg = { id: string; role: string; content: string };
type TopicRow = { id: string; name: string; sessionKey: string; forkedFrom?: { topicId: string | null; name: string; atMessageId: string } };

const skOf = (id: string) => `topic:${id.slice(0, 8)}`;
const TOKEN = process.env.GATEWAY_TOKEN ?? "test-token";

/** A real turn from outside the page (POST /api/chat), and the text its stream carried so far. */
function startTurn(sessionKey: string, content: string): { said: () => string; done: Promise<void> } {
  let sse = "";
  const done = (async () => {
    const res = await fetch(`${E2E_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gateway-Token": TOKEN },
      body: JSON.stringify({ sessionKey, messages: [{ role: "user", content }] }),
    });
    if (!res.ok || !res.body) throw new Error(`POST /api/chat answered ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      sse += decoder.decode(value);
    }
  })();
  done.catch(() => {});
  return { said: () => sse, done };
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `n` finished turns, a minute ago, chained by the seed endpoint. Returns the row ids in order. */
async function seedTurns(request: APIRequestContext, sessionKey: string, n: number): Promise<string[]> {
  const base = Date.now() - 60_000;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await seedMessage(request, { sessionKey, role: "user", content: `domanda ${i + 1}`, timestamp: new Date(base + i * 10_000).toISOString() })).id);
    ids.push((await seedMessage(request, { sessionKey, role: "assistant", content: `risposta ${i + 1}`, timestamp: new Date(base + i * 10_000 + 5_000).toISOString() })).id);
  }
  return ids;
}

async function history(request: APIRequestContext, sessionKey: string): Promise<Msg[]> {
  const res = await request.get(`${E2E_BASE}/api/history/${encodeURIComponent(sessionKey)}`);
  return ((await res.json()) as { messages: Msg[] }).messages;
}

async function branchesOf(request: APIRequestContext, topicId: string): Promise<TopicRow[]> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, TopicRow> };
  return Object.values(body.topics).filter((t) => t.forkedFrom?.topicId === topicId);
}

async function oneBranch(request: APIRequestContext, topicId: string): Promise<TopicRow> {
  await expect.poll(async () => (await branchesOf(request, topicId)).length, { message: "a branch is born", timeout: 10_000 }).toBe(1);
  return (await branchesOf(request, topicId))[0];
}

async function cleanup(request: APIRequestContext, topicId: string): Promise<void> {
  for (const b of await branchesOf(request, topicId)) await deleteTopic(request, b.id);
  await deleteTopic(request, topicId);
}

async function openChat(page: Page, request: APIRequestContext, topic: { id: string; name: string }): Promise<void> {
  await resetPaneStore(request, [topic.id]);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(escape(topic.name)));
}

const row = (page: Page, id: string) => page.locator(`[data-testid="chat-message"][data-message-id="${id}"]`);

/** Types a slash command and sends it: Escape first, or Enter picks the highlighted menu entry. */
async function sendCommand(page: Page, text: string): Promise<void> {
  const input = page.getByRole("textbox", { name: /Campo del messaggio|Message input for/ }).first();
  await input.click();
  await input.fill(text);
  await input.press("Escape");
  await input.press("Enter");
}

test.describe("Fork into a new chat", () => {
  test("the item sits on the last finished answer only, never on a prompt", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FORK-04" });
    const topic = await createTopic(request, `Fork item ${Date.now()}`);
    try {
      const ids = await seedTurns(request, skOf(topic.id), 2);
      await openChat(page, request, topic);
      await expect(row(page, ids[3])).toBeVisible({ timeout: 15_000 });
      await row(page, ids[1]).hover();
      await expect(row(page, ids[1]).getByTestId("msg-action-fork")).toHaveCount(0);
      await row(page, ids[3]).hover();
      await expect(row(page, ids[3]).getByTestId("msg-action-fork")).toBeVisible();
      await expect(page.locator('[data-testid="chat-message"][data-role="user"] [data-testid="msg-action-fork"]')).toHaveCount(0);
    } finally {
      await cleanup(request, topic.id);
    }
  });

  test("a chat ending on a background notice: the item is on the answer, and the branch has no notice", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FORK-04" });
    const topic = await createTopic(request, `Fork notice ${Date.now()}`);
    const sk = skOf(topic.id);
    try {
      const ids = await seedTurns(request, sk, 2);
      await seedMessage(request, {
        sessionKey: sk, role: "assistant", content: "",
        blocks: [{ kind: "background-notice", event: "deferred", change: "model", text: "Model change waits for the background work." }],
      });
      await openChat(page, request, topic);
      await expect(row(page, ids[3])).toBeVisible({ timeout: 15_000 });
      await row(page, ids[3]).hover();
      await row(page, ids[3]).getByTestId("msg-action-fork").click();
      const branch = await oneBranch(request, topic.id);
      const copied = await history(request, branch.sessionKey);
      expect(copied.map((m) => m.content)).toEqual(["domanda 1", "risposta 1", "domanda 2", "risposta 2"]);
      await expect(row(page, copied[3].id)).toBeVisible({ timeout: 15_000 });
    } finally {
      await cleanup(request, topic.id);
    }
  });

  test("forking from the item opens a new chat with the same history, focused, and the original keeps its messages", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FORK-04" });
    const topic = await createTopic(request, `Fork dalla voce ${Date.now()}`);
    const sk = skOf(topic.id);
    try {
      const ids = await seedTurns(request, sk, 2);
      await openChat(page, request, topic);
      await expect(row(page, ids[3])).toBeVisible({ timeout: 15_000 });
      await row(page, ids[3]).hover();
      await row(page, ids[3]).getByTestId("msg-action-fork").click();

      const branch = await oneBranch(request, topic.id);
      expect(branch.name).toBe(`${topic.name} (ramo)`);
      const item = page.getByRole("treeitem", { name: new RegExp(escape(branch.name)) });
      await expect(item).toBeVisible({ timeout: 10_000 });
      await expect(item).toHaveAttribute("aria-selected", "true");
      const copied = await history(request, branch.sessionKey);
      expect(copied.map((m) => [m.role, m.content])).toEqual((await history(request, sk)).map((m) => [m.role, m.content]));
      for (const m of copied) await expect(row(page, m.id)).toBeVisible();
      expect(await history(request, sk)).toHaveLength(4);
    } finally {
      await cleanup(request, topic.id);
    }
  });

  test("`/fork <text>` opens the branch and sends the text as its first message, not in the original", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FORK-04" });
    const topic = await createTopic(request, `Fork comando ${Date.now()}`);
    const sk = skOf(topic.id);
    try {
      const ids = await seedTurns(request, sk, 1);
      await openChat(page, request, topic);
      await expect(row(page, ids[1])).toBeVisible({ timeout: 15_000 });
      await sendCommand(page, "/fork prova un'altra strada");

      const branch = await oneBranch(request, topic.id);
      await expect(page.getByRole("treeitem", { name: new RegExp(escape(branch.name)) })).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
      await expect.poll(async () => (await history(request, branch.sessionKey))[2]?.content, { timeout: 15_000 }).toBe("prova un'altra strada");
      await expect(page.getByText("prova un'altra strada").first()).toBeVisible();
      expect((await history(request, sk)).map((m) => m.content)).not.toContain("prova un'altra strada");
    } finally {
      await cleanup(request, topic.id);
    }
  });

  test("the branch opens as a permanent tab: the next single click neither replaces it nor closes it, and the original stays", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FORK-04" });
    const topic = await createTopic(request, `Fork tab ${Date.now()}`);
    const other = await createTopic(request, `Fork altra ${Date.now()}`);
    try {
      const ids = await seedTurns(request, skOf(topic.id), 1);
      // No tab open, then ONE click: the original is this window's preview tab,
      // the one a single open replaces.
      await resetPaneStore(request, []);
      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopicByClick(page, new RegExp(escape(topic.name)));
      await expect(row(page, ids[1])).toBeVisible({ timeout: 15_000 });
      await row(page, ids[1]).hover();
      await row(page, ids[1]).getByTestId("msg-action-fork").click();

      const branch = await oneBranch(request, topic.id);
      const branchTab = page.getByTestId(`pane-tab-${branch.id}`);
      await expect(branchTab).toBeVisible({ timeout: 10_000 });
      await expect(branchTab.getByTestId("pane-tab-label")).not.toHaveClass(/\bitalic\b/);
      await expect(page.getByTestId(`pane-tab-${topic.id}`)).toBeVisible();

      await openTopicByClick(page, new RegExp(escape(other.name)));
      await expect(page.getByTestId(`pane-tab-${other.id}`)).toBeVisible({ timeout: 10_000 });
      await expect(branchTab).toBeVisible();
      // Closing a chat archives it (two states): the branch is still a live chat.
      expect((await branchesOf(request, topic.id)).map((b) => b.id)).toEqual([branch.id]);
    } finally {
      await deleteTopic(request, other.id);
      await cleanup(request, topic.id);
    }
  });

  test("`/fork` during a turn says to wait, and creates and opens nothing", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FORK-04" });
    test.setTimeout(90_000);
    // A turn that really runs: a fake CLI whose answer takes seconds. A seeded
    // `partial` row is not a turn: the stale-stream sweeper closes it, since no
    // process answers for it.
    const uninstall = installSlowTurnCli();
    const topic = await createTopic(request, `Fork in corso ${Date.now()}`, { provider: "claude-code" });
    const sk = skOf(topic.id);
    let turn: ReturnType<typeof startTurn> | null = null;
    try {
      await seedTurns(request, sk, 1);
      await openChat(page, request, topic);
      turn = startTurn(sk, "SLOW:12:forkwait");
      await expect.poll(() => turn!.said().includes("forkwait-02"), { timeout: 30_000, message: "the turn is under way" }).toBe(true);
      // No Escape here: with a turn streaming, Escape STOPS it (useKeyboardShortcuts).
      // Enter picks `/fork` from the menu, the second Enter sends it.
      const input = page.getByRole("textbox", { name: /Campo del messaggio|Message input for/ }).first();
      await input.click();
      await input.fill("/fork");
      await input.press("Enter");
      await expect(input).toHaveValue("/fork ");
      await input.press("Enter");
      await expect(page.getByText("Aspetta la fine del turno")).toBeVisible({ timeout: 10_000 });
      expect(turn.said()).not.toContain("forkwait-12");
      expect(await branchesOf(request, topic.id)).toEqual([]);
      await expect(page.getByRole("treeitem", { name: /\(ramo\)/ })).toHaveCount(0);
    } finally {
      await turn?.done.catch(() => {});
      uninstall();
      await cleanup(request, topic.id);
    }
  });

  test("a runtime with no way to carry the memory: the route refuses and the item is not there", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FORK-03" });
    const topic = await createTopic(request, `Fork openclaw ${Date.now()}`, { provider: "openclaw" });
    try {
      const ids = await seedTurns(request, skOf(topic.id), 1);
      const res = await request.post(`${E2E_BASE}/api/topics/${topic.id}/fork`, { data: {} });
      expect(res.status()).toBe(409);
      expect(await res.json()).toMatchObject({ code: "fork_unsupported" });
      await openChat(page, request, topic);
      await expect(row(page, ids[1])).toBeVisible({ timeout: 15_000 });
      await row(page, ids[1]).hover();
      await expect(row(page, ids[1]).getByTestId("msg-action-regenerate")).toBeVisible();
      await expect(row(page, ids[1]).getByTestId("msg-action-fork")).toHaveCount(0);
    } finally {
      await cleanup(request, topic.id);
    }
  });
});

test.describe("The branch says where it comes from", () => {
  async function forkedWithOwnTurn(request: APIRequestContext) {
    const origin = await createTopic(request, `Refactor login ${Date.now()}`);
    await seedTurns(request, skOf(origin.id), 2);
    const res = await request.post(`${E2E_BASE}/api/topics/${origin.id}/fork`, { data: { name: `${origin.name} (ramo)` } });
    expect(res.status()).toBe(201);
    const branch = (await res.json()) as TopicRow;
    await seedMessage(request, { sessionKey: branch.sessionKey, role: "user", content: "terza domanda, nel ramo" });
    await seedMessage(request, { sessionKey: branch.sessionKey, role: "assistant", content: "terza risposta, nel ramo" });
    return { origin, branch };
  }

  test("the divider sits between the copied history and the branch's own turns, and opens the original", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FORK-05" });
    const { origin, branch } = await forkedWithOwnTurn(request);
    try {
      const rows = await history(request, branch.sessionKey);
      await openChat(page, request, branch);
      const divider = page.getByTestId("fork-origin-divider");
      await expect(divider).toBeVisible({ timeout: 15_000 });
      await expect(divider).toContainText("Diramata da");
      await expect(page.getByTestId("fork-origin-open")).toHaveText(origin.name);
      const y = async (l: ReturnType<Page["locator"]>) => (await l.boundingBox())!.y;
      expect(await y(divider)).toBeGreaterThan(await y(row(page, rows[3].id)));
      expect(await y(divider)).toBeLessThan(await y(row(page, rows[4].id)));

      await page.getByTestId("fork-origin-open").click();
      await expect(page.getByRole("treeitem", { name: new RegExp(`^${escape(origin.name)}(?! \\(ramo\\))`) })).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
    } finally {
      await cleanup(request, origin.id);
    }
  });

  test("the divider is not conversation: neither the export nor the history carry it", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-FORK-05" });
    const { origin, branch } = await forkedWithOwnTurn(request);
    try {
      const rows = await history(request, branch.sessionKey);
      expect(rows).toHaveLength(6);
      expect(rows.some((m) => m.content.includes("Diramata da"))).toBe(false);
      await openChat(page, request, branch);
      await expect(page.getByTestId("fork-origin-divider")).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: "Strumenti e comandi" }).click();
      const download = page.waitForEvent("download", { timeout: 10_000 });
      await page.getByTestId("chat-export-conversation").click();
      const stream = await (await download).createReadStream();
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf-8");
      expect(text).toContain("terza risposta, nel ramo");
      expect(text).not.toContain("Diramata da");
    } finally {
      await cleanup(request, origin.id);
    }
  });
});
