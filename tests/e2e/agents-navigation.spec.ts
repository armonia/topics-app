/**
 * AGENTS NAVIGATION (openspec agenti-e-sistema, AGENTS-NAV-01).
 *
 * Agents overview (AGENTS-01): a card per agent with channel marks and
 * chat count, a channel-less agent saying so with a link to add one, and a
 * "New agent" card. Configure, on its own page (AGENTS-02): Activity is
 * the default, Configure opens separately with a column of sections that
 * survives a reload. Creating an agent (AGENTS-03) writes only IDENTITY.md
 * and shows up without a restart. Channels as a tree (AGENTS-04): channel ->
 * server -> category -> chat -> thread, inherited values say so, an edit
 * narrows to its own node, and Configure > Identity lists what is inherited
 * as one row each with See/Override. Permissions (AGENTS-05): Configure >
 * Permissions shows the policy path, the global owners/trusted and each
 * chat's senders/denied; the agent's Activity has "Stopped recently" with a
 * link into the full register.
 *
 * `/api/agent-config`, `/api/agent-channels` and `/api/agent-channels/places`
 * are faked with `page.route`: the real jarvis-channels files are never
 * touched. Names are placeholders.
 */
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";

hermetic(test);
test.use({ video: "on" });

const REG = {
  health: { ok: true, text: "ok" },
  issues: [],
  routes: [{ channel: "discord", chat: "200", agent: "gtm" }],
  agents: [
    {
      id: "main", name: "Jarvis", job: "CTO, risponde su Discord e WhatsApp", workspace: "/Users/x/.topics/agents/jarvis",
      persona: { "IDENTITY.md": "# Jarvis\nCTO, risponde su Discord e WhatsApp", "SOUL.md": "" },
      accounts: [
        { channel: "discord", account: "default", token: "Portachiavi: discord/jarvis" },
        { channel: "whatsapp", account: "default", token: "store" },
      ],
      chats: [
        { channel: "discord", chat: "*", account: "default", active: true, mention: false, senders: [], denied: [], hasSystem: false, system: "", routed: false, twoAgents: false, followedBy: ["main"] },
        { channel: "discord", chat: "100", account: "default", active: true, mention: false, senders: ["921"], denied: [], hasSystem: true, system: "Rispondi in una frase.", routed: false, twoAgents: false, category: "Operazioni", followedBy: ["main"] },
        { channel: "discord", chat: "101", account: "default", active: true, mention: true, senders: [], denied: ["55"], hasSystem: false, system: "", routed: false, twoAgents: false, category: "Operazioni", followedBy: ["main"] },
        { channel: "whatsapp", chat: "39001@g.us", account: "default", active: true, mention: false, senders: [], denied: [], hasSystem: false, system: "", routed: false, twoAgents: false, followedBy: ["main"] },
      ],
      jobs: [{ id: "j1", name: "Brief del mattino", paused: false, kind: "agent", schedule: "0 8 * * *", rawSchedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Rome" }, model: null, deliver: null }],
      model: { engine: "claude-sonnet-5-5", perChannel: {} },
    },
    {
      id: "gtm", name: "Visione", job: "Outreach", workspace: "/Users/x/.topics/agents/gtm",
      persona: { "IDENTITY.md": "# Visione\nOutreach", "SOUL.md": "" },
      accounts: [{ channel: "discord", account: "visione", token: "Portachiavi: discord/visione" }],
      chats: [{ channel: "discord", chat: "200", account: "visione", active: true, mention: false, senders: [], denied: [], hasSystem: false, system: "", routed: true, twoAgents: false, followedBy: ["main", "gtm"] }],
      jobs: [],
      model: { engine: "claude-sonnet-5-5", perChannel: {} },
    },
    {
      id: "scout", name: "Scout", job: "", workspace: "/Users/x/.topics/agents/scout",
      persona: { "IDENTITY.md": "# Scout\n", "SOUL.md": "" },
      accounts: [], chats: [], jobs: [],
      model: { engine: null, perChannel: {} },
    },
  ],
};

async function stage(page: Page) {
  const posts: { kind: string; body: any }[] = [];
  await page.route("**/api/agent-config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REG) }));
  await page.route("**/api/agent-config/*", async (r) => {
    const kind = new URL(r.request().url()).pathname.split("/").pop()!;
    if (r.request().method() !== "POST") return r.continue();
    posts.push({ kind, body: r.request().postDataJSON() });
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, service: "live" }) });
  });
  await page.route("**/api/agent-channels", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ titles: { "100": "#operazioni", "101": "#segnalazioni", "39001@g.us": "Famiglia" } }) }));
  await page.route("**/api/agent-channels/places", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ places: { "100": { server: "Armonia" }, "101": { server: "Armonia" }, "100:t1": { server: "Armonia", channel: "operazioni", thread: "Migrazione siti" } } }) }));
  await page.route("**/api/system/agents-health", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ problems: [{ id: "jobs:j2", sentence: "Un lavoro a orario non ha un agente scritto.", destination: { section: "jobs", agentId: "main" } }], count: 1, types: [] }) }));
  await page.route("**/api/agent-channels/activity", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    days: 7,
    rows: [{ agent: "main", channel: "discord", handled: 3, failed: 1, quota: 0, merged: 0, lastError: "boom" }],
    turns: [
      { agent: "main", channel: "discord", chat: "100", title: "#operazioni", state: "working", created: Date.now() - 60_000, error: null },
      { agent: "main", channel: "discord", chat: "101", title: "#segnalazioni", state: "failed", created: Date.now() - 3_600_000, error: "boom" },
      { agent: "gtm", channel: "discord:visione", chat: "200", title: "#outreach", state: "done", created: Date.now() - 7_200_000, error: null },
    ],
  }) }));
  await page.route("**/api/agent-tools**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filter: { mode: "all", servers: [] }, servers: [{ name: "fs" }, { name: "web" }] }) }));
  await page.route("**/api/memory-stores", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stores: [] }) }));
  await page.route((url) => url.pathname === "/api/agent-permissions", (r) => {
    const agentId = new URL(r.request().url()).searchParams.get("agent");
    const body = agentId === "main"
      ? {
        policy: { path: "./policy.js", rules: "module.exports = { rule: 'owner-only' };" },
        owners: ["+391234567890"], trusted: ["+390987654321"],
        chats: [
          { channel: "discord", chat: "100", account: "default", mention: false, senders: ["921"], denied: [] },
          { channel: "discord", chat: "101", account: "default", mention: true, senders: [], denied: ["55"] },
        ],
      }
      : { policy: { path: "", rules: null }, owners: [], trusted: [], chats: [] };
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/agent-permissions/stopped**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    rows: [{ created: Date.now() - 60_000, chat: "100", chatTitle: "#operazioni", channel: "discord", agent: "main", reason: "senza_menzione" }],
    total: 1, page: 1, pageSize: 10,
  }) }));
  await goToApp(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "agents" } })));
  await expect(page.getByTestId("agents-pane")).toBeVisible({ timeout: 15_000 });
  return posts;
}

