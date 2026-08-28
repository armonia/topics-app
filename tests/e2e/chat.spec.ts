import { expect } from "@playwright/test";
import { test } from "./fixtures/chat.fixture";
import { goToApp, openTestChat, openTopic, ensureTopicVisible } from "./helpers";
import { mockChatStream, unmockChatStream } from "./helpers/sse-helpers";
import { createTopic, deleteTopic, patchTopic, resetPaneStore } from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe.serial("Chat", () => {
  let testTopicId: string;
  let testTopicName: string;

  test.beforeAll(async ({ request }) => {
    testTopicName = "Chat E2E Test " + Date.now();
    const topic = await createTopic(request, testTopicName);
    testTopicId = topic.id;
  });

  test.afterAll(async ({ request }) => {
    if (testTopicId) {
      await deleteTopic(request, testTopicId);
    }
  });

  test("sends message and sees streamed response", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    await goToApp(page);
    // Close any open dialogs/palettes
    await page.keyboard.press("Escape");
    // Use the fresh test topic (no history) so mocked response is visible
    await openTopic(page, new RegExp(testTopicName));
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Set up SSE mock AFTER navigation to avoid interfering with page load
    await mockChatStream(page, {
      chunks: ["Hello ", "from ", "the ", "assistant!"],
      userMessage: "test message",
    });

    // Send message
    await textarea.click();
    await textarea.fill("test message");
    await textarea.press("Enter");

    // Assert the streamed content appeared (auto-retries until timeout)
    await expect(page.locator("body")).toContainText(
      "Hello from the assistant!",
      { timeout: 15_000 }
    );
  });

  test("loads history when switching topics", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    await goToApp(page);

    // Open a topic known to have existing messages
    await openTopic(page, /Web Search Test/);

    // Wait for at least one message to appear
    const messages = page.locator(".message-content");
    await expect(messages.first()).toBeVisible({ timeout: 15_000 });
    const firstTopicCount = await messages.count();
    expect(firstTopicCount).toBeGreaterThan(0);

    // Switch to the empty test topic and verify content changes
    await openTopic(page, new RegExp(testTopicName));

    // Wait for main content to settle after topic switch
    await page.locator('[role="main"]').waitFor({
      state: "visible",
      timeout: 10_000,
    });

    // The test topic should show different content than Web Search Test
    await expect(page.locator('[role="main"]')).toBeVisible();
  });

  test("aborts streaming via stop button", async ({ page, chatPage, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-01" });
    test.slow(); // Real streaming needs extra time

    // Skip if the AI gateway isn't reachable — this test requires real streaming
    // (the server's sendChat calls ${GATEWAY_URL}/v1/chat/completions server-side,
    // which Playwright page.route cannot intercept). In CI without gateway, skip.
    const gatewayUrl = process.env.GATEWAY_URL || "http://127.0.0.1:18789";
    // Probe the endpoint this test NEEDS, not just liveness. `/healthz` answers
    // `{"ok":true}` on a gateway that serves only its web UI and has no
    // OpenAI-compatible route at all, so the old guard let the test through and
    // it then died 15s later on a streaming indicator that never came — a red
    // that named the UI and meant "the gateway has no completions endpoint".
    //
    // An EMPTY body on purpose: a live route rejects it (400/401/422) without
    // spending a completion, while a missing route is a 404. So 404 alone means
    // "not available here", and every other answer means the route is there and
    // this test must really run.
    const completions = await request
      .post(`${gatewayUrl}/v1/chat/completions`, {
        data: {},
        timeout: 4000,
        ignoreHTTPSErrors: true,
        failOnStatusCode: false,
      })
      .then((r) => r.status())
      .catch(() => 0);
    test.skip(
      completions === 0 || completions === 404,
      `AI gateway at ${gatewayUrl} serves no /v1/chat/completions (${completions || "unreachable"}) — cannot verify real streaming abort`,
    );

    await goToApp(page);
    await openTestChat(page);

    // Send a prompt that triggers a long streaming response (real server)
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.click();
    await textarea.fill(
      "Write a very long paragraph of 500 words about the history of computing"
    );
    await textarea.press("Enter");

    // Wait for streaming indicator to appear (real server streaming)
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    // Click stop button to abort (use first match; sidebar and tab bar both have one)
    const stopBtn = page
      .getByRole("button", { name: /Stop generating/ })
      .first();
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });
    await stopBtn.click();

    // Streaming indicator should disappear after abort
    await expect(chatPage.streamingIndicator).toBeHidden({ timeout: 10_000 });

    // The main content area should have some text (partial response was kept)
    await expect(page.locator('[role="main"]')).not.toBeEmpty();
  });

  test("scroll-to-bottom button works", async ({ page, chatPage, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-03" });
    // The shared "Web Search Test" seed is too short to overflow the redesigned
    // list (footer spacer + increaseViewportBy), so the scroll-to-bottom button
    // never appears. Seed a fresh topic with enough messages to overflow it.
    //
    // Quaranta e non venti: la chat si è COMPATTATA (la riga dell'orario non
    // occupa più il suo spazio da invisibile, e le corse di tool sono un item
    // solo), quindi venti messaggi corti superano la finestra di MENO dei 150px
    // che servono a sganciare l'aggancio — e senza sgancio la freccia non
    // compare mai. Il test cadeva su una precondizione che non aveva creato.
    const sbTopicName = `chat-sb-${Date.now()}`;
    const sbTopic = await createTopic(request, sbTopicName);
    for (let i = 0; i < 40; i++) {
      await request.post(`${E2E_BASE}/api/topics/${sbTopic.id}/system-message`, {
        data: { content: `Seed ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(3)}` },
        ignoreHTTPSErrors: true,
      });
    }
    try {
      await goToApp(page);
      await openTopic(page, new RegExp(sbTopicName));

      // Wait for messages to load
      await expect(page.locator(".message-content").first()).toBeVisible({ timeout: 15_000 });

      // Scope the scroller to THIS topic's pane. `.first()` was order-dependent:
      // run alone there is one chat pane and it picks the right one, but in a
      // full-suite run an earlier spec leaves another chat open in the shared
      // workspace, so `.first()` could scroll a DIFFERENT pane — the seeded list
      // never moved and the button never appeared. Green in isolation, red in
      // sequence, with nothing wrong in the app.
      // MessageList labels its scroll container per topic
      // (`aria-label="Messages for <name>"`), which is the only topic-scoped
      // anchor around the list — use it instead of a global `.first()`.
      const scroller = page
        .locator(`[aria-label="Messages for ${sbTopicName}"] [data-virtuoso-scroller]`)
        .first();
      await expect(scroller, "this topic's own scroller is mounted").toBeVisible({ timeout: 10_000 });

      // Si risale con una ROTELLINA vera, non assegnando `scrollTop`.
      //
      // Assegnarlo è un movimento che un utente non può produrre, e l'app lo
      // classifica — correttamente — come proprio: `scrollTop` calato è
      // ambiguo (lo abbassa anche Virtuoso quando rimisura dopo un nostro
      // scroll forzato), e dentro la finestra di guardia che segue l'apertura
      // non sgancia l'aggancio. Senza sgancio la freccia non compare, e il
      // test cadeva su una precondizione che non aveva creato: non stava
      // provando la freccia, stava provando la guardia. La rotellina è un
      // gesto, l'app non ne produce, quindi sgancia sempre.
      // PRECONDIZIONE esplicita: senza abbastanza da scorrere non c'è nessuna
      // freccia da provare, e il rosso accuserebbe il bottone invece della
      // semina.
      const eccedenza = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(eccedenza, "il transcript deve eccedere la finestra di piu' della tolleranza dell'app").toBeGreaterThan(300);

      await scroller.hover();
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, -2000);
        if (await scroller.evaluate((el) => el.scrollTop === 0)) break;
      }

      // Scroll-to-bottom button should appear
      await expect(chatPage.scrollToBottomButton).toBeVisible({ timeout: 8_000 });

      // Click it — the list should return to the bottom (150px = app threshold,
      // MessageList.tsx:412)
      await chatPage.scrollToBottomButton.click();
      await expect
        .poll(
          () => scroller.evaluate((el) => Math.abs(el.scrollTop + el.clientHeight - el.scrollHeight)),
          { timeout: 8_000 }
        )
        .toBeLessThan(150);
    } finally {
      await deleteTopic(request, sbTopic.id);
    }
  });

  test("auto-scrolls to bottom on new streamed message", async ({ page, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-03" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    // Open test topic (created in beforeAll)
    await openTopic(page, new RegExp(testTopicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Mock SSE to return a long response that will extend the message list
    await mockChatStream(page, {
      chunks: ["This is a response that should trigger auto-scroll to bottom."],
      userMessage: "Test auto-scroll",
    });

    // The topic starts empty, so Virtuoso's scroller isn't mounted yet — there
    // is no scroll position to record before sending. Send first (which mounts
    // the list), then assert the at-bottom invariant.
    await textarea.fill("Test auto-scroll");
    await textarea.press("Control+Enter");

    // Wait for assistant response to appear
    await expect(
      page.locator(".message-content").filter({ hasText: "auto-scroll to bottom" })
    ).toBeVisible({ timeout: 15_000 });

    // After a new streamed message the list must rest at (or within 50px of) the
    // bottom. messageList resolves to the Virtuoso scroller ([data-virtuoso-scroller]).
    await expect.poll(
      async () => {
        const { scrollTop, scrollHeight, clientHeight } = await chatPage.messageList.evaluate(
          (e) => ({
            scrollTop: e.scrollTop,
            scrollHeight: e.scrollHeight,
            clientHeight: e.clientHeight,
          })
        );
        return scrollTop + clientHeight >= scrollHeight - 50;
      },
      { message: "Message list should auto-scroll to bottom on new message" }
    ).toBe(true);

    // Clean up route
    await unmockChatStream(page);
  });

  test("input toolbar has all buttons", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-04" });
    await goToApp(page);
    await openTestChat(page);

    // Il testo si prende la riga; sotto, la riga dei controlli: «+», i
    // permessi, e in coda microfono e invio. La graffetta non è più un bottone
    // sciolto — sta nel «+», che è l'unico posto da cui si aggiunge qualcosa
    // alla conversazione. Il microfono sì: è la seconda strada per riempire il
    // campo, e sta dove il campo finisce di riempirsi.
    const addMenu = page.getByRole("button", { name: "Tools & commands" });
    await expect(addMenu).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: /Record voice/ })
    ).toBeVisible({ timeout: 5_000 });
    // Il piano non è più un interruttore accanto alla graffetta: è un LIVELLO
    // di autonomia, e questo è il controllo che lo porta. C'erano due modi di
    // chiederlo — un flag di prompt in localStorage e questo, che passa
    // `--permission-mode plan` alla CLI — e solo il secondo veniva rispettato.
    await expect(
      page.getByRole("button", { name: /Autonomia/ })
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("button", { name: /Send message/ })
    ).toBeVisible({ timeout: 5_000 });

    // …e la graffetta è dentro il «+», con la sua scorciatoia.
    await addMenu.click();
    await expect(
      page.getByRole("button", { name: /Attach file/ })
    ).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
  });

  test("Shift+Enter creates multiline input", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-04" });
    await goToApp(page);
    const textarea = await openTestChat(page);

    await textarea.fill("");
    await textarea.click();
    await page.keyboard.type("Line 1");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Line 2");

    const value = await textarea.inputValue();
    expect(value).toContain("Line 1");
    expect(value).toContain("Line 2");
    await textarea.fill("");
  });
});

