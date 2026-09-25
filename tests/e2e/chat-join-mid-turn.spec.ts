/**
 * A CHAT JOINED IN THE MIDDLE OF ITS TURN SHOWS THE TURN FROM THE START, WITH NO
 * HOLE (card 423e016f).
 *
 * A window that starts showing a turn already in flight gets it in two pieces:
 * what happened before, read from the server, and the per-token frames from
 * then on. The first piece came from the database row, and the row's `blocks`
 * (the timeline the bubble draws) go through a write throttle that can be up
 * to 15 s behind: the history route and the `stream:catchup` of a reconnect
 * handed over a timeline without its last chunks, the frames appended after
 * it, and the bubble showed a gap for the rest of the turn. A chat added to the
 * window's subscription got no catch-up at all.
 *
 * The turn is a fake CLI's: n chunks `<tag>-01 ` .. `<tag>-NN `, one a second.
 * The bubble is sampled every 250 ms, and every sample has to be a contiguous
 * prefix of the turn.
 *
 * @covers CCLI-04
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";
import { restartTestServer } from "./helpers/restart-test-server";

hermetic(test);
test.use({ video: "on" });
test.describe.configure({ timeout: 150_000 });

const TOKEN = process.env.GATEWAY_TOKEN ?? "test-token";

async function sessionKeyOf(request: APIRequestContext, topicId: string): Promise<string> {
  const body = (await (await request.get(`${E2E_BASE}/api/topics`)).json()) as { topics: Record<string, { id: string; sessionKey: string }> };
  return Object.values(body.topics).find((t) => t.id === topicId)!.sessionKey;
}

/** POST /api/chat from outside the page; `said` is what its event stream carried so far. */
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
  // A restart cuts this stream on purpose; whoever needs the end awaits `done`.
  done.catch(() => {});
  return { said: () => sse, done };
}

/** The chunk numbers the last assistant bubble of `topicId` shows, in order. */
async function chunksShown(page: Page, topicId: string, tag: string): Promise<number[]> {
  const text = await page.evaluate((id) => {
    const pane = document.querySelector(`[data-testid="chat-panel"][data-chat-topic-id="${id}"]`);
    const bubbles = pane ? pane.querySelectorAll('[data-testid="chat-message"][data-role="assistant"]') : [];
    return bubbles[bubbles.length - 1]?.textContent ?? "";
  }, topicId);
  return (text.match(new RegExp(`${tag}-(\\d\\d)`, "g")) ?? []).map((c) => Number(c.slice(-2)));
}

const isPrefix = (nums: number[]) => nums.every((k, i) => k === i + 1);

/**
 * Samples the bubble until it shows all `n` chunks, and returns every sample
 * that was not a contiguous prefix of the turn.
 */
async function holesUntilWhole(page: Page, topicId: string, tag: string, n: number): Promise<number[][]> {
  const holes: number[][] = [];
  await expect
    .poll(async () => {
      const nums = await chunksShown(page, topicId, tag);
      if (!isPrefix(nums)) holes.push(nums);
      return nums.length;
    }, { timeout: 60_000, intervals: [250], message: "the bubble ends with the whole turn" })
    .toBe(n);
  return holes;
}

test.describe("a chat joined mid-turn shows the turn from its start", () => {
  let uninstall: () => void = () => {};
  const a = { id: "", name: "Join A", sk: "" };
  const b = { id: "", name: "Join B" };

  test.beforeAll(async ({ request }) => {
    uninstall = installSlowTurnCli();
    a.id = (await createTopic(request, a.name, { provider: "claude-code" })).id;
    b.id = (await createTopic(request, b.name, { provider: "claude-code" })).id;
    a.sk = await sessionKeyOf(request, a.id);
    // The first spawn of the CLI is the slow one: paid here.
    await startTurn(a.sk, "warm up").done;
  });

  test.afterAll(async ({ request }) => {
    uninstall();
    await deleteTopic(request, a.id).catch(() => {});
    await deleteTopic(request, b.id).catch(() => {});
  });

  test("a chat opened while its turn runs: no hole in the bubble at any moment", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CCLI-04" });
    await resetPaneStore(request, [b.id]);
    await goToApp(page);
    await expect(page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${b.id}"]`)).toBeVisible({ timeout: 20_000 });
    const turn = startTurn(a.sk, "SLOW:14:joinb");
    await expect.poll(() => turn.said().includes("joinb-05"), { timeout: 30_000, message: "the turn is under way" }).toBe(true);
    await page.getByRole("treeitem", { name: a.name }).click();
    await expect(page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${a.id}"]`)).toBeVisible({ timeout: 15_000 });
    const holes = await holesUntilWhole(page, a.id, "joinb", 14);
    expect(holes, "every sample is a contiguous prefix of the turn").toEqual([]);
    await turn.done;
  });

  /**
   * Nightly only: the restart would be paid by whichever spec runs next on the
   * PR gate, like the other specs that restart the server.
   */
  test("a server restart mid-turn: after the reconnect, no hole in the bubble @nightly", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CCLI-04" });
    await resetPaneStore(request, [a.id]);
    await goToApp(page);
    await expect(page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${a.id}"]`)).toBeVisible({ timeout: 20_000 });
    const turn = startTurn(a.sk, "SLOW:25:joinc");
    await expect.poll(() => turn.said().includes("joinc-06"), { timeout: 30_000, message: "the turn is under way" }).toBe(true);
    await restartTestServer();
    const holes = await holesUntilWhole(page, a.id, "joinc", 25);
    expect(holes, "every sample is a contiguous prefix of the turn").toEqual([]);
  });
});