test("panoramica degli agenti (AGENTS-01)", async ({ page }, info) => {
  test.info().annotations.push({ type: "spec", description: "AGENTS-NAV-01" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await stage(page);

  const cards = page.getByTestId("agent-overview-card");
  await expect(cards).toHaveCount(3);
  const jarvisCard = cards.filter({ hasText: "Jarvis" });
  await expect(jarvisCard).toContainText("CTO, risponde su Discord e WhatsApp");
  const marks = jarvisCard.getByTestId("agent-overview-channel");
  await expect(marks).toHaveCount(2); // one mark per channel, each with ITS own chat count
  await expect(marks.nth(0)).toContainText("2 chat");
  await expect(marks.nth(1)).toContainText("1 chat");
  await expect(jarvisCard.getByTestId("agent-overview-state")).toContainText("1 al lavoro");
  await expect(jarvisCard.getByTestId("agent-overview-activity")).toBeVisible();
  await expect(jarvisCard.getByTestId("agent-overview-configure")).toBeVisible();
  const scoutCard = cards.filter({ hasText: "Scout" });
  await expect(scoutCard.getByTestId("agent-overview-no-channels")).toContainText("Nessun canale");
  await expect(page.getByTestId("agent-overview-new")).toBeVisible();

  // "To fix" sits above the cards, each row with a button into its destination
  const toFix = page.getByTestId("agent-overview-to-fix-row");
  await expect(toFix).toHaveCount(1);
  const fixBox = await toFix.boundingBox();
  const cardsBox = await page.getByTestId("agent-overview-cards").boundingBox();
  expect(fixBox!.y).toBeLessThan(cardsBox!.y);

  // the activity list filters by state, agent and channel
  const turns = page.getByTestId("agent-activity-turn");
  await expect(turns).toHaveCount(3);
  await page.getByTestId("agent-activity-filter-working").click();
  await expect(turns).toHaveCount(1);
  await expect(turns.first()).toContainText("#operazioni");
  await page.getByTestId("agent-activity-filter-failed").click();
  await expect(turns).toHaveCount(1);
  await expect(turns.first()).toContainText("boom");
  await page.getByTestId("agent-activity-filter-all").click();
  await expect(turns).toHaveCount(3);

  // at 375 px the cards are one column, with no horizontal scroll
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(page.getByTestId("agent-overview-cards")).toBeVisible();
  const box = await page.getByTestId("agent-overview-cards").boundingBox();
  expect(box!.width).toBeLessThanOrEqual(375);
  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflowX).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("agenti-panoramica-375.png") });
});