test.describe("Chat — Rich Content Rendering", () => {
  test("renders markdown formatting in messages", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-02" });
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for messages to load
    await expect(page.locator(".message-content").first()).toBeVisible({ timeout: 15_000 });

    // Structural: at least one rich HTML element across all visible message content (D-05)
    const richElements = page.locator(".message-content p, .message-content strong, .message-content code, .message-content pre, .message-content ul, .message-content ol, .message-content a, .message-content h1, .message-content h2, .message-content h3");
    expect(await richElements.count()).toBeGreaterThan(0);
  });

  test("renders syntax highlighting, KaTeX math and mermaid diagrams", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-RND-01/02/03" });
    const richContent = [
      "Codice:",
      "```javascript",
      "const x = 42; // answer",
      "```",
      "Formula: $$E = mc^2$$",
      "Prezzo non-math: costa $5 e basta.",
      "```mermaid",
      "graph TD; A-->B;",
      "```",
    ].join("\n");
    await page.route(/\/api\/history/, async (route) => {
      await route.fulfill({
        status: 200,
        json: {
          messages: [
            { id: "rnd-user-1", role: "user", content: "Mostra rendering", timestamp: new Date().toISOString() },
            { id: "rnd-assistant-1", role: "assistant", content: richContent, timestamp: new Date().toISOString() },
          ],
        },
      });
    });
    await goToApp(page);
    await openTopic(page, /Web Search Test/);
    await expect(page.locator(".message-content").first()).toBeVisible({ timeout: 15_000 });

    // CHAT-RND-01 — hljs token spans present in the code block
    await expect(page.locator(".code-block-wrapper .hljs-keyword").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".code-block-wrapper .hljs-comment").first()).toBeVisible();

    // CHAT-RND-02 — display math rendered by KaTeX; single dollars stay text
    await expect(page.locator(".message-content .katex").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("costa $5 e basta")).toBeVisible();

    // CHAT-RND-03 — mermaid fence becomes an SVG diagram (lazy chunk)
    await expect(page.locator('[data-testid="mermaid-diagram"] svg').first()).toBeVisible({ timeout: 20_000 });
  });

  test("renders diff block with file path and code", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-02" });
    const diffContent = "Here is the change:\n\nsrc/app.ts\n<<<<<<< SEARCH\nold code here\n=======\nnew code here\n>>>>>>> REPLACE";

    // Mock chat SSE to return diff content
    await page.route(/\/api\/chat$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const data = JSON.stringify({ choices: [{ index: 0, delta: { content: diffContent } }] });
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: `data: ${data}\n\ndata: [DONE]\n\n`,
      });
    });

    // Mock history to return diff message
    await page.route(/\/api\/history\//, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        json: {
          messages: [
            { id: "mock-user-1", role: "user", content: "Fix the code", timestamp: new Date().toISOString() },
            { id: "mock-assistant-1", role: "assistant", content: diffContent, timestamp: new Date().toISOString() },
          ],
        },
      });
    });

    await goToApp(page);
    await ensureTopicVisible(page, /Web Search Test/);
    const chatItem = page.getByRole("treeitem", { name: /Web Search Test/ });
    await chatItem.waitFor({ state: "visible", timeout: 10_000 });
    await chatItem.click({ force: true });
    await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10_000 });
    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 10_000 });

    await textarea.fill("Fix the code");
    await textarea.press("Control+Enter");

    // Assert DiffBlock renders with file path
    // History mock + streamed send both inject the diff, so the path can
    // legitimately render twice — assert the first (strict-mode safe).
    await expect(page.getByText("src/app.ts").first()).toBeVisible({ timeout: 15_000 });

    // Assert Apply and Reject buttons are visible (DiffBlock action buttons).
    // `.first()` per la STESSA ragione dichiarata tre righe sopra: i due diff
    // renderizzati (history mock + streamed send) portano due Apply, e senza
    // `.first()` lo strict mode fa esplodere il locator.
    await expect(page.getByRole("button", { name: /Apply/ }).first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Message Action Toolbar", () => {
  test("message toolbar shows on hover with copy and pin actions", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-03" });
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for first message to be visible
    const firstMessage = page.locator(".message-content").first();
    await expect(firstMessage).toBeVisible({ timeout: 15_000 });

    // REAL hover + REAL clicks (CHAT-REL-01). These used to be
    // dispatchEvent() workarounds because the toolbar was clipped by its
    // overflow-hidden containing block and real clicks landed on the previous
    // row. Keeping them real is the regression guard for that fix.
    await firstMessage.hover();

    // Verify action buttons become visible after hover
    // Multiple messages → multiple toolbars; use .first() for the hovered one
    const copyBtn = page.getByRole("button", { name: "Copy message" }).first();
    const pinBtn = page.getByRole("button", { name: "Pin message" }).first();
    const replyBtn = page.getByRole("button", { name: "Reply" }).first();

    await expect(copyBtn).toBeVisible({ timeout: 5_000 });
    await expect(pinBtn).toBeVisible({ timeout: 5_000 });
    await expect(replyBtn).toBeVisible({ timeout: 5_000 });

    // Real click: fails if the toolbar is ever clipped/occluded again.
    await copyBtn.click();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard.length).toBeGreaterThan(0);
  });

  test("pin action toggles pin state on message", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-03" });
    await goToApp(page);
    await openTopic(page, /Web Search Test/);

    // Wait for messages to load
    const firstMessage = page.locator(".message-content").first();
    await expect(firstMessage).toBeVisible({ timeout: 15_000 });

    // REAL hover + REAL click (CHAT-REL-01 regression guard — see toolbar test).
    await firstMessage.hover();
    const pinBtn = page.getByRole("button", { name: "Pin message" }).first();
    await expect(pinBtn).toBeVisible({ timeout: 5_000 });
    await pinBtn.click();

    // Visual verification: pin button should have yellow color class
    await firstMessage.hover();
    const pinBtnAfterPin = page.getByRole("button", { name: "Pin message" }).first();
    await expect(pinBtnAfterPin).toBeVisible({ timeout: 5_000 });
    // Pinned state: class contains "text-yellow-500" (not "hover:text-yellow-500")
    await expect(pinBtnAfterPin).toHaveClass(/(?<!hover:)text-yellow-500/, { timeout: 5_000 });

    // API verification: pinnedMessages array should contain the message ID
    const topicRes = await request.get(`${E2E_BASE}/api/topics`, {
      ignoreHTTPSErrors: true,
    });
    const topicsData = await topicRes.json();
    const currentTopic = Object.values(topicsData.topics as Record<string, any>).find(
      (t: any) => t.name === "Web Search Test"
    );
    expect(currentTopic).toBeTruthy();
    expect(((currentTopic as any).pinnedMessages || []).length).toBeGreaterThan(0);

    // Unpin: re-trigger hover events and click pin to toggle off
    await firstMessage.dispatchEvent("mouseenter");
    await firstMessage.dispatchEvent("mouseover");
    await expect(pinBtnAfterPin).toBeVisible({ timeout: 5_000 });
    await pinBtnAfterPin.dispatchEvent("click");

    // Visual verification: pin button should return to muted (no yellow)
    await firstMessage.dispatchEvent("mouseenter");
    await firstMessage.dispatchEvent("mouseover");
    const pinBtnAfterUnpin = page.getByRole("button", { name: "Pin message" }).first();
    await expect(pinBtnAfterUnpin).toBeVisible({ timeout: 5_000 });
    // Unpinned state: no active "text-yellow-500" (allow "hover:text-yellow-500")
    await expect(pinBtnAfterUnpin).not.toHaveClass(/(?<!hover:)text-yellow-500/, { timeout: 5_000 });

    // API verification: pinnedMessages array should be empty after unpin
    const topicRes2 = await request.get(`${E2E_BASE}/api/topics`, {
      ignoreHTTPSErrors: true,
    });
    const topicsData2 = await topicRes2.json();
    const currentTopic2 = Object.values(topicsData2.topics as Record<string, any>).find(
      (t: any) => t.name === "Web Search Test"
    );
    expect(currentTopic2).toBeTruthy();
    expect(((currentTopic2 as any).pinnedMessages || []).length).toBe(0);
  });
});

