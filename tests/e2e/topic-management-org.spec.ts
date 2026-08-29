/**
 * Topic Management - Settings & Organization E2E Tests
 *
 * Tests for TOPIC-07 (settings modal), TOPIC-09 (project folders),
 * TOPIC-10 (unread indicators), TOPIC-11 (color customization),
 * TOPIC-12 (drag-reorder).
 *
 * CONVENTION: No waitForTimeout() usage.
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, rmSync } from "fs";
import { goToApp, openTopic } from "./helpers";
import {
  createTopic,
  deleteTopic,
  resetPaneStore,
  seedProjectPane,
} from "./helpers/api-fixtures";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

const TS = Date.now();

/** Navigate to the app and open a specific topic using search */
async function gotoAndOpenTopic(
  page: import("@playwright/test").Page,
  topicName: RegExp
) {
  await goToApp(page);
  await openTopicViaSearch(page, topicName);
}

/** Open a topic via the sidebar search, then clear the search and ensure the topic tab is active */
async function openTopicViaSearch(
  page: import("@playwright/test").Page,
  name: RegExp
) {
  const searchbox = page.getByRole("searchbox", { name: /Search topics/ });
  const searchText = name.source.replace(/[\\^$.*+?()[\]{}|]/g, "");
  await searchbox.fill(searchText);

  // In search mode, results render as buttons
  const searchResult = page.getByRole("button", { name });
  await searchResult.waitFor({ state: "visible", timeout: 5000 });
  // Double-click to permanently open (single click opens as preview which may not stick)
  await searchResult.dblclick();

  // Clear search to return to normal sidebar view
  await searchbox.fill("");

  // Wait for the main area to be ready
  await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 10000 });

  // Ensure the topic's tab is active by clicking on it in the tab bar
  // The tab text is in the main area header
  const topicTab = page.locator('[role="main"]').getByText(name).first();
  const tabVisible = await topicTab.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false);
  if (tabVisible) {
    await topicTab.click();
  }
}

/** Find a topic in the sidebar.
 *
 *  A note used to sit here saying dnd-kit's `useSortable` overrode
 *  `role="treeitem"` with `role="button"`. It was already false when written -
 *  that `role` was stripped by the spread right below the hook - and it is
 *  doubly false now that the hook is gone. The locator anchors on
 *  `[aria-label]` rather than on the role, so nothing ever depended on it: it
 *  was stale documentation pointing at a cause that does not exist.
 *
 *  Qui c'era prima un «apri la sezione Chat se è chiusa». Le intestazioni per
 *  TIPO non esistono più in nessuna vista (28b4aaeb, «Via la vista per tipo»):
 *  il blocco era un no-op protetto da `count() > 0`, cioè codice che descriveva
 *  un prodotto che non c'è e non poteva far fallire niente. */
async function ensureTopicVisible(
  page: import("@playwright/test").Page,
  name: RegExp
) {
  // Exact attribute, not the role: `aria-label` separates the chat from
  // "Archive E2E-...", which a partial match would also take.
  const sidebar = page.locator('[aria-label="Topics sidebar"]');
  const nameStr = name.source.replace(/[\\^$.*+?()[\]{}|]/g, "");
  const topicItem = sidebar.locator(`[aria-label="${nameStr}"]`);

  await topicItem.waitFor({ state: "visible", timeout: 10000 });
  return topicItem;
}

// Cartella VERA: la riga di progetto in sidebar risolve il nome dal path e
// `/api/projects/icon` va a guardarci dentro. Nome unico → riga propria.
const PROJECT_PATH = `/tmp/e2e-topic-org-project-${TS}`;
const PROJECT_NAME = PROJECT_PATH.split("/").pop()!;
const PROJECT_CHAT_NAME = `E2E-InProject-${TS}`;