test("configurare senza perdersi (AGENTS-02)", async ({ page }, info) => {
  test.info().annotations.push({ type: "spec", description: "AGENTS-NAV-01" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await stage(page);

  await page.getByTestId("agent-overview-card").filter({ hasText: "Scout" }).click();
  await expect(page.getByTestId("agent-activity")).toBeVisible();
  await expect(page.getByTestId("agent-configure")).toHaveCount(0);
  await expect(page.getByTestId("agent-detail-tab-activity")).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("agent-detail-tab-configure").click();
  await expect(page.getByTestId("agent-configure")).toBeVisible();
  await expect(page.getByTestId("agent-configure-section").filter({ hasText: "Identità" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("agent-inherited-badge").first()).toContainText("dalla base del sistema");
  await page.getByTestId("agent-inherited-view").first().click();
  await expect(page.getByTestId("agent-soul-own")).toHaveValue("");

  await page.getByTestId("agent-configure-section").filter({ hasText: "Mestiere" }).click();
  await expect(page.url()).toContain("#agenti/scout/configura/job");

  await page.reload();
  await expect(page.getByTestId("agent-configure-section").filter({ hasText: "Mestiere" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("agent-configure-understand")).toContainText("Per capire");
  await page.screenshot({ path: info.outputPath("agenti-configura-identita.png") });
});

test("creare un agente (AGENTS-03)", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "AGENTS-NAV-01" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await stage(page);

  let created = false;
  await page.route("**/api/agents", async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    created = true;
    const body = r.request().postDataJSON();
    expect(body.name).toBe("Ponte");
    expect(body.job).toBe("Traduce fra i team");
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, agent: { id: "ponte", name: "Ponte", job: body.job } }) });
  });

  await page.getByTestId("agent-overview-new").click();
  await page.getByTestId("agent-new-name").fill("Ponte");
  await page.getByTestId("agent-new-job").fill("Traduce fra i team");
  await page.getByTestId("agent-new-create").click();
  await expect.poll(() => created).toBe(true);
  await expect(page.getByTestId("agent-overview-new-form")).toHaveCount(0);
});

