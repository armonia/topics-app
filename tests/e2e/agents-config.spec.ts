/**
 * AGENTI IN TOPICS (openspec agenti-in-topics / agenti-e-sistema, AGCFG-01, AGCFG-03).
 *
 * The Agents view opens on a panoramica with one card per always-on agent
 * (Jarvis, Visione); opening a card goes to that agent's own page. Opening
 * Visione's own Configure shows only Visione's chats and jobs. Turning a job
 * off posts `{ id, paused: true }` to `/api/agent-config/job` and the note
 * says it is saved; turning a chat's «Solo se citato» on, from Visione's own
 * page, posts Visione's account, never Jarvis's. Editing the identity enables
 * Save and posts the new text.
 *
 * `/api/agent-config` is faked with `page.route`: the real jarvis-channels
 * files and the real service are never touched. The names are placeholders.
 *
 * A chat row opens on its own instructions and who may write: saving posts
 * both for that chat's account. A job row opens on its schedule: saving posts
 * the new cron. A chat both agents answer by design says «due agenti, voluto».
 *
 * Mutation: with `account: c.account` dropped from the chat post
 * (ChannelTree.tsx), the edit would land on Jarvis's rule of the same chat
 * and «posts Visione's account» is red.
 *
 * Video on: the recording is the proof; the screenshot goes to the test's
 * output (`vero-agenti-anagrafica.png`).
 *
 * Second mutation: with the senders sent as the raw text instead of split
 * into ids, «posts the senders as a list» is red.
 *
 * @covers AGCFG-01
 * @covers AGCFG-03
 */
import { expect, test, type Page } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { VIDEO_ON } from "./video-evidence";

hermetic(test);
test.use({ video: VIDEO_ON });

const chat = (chat: string, account: string, extra: object = {}) => ({ channel: "discord", chat, account, active: true, mention: false, senders: [], denied: [], hasSystem: true, system: "Rispondi in una frase.", routed: account === "visione", twoAgents: chat === "200", followedBy: account === "visione" ? ["gtm"] : ["main"], ...extra });
const REG = {
  health: { ok: false, text: "⚠️ Canali: 1 turni fermi in coda da oltre mezz'ora" },
  issues: [
    { agent: null, text: "discord:100: regola scritta 2 volte (Jarvis e Visione), con menzione/attiva diverse" },
  ],
  routes: [],
  agents: [
    {
      id: "main", name: "Jarvis", job: "", workspace: "/Users/x/.topics/agents/jarvis",
      persona: { "IDENTITY.md": "# Jarvis\nCTO", "SOUL.md": "Aiuta senza essere servile, e non più di quanto serva per restare onesto e preciso." },
      accounts: [{ channel: "discord", account: "default", token: "Portachiavi: discord/jarvis" }, { channel: "whatsapp", account: "default", token: "store" }],
      chats: [chat("100", "default", { mention: true }), chat("200", "default", { followedBy: ["main", "gtm"] }), chat("*", "default", { channel: "telegram", senders: ["1"] })],
      jobs: [{ id: "j1", name: "Brief del mattino", paused: false, kind: "agent", schedule: "0 8 * * *", rawSchedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Rome" }, model: null, deliver: "whatsapp:1" }],
      model: { engine: "claude-sonnet-5-5", perChannel: { discord: { "*": "anthropic/claude-opus-5-5" } } },
    },
    {
      id: "gtm", name: "Visione", job: "", workspace: "/Users/x/.topics/agents/gtm",
      persona: { "IDENTITY.md": "# Visione\nOutreach", "SOUL.md": "Misura, non racconta, e lo dice in una riga sola quando basta." },
      accounts: [{ channel: "discord", account: "visione", token: "Portachiavi: discord/visione" }],
      chats: [chat("200", "visione", { followedBy: ["main", "gtm"] })],
      jobs: [{ id: "v1", name: "Giro prospect e bozze", paused: false, kind: "agent", schedule: "0 8 * * 1-5", rawSchedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Rome" }, model: "muse-spark-1.3", deliver: "discord:200" }],
      model: { engine: "claude-sonnet-5-5", perChannel: {} },
    },
  ],
};

async function stage(page: Page) {
  const posts: { kind: string; body: any }[] = [];
  await page.route("**/api/agent-config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REG) }));
  await page.route("**/api/agent-config/*", async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    const kind = new URL(r.request().url()).pathname.split("/").pop()!;
    posts.push({ kind, body: r.request().postDataJSON() });
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, service: kind === "chat" ? "restarted" : "live" }) });
  });
  await page.route("**/api/agent-channels", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ titles: { "100": "#generale", "200": "#vendite" } }) }));
  await page.route("**/api/agent-channels/places", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ places: {} }) }));
  await page.route("**/api/system/agents-health", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ problems: [], count: 0, types: [] }) }));
  await goToApp(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "agents" } })));
  await expect(page.getByTestId("agents-pane")).toBeVisible({ timeout: 15_000 });
  return posts;
}

