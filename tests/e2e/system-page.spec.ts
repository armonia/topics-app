/**
 * SYSTEM PAGE (openspec agenti-e-sistema, T4).
 *
 * Harness (SYSTEM-01): the layers with their weight, one chip per agent, a
 * contradiction naming its two sources, and the per-harness weight saying the
 * figure is missing when there is no hub. Tools (SYSTEM-02): the catalogue shows
 * each agent beside the server it may use. Memories (SYSTEM-03, SYSTEM-05): the
 * three sentences, a search over two stores, the card with type, date and links,
 * and a store nobody receives, in amber. Health (SYSTEM-04): one row per problem
 * with its button, and the number next to «Sistema» in the sidebar going down
 * once a problem is fixed.
 *
 * Every `/api` route is faked with `page.route`: no real agent folder is touched.
 *
 * @covers SYSTEM-PAGE-01
 */
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { VIDEO_ON } from "./video-evidence";

hermetic(test);
test.use({ video: VIDEO_ON });

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const agent = (id: string, name: string) => ({
  id, name, job: "Role", workspace: `/tmp/${id}`,
  persona: { "IDENTITY.md": `# ${name}`, "SOUL.md": "" },
  accounts: [], chats: [], jobs: [], model: { engine: null, perChannel: {} },
});

const REG = {
  health: { ok: true, text: "ok" },
  routes: [],
  issues: [{ agent: "main", text: "disagree", type: "source-contradiction", ref: "account:x", sources: ["config.json channels.discord.x", "engine.json agents"] }],
  agents: [agent("main", "Alpha"), agent("gtm", "Beta")],
};

const persona = (own: number) => ({ layers: [{ name: "base", tokens: 1200 }, { name: "rules", tokens: 800 }, { name: "profile", tokens: 100 }, { name: "identity", tokens: own }, { name: "agent", tokens: 0 }] });

const STORES = [
  { id: "agent:main", kind: "agent", ownerAgentId: "main", path: "/tmp/m", index: { lines: 3, chars: 400, overLimit: false }, cards: [{ file: "alpha-note.md", name: "alpha-note", description: "d", type: "feedback" }, { file: "other.md", name: "other", description: "d", type: "project" }], receivedBy: ["main"], readableBy: [] },
  { id: "project:demo", kind: "project", ownerAgentId: null, path: "/tmp/p", index: { lines: 2, chars: 200, overLimit: false }, cards: [{ file: "beta-note.md", name: "beta-note", description: "d", type: "project" }], receivedBy: ["gtm"], readableBy: ["main"] },
  { id: "agent:gtm", kind: "agent", ownerAgentId: "gtm", path: "/tmp/g", index: null, cards: [{ file: "lost.md", name: "lost", description: "d", type: "user" }], receivedBy: [], readableBy: [] },
];

async function stage(page: Page) {
  let problems = [
    { id: "job-without-agent:j1", type: "job-without-agent", severity: "error", sentence: "The scheduled job \"Morning brief\" has no agent to run it.", destination: { section: "jobs", ref: "j1" } },
    { id: "memory-unreceived:agent:gtm", type: "memory-unreceived", severity: "warning", sentence: "agent:gtm has cards but nobody receives it.", destination: { section: "memory", agentId: "gtm" } },
  ];
  await page.route("**/api/agent-config", (r) => r.fulfill(json(REG)));
  await page.route("**/api/agent-config/persona**", (r) => r.fulfill(json(persona(new URL(r.request().url()).searchParams.get("agent") === "main" ? 300 : 150))));
  await page.route("**/api/agent-channels**", (r) => r.fulfill(json({ titles: {}, days: 7, rows: [], turns: [] })));
  await page.route("**/api/hub/**", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("**/api/system/agents-health", (r) => r.fulfill(json({ problems, count: problems.length, types: [] })));
  await page.route("**/api/system/engine-log**", (r) => r.fulfill(json({ path: "/tmp/logs/engine.log", exists: true, lines: [{ level: "error", agent: "main", text: "ERROR agent=main boom" }] })));
  await page.route("**/api/agent-tools", (r) => r.fulfill(json({
    mcp: [
      { name: "docs-server", state: "active", transport: "http", toolCount: 4, source: "~/.claude.json", parkedByUser: false, agents: ["main", "gtm"], tokens: 900 },
      { name: "mail-server", state: "active", transport: "http", toolCount: 2, source: "~/.claude.json", parkedByUser: false, agents: ["main"], tokens: 300 },
    ],
    skills: [], clis: [], sources: [],
    agents: [
      { id: "main", name: "Alpha", filter: { mode: "all", servers: [] } },
      { id: "gtm", name: "Beta", filter: { mode: "selected", servers: ["docs-server"] } },
    ],
    tokenWeight: { alwaysOn: 1200, onDemand: 400 },
  })));
  await page.route("**/api/memory-stores", (r) => r.fulfill(json({ stores: STORES, problems: [{ storeId: "agent:gtm", kind: "unreceived", text: "agent:gtm has 1 card but nobody receives it" }] })));
  await page.route("**/api/memory-stores/search**", (r) => r.fulfill(json({ results: [
    { storeId: "agent:main", file: "alpha-note.md", name: "alpha-note", description: "d", type: "feedback", snippet: "the keyword lives here" },
    { storeId: "project:demo", file: "beta-note.md", name: "beta-note", description: "d", type: "project", snippet: "the keyword lives here too" },
  ] })));
  await page.route("**/api/memory-stores/*/cards/*", (r) => r.fulfill(json({ content: "---\ntype: feedback\nupdated: 2026-11-01\n---\nSee [[other]] for the keyword." })));
  await goToApp(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "system-page" } })));
  await expect(page.getByTestId("system-pane")).toBeVisible({ timeout: 15_000 });
  return { fix: () => { problems = problems.slice(1); } };
}