test.describe("Topic Management - Settings & Organization", () => {
  let alphaId: string;
  let betaId: string;
  let gammaId: string;
  let projectChatId: string;

  test.beforeAll(async ({ request }) => {
    const alpha = await createTopic(request, `E2E-Alpha-${TS}`);
    const beta = await createTopic(request, `E2E-Beta-${TS}`);
    const gamma = await createTopic(request, `E2E-Gamma-${TS}`);
    alphaId = alpha.id;
    betaId = beta.id;
    gammaId = gamma.id;
    // Progetto + una chat dentro, per TOPIC-09 (la cartella e il suo figlio).
    mkdirSync(PROJECT_PATH, { recursive: true });
    const inProject = await createTopic(request, PROJECT_CHAT_NAME, {
      projectPath: PROJECT_PATH,
    });
    projectChatId = inProject.id;
  });

  test.afterAll(async ({ request }) => {
    await deleteTopic(request, alphaId).catch(() => {});
    await deleteTopic(request, betaId).catch(() => {});
    await deleteTopic(request, gammaId).catch(() => {});
    await deleteTopic(request, projectChatId).catch(() => {});
    rmSync(PROJECT_PATH, { recursive: true, force: true });
  });

  // Il reset era in UN solo test (TOPIC-10, sotto): serve a tutti. Il pane-store
  // è UNO per l'intera suite seriale, e questi test contano/riordinano righe
  // nella sidebar, che elenca una chat standalone solo se ha un tab aperto —
  // quindi si riparte esattamente dai tre topic del beforeAll, né più né meno.
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [alphaId, betaId, gammaId]);
  });

  test("TOPICUI-07: topic settings modal with system prompt and context files", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-02" });
    await goToApp(page);

    // Click the topic in the sidebar to open it as a panel
    const topicBtn = await ensureTopicVisible(page, new RegExp(`E2E-Alpha-${TS}`));
    await topicBtn.click();

    // Wait for the tab to appear, then click it using evaluate to avoid DOM detachment issues
    await expect(async () => {
      const found = await page.evaluate((ts) => {
        const spans = document.querySelectorAll('[role="main"] span');
        for (const span of spans) {
          if (span.textContent?.includes(`E2E-Alpha-${ts}`)) {
            // Click the parent tab element
            const tab = span.closest('[draggable], [class*="cursor-pointer"]') || span.parentElement;
            if (tab) (tab as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, `${TS}`);
      expect(found).toBe(true);
    }).toPass({ timeout: 5000 });

    // Wait for chat input to confirm the topic is actively shown
    const chatInput = page.locator(`[aria-label*="Message input for E2E-Alpha"]`);
    await expect(chatInput).toBeVisible({ timeout: 10000 });

    // Open settings modal via tab right-click context menu
    const mainArea = page.locator('[role="main"]');
    const topicTabText = mainArea.getByText(new RegExp(`E2E-Alpha-${TS}`)).first();
    await expect(topicTabText).toBeVisible({ timeout: 3000 });
    // Right-click using dispatchEvent to avoid DOM detachment
    await topicTabText.dispatchEvent("contextmenu");

    // Wait for and click "Impostazioni" in the tab context menu
    const settingsMenuItem = page.locator('button').filter({ hasText: /^Impostazioni$/ });
    await expect(settingsMenuItem).toBeVisible({ timeout: 3000 });
    await settingsMenuItem.click();

    // Wait for settings dialog to appear
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // --- System prompt ---
    const promptTextarea = page.getByLabel("System prompt");
    await expect(promptTextarea).toBeVisible();
    await promptTextarea.fill(
      "You are a helpful test assistant for E2E testing."
    );

    // --- Context files ---
    const fileInput = page.getByLabel("Add context file");
    await expect(fileInput).toBeVisible();
    await fileInput.fill("/tmp/test-context.md");
    await fileInput.press("Enter");

    // Verify file appears in the context files list
    const filesList = page.getByLabel("Context files list");
    await expect(filesList).toContainText("test-context.md");

    // Save changes
    const saveBtn = dialog.getByRole("button", { name: /^Save$/i });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Wait for save confirmation -- Save button becomes disabled after save completes
    await expect(saveBtn).toBeDisabled({ timeout: 5000 });

    // Reload and verify persistence
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });

    // Re-open the topic by clicking it in sidebar
    const topicBtnReload = await ensureTopicVisible(page, new RegExp(`E2E-Alpha-${TS}`));
    await topicBtnReload.click();

    // Click on the tab to make it active
    await expect(async () => {
      const found = await page.evaluate((ts) => {
        const spans = document.querySelectorAll('[role="main"] span');
        for (const span of spans) {
          if (span.textContent?.includes(`E2E-Alpha-${ts}`)) {
            const tab = span.closest('[draggable], [class*="cursor-pointer"]') || span.parentElement;
            if (tab) (tab as HTMLElement).click();
            return true;
          }
        }
        return false;
      }, `${TS}`);
      expect(found).toBe(true);
    }).toPass({ timeout: 5000 });

    // Wait for chat input
    await expect(page.locator(`[aria-label*="Message input for E2E-Alpha"]`)).toBeVisible({ timeout: 10000 });

    // Re-open settings via tab right-click context menu
    const mainAreaReload = page.locator('[role="main"]');
    const topicTabReload = mainAreaReload.getByText(new RegExp(`E2E-Alpha-${TS}`)).first();
    await expect(topicTabReload).toBeVisible({ timeout: 3000 });
    await topicTabReload.dispatchEvent("contextmenu");
    const settingsMenuReload = page.locator('button').filter({ hasText: /^Impostazioni$/ });
    await expect(settingsMenuReload).toBeVisible({ timeout: 3000 });
    await settingsMenuReload.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });

    // Verify system prompt persisted
    await expect(page.getByLabel("System prompt")).toHaveValue(
      "You are a helpful test assistant for E2E testing."
    );

    // Verify context file persisted
    await expect(page.getByLabel("Context files list")).toContainText(
      "test-context.md"
    );
  });

  // TOPIC-09 — la CARTELLA DI PROGETTO si apre e si chiude, che è quello che il
  // titolo di questo test ha sempre detto.
  //
  // Il corpo, invece, guardava la «sezione Chat» della vista per TIPO: un
  // raggruppamento diverso (per tipo di riga, non per progetto) che è stato
  // TOLTO dal prodotto il 06/08 — commit 28b4aaeb, «Via la vista per tipo»:
  // `viewMode: 'grouped'` non esiste più (`hydrateSidebarState` lo fa ricadere
  // su 'timeline', useSidebarState.ts:155) e `renderSection` ha un solo
  // chiamante, le sezioni per STATO. Quel commit dichiara di aver riscritto «i
  // test che asseriavano le sezioni per tipo»: ne ha aggiornato uno
  // (panels.spec.ts) e ha mancato questo, che da allora cerca un bottone
  // `sezione Chat` che nessuna vista disegna.
  //
  // L'invariante che il test proteggeva — «un contenitore della sidebar si
  // richiude e i suoi figli spariscono, si riapre e tornano» — è intatta e vive
  // sulla riga di progetto, che è anche ciò che il nome del test promette. Il
  // chevron è un controllo A SÉ dal nome del progetto (TopicTree.tsx §Project
  // header): apre e chiude soltanto, senza mai spostare il fuoco.
  test("TOPICUI-09: project folder expand and collapse", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-09" });
    // Il figlio deve avere una NOTIFICA per comparire senza una tab aperta:
    // `buildSidebarItems` elenca una chat di progetto solo se ha una pane aperta
    // dentro il progetto, un'attenzione pendente, o è fissata. L'`unread:updated`
    // iniettato è la stessa strada di TOPIC-10.
    const ws = await interceptWebSocket(page);
    // La riga del progetto esiste finché la sua pane è aperta (`hasProjectTab`):
    // il beforeEach ha appena azzerato il pane-store, quindi si semina QUI.
    await seedProjectPane(page.request, PROJECT_PATH);
    await goToApp(page);

    const chevron = page.getByRole("button", { name: `Expand ${PROJECT_NAME}` }).or(
      page.getByRole("button", { name: `Collapse ${PROJECT_NAME}` }),
    );
    await expect(chevron).toBeVisible({ timeout: 10000 });

    ws.send({ type: "unread:updated", topicId: projectChatId, unreadCount: 2 });

    // Si parte da APERTA, qualunque fosse lo stato iniziale, così le due metà
    // dell'asserzione (chiudi → sparisce, riapri → torna) partono da un punto noto.
    if ((await chevron.getAttribute("aria-expanded")) === "false") await chevron.click();
    await expect(chevron).toHaveAttribute("aria-expanded", "true");
    const childRow = page
      .locator('[aria-label="Topics sidebar"]')
      .locator(`[aria-label="${PROJECT_CHAT_NAME}"]`);
    await expect(childRow).toBeVisible({ timeout: 10000 });

    // Chiudi: l'attributo cambia E il figlio sparisce davvero.
    await chevron.click();
    await expect(chevron).toHaveAttribute("aria-expanded", "false");
    await expect(childRow).toHaveCount(0);

    // Riapri: torna com'era.
    await chevron.click();
    await expect(chevron).toHaveAttribute("aria-expanded", "true");
    await expect(childRow).toBeVisible({ timeout: 10000 });
  });

  test("TOPICUI-10: unread indicator via WebSocket mock", async ({ page }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-02" });
    // Intercept WebSocket BEFORE page.goto() — keeps real connection alive + allows injection
    const ws = await interceptWebSocket(page);

    // Reset the authoritative pane-store to EXACTLY [alpha, beta] so hydrate yields
    // a clean two-tab layout (one active). In the accumulated shared-DB state Alpha
    // could hydrate as an open/visible pane (or a split alongside Beta) — and the
    // client suppresses the unread badge for a topic whose pane is currently shown,
    // so the injected unread:updated would never paint. With this reset, clicking
    // Beta activates Beta and leaves Alpha an INACTIVE tab (still a sidebar row),
    // which is the precondition the badge assertion needs.
    // Niente `.catch`: un reset che fallisce in silenzio si traveste da
    // asserzione rotta dieci secondi dopo.
    await resetPaneStore(page.request, [alphaId, betaId]);

    // Navigate to the app
    await goToApp(page);

    // (Niente «apri la sezione Chat»: le sezioni per tipo non esistono più —
    // vedi il cappello di ensureTopicVisible.)

    // Click on Beta topic to make it focused (so Alpha is unfocused and can show unread badge)
    const betaTopic = page.getByRole("treeitem", { name: new RegExp(`E2E-Beta-${TS}`) });
    await betaTopic.waitFor({ state: "visible", timeout: 10000 });
    await betaTopic.click();
    await page.locator('[role="main"]').waitFor({ state: "visible", timeout: 5000 });

    // Inject unread:updated event for Alpha topic via intercepted WebSocket
    ws.send({
      type: "unread:updated",
      topicId: alphaId,
      unreadCount: 3,
    });

    // Verify unread badge appears on Alpha topic (which is visible but not focused)
    const alphaTopic = page.getByRole("treeitem", { name: new RegExp(`E2E-Alpha-${TS}`) });
    await alphaTopic.waitFor({ state: "visible", timeout: 10000 });

    // The unread badge shows the count inside a styled span. Target by aria-label
    // (NotificationBadge renders aria-label=`${count} unread`) — the broad
    // span+hasText:"3" also matched the topic-name span (strict-mode violation).
    const badge = alphaTopic.locator('span[aria-label="3 unread"]');
    await expect(badge).toBeVisible({ timeout: 5000 });
  });

  test("TOPICUI-11: color customization via context menu persists", async ({
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "TOPIC-02" });
    // Navigate to app and find Beta topic
    await goToApp(page);
    const betaTopic = await ensureTopicVisible(page, new RegExp(`E2E-Beta-${TS}`));

    // Right-click to open context menu
    await betaTopic.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: 5000 });

    // Click "Cambia colore" menuitem to open color submenu
    await menu.getByRole("menuitem", { name: /Cambia colore/i }).click();

    // Wait for color submenu to appear
    await expect(menu.getByText("Scegli colore")).toBeVisible({ timeout: 3000 });

    // Click the green color swatch (#059669 = rgb(5, 150, 105))
    await menu.getByRole("button", { name: "Colore #059669" }).click();

    // Context menu should auto-close (handleColorChange calls onClose)
    await expect(menu).toBeHidden({ timeout: 3000 });

    // The colour is DATA, not a sidebar decoration: the redesign dropped the
    // coloured accent from the tree row (nothing under components/Sidebar reads
    // `topic.color` any more — it feeds the pane/settings surfaces instead), so
    // asserting a tinted svg in the row tested an affordance that no longer
    // exists. What the feature must still guarantee is that the pick STICKS.
    // GET /api/topics returns `{ topics: Record<id, Topic>, … }` — a keyed map.
    const colorOf = async () => {
      const res = await page.request.get(`${E2E_BASE}/api/topics`);
      const body = await res.json();
      return body?.topics?.[betaId]?.color;
    };
    await expect.poll(colorOf, {
      message: "the picked colour is persisted server-side",
      timeout: 5000,
    }).toBe("#059669");

    // …and that it survives a reload: reopening the submenu shows THAT swatch
    // as the selected one (ContextMenu marks `topic.color === color` with the
    // scale-110 ring), which is the user-visible proof the value round-tripped.
    await page.reload();
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
    const betaAfterReload = await ensureTopicVisible(page, new RegExp(`E2E-Beta-${TS}`));
    await betaAfterReload.click({ button: "right" });
    const menuAfterReload = page.getByRole("menu");
    await expect(menuAfterReload).toBeVisible({ timeout: 5000 });
    await menuAfterReload.getByRole("menuitem", { name: /Cambia colore/i }).click();
    await expect(menuAfterReload.getByText("Scegli colore")).toBeVisible({ timeout: 3000 });
    await expect(
      menuAfterReload.getByRole("button", { name: "Colore #059669" }),
      "the previously picked swatch is marked selected after reload",
    ).toHaveClass(/scale-110/);
  });

  // TOPIC-12 ("drag-reorder using dnd-helpers persists across reload") was
  // deleted with the feature: manual topic drag-reorder is gone from the UI
  // (no DndContext in the sidebar, and `topicsApi.reorder` has zero callers).
  // The POST /api/topics/reorder route still exists server-side but is
  // unreachable from the client. Restore from git history if reorder is
  // re-wired.
});
