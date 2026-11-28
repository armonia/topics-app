import { expect, test, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, resetPaneStore, unarchiveTopic } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

/**
 * A JSON TOOL RESULT READS AS A LAID-OUT VIEW, AND THE ORIGINAL IS ONE CLICK AWAY.
 *
 * (a) The Readable / Original switch leaves the original text byte-identical.
 * (b) A shape the pure matcher does not know asks the model fallback, whose
 *     answer is a NDJSON stream: the view appears while the stream is still
 *     open (before the `done` line), and the original is on screen until then.
 *     The stream is held open by the test, so the order is measured, not hoped.
 *
 * @covers READABLE-VIEW-03
 * @covers READABLE-VIEW-04
 */

const FLAT_RESULT = JSON.stringify({ title: "Fix the login", status: "in_progress", labels: ["auth", "bug"], updatedAt: "2026-11-20T11:48:00Z" });
const NESTED_RESULT = JSON.stringify({ data: { items: [{ name: "alpha", qty: 3 }, { name: "beta", qty: 5 }] }, total: 2 });

async function sessionKeyOf(request: import("@playwright/test").APIRequestContext, topicId: string): Promise<string> {
  const res = await request.get(`${E2E_BASE}/api/topics`);
  const topics = ((await res.json()) as { topics: Record<string, { id: string; sessionKey: string }> }).topics;
  return Object.values(topics).find((x) => x.id === topicId)!.sessionKey;
}

async function seedToolChat(request: import("@playwright/test").APIRequestContext, name: string, tool: string, result: string): Promise<{ topicId: string; callId: string }> {
  const t = await createTopic(request, `${name} ${Date.now().toString(36)}`);
  const sessionKey = await sessionKeyOf(request, t.id);
  const callId = `rv-${Date.now().toString(36)}`;
  await seedMessage(request, { sessionKey, role: "user", content: "Show me the result" });
  const now = Date.now();
  await seedMessage(request, {
    sessionKey, role: "assistant", content: "",
    toolCalls: [{ id: callId, name: tool, args: { id: "42" }, status: "success", result, startedAt: now - 2000, endedAt: now - 1000 }],
  });
  await unarchiveTopic(request, t.id);
  return { topicId: t.id, callId };
}

async function openChat(page: Page, request: import("@playwright/test").APIRequestContext, topicId: string, callId: string) {
  await resetPaneStore(request, [topicId]);
  await page.goto("/manifest.json", { waitUntil: "commit" }).catch(() => {});
  await page.evaluate((id) => {
    localStorage.removeItem("topics.readableView");
    localStorage.setItem("pane-store-focused-id", id);
  }, topicId);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await page.locator(`[data-testid="tool-call-row-${callId}"] > button`).click();
}

test("the Readable / Original switch leaves the original text identical", async ({ page, request }, testInfo) => {
  const { topicId, callId } = await seedToolChat(request, "Readable switch", "mcp__acme__get_item", FLAT_RESULT);
  await openChat(page, request, topicId, callId);
  const result = page.getByTestId("readable-result");
  await expect(result.getByTestId("readable-card")).toBeVisible();

  await result.getByTestId("readable-mode-original").click();
  const original = result.getByTestId("tool-call-result");
  await expect(original).toBeVisible();
  const before = await original.innerText();

  await result.getByTestId("readable-mode-readable").click();
  await expect(result.getByTestId("readable-card")).toBeVisible();
  await expect(result.getByTestId("tool-call-result")).toHaveCount(0);

  await result.getByTestId("readable-mode-original").click();
  expect(await original.innerText()).toBe(before);
  expect(before).toContain("Fix the login");

  // The choice is remembered across a reload.
  await page.reload();
  await goToApp(page);
  await page.locator(`[data-testid="tool-call-row-${callId}"] > button`).click();
  await expect(page.getByTestId("readable-result").getByTestId("readable-mode-original")).toHaveAttribute("aria-pressed", "true");

  for (const width of [375, 768, 1440, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByTestId("readable-result").getByTestId("readable-mode-readable").click();
    await expect(page.getByTestId("readable-card")).toBeVisible();
    await testInfo.attach(`readable-${width}`, { body: await page.screenshot(), contentType: "image/png" });
  }
});

test("a never-seen shape shows its view while the model's stream is still open", async ({ page, request }) => {
  // The fetch to the fallback route is replaced by a stream the test holds open.
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    (window as unknown as Record<string, unknown>).__rvPush = (line: unknown) => controller?.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
    (window as unknown as Record<string, unknown>).__rvClose = () => controller?.close();
    window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (!url.includes("/api/readable-view") || url.includes("/settings")) return realFetch(input, init);
      const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
      return Promise.resolve(new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }));
    }, { preconnect: realFetch.preconnect });
  });
  const { topicId, callId } = await seedToolChat(request, "Readable stream", "mcp__acme__fetch_order", NESTED_RESULT);
  await openChat(page, request, topicId, callId);

  // No answer yet: the original is what the reader has, and it is the whole text.
  await expect(page.getByTestId("tool-call-result")).toContainText("alpha");
  await expect(page.getByTestId("readable-result")).toHaveCount(0);

  // First part of the stream: the view is drawn, the stream is not finished.
  await page.evaluate(() => (window as unknown as { __rvPush: (l: unknown) => void }).__rvPush({
    view: { kind: "table", columns: ["Name", "Qty"], rows: [[{ text: "alpha" }, { text: "3" }]] },
  }));
  const view = page.getByTestId("readable-result");
  await expect(view.getByText("alpha").first()).toBeVisible();
  await expect(view.getByText("beta")).toHaveCount(0);

  // The rest arrives, then the end.
  await page.evaluate(() => {
    const w = window as unknown as { __rvPush: (l: unknown) => void; __rvClose: () => void };
    w.__rvPush({ view: { kind: "table", columns: ["Name", "Qty"], rows: [[{ text: "alpha" }, { text: "3" }], [{ text: "beta" }, { text: "5" }]] } });
    w.__rvPush({ done: true });
    w.__rvClose();
  });
  await expect(view.getByText("beta").first()).toBeVisible();
});