test("harness a strati con le contraddizioni (SYSTEM-01)", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SYSTEM-PAGE-01" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await stage(page);
  await page.getByTestId("system-nav-harness").click();

  await expect(page.getByTestId("harness-weight-base")).toContainText("1");
  for (const layer of ["base", "rules", "agent", "tools", "memory", "turn"]) await expect(page.getByTestId(`harness-layer-${layer}`)).toBeVisible();
  await expect(page.getByTestId("harness-weight-tools")).toContainText("1");
  const chips = page.getByTestId("harness-agent-chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.filter({ hasText: "Alpha" })).toBeVisible();

  const contradiction = page.getByTestId("harness-contradiction").first();
  await expect(contradiction).toContainText("config.json channels.discord.x");
  await expect(contradiction).toContainText("engine.json agents");
  await expect(page.getByTestId("harness-external-missing")).toContainText(/hub/i);

  await chips.filter({ hasText: "Alpha" }).click();
  await expect(page.getByTestId("agents-pane")).toBeVisible({ timeout: 10_000 });
});

test("strumenti: chi usa quale server (SYSTEM-02)", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SYSTEM-PAGE-01" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await stage(page);
  await page.getByTestId("system-nav-tools").click();

  const mail = page.getByTestId("agent-tools-users-mail-server");
  const allowed = (box: ReturnType<typeof page.getByTestId>) => box.locator('[data-testid="agent-tools-user"]:not([data-access="none"])');
  await expect(allowed(mail)).toHaveCount(1);
  await expect(allowed(mail)).toContainText("Alpha");
  await expect(mail.locator('[data-access="none"]')).toContainText("Beta");
  await expect(allowed(page.getByTestId("agent-tools-users-docs-server"))).toHaveCount(2);
  await expect(page.getByTestId("system-tools-weight")).toBeVisible();
  await mail.getByTestId("agent-tools-limit").first().click();
  await expect(page.getByTestId("agents-pane")).toBeVisible({ timeout: 10_000 });
});

test("una memoria che nessuno riceve (SYSTEM-03)", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SYSTEM-PAGE-01" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await stage(page);
  await page.getByTestId("system-nav-memory").click();

  const lost = page.locator('[data-testid="memory-store"][data-store="agent:gtm"]');
  await expect(lost.getByTestId("memory-store-unreceived")).toBeVisible();
  await lost.getByTestId("memory-store-fix").click();
  await expect(page.getByTestId("agents-pane")).toBeVisible({ timeout: 10_000 });
});

test("tutto ciò che è rotto in un posto, e il numero scende (SYSTEM-04)", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SYSTEM-PAGE-01" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const { fix } = await stage(page);

  const count = page.getByTestId("sidebar-system-count");
  await expect(count).toHaveText("2", { timeout: 10_000 });
  await expect(count).toHaveAttribute("data-severity", "error");
  const rows = page.getByTestId("system-health-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByTestId("system-health-open")).toBeVisible();

  fix();
  await page.getByTestId("system-health-refresh").click();
  await expect(rows).toHaveCount(1);
  await expect(count).toHaveText("1", { timeout: 10_000 });
  await expect(count).toHaveAttribute("data-severity", "warning");
});

test("memorie spiegate e cercabili (SYSTEM-05)", async ({ page }, info) => {
  test.info().annotations.push({ type: "spec", description: "SYSTEM-PAGE-01" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await stage(page);
  await page.getByTestId("system-nav-memory").click();

  await expect(page.getByTestId("memory-explainer")).toBeVisible();
  await page.getByTestId("memory-search-input").fill("keyword");
  await page.getByTestId("memory-search-go").click();
  const groups = page.getByTestId("memory-result-store");
  await expect(groups).toHaveCount(2);
  await expect(page.locator('[data-testid="memory-result-store"][data-store="agent:main"]')).toContainText("alpha-note");
  await expect(page.locator('[data-testid="memory-result-store"][data-store="project:demo"]')).toContainText("beta-note");

  await page.getByTestId("memory-result").first().click();
  await expect(page.getByTestId("memory-card-type")).toContainText("feedback");
  await expect(page.getByTestId("memory-card-date")).toContainText("2026-11-01");
  await expect(page.getByTestId("memory-card-links")).toContainText("other");
  await expect(page.getByTestId("memory-card-text")).toContainText("keyword");

  for (const width of [375, 768, 1440, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`sistema-memorie-${width}.png`) });
  }
});

test("registro del motore filtrabile (SYSTEM-04)", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "SYSTEM-PAGE-01" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await stage(page);
  await page.getByTestId("system-nav-log").click();
  await expect(page.getByTestId("log-lines")).toContainText("boom");
  await page.getByTestId("log-level").click();
  await page.getByRole("option").last().click();
  await expect(page.getByTestId("log-agent")).toBeVisible();
});
