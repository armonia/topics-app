/**
 * A WINDOW WHOSE SOCKET DROPS IN THE MIDDLE OF A TURN GETS BACK WHAT IT MISSED,
 * WITHOUT A RELOAD (T18, bar B3).
 *
 * "Ogni tanto la sessione è lenta e devo fare aggiorna per vedere il vero
 * progresso" (08/10). On the server side the provider now catches up with its
 * child by itself; this is the other half of the path: the browser's own
 * socket. The proxy closes it while a fake CLI is writing one chunk a second,
 * the chunks of the gap reach nobody, and after the hook's backoff the new
 * socket must bring the bubble back to the whole turn (the `stream:catchup`
 * the handshake asks for, then the live frames), with no hole at any sample.
 *
 * CONVENTION: no waitForTimeout. Condition-based waits only.
 * @covers CCLI-04
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { installSlowTurnCli } from "./helpers/fake-claude-cli";

hermetic(test);
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

test.describe("a socket dropped mid-turn catches up without a reload", () => {
  let uninstall: () => void = () => {};
  const t = { id: "", name: "Drop mid-turn", sk: "" };

  test.beforeAll(async ({ request }) => {
    uninstall = installSlowTurnCli();
    t.id = (await createTopic(request, t.name, { provider: "claude-code" })).id;
    t.sk = await sessionKeyOf(request, t.id);
    // The first spawn of the CLI is the slow one: paid here.
    await startTurn(t.sk, "warm up").done;
  });

  test.afterAll(async ({ request }) => {
    uninstall();
    await deleteTopic(request, t.id).catch(() => {});
  });

  test("the socket drops while chunks keep coming: the bubble ends whole, never with a hole", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CCLI-04" });
    await resetPaneStore(request, [t.id]);

    // Pass-through proxy, installed before navigation so it sees the app's socket.
    const clientRoutes: { close: () => void }[] = [];
    let connections = 0;
    // While the network is "down" a reconnect attempt is refused, so the gap
    // spans several chunks whatever the hook's backoff: the frames of the gap
    // are lost for good, as on a real cut.
    let refuse = false;
    await page.routeWebSocket(/\/ws/, (ws) => {
      if (refuse) { ws.close(); return; }
      const server = ws.connectToServer();
      connections += 1;
      clientRoutes.push(ws);
      ws.onMessage((msg) => server.send(msg));
      server.onMessage((msg) => ws.send(msg));
    });

    await goToApp(page);
    await expect(page.locator(`[data-testid="chat-panel"][data-chat-topic-id="${t.id}"]`)).toBeVisible({ timeout: 20_000 });
    const turn = startTurn(t.sk, "SLOW:16:dropws");
    await expect.poll(async () => (await chunksShown(page, t.id, "dropws")).length, { timeout: 30_000, message: "the bubble streams" })
      .toBeGreaterThanOrEqual(3);

    const before = connections;
    refuse = true;
    clientRoutes[clientRoutes.length - 1]!.close();
    // Chunks are written while this window is deaf.
    const shownAtDrop = (await chunksShown(page, t.id, "dropws")).length;
    await expect.poll(() => (turn.said().match(/dropws-\d\d/g) ?? []).length, { timeout: 30_000, message: "the turn goes on during the drop" })
      .toBeGreaterThanOrEqual(shownAtDrop + 3);
    // The page is deaf: it shows less than the turn has written. Without this
    // the spec could pass on a drop that never opened a gap.
    const shownBeforeReconnect = (await chunksShown(page, t.id, "dropws")).length;
    const writtenBeforeReconnect = (turn.said().match(/dropws-\d\d/g) ?? []).length;
    console.log(`[T18 B3] at drop ${shownAtDrop} shown; before reconnect ${shownBeforeReconnect} shown of ${writtenBeforeReconnect} written; sockets ${connections}`);
    expect(shownBeforeReconnect, "the window fell behind during the drop").toBeLessThan(writtenBeforeReconnect);
    refuse = false;
    await expect.poll(() => connections, { timeout: 20_000, message: "a new socket replaces the dropped one" }).toBeGreaterThan(before);

    const holes: number[][] = [];
    await expect
      .poll(async () => {
        const nums = await chunksShown(page, t.id, "dropws");
        if (!isPrefix(nums)) holes.push(nums);
        return nums.length;
      }, { timeout: 60_000, intervals: [250], message: "the bubble ends with the whole turn" })
      .toBe(16);
    expect(holes, "every sample is a contiguous prefix of the turn").toEqual([]);
    await turn.done;
  });
});
