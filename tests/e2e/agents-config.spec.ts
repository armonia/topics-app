/**
 * AGENTI IN TOPICS (openspec agenti-in-topics, AGCFG-01).
 *
 * The Agents view opens on the registry of Jarvis and Visione: the health of
 * the channels, the incoherences of the configuration, the personality, the
 * model, the chats with their switches and the scheduled jobs. Switching
 * Visione's tab shows only Visione's chats and jobs. Turning a job off posts
 * `{ id, paused: true }` to `/api/agent-config/job` and the note says it is
 * saved; turning a chat's «Solo se citato» on posts Visione's account, never
 * Jarvis's. Editing the personality enables Save and posts the new text.
 *
 * `/api/agent-config` is faked with `page.route`: the real jarvis-channels
 * files and the real service are never touched. The names are placeholders.
 *
 * A chat row opens on its own instructions and who may write: saving posts
 * both for that chat's account. A job row opens on its schedule: saving posts
 * the new cron. A chat both agents answer by design says «due agenti, voluto».
 *
 * Mutation: with `account: c.account` dropped from the chat post
 * (AgentProfiles.tsx), the edit would land on Jarvis's rule of the same chat
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

hermetic(test);
test.use({ video: "on" });

const chat = (chat: string, account: string, extra: object = {}) => ({ channel: "discord", chat, account, active: true, mention: false, senders: [], denied: [], hasSystem: true, system: "Rispondi in una frase.", routed: account === "visione", twoAgents: chat === "200", ...extra });
const REG = {
  health: { ok: false, text: "⚠️ Canali: 1 turni fermi in coda da oltre mezz'ora" },
  issues: [
    { agent: null, text: "discord:100: regola scritta 2 volte (Jarvis e Visione), con menzione/attiva diverse" },
  ],
  agents: [
    {
      id: "main", name: "Jarvis", workspace: "/Users/x/.claude/jarvis/home",
      persona: { "IDENTITY.md": "# IDENTITY\n- **Name:** Jarvis\n- **Vibe:** diretto, conciso, ironico", "SOUL.md": "# SOUL\nAiuta senza essere servile." },
      accounts: [{ channel: "discord", account: "default", token: "Portachiavi: discord/jarvis" }, { channel: "whatsapp", account: "default", token: "store" }],
      chats: [chat("100", "default", { mention: true }), chat("200", "default"), chat("*", "default", { channel: "telegram", senders: ["1"] })],
      jobs: [{ id: "j1", name: "Brief del mattino", paused: false, kind: "agent", schedule: "0 8 * * *", rawSchedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Rome" }, model: null, deliver: "whatsapp:1" }],
      model: { engine: "claude-sonnet-5-5", perChannel: { discord: { "*": "anthropic/claude-opus-5-5" } } },
    },
    {
      id: "gtm", name: "Visione", workspace: "/Users/x/.claude/jarvis/home/workspace-gtm",
      persona: { "IDENTITY.md": "# IDENTITY\n- **Name:** Visione\n- **Vibe:** operativa e stretta", "SOUL.md": "# SOUL\nMisura, non racconta." },
      accounts: [{ channel: "discord", account: "visione", token: "Portachiavi: discord/visione" }],
      chats: [chat("200", "visione")],
      jobs: [{ id: "v1", name: "Giro prospect e bozze", paused: false, kind: "agent", schedule: "0 8 * * 1-5", rawSchedule: { kind: "cron", expr: "0 8 * * 1-5", tz: "Europe/Rome" }, model: "muse-spark-1.3", deliver: "discord:200" }],
      model: { engine: "claude-sonnet-5-5", perChannel: {} },
    },
  ],
};

async function stage(page: Page) {
  const posts: { kind: string; body: any }[] = [];
  await page.route("**/api/agent-config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REG) }));
  await page.route("**/api/agent-config/*", async (r) => {
    const kind = new URL(r.request().url()).pathname.split("/").pop()!;
    posts.push({ kind, body: r.request().postDataJSON() });
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, service: kind === "chat" ? "restarted" : "live" }) });
  });
  await page.route("**/api/agent-channels", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ titles: { "100": "#generale", "200": "#vendite" } }) }));
  await goToApp(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "agents" } })));
  await expect(page.getByTestId("agent-profiles")).toBeVisible({ timeout: 15_000 });
  return posts;
}