test("without jarvis-channels the view stays the sessions list it was", async ({ page }, info) => {
  await page.route("**/api/agent-config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agents: [], issues: [], health: null, routes: [] }) }));
  await goToApp(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "agents" } })));
  await expect(page.getByTestId("agents-pane")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-overview-cards")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("vero-agenti-senza-anagrafica.png"), fullPage: true });
});

test("the registry of Jarvis and Visione reads and writes through /api/agent-config", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 1500 });
  const posts = await stage(page);
  await expect(page.getByTestId("agent-health")).toContainText("turni fermi");

  await page.getByTestId("agent-overview-card").filter({ hasText: "Jarvis" }).click();
  await expect(page.getByTestId("agent-issues")).toContainText("regola scritta 2 volte");
  await page.getByTestId("agent-detail-tab-configure").click();
  await page.getByTestId("agent-configure-section").filter({ hasText: "Canali e chat" }).click();

  await expect(page.getByTestId("channel-tree-chat")).toHaveCount(2); // the two real chats; the "*" default is the baseline, not a leaf
  await page.getByTestId("channel-tree-chat").first().getByTestId("agent-chat-edit").click();
  await expect(page.getByTestId("agent-chat-system")).toHaveValue("Rispondi in una frase.");
  await page.getByTestId("agent-chat-senders").fill("921, 502");
  await page.getByTestId("agent-chat-save").click();
  // posts the senders as a list
  await expect.poll(() => posts.find((p) => p.kind === "chat")?.body).toEqual({ channel: "discord", chat: "100", account: "default", system: "Rispondi in una frase.", senders: ["921", "502"] });
  await expect(page.getByTestId("agent-chat-editor")).toHaveCount(0);

  await page.getByTestId("agent-configure-section").filter({ hasText: "Lavori a orario" }).click();
  await page.getByTestId("agent-job-edit").first().click();
  await page.getByTestId("agent-job-cron").fill("30 7 * * 1-5");
  await page.getByTestId("agent-job-save").click();
  await expect.poll(() => posts.find((p) => p.kind === "job" && p.body.schedule)?.body).toEqual({ id: "j1", schedule: { kind: "cron", expr: "30 7 * * 1-5", tz: "Europe/Rome" } });
  await page.screenshot({ path: info.outputPath("vero-agenti-anagrafica.png"), fullPage: true });

  await page.getByTestId("agent-job-on").first().click();
  await expect.poll(() => posts.find((p) => p.kind === "job" && "paused" in p.body)?.body).toEqual({ id: "j1", paused: true });
  await expect(page.getByTestId("agent-note")).toContainText("Salvato");

  await page.getByTestId("agent-detail-back").click();
  await page.getByTestId("agent-overview-card").filter({ hasText: "Visione" }).click();
  await expect(page.getByTestId("agent-activity")).toBeVisible();
  await expect(page.getByTestId("agent-activity-job")).toContainText("Giro prospect");
  await page.getByTestId("agent-detail-tab-configure").click();
  await page.getByTestId("agent-configure-section").filter({ hasText: "Canali e chat" }).click();
  await expect(page.getByTestId("channel-tree-chat")).toHaveCount(1);
  await page.getByTestId("channel-tree-chat").getByTestId("agent-chat-mention").click();
  // posts Visione's account
  await expect.poll(() => posts.find((p) => p.kind === "chat" && "mention" in p.body)?.body).toEqual({ channel: "discord", chat: "200", account: "visione", mention: true });
  await expect(page.getByTestId("agent-note")).toContainText("canali riavviati");

  await page.getByTestId("agent-configure-section").filter({ hasText: "Identità" }).click();
  await page.getByTestId("agent-inherited-view").first().click();
  await page.getByTestId("agent-soul-own").fill("Misura, non racconta, e lo dice in una riga sola quando basta davvero.");
  await page.getByTestId("agent-soul-save").click();
  await expect.poll(() => posts.find((p) => p.kind === "persona")?.body?.agent).toBe("gtm");
});
