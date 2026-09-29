/**
 * ONE TAB, THREE ZONES: the label stays, state lives in one slot on the right,
 * and the command takes the slot's place.
 *
 * THE BUG THIS EXISTS FOR. A tab is 150px wide and its label was the only part
 * that shrank, while every signal (project marker, org badge, count, pin,
 * elapsed time, loader) sat in flow between the label and the edge. On the
 * project tab «Armonia» of 29/09 six of them left the name at zero, and each
 * one that appeared or changed text ("5m" to "12m") moved the name again. Under
 * the pointer, Stop and Close stood side by side.
 *
 * So this file MEASURES, with `boundingBox`, not with impressions:
 *  a) a project tab carrying every signal at once keeps a label of 56px or more;
 *  b) a chat tab walked through rest, working, attention, hover and stopped
 *     keeps its label and its slot at the same x and the same width;
 *  c) on a streaming chat the slot is Stop with no Close beside it, and after
 *     Stop the same slot is Close;
 *  d) a project tab with a working child offers Close, never Stop;
 *  e) a browser tab whose kind comes and goes (the agent takes the wheel and
 *     gives it back) keeps its label at the same x and width: the kind is a
 *     corner mark on the favicon, not a fourth zone in flow;
 *  f) a "99+" count stays inside the 20px slot, and the exact count is in the
 *     tab's accessible name.
 *
 * It is a behaviour: video on, the .webm is the evidence.
 *
 * @covers TABSLOT-01
 * @covers TABSLOT-02
 * @covers TABSLOT-03
 * @covers CHROME-12
 */
import { expect, mergeTests, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { test as chatTest } from "./fixtures/chat.fixture";
import { test as browserTest } from "./fixtures/browser-v2.fixture";
import { goToApp, openTopic } from "./helpers";
import {
  closeAllBrowserContexts, createTopic, deleteTopic, resetPaneStore, seedProjectInnerChats, waitForTopicVisible,
} from "./helpers/api-fixtures";
import { seedMessage } from "./helpers/seed-messages";
import { interceptWebSocket } from "./helpers/ws-helpers";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";

const test = mergeTests(chatTest, browserTest);
hermetic(test);
test.use({ video: "on" });

const BASE = E2E_BASE;
const TS = Date.now();
/** TABSLOT-01's floor for the label. */
const LABEL_MIN_PX = 56;
/** Two measures of one state are "the same place" within half a pixel. */
const SAME_PX = 0.5;
/** How long the held POST keeps a turn alive (see `startHeldTurn`). */
const HELD_TURN_MS = 20_000;

interface Box { x: number; width: number }

/** Where the label and the slot of a tab are, in page pixels. */
async function zones(tab: Locator): Promise<{ label: Box; slot: Box }> {
  const label = await tab.getByTestId("pane-tab-label").boundingBox();
  const slot = await tab.getByTestId("pane-tab-slot").boundingBox();
  expect(label, "the label is rendered").not.toBeNull();
  expect(slot, "the slot is rendered").not.toBeNull();
  return { label: { x: label!.x, width: label!.width }, slot: { x: slot!.x, width: slot!.width } };
}

/** The box of `inner` lies inside the box of `outer`, within half a pixel. */
async function expectInside(inner: Locator, outer: Locator, what: string) {
  const i = (await inner.boundingBox())!;
  const o = (await outer.boundingBox())!;
  console.log(`[fit] ${what}: inner x=${i.x.toFixed(2)} w=${i.width.toFixed(2)} | box x=${o.x.toFixed(2)} w=${o.width.toFixed(2)}`);
  expect(i.x, `${what}: left edge inside`).toBeGreaterThanOrEqual(o.x - SAME_PX);
  expect(i.x + i.width, `${what}: right edge inside`).toBeLessThanOrEqual(o.x + o.width + SAME_PX);
  expect(i.y, `${what}: top edge inside`).toBeGreaterThanOrEqual(o.y - SAME_PX);
  expect(i.y + i.height, `${what}: bottom edge inside`).toBeLessThanOrEqual(o.y + o.height + SAME_PX);
}

/** Park the pointer where no tab is, so "rest" really is rest. */
async function pointerAway(page: Page) {
  await page.mouse.move(640, 700);
}

/**
 * Hold the chat POST open: the assistant placeholder exists before the answer,
 * so the turn stays alive and stoppable for as long as the test needs it. The
 * same trick `tab-stop-before-close.spec.ts` uses.
 */
async function startHeldTurn(page: Page, input: Locator) {
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await new Promise((r) => setTimeout(r, HELD_TURN_MS));
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      body: "data: [DONE]\n\n",
    });
  });
  await input.click();
  await input.fill("ciao");
  await input.press("Enter");
}

