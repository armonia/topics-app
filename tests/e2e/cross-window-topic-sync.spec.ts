import { expect, test } from "@playwright/test";
import { goToApp, ensureTopicVisible } from "./helpers";
import { E2E_BASE, E2E_DATA_DIR } from "./helpers/test-server";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  seedProjectInnerChats,
} from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const BASE = E2E_BASE;

/**
 * Cross-window topic + message sync.
 *
 * Verifies that:
 *  - A topic created via the API on window A's behalf appears in window B's
 *    sidebar in real-time (WS `topic:created`).
 *  - A topic created via the API inside a project appears as a chat tab in
 *    window B's project view in real-time (no manual refresh).
 *  - A user message broadcast from window A appears in window B's open chat
 *    pane in real-time (WS `message:new` with content + messageId).
 *  - Reload window B and the topic is still there (server is the source of
 *    truth — fix isn't masking via stale cache).
 *
 * Mirrors the user's bug report:
 *   "apro una chat all'interno di un progetto come nuova tab; aprendola
 *    sull'applicazione Electron non la vedo poi da browser".
 */
test.describe.serial("Cross-window topic + message sync", () => {
  const projectPath = E2E_DATA_DIR;

  // Ogni test qui apre DUE contesti sullo stesso server, e il pane-store è uno
  // solo per tutta la suite seriale: con le pane dei file precedenti ancora
  // aperte le due finestre nascono già piene, la barra dei tab va in overflow e
  // il tab appena creato (New Chat / la chat sincronizzata) non è più visibile.
  // I test seminano da sé ciò che gli serve — createTopic apre il tab e il test
  // del progetto riscrive per intero il layout interno con seedProjectInnerChats.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, []);
  });

  test("topic:created broadcast surfaces topic in other window's sidebar", async ({
    browser,
    request,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    let topicId = "";
    try {
      await goToApp(pageA);
      await goToApp(pageB);

      // Create from "window A's perspective" via API — server broadcasts
      // topic:created to all WS clients including window B.
      const topicName = `XWin Sync ${Date.now()}`;
      const t = await createTopic(request, topicName);
      topicId = t.id;

      // Window B should see the topic in its sidebar without reload.
      await expect(
        pageB.getByRole("treeitem", { name: new RegExp(topicName) }),
      ).toBeVisible({ timeout: 5000 });

      // Sanity: window A also sees it.
      await expect(
        pageA.getByRole("treeitem", { name: new RegExp(topicName) }),
      ).toBeVisible({ timeout: 5000 });

      // Reload B — server is source of truth, topic must persist.
      await pageB.reload();
      await pageB.waitForSelector('[aria-label="Topics sidebar"]', {
        state: "visible",
        timeout: 15000,
      });
      await expect(
        pageB.getByRole("treeitem", { name: new RegExp(topicName) }),
      ).toBeVisible({ timeout: 10000 });
    } finally {
      if (topicId) await deleteTopic(request, topicId);
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("project topic created in window A surfaces as chat tab in window B's project view", async ({
    browser,
    request,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // Pre-seed a topic in the project so window B has the project open.
    const seedName = `XWin Seed ${Date.now()}`;
    const seed = await createTopic(request, seedName, { projectPath });
    // A project-bound topic renders as a sidebar CHILD only while it has an open
    // inner tab (buildSidebarItems), and that inner layout lives server-side under
    // `topics-project-panes-<hash>` (union-hydrated on every reload). A fresh
    // Playwright context has no localStorage to supply it, so without this the
    // seed topic never appears under window B's project accordion. Seed it as an
    // open inner chat so both windows surface the project row + this child.
    await seedProjectInnerChats(request, projectPath, [seed.id]);

    let newTopicId = "";
    try {
      await goToApp(pageA);
      await goToApp(pageB);

      // The seeded topic has a projectPath, so window B nests it under its
      // project accordion (collapsed by default) — the top-level treeitem never
      // renders until the group is expanded. Wait for the project row, expand it
      // if collapsed, THEN click the seed topic to bring the project pane in view.
      const projectName = projectPath.split("/").pop()!;
      await expect(
        pageB.getByRole("button", { name: `${projectName} project` }).first(),
      ).toBeVisible({ timeout: 10000 });
      const expandProject = pageB.getByRole("button", { name: `Expand ${projectName}` }).first();
      if (await expandProject.isVisible().catch(() => false)) {
        await expandProject.click();
      }
      await expect(
        pageB.getByRole("treeitem", { name: new RegExp(seedName) }),
      ).toBeVisible({ timeout: 10000 });
      await pageB.getByRole("treeitem", { name: new RegExp(seedName) }).dblclick();
      // Project view should mount (we look for the seed tab inside the main area).
      await expect(
        pageB.locator('[role="main"]'),
      ).toBeVisible({ timeout: 10000 });

      // Create a new topic in the same project — server broadcasts topic:created.
      const newName = `XWin NewTab ${Date.now()}`;
      const newTopic = await createTopic(request, newName, { projectPath });
      newTopicId = newTopic.id;

      // Window B's project view should now show the new chat tab without reload.
      // Tab strips render with text content matching the topic name.
      await expect(
        pageB.locator('[role="main"]').getByText(newName, { exact: false }).first(),
      ).toBeVisible({ timeout: 8000 });
    } finally {
      if (newTopicId) await deleteTopic(request, newTopicId);
      await deleteTopic(request, seed.id);
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("message:new from window A appears in window B's open chat pane", async ({
    browser,
    request,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const topicName = `XWin Msg ${Date.now()}`;
    const topic = await createTopic(request, topicName);
    const topicId = topic.id;

    try {
      // Get the topic's sessionKey so we can post a system-message via API
      // (simulates an external write — exercises the message:new emission).
      const topicResp = await request.get(`${BASE}/api/topics`);
      const topicsData = (await topicResp.json()) as {
        topics?: Record<string, { id: string; sessionKey?: string }>;
      };
      const sessionKey = topicsData.topics?.[topicId]?.sessionKey;
      expect(sessionKey).toBeTruthy();

      // Both windows open the topic.
      await goToApp(pageA);
      await goToApp(pageB);
      await pageA
        .getByRole("treeitem", { name: new RegExp(topicName) })
        .dblclick();
      await pageB
        .getByRole("treeitem", { name: new RegExp(topicName) })
        .dblclick();

      // Wait for chat areas to render.
      await expect(pageA.locator('[role="main"]')).toBeVisible({ timeout: 10000 });
      await expect(pageB.locator('[role="main"]')).toBeVisible({ timeout: 10000 });

      // Post a system-message via REST — server emits a message:new with
      // both `content` and `messageId`. Both windows should pick it up.
      const uniqueMarker = `xwin-msg-${Date.now()}`;
      const postRes = await request.post(
        `${BASE}/api/topics/${topicId}/system-message`,
        { data: { content: `Cross-window test: ${uniqueMarker}` } },
      );
      expect(postRes.ok()).toBeTruthy();

      // Both windows should display the message — DENTRO la conversazione.
      // Cercarlo in tutta la pagina lo trova anche nell'anteprima della sidebar
      // (`topic-preview`, la riga dell'ultimo messaggio sotto il nome del
      // topic), e lo trova PRIMA: la sidebar si aggiorna comunque, quindi il
      // test poteva passare anche con la pane della chat completamente muta —
      // che e' esattamente la regressione che dice di sorvegliare.
      await expect(
        pageA.locator('[role="main"]').getByText(new RegExp(uniqueMarker)),
      ).toBeVisible({ timeout: 8000 });
      await expect(
        pageB.locator('[role="main"]').getByText(new RegExp(uniqueMarker)),
      ).toBeVisible({ timeout: 8000 });
    } finally {
      await deleteTopic(request, topicId);
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("App-level new chat (draft) opens and stays while you're on it", async ({
    browser,
  }) => {
    // Regression guard: a new App-level chat (no project) was opening and
    // immediately closing after the cross-window sync fix. The DRAFT pane
    // must remain visible long enough for the user to type their first
    // message (which then promotes the draft to a real topic).
    //
    // La bozza vuota adesso SI congeda da sola, ma solo quando smetti di
    // guardarla (vedi `draft-pane-lifecycle.spec.ts`): finché è la pane a
    // fuoco resta, ed è esattamente ciò che questo test misura.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      // "+ → New Chat" c'è sempre: il gate `enableNewChat` è stato rimosso
      // (2026-08-06), quindi niente da seminare prima del primo paint.
      await goToApp(page);

      // Open an existing topic first so the standalone chat group renders
      // (the "+ Add pane" button only appears when the group is mounted).
      // Then click + → New Chat to trigger the App-level draft creation
      // path that broke ("apro fuori da un progetto, si chiude subito").
      await ensureTopicVisible(page, /Web Search Test/);
      await page
        .getByRole("treeitem", { name: /Web Search Test/ })
        .first()
        .dblclick();
      await expect(page.locator('[role="main"]')).toBeVisible({
        timeout: 10000,
      });

      const addPaneBtn = page.getByTitle("Add pane").first();
      await expect(addPaneBtn).toBeVisible({ timeout: 10000 });
      await addPaneBtn.click();

      // Agganciata al testId, non al testo: la voce si chiamava «New Chat», da
      // `f6838968` si chiama «Chat» (il verbo lo porta il trigger, che si chiama
      // «New») e porta accanto la sua lettera mnemonica — cioè il nome
      // accessibile non è più una costante. La TAB che ne nasce resta «New
      // Chat»: quello è il nome della chat, non del comando.
      const newChatBtn = page.getByTestId("pane-add-menu-new-chat").first();
      await expect(newChatBtn).toBeVisible({ timeout: 5000 });
      await newChatBtn.click();

      // The draft pane should now be active. Verify a "New Chat" tab is
      // visible AND remains visible after 1.5s (regression guard — the
      // bug was "tab opens and immediately closes" within ~100-500ms).
      const draftTab = page
        .locator('[data-testid="panel-tab-bar"]')
        .first()
        .getByText(/^New Chat$/)
        .first();
      await expect(draftTab).toBeVisible({ timeout: 5000 });

      await page.waitForTimeout(1500);
      await expect(draftTab).toBeVisible();

      // The chat input should be present and ready to receive a first message —
      // quella DELLA BOZZA, non «la prima textarea della pagina».
      //
      // Il test apriva prima «Web Search Test» e poi la nuova chat, e finché
      // aprire una chat ne SOSTITUIVA un'altra restava una pane sola: `.first()`
      // pescava per forza la bozza. Da `217ff8f5` l'apertura aggiunge invece di
      // sostituire (aprire una chat non ne archivia più un'altra), le due pane
      // convivono, e `.first()` prendeva la textarea di «Web Search Test» — che
      // essendo nella pane non attiva è NASCOSTA. Misurato nella run completa
      // del 04/08: `9 × locator resolved to <textarea … aria-label="Message
      // input for Web Search Test">` con «unexpected value hidden».
      //
      // Il test non stava sbagliando diagnosi: stava guardando la chat sbagliata.
      const textarea = page.getByLabel("New Chat panel").locator("textarea").first();
      await expect(textarea).toBeVisible({ timeout: 5000 });
    } finally {
      await ctx.close();
    }
  });

  test("message:new dedupes by messageId — no duplicates after reload race", async ({
    browser,
    request,
  }) => {
    // Stresses the dedupe: post a system-message, then immediately reload
    // window B. The history fetch and a possibly-still-in-flight WS push
    // should converge to exactly one rendered message — no duplicate.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    const topicName = `XWin Dedupe ${Date.now()}`;
    const topic = await createTopic(request, topicName);
    const topicId = topic.id;

    try {
      await goToApp(page);
      await page
        .getByRole("treeitem", { name: new RegExp(topicName) })
        .dblclick();
      await expect(page.locator('[role="main"]')).toBeVisible({ timeout: 10000 });

      const marker = `dedupe-${Date.now()}`;
      const messageContent = `Dedupe test ${marker}`;
      const postRes = await request.post(
        `${BASE}/api/topics/${topicId}/system-message`,
        { data: { content: messageContent } },
      );
      expect(postRes.ok()).toBeTruthy();

      // The message arrives via WS push.
      await expect(
        page.getByText(new RegExp(marker)),
      ).toBeVisible({ timeout: 8000 });

      // Now reload — the page re-fetches history. If dedupe is broken,
      // the same message would appear twice (history + WS push merged
      // without id-dedupe).
      await page.reload();
      await page.waitForSelector('[aria-label="Topics sidebar"]', {
        state: "visible",
        timeout: 15000,
      });
      await page
        .getByRole("treeitem", { name: new RegExp(topicName) })
        .dblclick();
      // DENTRO la conversazione, non «da qualche parte nella pagina». Il
      // conteggio su tutta la pagina misurava anche l'ANTEPRIMA che la sidebar
      // stampa sotto il nome del topic (`[data-testid="topic-preview"]`, riga
      // dell'ultimo messaggio): due nodi con lo stesso testo, e il test rosso
      // diceva «messaggio duplicato» mentre di messaggi ce n'era uno solo.
      // Nessun dedupe era rotto — era il locator a contare una cosa diversa da
      // quella che il test dichiara di misurare, ed e' lo stesso difetto gia'
      // scritto in `PaneTabBar.tsx`: agganciarsi a cio' che si vede invece che
      // a un appiglio stabile.
      const conversazione = page.locator('[role="main"]');
      await expect(
        conversazione.getByText(new RegExp(marker)),
      ).toBeVisible({ timeout: 8000 });

      const occurrences = await conversazione.getByText(new RegExp(marker)).count();
      expect(occurrences).toBe(1);
    } finally {
      await deleteTopic(request, topicId);
      await ctx.close();
    }
  });

  test("App-level draft survives a concurrent client's pane-store-v2 broadcast", async ({
    browser,
    request,
  }) => {
    // Regression guard for the "ora la nuova chat App-level si chiude subito"
    // report. With Electron + browser pointed at the same server, Electron's
    // 500 ms-debounced PUTs broadcast back as ui-state:updated to all clients.
    // Pre-fix, the receiving client dispatched HYDRATE_FROM_SNAPSHOT with the
    // remote (draft-less) snapshot, and `state.panes = clean.panes` wiped the
    // local draft within ~300 ms of creation. Drafts are device-local; this
    // test creates an App-level draft and then simulates a concurrent client
    // by PUTing a higher-seq snapshot that doesn't know about it.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      // La riga "New Chat" c'è sempre: gate `enableNewChat` rimosso (2026-08-06).
      await goToApp(page);

      // Open an existing topic so the standalone chat group (and its "Add pane"
      // button) mount, then + → New Chat to create the App-level draft — the
      // exact path the "nuova chat App-level si chiude subito" report broke.
      // (The prior top-bar "New" button was removed; the add-pane trigger now
      // carries title="Add pane", and New Chat lives inside its menu.)
      await ensureTopicVisible(page, /Web Search Test/);
      await page
        .getByRole("treeitem", { name: /Web Search Test/ })
        .first()
        .dblclick();
      await expect(page.locator('[role="main"]')).toBeVisible({ timeout: 10000 });

      const addPaneBtn = page.getByTitle("Add pane").first();
      await expect(addPaneBtn).toBeVisible({ timeout: 10000 });
      await addPaneBtn.click();

      // Agganciata al testId, non al testo: la voce si chiamava «New Chat», da
      // `f6838968` si chiama «Chat» (il verbo lo porta il trigger, che si chiama
      // «New») e porta accanto la sua lettera mnemonica — cioè il nome
      // accessibile non è più una costante. La TAB che ne nasce resta «New
      // Chat»: quello è il nome della chat, non del comando.
      const newChatBtn = page.getByTestId("pane-add-menu-new-chat").first();
      await expect(newChatBtn).toBeVisible({ timeout: 5000 });
      await newChatBtn.click();

      // Confirm the draft tab rendered before the broadcast lands.
      const draftTab = page
        .locator('[data-pane-id^="draft:"], [data-paneid^="draft:"], [id^="draft:"]')
        .first();
      const newChatTab = page.getByText("New Chat").last();
      await expect(newChatTab).toBeVisible({ timeout: 3000 });

      // Simulate a concurrent client (Electron) PUTing a higher-seq snapshot
      // that doesn't know about the draft. Server broadcasts it back to this
      // page as ui-state:updated → HYDRATE_FROM_SNAPSHOT.
      const concurrent = {
        panes: {},
        groups: {
          "group:default": {
            id: "group:default",
            paneIds: [],
            splitRatio: 0.5,
            splitAxis: "horizontal",
          },
        },
        projects: {},
        groupOrder: ["group:default"],
        closedStack: [],
        lastSeq: Date.now(),
      };
      const putRes = await request.put(`${BASE}/api/ui-state/pane-store-v2`, {
        data: { value: concurrent, payload_version: 1 },
        headers: {
          "Content-Type": "application/json",
          "X-Client-Id": "test-electron-sim",
        },
      });
      expect(putRes.ok()).toBeTruthy();

      // Wait long enough for the WS broadcast to land + reducer to apply.
      await page.waitForTimeout(2000);

      // The draft tab must still render — pre-fix this would disappear.
      await expect(newChatTab).toBeVisible();
      // Sanity: also probe via the DOM-attached pane id selectors.
      const draftCount = await draftTab.count();
      expect(draftCount).toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }
  });
});