test("canali come albero, ereditato senza ripetizioni (AGENTS-04)", async ({ page }, info) => {
  test.info().annotations.push({ type: "spec", description: "AGENTS-NAV-01" });
  await page.setViewportSize({ width: 1280, height: 900 });
  const posts = await stage(page);

  await page.getByTestId("agent-overview-card").filter({ hasText: "Jarvis" }).click();
  // the agent's Activity: now, errors with the reason, jobs with the cadence in words, how it is made
  await expect(page.getByTestId("agent-activity-now")).toContainText("#operazioni");
  await expect(page.getByTestId("agent-activity-errors")).toContainText("boom");
  await expect(page.getByTestId("agent-activity-job-when")).toHaveText("ogni giorno alle 8");
  await expect(page.getByTestId("agent-activity-upcoming")).not.toContainText("0 8 * * *");
  await expect(page.getByTestId("agent-activity-row").first()).toContainText("Discord");
  await page.getByTestId("agent-made-of-row").filter({ hasText: "Canali e chat" }).click();
  await expect(page.getByTestId("agent-configure-section").filter({ hasText: "Canali e chat" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("agent-configure-section").filter({ hasText: "Canali e chat" })).toContainText("3 chat · 1 thread");

  await expect(page.getByTestId("channel-tree-channel")).toHaveCount(2);
  await expect(page.getByTestId("channel-tree-channel").first()).toContainText("Discord");
  await expect(page.getByTestId("channel-tree-server").first()).toContainText("Armonia");
  await expect(page.getByTestId("channel-tree-channel").first().getByTestId("channel-tree-count").first()).toContainText("2 chat · 1 thread");
  await expect(page.getByTestId("channel-tree-header")).toContainText("Risponde");
  // the columns are one grid: the switch sits under its heading and the name is not cut
  const headerBox = await page.getByTestId("channel-tree-header-active").boundingBox();
  const switchBox = await page.getByTestId("channel-tree-chat").filter({ hasText: "#segnalazioni" }).getByTestId("agent-chat-active").boundingBox();
  expect(Math.abs((switchBox?.x ?? -99) - (headerBox?.x ?? 99))).toBeLessThanOrEqual(4);
  const nameBox = await page.getByTestId("channel-tree-chat-open").filter({ hasText: "#operazioni" }).evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1);
  expect(nameBox).toBe(true);
  // the thread sits under its chat without opening anything
  await expect(page.getByTestId("channel-tree-chat").filter({ hasText: "#operazioni" }).getByTestId("channel-tree-thread")).toContainText("Migrazione siti");
  // search narrows the tree to chats, threads or people that match
  await page.getByTestId("channel-tree-search").fill("migrazione");
  await expect(page.getByTestId("channel-tree-chat")).toHaveCount(1);
  await page.getByTestId("channel-tree-search").fill("");
  await expect(page.getByTestId("channel-tree-chat")).toHaveCount(3);
  await expect(page.getByTestId("channel-tree-category").first()).toContainText("Operazioni");
  await expect(page.getByTestId("channel-tree-chat")).toHaveCount(3); // 2 discord + 1 whatsapp
  await expect(page.getByTestId("channel-tree-inherit-tag").first()).toContainText("come Discord");

  // set "when mentioned" on channel 101: only that channel changes and it becomes its own
  const chat101 = page.getByTestId("channel-tree-chat").filter({ hasText: "#segnalazioni" });
  await chat101.getByTestId("agent-chat-mention").click();
  await expect.poll(() => posts.find((p) => p.kind === "chat" && p.body.chat === "101")?.body).toMatchObject({ channel: "discord", chat: "101", mention: false });

  await chat101.getByTestId("channel-tree-chat-open").click();
  await expect(page.getByTestId("channel-tree-detail")).toBeVisible();
  await expect(page.getByTestId("channel-tree-people")).toContainText("Escluso");

  await page.getByTestId("agent-configure-section").filter({ hasText: "Identità" }).click();
  await expect(page.getByTestId("agent-inherited-row")).toHaveCount(4); // anima, regole, strumenti, memoria
  await expect(page.getByTestId("agent-inherited-action").first()).toContainText("Sovrascrivi");
  await page.screenshot({ path: info.outputPath("agenti-canali-albero.png") });
});

test("permessi agenti e registro dei fermati (AGENTS-05)", async ({ page }, info) => {
  test.info().annotations.push({ type: "spec", description: "AGENTS-NAV-01" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await stage(page);

  await page.getByTestId("agent-overview-card").filter({ hasText: "Jarvis" }).click();
  // the UI label "Fermati di recente" in Activity, with a link into the full register // allow-italian: quoted UI copy
  await expect(page.getByTestId("agent-activity-stopped-row")).toHaveCount(1);
  await expect(page.getByTestId("agent-activity-stopped-row")).toContainText("#operazioni");
  await page.getByTestId("agent-activity-stopped-seeall").click();

  await expect(page.getByTestId("agent-configure-section").filter({ hasText: "Permessi" })).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("agent-permissions")).toBeVisible();
  // policy, owners and trusted are one inherited row each, the list opens with «Vedi»
  await expect(page.getByTestId("agent-inherited-row")).toHaveCount(3);
  const secondInheritedRow = page.getByTestId("agent-inherited-row").nth(1);
  await secondInheritedRow.getByTestId("agent-inherited-view").click();
  await expect(secondInheritedRow.getByTestId("agent-inherited-detail")).toContainText("+391234567890");

  // the chat's senders/denied, with «Sovrascrivi» pointing back at the chat that owns them
  await expect(page.getByTestId("agent-permissions-chats")).toContainText("Escluso");
  await page.getByTestId("agent-permissions-override").first().click();
  await expect(page.getByTestId("agent-configure-section").filter({ hasText: "Canali e chat" })).toHaveAttribute("aria-current", "true");

  // the full register, filterable, reached from the same section
  await page.getByTestId("agent-configure-section").filter({ hasText: "Permessi" }).click();
  await expect(page.getByTestId("agent-permissions-register")).toBeVisible();
  await expect(page.getByTestId("agent-permissions-stopped-row")).toHaveCount(1);

  // at 375 px, a link into a Configure section opens it in one tap, same as on desktop
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByTestId("agent-detail-tab-activity").click();
  await page.getByTestId("agent-activity-stopped-seeall").click();
  await expect(page.getByTestId("agent-permissions")).toBeVisible();

  const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflowX).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("agenti-permessi-375.png") });

  // at 768 px, the stopped-turns register's filters and pagination stay inside the column
  await page.setViewportSize({ width: 768, height: 900 });
  // a single page of results means no pagination controls at all
  await expect(page.getByTestId("agent-permissions-register-prev")).toHaveCount(0);
  const registerBox = await page.getByTestId("agent-permissions-register").boundingBox();
  const reasonFilterBox = await page.getByTestId("agent-permissions-reason-filter").boundingBox();
  expect(reasonFilterBox!.x + reasonFilterBox!.width).toBeLessThanOrEqual(registerBox!.x + registerBox!.width + 1);
  const overflowX768 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflowX768).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("agenti-permessi-768.png") });
});