/** Two exchanges on disk: with one, a stop falls into the "first question,
 *  changed my mind" branch and wipes the chat, which is another subject. */
async function seedTwoExchanges(request: import("@playwright/test").APIRequestContext, sessionKey: string) {
  await seedMessage(request, { sessionKey, role: "user", content: "domanda di prima" });
  await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di prima" });
  await seedMessage(request, { sessionKey, role: "user", content: "e poi?" });
  await seedMessage(request, { sessionKey, role: "assistant", content: "risposta di poi" });
}

test.describe.serial("Una tab, tre zone", () => {
  // ── the chat pair (b, c) ───────────────────────────────────────────────────
  let chatA = { id: "", name: "" };
  let chatB = { id: "", name: "" };
  // ── the project (a, d) ─────────────────────────────────────────────────────
  const SEED_PATH = canonicalTmpDir("e2e-tab-one-slot");
  let projectPath = "";
  let projectPaneId = "";
  let projectId = "";
  let childId = "";
  let childSessionKey = "";
  let orgId = "";
  let mateId = "";

  test.beforeAll(async ({ request }) => {
    chatA = await createTopic(request, `slot-A-${TS}`);
    chatB = await createTopic(request, `slot-B-${TS}`);
    const res = await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true });
    const { topics } = (await res.json()) as { topics: Record<string, { sessionKey: string; projectPath?: string }> };
    await seedTwoExchanges(request, topics[chatA.id]!.sessionKey);

    // The project, shared with somebody else: the org mark is one of the
    // signals the tab has to carry without paying for it with the label.
    mkdirSync(SEED_PATH, { recursive: true });
    writeFileSync(`${SEED_PATH}/package.json`, JSON.stringify({ name: "e2e-tab-one-slot" }));
    const orgs = ((await (await request.get(`${BASE}/api/auth/orgs`)).json()) as {
      orgs: Array<{ id: string; installation?: boolean }>;
    }).orgs;
    orgId = (orgs.find((o) => o.installation) ?? orgs[0])!.id;
    const created = await request.post(`${BASE}/api/projects`, { data: { name: `slot-${TS}`, path: SEED_PATH } });
    expect(created.ok(), "the project is created").toBeTruthy();
    projectId = ((await created.json()) as { id: string }).id;
    const invite = await request.post(`${BASE}/api/test/orgs/${orgId}/members`, { data: { name: "Compagna slot" } });
    expect(invite.ok(), "a second member makes the project shared").toBeTruthy();
    mateId = ((await invite.json()) as { personId: string }).personId;

    const child = await createTopic(request, `slot-child-${TS}`, { projectPath: SEED_PATH });
    childId = child.id;
    const again = (await (await request.get(`${BASE}/api/topics`, { ignoreHTTPSErrors: true })).json()) as {
      topics: Record<string, { sessionKey: string; projectPath?: string }>;
    };
    childSessionKey = again.topics[childId]!.sessionKey;
    projectPath = again.topics[childId]!.projectPath ?? "";
    expect(projectPath, "the child keeps its project").toBeTruthy();
    projectPaneId = `project:${encodeURIComponent(projectPath)}`;
    await seedProjectInnerChats(request, projectPath, [childId]);
  });

  test.afterAll(async ({ request }) => {
    for (const id of [chatA.id, chatB.id, childId]) if (id) await deleteTopic(request, id).catch(() => {});
    if (mateId) await request.delete(`${BASE}/api/auth/orgs/${orgId}/members?personId=${encodeURIComponent(mateId)}`).catch(() => {});
    if (projectId) await request.delete(`${BASE}/api/projects/${projectId}`).catch(() => {});
    removeTmpDir(SEED_PATH);
  });

  /** The child answers, as far as the status snapshot says: the project's
   *  roll-up turns without a real model behind it. Before `goToApp`. */
  async function armWorkingChild(page: Page) {
    await page.route("**/api/topics/streaming", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [{ topicId: childId, sessionKey: childSessionKey, state: "streaming" }] }),
      }),
    );
  }

  /** The project tab, NOT selected (the chat beside it is), with a working child. */
  async function projectTabAtRest(page: Page, request: import("@playwright/test").APIRequestContext) {
    await resetPaneStore(request, [projectPaneId, chatB.id]);
    await armWorkingChild(page);
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    const projectTab = page.locator(`[role="tab"][data-pane-id="${projectPaneId}"]`);
    const other = page.locator(`[role="tab"][data-pane-id="${chatB.id}"]`);
    await expect(projectTab).toBeVisible({ timeout: 20_000 });
    await other.click();
    await expect(projectTab).toHaveAttribute("data-active", "false", { timeout: 10_000 });
    return { projectTab, ws };
  }

  test("a) TABSLOT-01: every signal at once, and the project label keeps 56px", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "TABSLOT-01" });
    test.info().annotations.push({ type: "spec", description: "TABSLOT-02" });
    test.info().annotations.push({ type: "spec", description: "TABSLOT-03" });
    const { projectTab, ws } = await projectTabAtRest(page, request);

    // Attention: 13 things inside ask for you.
    ws.send({ type: "unread:updated", topicId: childId, unreadCount: 13 });
    // Pinned, through the tab's own menu.
    await projectTab.click({ button: "right" });
    await page.getByTestId("tab-menu-pin-tab").click();
    await expect(projectTab, "the pin is said in the accessible name").toHaveAttribute("aria-label", /Fissato/, { timeout: 10_000 });
    await pointerAway(page);

    // Everything is there…
    await expect(projectTab.getByTestId("pane-tab-shared-org"), "org sharing, on the icon's corner").toBeVisible({ timeout: 10_000 });
    await expect(projectTab.getByTestId("tab-project-marker"), "the project marker").toBeVisible();
    const slot = projectTab.getByTestId("pane-tab-slot");
    await expect(slot, "working AND asking for you: the ring around the number").toHaveAttribute("data-signal", "working", { timeout: 15_000 });
    await expect(slot.locator("[data-notification-count]")).toHaveText("13", { timeout: 10_000 });
    // …and what left the tab's face is not drawn on it.
    for (const gone of ["tab-pinned", "tab-elapsed", "project-elapsed", "tab-spawned-browser", "tab-cloud"]) {
      await expect(projectTab.getByTestId(gone), `${gone} is no longer on the tab`).toHaveCount(0);
    }

    const { label, slot: slotBox } = await zones(projectTab);
    const tabBox = (await projectTab.boundingBox())!;
    console.log(`[a] project tab w=${tabBox.width} label x=${label.x - tabBox.x} w=${label.width} slot x=${slotBox.x - tabBox.x} w=${slotBox.width}`);
    expect(label.width, "the label keeps its floor with every signal on").toBeGreaterThanOrEqual(LABEL_MIN_PX);
    // Nothing in flow between label and slot: only the row gap (8px).
    expect(Math.abs(slotBox.x - (label.x + label.width) - 8), "nothing between the label and the slot").toBeLessThanOrEqual(SAME_PX);
    expect(slotBox.width, "the slot is 20px").toBeCloseTo(20, 0);

    // THE RING IS A CIRCLE AROUND THE NUMBER, measured, not inferred from
    // `data-signal`: an orbit left in flow became a 6.6px sliver beside the
    // "13", with the attribute and the text still right.
    const ring = await slot.locator('[data-loader-state="working"]').evaluate((el) => {
      const r = (e: Element) => e.getBoundingClientRect();
      const orbit = el.querySelector('span[aria-hidden="true"]')!;
      const number = el.querySelector("[data-notification-count]")!;
      return { ring: r(el).toJSON(), orbit: r(orbit).toJSON(), number: r(number).toJSON() };
    });
    console.log(`[a] ring x=${ring.ring.x} w=${ring.ring.width} | orbit x=${ring.orbit.x} w=${ring.orbit.width} h=${ring.orbit.height} | number x=${ring.number.x} w=${ring.number.width}`);
    for (const k of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(ring.orbit[k] - ring.ring[k]), `the orbit fills the ring box (${k})`).toBeLessThanOrEqual(SAME_PX);
    }
    const mid = (b: { x: number; width: number }) => b.x + b.width / 2;
    const midY = (b: { y: number; height: number }) => b.y + b.height / 2;
    expect(Math.abs(mid(ring.number) - mid(ring.orbit)), "the number sits on the orbit's centre (x)").toBeLessThanOrEqual(SAME_PX);
    expect(Math.abs(midY(ring.number) - midY(ring.orbit)), "the number sits on the orbit's centre (y)").toBeLessThanOrEqual(SAME_PX);
    await projectTab.screenshot({ path: test.info().outputPath("project-tab-all-signals.png") });

    // THREE FIGURES STILL FIT THE RING: "99+" around the orbit, inside its 20px.
    ws.send({ type: "unread:updated", topicId: childId, unreadCount: 150 });
    const ringNumber = slot.locator('[data-loader-state="working"] [data-notification-count]');
    await expect(ringNumber).toHaveText("99+", { timeout: 10_000 });
    await expectInside(ringNumber, slot, "99+ in the ring");
  });

  test("d) CHROME-12: a project tab with a working child offers Close, never Stop", async ({ page, request }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-12" });
    const { projectTab } = await projectTabAtRest(page, request);
    await expect(projectTab.getByTestId("pane-tab-slot")).toHaveAttribute("data-signal", "working", { timeout: 15_000 });
    await projectTab.hover();
    await expect(projectTab.getByTestId("pane-tab-close")).toBeVisible({ timeout: 5_000 });
    await expect(projectTab.getByTestId("pane-tab-stop")).toHaveCount(0);
  });

  test("b) TABSLOT-01/02: rest, working, attention, hover, stopped - the label and the slot never move", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "TABSLOT-01" });
    test.info().annotations.push({ type: "spec", description: "TABSLOT-02" });
    await resetPaneStore(request, [chatA.id, chatB.id]);
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(chatA.name));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    const tab = page.locator(`[role="tab"][data-pane-id="${chatA.id}"]`);
    const slot = tab.getByTestId("pane-tab-slot");
    await expect(tab).toBeVisible({ timeout: 15_000 });

    const seen: Record<string, { label: Box; slot: Box }> = {};

    await pointerAway(page);
    await expect(slot).toHaveAttribute("data-signal", "none");
    seen.rest = await zones(tab);

    await startHeldTurn(page, chatPage.messageInput);
    await pointerAway(page);
    await expect(slot).toHaveAttribute("data-signal", "working", { timeout: 15_000 });
    seen.working = await zones(tab);

    // Attention needs the tab NOT under your eyes: the badge is suppressed on
    // the tab you are looking at (TAB-BADGE-07).
    await page.locator(`[role="tab"][data-pane-id="${chatB.id}"]`).click();
    await expect(tab).toHaveAttribute("data-active", "false");
    ws.send({ type: "unread:updated", topicId: chatA.id, unreadCount: 3 });
    await pointerAway(page);
    await expect(slot.locator("[data-notification-count]")).toHaveText("3", { timeout: 10_000 });
    seen.attention = await zones(tab);

    await tab.hover();
    await expect(tab.getByTestId("pane-tab-stop")).toBeVisible({ timeout: 5_000 });
    seen.hover = await zones(tab);

    await tab.getByTestId("pane-tab-stop").click();
    await expect(slot, "the turn has stopped: the number alone").toHaveAttribute("data-signal", "attention", { timeout: 10_000 });
    await pointerAway(page);
    seen.stopped = await zones(tab);

    const tabBox = (await tab.boundingBox())!;
    for (const [state, z] of Object.entries(seen)) {
      console.log(`[b] ${state}: label x=${(z.label.x - tabBox.x).toFixed(2)} w=${z.label.width.toFixed(2)} | slot x=${(z.slot.x - tabBox.x).toFixed(2)} w=${z.slot.width.toFixed(2)}`);
    }
    for (const [state, z] of Object.entries(seen)) {
      expect(Math.abs(z.label.x - seen.rest.label.x), `label x in ${state}`).toBeLessThanOrEqual(SAME_PX);
      expect(Math.abs(z.label.width - seen.rest.label.width), `label width in ${state}`).toBeLessThanOrEqual(SAME_PX);
      expect(Math.abs(z.slot.x - seen.rest.slot.x), `slot x in ${state}`).toBeLessThanOrEqual(SAME_PX);
      expect(Math.abs(z.slot.width - seen.rest.slot.width), `slot width in ${state}`).toBeLessThanOrEqual(SAME_PX);
    }
  });

  test("c) CHROME-12: Stop in the slot and no Close beside it; after Stop the same slot closes", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "CHROME-12" });
    await resetPaneStore(request, [chatA.id]);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(chatA.name));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    const tab = page.locator(`[role="tab"][data-pane-id="${chatA.id}"]`);
    await expect(tab).toBeVisible({ timeout: 15_000 });

    await startHeldTurn(page, chatPage.messageInput);
    await expect(chatPage.streamingIndicator).toBeVisible({ timeout: 15_000 });

    await tab.hover();
    const stop = tab.getByTestId("pane-tab-stop");
    await expect(stop).toBeVisible({ timeout: 5_000 });
    await expect(tab.getByTestId("pane-tab-close"), "never Stop and Close side by side").toHaveCount(0);
    const stopBox = (await stop.boundingBox())!;

    await stop.click();
    await expect(chatPage.streamingIndicator, "the turn has ended").toBeHidden({ timeout: 10_000 });
    await expect(tab, "the tab stays open").toBeVisible();

    await tab.hover();
    const close = tab.getByTestId("pane-tab-close");
    await expect(close).toBeVisible({ timeout: 5_000 });
    await expect(stop).toHaveCount(0);
    const closeBox = (await close.boundingBox())!;
    console.log(`[c] stop box x=${stopBox.x} w=${stopBox.width} | close box x=${closeBox.x} w=${closeBox.width}`);
    expect(Math.abs(closeBox.x + closeBox.width / 2 - (stopBox.x + stopBox.width / 2)), "Close lands where Stop was").toBeLessThanOrEqual(SAME_PX);

    await close.click();
    await expect(page.locator(`[data-pane-id="${chatA.id}"]`), "the tab closes").toHaveCount(0, { timeout: 10_000 });
  });

  test("e) TABSLOT-01/03: a browser tab whose kind comes and goes keeps its label where it was", async ({ page, request, browserProcessPageV2 }) => {
    test.info().annotations.push({ type: "spec", description: "TABSLOT-01" });
    test.info().annotations.push({ type: "spec", description: "TABSLOT-03" });
    await resetPaneStore(request, []);
    await browserProcessPageV2.mockBrowserWs({ framesPerSecond: 15 });
    await browserProcessPageV2.mockBrowserContexts([]);
    await browserProcessPageV2.mockRemoteBrowserPane({ connected: true, url: "https://example.com", title: "Example", hasScreenshot: true });
    // THE DEFAULT KIND at rest: the page in this device's own <iframe>, no kind
    // to report. The agent taking the wheel moves the pane to the server
    // session and gives it a kind; handing it back takes the kind away.
    await page.route(/\/api\/browsers\/framable/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ framable: true }) }));
    const topic = await createTopic(request, `slot-browser-${TS}`);
    try {
      await goToApp(page);
      await waitForTopicVisible(page, topic.id);
      await page.evaluate((tid) => {
        window.dispatchEvent(new CustomEvent("browser:open-and-navigate", { detail: { topicId: tid, url: "https://example.com" } }));
      }, topic.id);
      await expect(page.getByTestId("browser-iframe")).toBeVisible({ timeout: 15_000 });
      const tab = page.locator('[role="tab"][data-pane-id^="browser:"]').first();
      const kindMark = tab.getByTestId("browser-tab-type-icon");
      await expect(kindMark, "the default kind carries no mark").toHaveCount(0);

      const seen: Record<string, { label: Box; slot: Box }> = {};
      await pointerAway(page);
      seen.rest = await zones(tab);

      await browserProcessPageV2.waitForWsConnected();
      browserProcessPageV2.broadcastAgentActive(true, "Naviga su example.com");
      await expect(kindMark).toHaveAttribute("data-kind", "agent", { timeout: 10_000 });
      await pointerAway(page);
      seen.agent = await zones(tab);
      await tab.screenshot({ path: test.info().outputPath("browser-tab-kind-corner.png") });
      const lead = (await tab.getByTestId("browser-tab-icon").boundingBox())!;
      const mark = (await kindMark.boundingBox())!;

      browserProcessPageV2.broadcastAgentActive(false);
      await expect(kindMark).toHaveCount(0, { timeout: 10_000 });
      await pointerAway(page);
      seen.after = await zones(tab);

      const tabBox = (await tab.boundingBox())!;
      for (const [state, z] of Object.entries(seen)) {
        console.log(`[e] ${state}: label x=${(z.label.x - tabBox.x).toFixed(2)} w=${z.label.width.toFixed(2)} | slot x=${(z.slot.x - tabBox.x).toFixed(2)} w=${z.slot.width.toFixed(2)}`);
        expect(Math.abs(z.label.x - seen.rest.label.x), `label x in ${state}`).toBeLessThanOrEqual(SAME_PX);
        expect(Math.abs(z.label.width - seen.rest.label.width), `label width in ${state}`).toBeLessThanOrEqual(SAME_PX);
      }
      // The mark sits on the favicon's corner: it starts inside the lead icon.
      console.log(`[e] lead x=${lead.x - tabBox.x} w=${lead.width} | mark x=${mark.x - tabBox.x} w=${mark.width}`);
      expect(mark.x, "the kind is a corner of the favicon, not a zone of its own").toBeLessThan(lead.x + lead.width);
    } finally {
      await deleteTopic(request, topic.id).catch(() => {});
      await closeAllBrowserContexts(request);
    }
  });

  test("f) TABSLOT-02: a 99+ count stays inside the slot, and the exact count is in the tab's name", async ({ page, request, chatPage }) => {
    test.info().annotations.push({ type: "spec", description: "TABSLOT-02" });
    await resetPaneStore(request, [chatA.id, chatB.id]);
    const ws = await interceptWebSocket(page);
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(chatB.name));
    await chatPage.messageInput.waitFor({ state: "visible", timeout: 15_000 });
    const tab = page.locator(`[role="tab"][data-pane-id="${chatA.id}"]`);
    const slot = tab.getByTestId("pane-tab-slot");
    await expect(tab).toHaveAttribute("data-active", "false", { timeout: 15_000 });
    const figure = slot.locator("[data-notification-count]");

    for (const [count, shown] of [[13, "13"], [150, "99+"]] as const) {
      ws.send({ type: "unread:updated", topicId: chatA.id, unreadCount: count });
      await pointerAway(page);
      await expect(figure).toHaveText(shown, { timeout: 10_000 });
      await expectInside(figure, slot, `badge ${shown}`);
      await expect(tab, "the exact count is in the tab's accessible name").toHaveAttribute("aria-label", new RegExp(`\\b${count}\\b`));
    }
    await tab.screenshot({ path: test.info().outputPath("tab-99-plus.png") });
  });
});
