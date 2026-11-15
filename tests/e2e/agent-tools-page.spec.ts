/**
 * The agents' tools page, opened from the user menu: MCP servers in three
 * states, a skill and a CLI, with the inventory intercepted (no real server,
 * no sign-in). Authorizing a server that needs it changes its state.
 *
 * @covers AGENT-TOOLS-01
 */
import { expect, test } from "@playwright/test";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { openUserMenuLevel } from "./helpers/user-menu";
import { openProfileMenu } from "./helpers/open-perf-panel";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

hermetic(test);

const inventory = () => ({
  mcp: [
    { name: "docs-server", state: "active", transport: "http", toolCount: 4, source: "~/.claude.json", parkedByUser: false },
    { name: "old-server", state: "parked", transport: "stdio", toolCount: 0, reason: "Parked from the Tools page.", source: "~/.claude.json", parkedByUser: true },
    { name: "mail-server", state: "needs-auth", transport: "http", toolCount: 0, reason: "Sign-in required.", source: "~/.claude.json", parkedByUser: false },
  ],
  skills: [{ name: "fake-skill", description: "Does a fake thing", source: "~/.agents/skills" }],
  clis: [{ id: "fake-cli", name: "Fake CLI", installed: true, path: "/usr/bin/fake", install: "npm i -g fake" }],
  sources: [{ kind: "mcp", label: "~/.claude.json", found: true, extra: false }],
});

test("dal menu utente si apre Strumenti: autorizza, parcheggia, rimonta, aggiorna e i collegamenti", async ({ page }) => {
  const state = inventory();
  const mail = () => state.mcp[2] as { state: string; toolCount: number; reason?: string };
  const posted: Array<Record<string, unknown>> = [];
  let refreshes = 0;
  let inventoryReads = 0;
  await page.route("**/api/agent-tools", (route) => { inventoryReads += 1; return route.fulfill({ json: state }); });
  // The server mounts a server only at the OAuth callback, never at /start.
  await page.route("**/api/mcp/oauth/start", (route) => route.fulfill({ json: { authorizeUrl: "about:blank" } }));
  await page.route("**/api/mcp/fleet/refresh", (route) => { refreshes += 1; return route.fulfill({ json: {} }); });
  await page.route("**/api/agent-tools/settings", (route) => {
    const body = route.request().postDataJSON() as { park?: string; mount?: string };
    posted.push(body);
    const target = state.mcp.find((m) => m.name === (body.park ?? body.mount));
    if (target && body.park) { target.state = "parked"; target.parkedByUser = true; }
    if (target && body.mount) { target.state = "active"; target.parkedByUser = false; }
    return route.fulfill({ json: {} });
  });

  await goToApp(page);
  const card = page.getByTestId("identity-me-profile");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();
  const menu = page.getByTestId("profile-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await menu.getByTestId("topics-menu-agent-tools").click();

  const pageEl = page.getByTestId("agent-tools-page");
  await expect(pageEl).toBeVisible({ timeout: 10_000 });
  const row = (name: string) => pageEl.getByTestId(`agent-tools-mcp-${name}`);
  await expect(row("docs-server")).toHaveAttribute("data-state", "active");
  await expect(row("old-server")).toHaveAttribute("data-state", "parked");
  await expect(row("mail-server")).toHaveAttribute("data-state", "needs-auth");
  await expect(pageEl.getByTestId("agent-tools-skill-fake-skill")).toBeVisible();
  await expect(pageEl.getByTestId("agent-tools-cli-fake-cli")).toHaveAttribute("data-installed", "true");

  // Authorize: the page stays on "needs sign-in" until the callback, then follows it by itself.
  const readsAtClick = inventoryReads;
  await row("mail-server").getByRole("button", { name: /Authorize|Autorizza/ }).click();
  await expect.poll(() => inventoryReads, { timeout: 10_000 }).toBeGreaterThan(readsAtClick);
  await expect(row("mail-server")).toHaveAttribute("data-state", "needs-auth");
  mail().state = "active";
  mail().toolCount = 2;
  await expect(row("mail-server")).toHaveAttribute("data-state", "active", { timeout: 10_000 });

  // Disconnect parks the server for the agents (the settings call carries the name).
  await row("docs-server").getByRole("button", { name: /Disconnect|Scollega/ }).click();
  await expect(row("docs-server")).toHaveAttribute("data-state", "parked");
  expect(posted).toContainEqual({ park: "docs-server" });

  // Mount brings back a server parked from here.
  await row("old-server").getByRole("button", { name: /Mount|Rimonta/ }).click();
  await expect(row("old-server")).toHaveAttribute("data-state", "active");
  expect(posted).toContainEqual({ mount: "old-server" });

  await pageEl.getByTestId("agent-tools-refresh").click();
  await expect.poll(() => refreshes).toBe(1);

  // The links go to the existing views, nothing is duplicated here.
  // The Automations view needs a hub to render rows, so the link is proven by the request it makes.
  await page.evaluate(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.addEventListener("topics:open-utility", (e) => (window as unknown as { __opened: string[] }).__opened.push((e as CustomEvent<{ type: string }>).detail.type));
  });
  await pageEl.getByTestId("agent-tools-open-automations").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toContain("automations");
});

