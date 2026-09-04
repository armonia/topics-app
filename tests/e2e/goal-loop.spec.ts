import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

const BASE = E2E_BASE;

/**
 * "The chat carries on by itself, and it SHOWS that it is the chat doing it."
 *
 * Until now `/goal` saved the objective and re-injected it into every turn, and
 * when a turn ended with the objective still open nothing happened: the chat
 * stopped and the bar kept showing a goal nobody was pursuing. The server now
 * asks a cheap judge and, when work is left, sends the continuation itself
 * (server/services/goal-loop.ts).
 *
 * Two things can only be checked on a screen, and that is what this spec is
 * for. First: the continuation must NOT look like the person talking. The row
 * is a `user` one - it is the only role a provider answers - so without the
 * marker the transcript would show the human saying "Objective still open...".
 * Here it renders as one compact system line. Second: the bar has to say the
 * loop is running, with its count, or nobody can tell an autonomous chat from a
 * chat somebody is typing into.
 *
 * The states arrive as injected `goal:updated` frames: the loop's own decisions
 * are already covered without a browser (server/services/goal-loop.test.ts, and
 * the real route driven end to end in tests/integration/goal-continuation.test.ts).
 * What is under test HERE is the screen.
 *
 * @covers CHAT-GOALLOOP-02
 */
test.use({ video: "on" });

test.describe.serial("La barra dell'obiettivo mostra il ciclo", () => {
  let topicId: string;
  let topicName: string;
  let goalId: string;

  test.beforeAll(async ({ request }) => {
    topicName = `goal-loop-${Date.now()}`;
    const topic = await createTopic(request, topicName);
    topicId = topic.id;

    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as {
      topics: Record<string, { id: string; sessionKey: string }>;
    };
    const sessionKey = Object.values(topics).find((t) => t.id === topicId)?.sessionKey ?? "";
    expect(sessionKey, "il topic deve avere una sessionKey").toBeTruthy();

    const put = await request.put(`${BASE}/api/topics/${topicId}/goal`, {
      ignoreHTTPSErrors: true,
      data: { content: "portare la barra dei gate a verde" },
    });
    expect(put.ok()).toBe(true);
    goalId = ((await put.json()) as { goal: { id: string } }).goal.id;

    // The human turn, the half-done answer, and the continuation the server
    // sent itself: it is that last row that must not look like a person.
    await seedMessage(request, { sessionKey, role: "user", content: "comincia dai gate" });
    await seedMessage(request, {
      sessionKey,
      role: "assistant",
      content: "ho sistemato i tipi, restano il lint e i test",
    });
    await seedMessage(request, {
      sessionKey,
      role: "user",
      content:
        "Objective still open: portare la barra dei gate a verde Continue. When it is reached AND verified, call close_goal(achieved) with the evidence.",
      blocks: [{ kind: "goal-nudge", attempt: 1 }],
    });
  });

  test.afterAll(async ({ request }) => {
    await deleteTopic(request, topicId).catch(() => {});
  });

  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("la continuazione è una riga di sistema, la barra conta, e a obiettivo raggiunto sparisce", async ({ page }) => {
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await openTopic(page, topicName);

    // 1. The objective is on the bar.
    const bar = page.getByTestId("goal-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("portare la barra dei gate a verde");

    // 2. THE CONTINUATION IS NOT A USER BUBBLE. One compact line that says
    //    whose push this is and which attempt we are on.
    const nudge = page.getByTestId("goal-loop-row").filter({ has: page.locator('[data-goal-loop="nudge:1"]') })
      .or(page.locator('[data-testid="goal-loop-row"][data-goal-loop="nudge:1"]'));
    await expect(nudge.first()).toBeVisible();
    // And the text the server sent to the model does not show up as the
    // user's prose: the line replaces it.
    await expect(page.locator('[data-testid="chat-message"][data-role="user"]')
      .filter({ hasText: "call close_goal(achieved)" })).toHaveCount(0);

    // 3. THE LOOP IS ALIVE, AND THE BAR SAYS SO. The frame is the one the
    //    server sends at every step (`goal:updated` carries the whole goal).
    const goalFrame = (over: Record<string, unknown>) => ({
      type: "goal:updated",
      topicId,
      goal: {
        id: goalId,
        topicId,
        content: "portare la barra dei gate a verde",
        status: "active",
        createdBy: "human",
        createdAt: new Date().toISOString(),
        closedAt: null,
        steps: [],
        continuations: 0,
        idleTurns: 0,
        loopState: "running",
        ...over,
      },
    });

    ws.send(goalFrame({ continuations: 1 }));
    const loopState = page.getByTestId("goal-loop-state");
    await expect(loopState).toBeVisible();
    await expect(loopState).toContainText("1");
    // ...and with it the way to stop it without giving up the objective.
    await expect(page.getByTestId("goal-loop-stop")).toBeVisible();

    // 4. REACHED: the goal closes and the bar disappears on its own, with
    //    nobody reloading the page.
    ws.send({ type: "goal:updated", topicId, goal: null });
    await expect(bar).toBeHidden();
  });
});