test("without jarvis-channels the view stays the sessions list it was", async ({ page }, info) => {
  await page.route("**/api/agent-config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agents: [], issues: [], health: null }) }));
  await goToApp(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-utility", { detail: { type: "agents" } })));
  await expect(page.getByTestId("agents-pane")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("agent-profiles")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("vero-agenti-senza-anagrafica.png"), fullPage: true });
});

test("the registry of Jarvis and Visione reads and writes through /api/agent-config", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 1500 });
  const posts = await stage(page);
  await expect(page.getByTestId("agent-health")).toContainText("turni fermi");
  await expect(page.getByTestId("agent-issues")).toContainText("#generale: regola scritta 2 volte");
  await expect(page.getByTestId("agent-persona")).toHaveValue(/Jarvis/);
  await expect(page.getByTestId("agent-chat")).toHaveCount(3);
  await expect(page.getByTestId("agent-chat-two")).toHaveCount(1);
  await page.getByTestId("agent-chat-edit").first().click();
  await expect(page.getByTestId("agent-chat-system")).toHaveValue("Rispondi in una frase.");
  await page.getByTestId("agent-chat-senders").fill("921, 502");
  await page.getByTestId("agent-chat-save").click();
  // posts the senders as a list
  await expect.poll(() => posts.find((p) => p.kind === "chat")?.body).toEqual({ channel: "discord", chat: "100", account: "default", system: "Rispondi in una frase.", senders: ["921", "502"] });
  await expect(page.getByTestId("agent-chat-editor")).toHaveCount(0);
  await page.getByTestId("agent-job-edit").first().click();
  await page.getByTestId("agent-job-cron").fill("30 7 * * 1-5");
  await page.getByTestId("agent-job-save").click();
  await expect.poll(() => posts.find((p) => p.kind === "job" && p.body.schedule)?.body).toEqual({ id: "j1", schedule: { kind: "cron", expr: "30 7 * * 1-5", tz: "Europe/Rome" } });
  await page.getByTestId("agent-chat-edit").first().click();
  await page.getByTestId("agent-job-edit").first().click();
  await page.screenshot({ path: info.outputPath("vero-agenti-anagrafica.png"), fullPage: true });

  await page.getByTestId("agent-job-on").first().click();
  await expect.poll(() => posts.find((p) => p.kind === "job" && "paused" in p.body)?.body).toEqual({ id: "j1", paused: true });
  await expect(page.getByTestId("agent-note")).toContainText("Salvato");

  await page.getByTestId("agent-tab").filter({ hasText: "Visione" }).click();
  await expect(page.getByTestId("agent-persona")).toHaveValue(/Visione/);
  await expect(page.getByTestId("agent-chat")).toHaveCount(1);
  await expect(page.getByTestId("agent-job")).toContainText("Giro prospect");
  await page.getByTestId("agent-chat").getByRole("switch", { name: "Solo se citato" }).click();
  // posts Visione's account
  await expect.poll(() => posts.find((p) => p.kind === "chat" && "mention" in p.body)?.body).toEqual({ channel: "discord", chat: "200", account: "visione", mention: true });
  await expect(page.getByTestId("agent-note")).toContainText("canali riavviati");

  await page.getByTestId("agent-persona").fill("# IDENTITY\n- **Name:** Visione\n- **Vibe:** operativa, misura e basta");
  await page.getByTestId("agent-persona-save").click();
  await expect.poll(() => posts.find((p) => p.kind === "persona")?.body?.agent).toBe("gtm");
});
