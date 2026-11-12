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

test("dal menu utente si apre Strumenti, e autorizzare un MCP ne cambia lo stato", async ({ page }) => {
  const state = inventory();
  await page.route("**/api/agent-tools", (route) => route.fulfill({ json: state }));
  await page.route("**/api/mcp/oauth/start", (route) => {
    state.mcp[2] = { ...state.mcp[2], state: "active", toolCount: 2, reason: undefined } as never;
    return route.fulfill({ json: { authorizeUrl: "about:blank" } });
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
  await expect(pageEl.getByTestId("agent-tools-mcp-docs-server")).toHaveAttribute("data-state", "active");
  await expect(pageEl.getByTestId("agent-tools-mcp-old-server")).toHaveAttribute("data-state", "parked");
  await expect(pageEl.getByTestId("agent-tools-mcp-mail-server")).toHaveAttribute("data-state", "needs-auth");
  await expect(pageEl.getByTestId("agent-tools-skill-fake-skill")).toBeVisible();
  await expect(pageEl.getByTestId("agent-tools-cli-fake-cli")).toHaveAttribute("data-installed", "true");

  await pageEl.getByTestId("agent-tools-mcp-mail-server").getByRole("button", { name: /Authorize|Autorizza/ }).click();
  await expect(pageEl.getByTestId("agent-tools-mcp-mail-server")).toHaveAttribute("data-state", "active");
});
