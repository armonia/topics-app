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
 * as one row each with See/Override.
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
  await page.route("**/api/agent-tools**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ filter: { mode: "all", servers: [] }, servers: [{ name: "fs" }, { name: "web" }] }) }));
  await page.route("**/api/memory-stores", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stores: [] }) }));
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
  await expect(jarvisCard.getByTestId("agent-overview-chat-count")).toContainText("3 chat");
  const scoutCard = cards.filter({ hasText: "Scout" });
  await expect(scoutCard.getByTestId("agent-overview-no-channels")).toContainText("Nessun canale");
  await expect(page.getByTestId("agent-overview-new")).toBeVisible();

  // at 375 px the cards are one column, with no horizontal scroll
  await page.setViewportSize({ width: 375, height: 800 });
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
  await page.getByTestId("agent-detail-tab-configure").click();
  await page.getByTestId("agent-configure-section").filter({ hasText: "Canali e chat" }).click();

  await expect(page.getByTestId("channel-tree-channel")).toContainText("Discord");
  await expect(page.getByTestId("channel-tree-server")).toContainText("Armonia");
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