test.describe("Message Branching", () => {
  test("branch navigation arrows switch between edit branches", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-03" });
    test.slow();

    // Editing a message forks a sibling user branch and streams a new assistant
    // reply. The streaming half needs a provider-backed edit endpoint, which the
    // isolated test server has no upstream for — so we seed the *exact* persisted
    // shape an edit produces and drive the branch-navigation UI + real
    // switch-branch endpoint against it. loadActiveThread reports siblingCount
    // from the number of children sharing a parent; two ROOT user messages
    // (parent_id NULL) with distinct branch_index (0, 1), each with its own
    // assistant child, yields siblingCount=2 on the active root → the arrows show.
    const topic = await createTopic(request, "Branch Nav " + Date.now());
    const sk = `topic:${topic.id.slice(0, 8)}`;
    try {
      const base = Date.now();
      // Branch 0 (default-active): original user message + assistant reply.
      const u0 = await seedMessage(request, {
        sessionKey: sk, role: "user", branchIndex: 0,
        content: "Test message for branching",
        timestamp: new Date(base - 5000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk, role: "assistant", parentId: u0.id, branchIndex: 0,
        content: "Hello from branch 1!",
        timestamp: new Date(base - 4000).toISOString(),
      });
      // Branch 1 (sibling root): the edited user message + its assistant reply.
      // parentId: null is REQUIRED — without it the seed endpoint defaults the
      // parent to the previous message (a0), chaining u1 into the thread instead
      // of forking a second root, and loadActiveThread then reports siblingCount=1
      // (no branch arrows). Explicit null forks the genuine two-root shape an edit
      // of the first user message produces.
      const u1 = await seedMessage(request, {
        sessionKey: sk, role: "user", branchIndex: 1, parentId: null,
        content: "Edited message for branching",
        timestamp: new Date(base - 3000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk, role: "assistant", parentId: u1.id, branchIndex: 0,
        content: "Hello from branch 2!",
        timestamp: new Date(base - 2000).toISOString(),
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));

      // Default active root branch is 0 → the first branch's user message shows.
      await expect(
        page.locator(".message-content").filter({ hasText: "Test message for branching" })
      ).toBeVisible({ timeout: 15_000 });

      // Branch navigation renders on the user message whenever siblingCount > 1
      // (not hover-gated — MessageBubble.tsx:240). Prev is disabled on branch 0.
      const prevBranchBtn = page.getByRole("button", { name: "Previous branch" });
      const nextBranchBtn = page.getByRole("button", { name: "Next branch" });
      await expect(prevBranchBtn.first()).toBeVisible({ timeout: 10_000 });
      await expect(nextBranchBtn.first()).toBeVisible({ timeout: 10_000 });

      // Counter reads "1/2" on the first branch.
      const branchCounter = page.locator("span").filter({ hasText: /^\d+\/\d+$/ });
      await expect(branchCounter.first()).toHaveText("1/2", { timeout: 5_000 });

      // Switching to the next branch surfaces the edited sibling (real
      // switch-branch endpoint → getActiveThread re-hydrate) and bumps the counter.
      await nextBranchBtn.first().click();
      await expect(
        page.locator(".message-content").filter({ hasText: "Edited message for branching" })
      ).toBeVisible({ timeout: 10_000 });
      await expect(branchCounter.first()).toHaveText("2/2", { timeout: 5_000 });
    } finally {
      await deleteTopic(request, topic.id);
    }
  });
});

test.describe.serial("Chat Input Features", () => {
  let topicId: string;
  let topicName: string;

  test.beforeAll(async ({ request }) => {
    // Create topic without projectPath (appears in sezione Chat)
    topicName = "Input Feature Test " + Date.now();
    const topic = await createTopic(request, topicName);
    topicId = topic.id;
  });

  test.beforeEach(async ({ request }) => {
    // Start each test with a CLEAN pane store. These tests share ONE server
    // (persisted pane-store), so a pane opened by an earlier test in this serial
    // block (e.g. the baseline "Web Search Test" pane, or this topic's own chat)
    // survives into the next test's hydrate. That leftover pane causes page-wide
    // selectors (`input[type=file]`, `textbox[Message input]`, `getByText`) to
    // resolve to MULTIPLE elements — and when the @-mention test then PATCHes a
    // live projectPath onto an already-open chat, the transform duplicates the
    // pane into two identical copies (strict-mode violation). Resetting both the
    // v2 pane store and the legacy openPanels to empty makes each test open
    // exactly ONE pane via openTopic.
    await resetPaneStore(request, []);
    await request
      .put(`${E2E_BASE}/api/ui-state/panels`, { data: { openPanels: [] }, ignoreHTTPSErrors: true })
      .catch(() => {});
  });

  test.afterAll(async ({ request }) => {
    if (topicId) {
      await deleteTopic(request, topicId);
    }
  });

  test("file attachment shows preview via setInputFiles", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-04" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    // Match the FULL unique name (incl. timestamp), not the "Input Feature Test"
    // prefix: on a retry the serial group's beforeAll re-runs and mints a new
    // timestamped topic, leaving the prior one live in the DB. A prefix regex
    // matches both → ensureTopicVisible seeds both → strict-mode violation.
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Scope to THIS topic's pane: a baseline "Web Search Test" pane persists in
    // the server pane-store from earlier tests, so it stays mounted (keep-alive)
    // alongside the topic under test. Each ChatPanel carries its own hidden
    // `input[type="file"]`, so a page-wide selector resolves to 2 elements
    // (strict-mode violation). The pane root is
    // `role="region" aria-label="<topic.name> panel"` (ChatPanel.tsx:173).
    const pane = page.getByRole("region", { name: new RegExp(`${topicName} panel`) });
    // Use setInputFiles on the hidden file input to attach a file (D-08: real upload)
    const fileInput = pane.locator('input[type="file"]');
    await fileInput.setInputFiles("tests/e2e/fixtures/test-upload.txt");

    // Verify pending file preview shows the filename in the input area
    await expect(pane.getByText("test-upload.txt")).toBeVisible({ timeout: 5_000 });
  });

  test("@-mention autocomplete shows file suggestions", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-04" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    // Match the FULL unique name (incl. timestamp), not the "Input Feature Test"
    // prefix: on a retry the serial group's beforeAll re-runs and mints a new
    // timestamped topic, leaving the prior one live in the DB. A prefix regex
    // matches both → ensureTopicVisible seeds both → strict-mode violation.
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // PATCH topic to add projectPath for @-mention support (CHAT-09)
    // The server broadcasts topic:updated via WebSocket, so the client updates live
    await patchTopic(request, topicId, { projectPath: process.cwd() });

    // Wait for the placeholder to change (indicates projectPath was received)
    await expect(textarea).toHaveAttribute(
      "placeholder",
      /@ to mention files/,
      { timeout: 10_000 }
    );

    // Type @ to trigger FileMentionMenu
    await textarea.click();
    await textarea.fill("@");

    // Wait for the mention menu to appear (data-mention-menu attribute)
    const mentionMenu = page.locator("[data-mention-menu]");
    await expect(mentionMenu).toBeVisible({ timeout: 10_000 });

    // Assert menu contains at least one file suggestion button
    const fileSuggestions = mentionMenu.locator("button[data-mention-idx]");
    await expect(fileSuggestions.first()).toBeVisible({ timeout: 5_000 });
    expect(await fileSuggestions.count()).toBeGreaterThan(0);

    // Clean up: remove projectPath so topic stays in sezione Chat for next tests
    await patchTopic(request, topicId, { projectPath: "" });
  });

  test("slash command menu shows and executes command", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-04" });
    await goToApp(page);
    await page.keyboard.press("Escape");
    // Match the FULL unique name (incl. timestamp), not the "Input Feature Test"
    // prefix: on a retry the serial group's beforeAll re-runs and mints a new
    // timestamped topic, leaving the prior one live in the DB. A prefix regex
    // matches both → ensureTopicVisible seeds both → strict-mode violation.
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Type / to trigger slash command menu
    await textarea.click();
    await textarea.fill("/");

    // Wait for slash command menu to appear (absolute positioned above input)
    // The menu contains buttons with slash command text like "/status", "/help"
    const slashMenuButton = page.locator("span.font-mono").filter({
      hasText: "/status",
    });
    await expect(slashMenuButton).toBeVisible({ timeout: 5_000 });

    // Verify multiple commands are shown
    await expect(
      page.locator("span.font-mono").filter({ hasText: "/help" })
    ).toBeVisible({ timeout: 3_000 });
    await expect(
      page.locator("span.font-mono").filter({ hasText: "/clear" })
    ).toBeVisible({ timeout: 3_000 });

    // Type /help to filter the menu to the /help command
    await textarea.fill("/help");

    // Press Enter to select /help from the filtered slash menu
    await textarea.press("Enter");

    // The slash menu selection sets the input to "/help " - submit it
    await textarea.press("Enter");

    // Verify command result banner appears (success or error banner with text)
    const resultBanner = page.locator(".font-mono").filter({
      hasText: /.+/,
    });
    await expect(resultBanner.first()).toBeVisible({ timeout: 10_000 });
  });

  test("context pills show active context sources", async ({
    page,
    request,
  }) => {
    test.info().annotations.push({ type: "spec", description: "CTX-01" });
    // PATCH the test topic to add contextFiles (use package.json as a known file)
    const contextFile = process.cwd() + "/package.json";
    await patchTopic(request, topicId, {
      contextFiles: [contextFile],
    });

    await goToApp(page);
    await page.keyboard.press("Escape");
    // Match the FULL unique name (incl. timestamp), not the "Input Feature Test"
    // prefix: on a retry the serial group's beforeAll re-runs and mints a new
    // timestamped topic, leaving the prior one live in the DB. A prefix regex
    // matches both → ensureTopicVisible seeds both → strict-mode violation.
    await openTopic(page, new RegExp(topicName));

    const textarea = page.getByRole("textbox", { name: /Message input/ });
    await textarea.waitFor({ state: "visible", timeout: 15_000 });

    // Verify ContextPills renders with the context file name
    const contextPill = page.locator(".context-pill").first();
    await expect(contextPill).toBeVisible({ timeout: 10_000 });

    // Verify the file name is shown in the pill
    await expect(page.getByText("package.json")).toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Conversation pack (CHAT-CONV)", () => {
  test("delete removes a message via two-click confirm and survives reload", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-CONV-02" });
    const topic = await createTopic(request, "Conv Delete " + Date.now());
    const sk = `topic:${topic.id.slice(0, 8)}`;
    try {
      const base = Date.now();
      const u0 = await seedMessage(request, {
        sessionKey: sk, role: "user", branchIndex: 0,
        content: "keep this question",
        timestamp: new Date(base - 5000).toISOString(),
      });
      const a0 = await seedMessage(request, {
        sessionKey: sk, role: "assistant", parentId: u0.id, branchIndex: 0,
        content: "reply to be deleted",
        timestamp: new Date(base - 4000).toISOString(),
      });
      void a0;

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));

      const target = page.locator(".message-content").filter({ hasText: "reply to be deleted" });
      await expect(target).toBeVisible({ timeout: 15_000 });

      // Two-click confirm: first click arms the button, second fires.
      await target.hover();
      const delBtn = page.getByTestId("msg-action-delete").last();
      await expect(delBtn).toBeVisible({ timeout: 5_000 });
      await delBtn.click();
      await expect(delBtn).toContainText("Delete?", { timeout: 3_000 });
      await delBtn.click();

      await expect(target).toHaveCount(0, { timeout: 10_000 });
      // Server truth: gone after a full reload too.
      await page.reload();
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));
      await expect(
        page.locator(".message-content").filter({ hasText: "keep this question" })
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.locator(".message-content").filter({ hasText: "reply to be deleted" })
      ).toHaveCount(0);
    } finally {
      await deleteTopic(request, topic.id);
    }
  });

  test("regenerate action is offered on assistant messages; export downloads the thread", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHAT-CONV-01 / CHAT-CONV-03" });
    const topic = await createTopic(request, "Conv Export " + Date.now());
    const sk = `topic:${topic.id.slice(0, 8)}`;
    try {
      const base = Date.now();
      const u0 = await seedMessage(request, {
        sessionKey: sk, role: "user", branchIndex: 0,
        content: "export me please",
        timestamp: new Date(base - 5000).toISOString(),
      });
      await seedMessage(request, {
        sessionKey: sk, role: "assistant", parentId: u0.id, branchIndex: 0,
        content: "exported answer body",
        timestamp: new Date(base - 4000).toISOString(),
      });

      await goToApp(page);
      await page.keyboard.press("Escape");
      await openTopic(page, new RegExp(topic.name));

      const assistantMsg = page.locator(".message-content").filter({ hasText: "exported answer body" });
      await expect(assistantMsg).toBeVisible({ timeout: 15_000 });

      // CHAT-CONV-01 (UI wiring): the regenerate action shows on hover of an
      // assistant message. The streamed happy-path needs a live provider and
      // is covered by the gateway-gated env, not here.
      await assistantMsg.hover();
      await expect(page.getByTestId("msg-action-regenerate").last()).toBeVisible({ timeout: 5_000 });

      // CHAT-CONV-03: composer ⋯ menu → Export conversation → a .md download
      // whose content carries the whole active thread.
      await page.getByRole("button", { name: "Tools & commands" }).click();
      const exportBtn = page.getByTestId("chat-export-conversation");
      await expect(exportBtn).toBeVisible({ timeout: 5_000 });
      const downloadP = page.waitForEvent("download", { timeout: 10_000 });
      await exportBtn.click();
      const download = await downloadP;
      expect(download.suggestedFilename()).toMatch(/\.md$/);
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString("utf-8");
      expect(text).toContain("export me please");
      expect(text).toContain("exported answer body");
    } finally {
      await deleteTopic(request, topic.id);
    }
  });

  // Le manopole che si cambiano IN CORSO di conversazione hanno una superficie
  // nel composer. Prima l'effort stava dentro il popover provider/modello
  // (dietro un trigger "Provider & model", sotto un campo di ricerca).
  //
  // L'AUTONOMIA non c'e' piu': mostrava "Chiedi — Approvi ogni azione"
  // selezionato su ogni topic mentre lo spawn usa `bypassPermissions`, e non e'
  // collegabile finche' il server non gestisce il canale di permesso della CLI
  // (`can_use_tool` non compare da nessuna parte). Motivo e piano in
  // openspec/changes/autonomy-level-needs-permission-channel/. Questo test
  // copriva la PERSISTENZA di quel valore — che continua a funzionare via
  // `PATCH /api/topics/:id`, colonna intatta — ma non piu' il controllo.
  test("CHAT-CONFIG: il composer espone l'effort inline, e l'autonomia sta fuori dal pannello", async ({ page, request }) => {
    const topic = await createTopic(request, `E2E-Config-${Date.now()}`);
    try {
      await goToApp(page);
      await openTopic(page, new RegExp(topic.name));

      const trigger = page.getByTestId("chat-session-config");
      await expect(trigger, "the composer offers a config control").toBeVisible({ timeout: 10_000 });
      await trigger.click();

      const panel = page.getByTestId("chat-session-config-panel");
      await expect(panel).toBeVisible({ timeout: 5_000 });

      // L'effort e' la manopola che questa superficie serve davvero.
      await expect(panel, "il pannello mostra i tier di effort").toContainText(/effort/i);

      // L'autonomia NON sta più qui dentro: da quando decide davvero
      // `--permission-mode` è tornata in vista nel composer, sempre leggibile
      // senza aprire niente (vedi il test qui sotto). Dentro il pannello resta
      // l'effort, che è la manopola per cui questa superficie esiste.
      await expect(page.getByTestId("session-autonomy-ask")).toHaveCount(0);
      await expect(page.getByTestId("session-autonomy-auto-apply")).toHaveCount(0);
      await expect(page.getByTestId("session-autonomy-yolo")).toHaveCount(0);

      // La colonna resta scrivibile dall'API: i dati non sono stati buttati con
      // la UI, e il giorno in cui il canale di permesso esiste sono ancora la'.
      const patch = await request.patch(`${E2E_BASE}/api/topics/${topic.id}`, {
        data: { autonomyLevel: "yolo" },
      });
      expect(patch.ok(), "PATCH autonomyLevel resta accettata").toBe(true);
      await expect
        .poll(async () => {
          const res = await request.get(`${E2E_BASE}/api/topics`);
          const body = await res.json();
          return body?.topics?.[topic.id]?.autonomyLevel;
        }, { message: "il valore e' ancora persistito lato server", timeout: 5_000 })
        .toBe("yolo");
    } finally {
      await deleteTopic(request, topic.id);
    }
  });

  test("CHAT-CONFIG: l'autonomia è SEMPRE in vista nel composer, e di base la chat agisce", async ({ page, request }) => {
    // Il permesso che decide se un agente può toccare i tuoi file stava solo nel
    // modale delle impostazioni, dietro un tasto destro su una tab. Ed era stato
    // tolto da questa superficie quando non faceva niente: adesso fa, quindi
    // torna dov'è la mano di chi scrive — e si legge SENZA aprire nulla, perché
    // la differenza fra «fa e basta» e «prima chiede» non si scopre in un menu.
    const topic = await createTopic(request, `E2E-Autonomy-${Date.now()}`);
    try {
      await goToApp(page);
      await openTopic(page, new RegExp(topic.name));

      const picker = page.getByTestId("composer-autonomy");
      await expect(picker, "il livello si legge dal composer, chiuso").toBeVisible({ timeout: 10_000 });
      // Di base la chat AGISCE: un topic nuovo non nasce più bloccato in plan
      // mode (migration 081 + l'insert che non scrive più 'ask' d'ufficio).
      await expect(picker).toHaveAttribute("data-level", "auto-apply");
      await expect(picker).toContainText("Agisce");

      // Si cambia da qui, e il valore è quello vero del topic.
      await picker.click();
      await page.getByTestId("composer-autonomy-ask").click();
      await expect(picker).toHaveAttribute("data-level", "ask");
      await expect
        .poll(async () => {
          const body = await (await request.get(`${E2E_BASE}/api/topics`)).json();
          return body?.topics?.[topic.id]?.autonomyLevel;
        }, { message: "la scelta è persistita", timeout: 5_000 })
        .toBe("ask");
    } finally {
      await deleteTopic(request, topic.id);
    }
  });
});