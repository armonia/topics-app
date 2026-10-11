/**
 * Measure the real pane-tab strip as its host cell gets narrower.
 *
 * @covers LAYOUT-42 (scenarios DENS-01..07 of openspec/changes/tab-bar-density)
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createTerminalSession, createTopic, deleteTerminalSession, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectPane, unarchiveTopic } from "./helpers/api-fixtures";
import { E2E_BASE } from "./helpers/test-server";
import { hermetic } from "./fixtures/hermetic";
import { canonicalTmpDir, removeTmpDir } from "./helpers/file-project";
import { projectLayoutKey, projectPanesKey } from "../../shared/project-keys";
import { openProjectFromSidebar, projectWindow } from "./helpers/project-window";

hermetic(test);

test.use({
  viewport: { width: 1800, height: 900 },
  video: "on",
  contextOptions: { reducedMotion: "reduce" },
});
test.describe.configure({ mode: "serial" });

const STAMP = Date.now();
const BROWSER_STREAM_WS = /\/ws\/browser\//;
const CHAT_COUNT = 4;
const FULL_TAB_COUNT = 6;
const PROJECT_PATH = canonicalTmpDir("e2e-tab-bar-density");

interface TopicFixture {
  id: string;
  name: string;
}

interface TabMeasure {
  id: string;
  x: number;
  width: number;
  height: number;
  active: boolean;
  labelText: string;
  labelVisible: boolean;
  hasGlyph: boolean;
}

interface StripMeasure {
  mode: string;
  clientWidth: number;
  scrollWidth: number;
  tabs: TabMeasure[];
}

let topics: TopicFixture[] = [];
let terminalSessionId = "";
let standaloneSiblingId = "";

const chatTopicId = (index: number): string => topics[index]!.id;
const chatId = (index: number): string => `chat:${chatTopicId(index)}`;
const browserPaneId = `browser:${randomUUID()}`;
const filePaneId = `file:${randomUUID()}`;
let terminalPaneId = "";
const densityPaneIds = (): string[] => [
  chatId(0),
  terminalPaneId,
  browserPaneId,
  filePaneId,
  chatId(1),
  chatId(2),
];

test.beforeAll(async ({ request }) => {
  mkdirSync(PROJECT_PATH, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: "e2e-tab-bar-density" }));
  writeFileSync(`${PROJECT_PATH}/density-file.ts`, "export const densityFixture = true;\n");
  for (let index = 0; index < CHAT_COUNT; index++) {
    topics.push(await createTopic(request, `Density ${STAMP} chat ${index + 1}`, { projectPath: PROJECT_PATH }));
  }
  standaloneSiblingId = (await createTopic(request, `Density ${STAMP} outer sibling`)).id;
});

test.afterAll(async ({ request }) => {
  if (terminalSessionId) await deleteTerminalSession(request, terminalSessionId).catch(() => {});
  await resetProjectPanes(request, PROJECT_PATH);
  await Promise.all([
    ...topics.map((topic) => deleteTopic(request, topic.id).catch(() => {})),
    standaloneSiblingId && deleteTopic(request, standaloneSiblingId).catch(() => {}),
  ]);
  topics = [];
  removeTmpDir(PROJECT_PATH);
});

async function seedDensityGrid(
  page: Page,
  request: APIRequestContext,
  singleTab = false,
): Promise<string[]> {
  await page.routeWebSocket(BROWSER_STREAM_WS, () => {});

  // The live-session reconciler adopts terminals whose cwd is this project.
  // DENS-04 needs a truly single-tab group, so stop the fixture terminal for
  // that case and bring it back for the mixed-pane cases after it.
  if (singleTab && terminalSessionId) {
    await deleteTerminalSession(request, terminalSessionId);
    terminalSessionId = "";
    terminalPaneId = "";
  } else if (!singleTab && !terminalSessionId) {
    terminalSessionId = (await createTerminalSession(request, {
      cwd: PROJECT_PATH,
      name: `Density terminal ${STAMP}`,
    })).id;
    terminalPaneId = `terminal:${terminalSessionId}`;
  }

  const tabs = singleTab ? [chatId(0)] : densityPaneIds();
  const sibling = chatId(3);
  const paneIds = [...tabs, sibling];
  const openChatTopicIds = singleTab ? [topics[0]!.id, topics[3]!.id] : topics.map((topic) => topic.id);
  await Promise.all(topics.map((topic) => unarchiveTopic(request, topic.id)));

  await resetPaneStore(request, []);
  await seedProjectPane(request, PROJECT_PATH);
  await resetProjectPanes(request, PROJECT_PATH);
  const nonChatPanes = singleTab ? [] : [
    { id: terminalPaneId, type: "terminal", title: `Density terminal ${STAMP}`, terminalSessionId, preview: false },
    { id: browserPaneId, type: "browser", title: `Density browser ${STAMP}`, url: "https://example.com/density", preview: false },
    { id: filePaneId, type: "file", title: "density-file.ts", filePath: `${PROJECT_PATH}/density-file.ts`, preview: false },
  ];
  await request.put(`${E2E_BASE}/api/ui-state/${projectPanesKey(PROJECT_PATH)}`, {
    data: {
      nonChatPanes,
      openChatTopicIds,
      activeChatTopicId: topics[0]!.id,
    },
    ignoreHTTPSErrors: true,
  });

  await page.goto("/favicon.ico", { waitUntil: "commit" }).catch(() => {});
  const hostGroupId = `density-host-${STAMP}`;
  const mainGroupId = `density-main-${STAMP}`;
  await page.evaluate(({ layoutKey, panesKey, layout, tabState }) => {
    localStorage.setItem(layoutKey, JSON.stringify(layout));
    localStorage.setItem(panesKey, JSON.stringify(tabState));
  }, {
    layoutKey: projectLayoutKey(PROJECT_PATH),
    panesKey: projectPanesKey(PROJECT_PATH),
    tabState: {
      nonChatPanes,
      openChatTopicIds,
      activeChatTopicId: topics[0]!.id,
    },
    layout: {
      // The project lead belongs to the first cell; keep it in a one-tab host
      // so the density group gets the full width requested by each scenario.
      groups: [
        { id: hostGroupId, paneIds: [sibling], activePaneId: sibling, type: "chat" },
        { id: mainGroupId, paneIds: tabs, activePaneId: tabs[0], type: "chat" },
      ],
      rows: [{ groupIds: [hostGroupId, mainGroupId], widths: [0.15, 0.85] }],
      rowHeights: [1],
      focusedGroupId: mainGroupId,
      sidebarCollapsed: true,
    },
  });

  await page.goto("/");
  await openProjectFromSidebar(page, /e2e-tab-bar-density/);
  await expect(projectWindow(page)).toBeVisible();
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15_000 });
  for (const id of paneIds) await expect(tab(page, id)).toBeVisible({ timeout: 15_000 });

  const projectBars = projectWindow(page).locator('[data-testid="panel-tab-bar"]');
  await expect(projectBars).toHaveCount(2);

  await tab(page, chatId(0)).click();
  await expect(tab(page, chatId(0))).toHaveAttribute("data-active", "true");
  return tabs;
}

function tab(page: Page, paneId: string): Locator {
  return page.getByTestId(`pane-tab-${paneId}`).first();
}

function densityBar(page: Page, paneId: string): Locator {
  return tab(page, paneId).locator('xpath=ancestor::*[@data-testid="panel-tab-bar"][1]');
}

function densityCell(page: Page, paneId: string): Locator {
  return densityBar(page, paneId).locator('xpath=ancestor::*[@data-split-leaf][1]');
}

async function setGroupWidth(page: Page, paneId: string, targetWidth: number): Promise<void> {
  const cell = densityCell(page, paneId);
  const split = cell.locator('xpath=ancestor::*[@data-split-node="row"][1]');
  const divider = split.locator(':scope > [data-resize-axis="col"]').first();
  await expect(divider).toBeVisible({ timeout: 5_000 });

  const box = (await cell.boundingBox())!;
  const dividerBox = (await divider.boundingBox())!;
  const startX = dividerBox.x + dividerBox.width / 2;
  const startY = dividerBox.y + dividerBox.height / 2;
  const isRightCell = await cell.evaluate((element) =>
    element.parentElement?.previousElementSibling?.matches('[data-resize-axis="col"]') ?? false,
  );
  const delta = (targetWidth - box.width) * (isRightCell ? -1 : 1);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + delta, startY, { steps: 20 });
  await page.mouse.up();

  await expect.poll(async () => {
    const current = (await cell.boundingBox())?.width ?? 0;
    return Math.abs(current - targetWidth) <= 1;
  }, { timeout: 8_000, message: `the split cell should be ${targetWidth}px wide` }).toBe(true);
}

async function measureStrip(page: Page, paneId: string): Promise<StripMeasure> {
  return densityBar(page, paneId).evaluate((bar): StripMeasure => {
    const strip = bar.querySelector<HTMLElement>(":scope > div");
    if (!strip) throw new Error("the tab strip is missing");
    const tabs = Array.from(bar.querySelectorAll<HTMLElement>("[data-pane-id]"));
    return {
      mode: bar.getAttribute("data-density") ?? "",
      clientWidth: strip.clientWidth,
      scrollWidth: strip.scrollWidth,
      tabs: tabs.map((element) => {
        const bounds = element.getBoundingClientRect();
        const label = element.querySelector<HTMLElement>('[data-testid="pane-tab-label"]');
        const labelBounds = label?.getBoundingClientRect();
        return {
          id: element.dataset.paneId ?? "",
          x: Math.round(bounds.x * 100) / 100,
          width: Math.round(bounds.width * 100) / 100,
          height: Math.round(bounds.height * 100) / 100,
          active: element.dataset.active === "true",
          labelText: label?.textContent?.trim() ?? "",
          labelVisible: !!label && !!labelBounds && labelBounds.width > 0 && label.getClientRects().length > 0
            && getComputedStyle(label).display !== "none",
          hasGlyph: !!element.querySelector("svg, img, [data-topic-initial], [data-testid=\"browser-tab-icon\"]"),
        };
      }),
    };
  });
}

async function expectMode(page: Page, paneId: string, mode: string): Promise<StripMeasure> {
  await expect(densityBar(page, paneId)).toHaveAttribute("data-density", mode, { timeout: 8_000 });
  return measureStrip(page, paneId);
}

test("DENS-01: a wide group keeps today's tab widths", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "LAYOUT-42" });
  const ids = await seedDensityGrid(page, request);
  await setGroupWidth(page, ids[0]!, 1200);

  const strip = await expectMode(page, ids[0]!, "full");
  expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  expect(strip.tabs).toHaveLength(FULL_TAB_COUNT);
  for (const measured of strip.tabs) {
    expect(measured.width, measured.id).toBe(measured.id === browserPaneId ? 200 : 150);
  }
});

test("DENS-02: compact tabs fit and keep every label present", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "LAYOUT-42" });
  const ids = await seedDensityGrid(page, request);
  await setGroupWidth(page, ids[0]!, 600);

  const strip = await expectMode(page, ids[0]!, "compact");
  expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  for (const measured of strip.tabs) {
    expect(measured.labelText, measured.id).not.toBe("");
    expect(measured.labelVisible, measured.id).toBe(true);
    expect(measured.width, measured.id).toBeGreaterThanOrEqual(measured.active ? 120 : 76);
  }
});

test("DENS-03: square tabs fit while the active name stays readable", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "LAYOUT-42" });
  const ids = await seedDensityGrid(page, request);
  await setGroupWidth(page, ids[0]!, 340);

  const strip = await expectMode(page, ids[0]!, "square");
  expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  const active = strip.tabs.find((measured) => measured.active)!;
  expect(active.width).toBeGreaterThanOrEqual(96);
  expect(active.labelText).not.toBe("");
  expect(active.labelVisible).toBe(true);
  for (const measured of strip.tabs.filter((candidate) => !candidate.active)) {
    expect(Math.abs(measured.width - measured.height), measured.id).toBeLessThanOrEqual(1);
    expect(measured.hasGlyph, measured.id).toBe(true);
  }
});

test("DENS-04: one tab fits at 160px without horizontal scrolling", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "LAYOUT-42" });
  const ids = await seedDensityGrid(page, request, true);
  await setGroupWidth(page, ids[0]!, 160);

  const strip = await measureStrip(page, ids[0]!);
  expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth);
  expect(strip.tabs).toHaveLength(1);
  expect(strip.tabs[0]!.width).toBeLessThanOrEqual(strip.clientWidth);
  expect(strip.tabs[0]!.width).toBeGreaterThanOrEqual(strip.tabs[0]!.height);
});

test("DENS-05: hovering across the strip never changes tab widths", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "LAYOUT-42" });
  const ids = await seedDensityGrid(page, request);
  await setGroupWidth(page, ids[0]!, 340);
  const strip = await expectMode(page, ids[0]!, "square");
  const before = Object.fromEntries(strip.tabs.map((measured) => [measured.id, measured.width]));

  for (const id of ids) {
    await tab(page, id).hover();
    const after = await measureStrip(page, ids[0]!);
    expect(Object.fromEntries(after.tabs.map((measured) => [measured.id, measured.width]))).toEqual(before);
  }
});

test("DENS-06: pointer close freezes survivors until the pointer leaves the bar", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "LAYOUT-42" });
  const ids = await seedDensityGrid(page, request);
  await setGroupWidth(page, ids[0]!, 600);
  const before = await expectMode(page, ids[0]!, "compact");
  const beforeGeometry = Object.fromEntries(before.tabs.map((measured) => [measured.id, {
    x: measured.x,
    width: measured.width,
  }]));
  const doomed = tab(page, chatId(1));
  await doomed.hover();
  const close = doomed.getByTestId("pane-tab-close");
  await expect(close).toBeVisible({ timeout: 5_000 });
  await close.click();
  await expect(doomed).toHaveCount(0, { timeout: 15_000 });

  const frozen = await measureStrip(page, ids[0]!);
  const survivors = ids.filter((id) => id !== chatId(1));
  expect(Object.fromEntries(frozen.tabs.map((measured) => [measured.id, {
    x: measured.x,
    width: measured.width,
  }]))).toEqual(
    Object.fromEntries(survivors.map((id) => [id, beforeGeometry[id]])),
  );

  await page.mouse.move(0, 0);
  await expect.poll(async () => {
    const after = await measureStrip(page, ids[0]!);
    return after.tabs.some((measured) => Math.abs(measured.width - beforeGeometry[measured.id]!.width) > 1);
  }, { timeout: 8_000, message: "surviving tabs should redistribute after pointerleave" }).toBe(true);
});

test("DENS-07: a square tab keeps its full name in the tooltip and accessible label", async ({ page, request }) => {
  test.info().annotations.push({ type: "spec", description: "LAYOUT-42" });
  const ids = await seedDensityGrid(page, request);
  await setGroupWidth(page, ids[0]!, 340);
  await expectMode(page, ids[0]!, "square");

  const square = tab(page, chatId(1));
  const fullName = topics[1]!.name;
  await expect(square).toHaveAttribute("title", fullName);
  expect(await square.getAttribute("aria-label")).toContain(fullName);
});