// Evidence for the card: the Tools level next to the Devices level at four widths, realistic data.
const SHOT_DIR = join(homedir(), ".topics", "media", "strumenti-572f8a09");

test("screenshots: Strumenti accanto a Dispositivi a 375, 768, 1440 e 3440", async ({ page }) => {
  mkdirSync(SHOT_DIR, { recursive: true });
  const mcp = [
    ...["docs", "github", "linear", "browser", "database"].map((name, i) => ({ name: `${name}-server`, state: "active", transport: "http", toolCount: 4 + i * 3, source: "~/.claude.json", parkedByUser: false })),
    { name: "mail-server", state: "needs-auth", transport: "http", toolCount: 0, reason: "Sign-in required.", source: "~/.claude.json", parkedByUser: false },
    { name: "broken-server", state: "failed", transport: "stdio", toolCount: 0, reason: "Process exited with code 1.", source: "~/.claude.json", parkedByUser: false },
    { name: "old-server", state: "parked", transport: "stdio", toolCount: 0, reason: "Parked from the Tools page.", source: "~/.claude.json", parkedByUser: true },
  ];
  const skills = ["commit", "review", "deploy-checklist", "design-system-audit", "release-notes", "database-migration", "security-sweep"].map((name) => ({
    name, description: `A fairly long description of what the ${name} skill does for the agent`, source: "~/.agents/skills",
  }));
  const clis = [
    { id: "claude-code", name: "Claude Code", installed: true, path: "/usr/bin/claude", install: "npm i -g claude" },
    { id: "codex", name: "Codex", installed: true, path: "/usr/bin/codex", install: "npm i -g codex" },
    { id: "muse", name: "Muse", installed: false, path: "", install: "npm i -g muse" },
  ];
  const sources = [
    { kind: "mcp", label: "~/.claude.json", found: true, extra: false },
    { kind: "skills", label: "~/.agents/skills", found: true, extra: false },
    { kind: "skills", label: "~/work/team-skills", found: true, extra: true },
  ];
  await page.route("**/api/agent-tools", (route) => route.fulfill({ json: { mcp, skills, clis, sources } }));

  for (const width of [375, 768, 1440, 3440]) {
    await page.setViewportSize({ width, height: 900 });
    await goToApp(page);
    await openProfileMenu(page);
    await page.getByTestId("topics-menu-agent-tools").click();
    const tools = page.getByTestId("agent-tools-page");
    await expect(tools).toBeVisible({ timeout: 10_000 });
    await expect(tools.getByTestId("agent-tools-mcp-github-server")).toBeVisible();
    await page.screenshot({ path: join(SHOT_DIR, `strumenti-${width}.png`) });
    // No horizontal overflow of the page at any width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await goToApp(page);
    await expect(await openUserMenuLevel(page, "devices")).toBeVisible();
    await page.screenshot({ path: join(SHOT_DIR, `dispositivi-${width}.png`) });
  }
});
