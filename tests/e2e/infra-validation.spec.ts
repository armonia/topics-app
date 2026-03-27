/**
 * Infrastructure validation spec — proves all Phase 1 INFRA requirements work
 * against the live app. Each test group maps to a specific INFRA requirement.
 */
import { test, expect } from "./fixtures/test-fixtures";
import { dndDrag, dndReorder } from "./helpers/dnd-helpers";
import { scrollToFind, scrollAndCollect } from "./helpers/scroll-helpers";
import { interceptWebSocket, mockWebSocket } from "./helpers/ws-helpers";
import {
  createTopic,
  deleteTopic,
  createAgentProfile,
  deleteAgentProfile,
} from "./helpers/api-fixtures";
import { goToApp } from "./helpers";
import * as fs from "fs";
import * as path from "path";

test.describe("INFRA-01: dnd-helper functions are importable", () => {
  test("dndDrag and dndReorder are callable functions", async () => {
    expect(typeof dndDrag).toBe("function");
    expect(typeof dndReorder).toBe("function");
  });
});

test.describe("INFRA-02: scroll-helper functions are importable", () => {
  test("scrollToFind and scrollAndCollect are callable functions", async () => {
    expect(typeof scrollToFind).toBe("function");
    expect(typeof scrollAndCollect).toBe("function");
  });
});

test.describe("INFRA-03: ws-helper can intercept WebSocket messages", () => {
  test("interceptWebSocket captures messages on page load", async ({
    page,
  }) => {
    const interceptor = await interceptWebSocket(page);
    await page.goto("/");
    await page
      .locator('[aria-label="Topics sidebar"]')
      .waitFor({ state: "visible", timeout: 15000 });
    // Wait for WS messages to flow — the app sends/receives after connecting
    await expect
      .poll(() => interceptor.messages.length, {
        message: "Expected WebSocket messages to be captured",
        timeout: 10000,
      })
      .toBeGreaterThan(0);
  });
});

test.describe("INFRA-04: api-fixtures create and delete data", () => {
  test("can create and delete a topic via API", async ({ request }) => {
    const topic = await createTopic(
      request,
      "Infra Test Topic " + Date.now()
    );
    expect(topic).toHaveProperty("id");
    expect(topic).toHaveProperty("name");
    // Cleanup
    await deleteTopic(request, topic.id);
  });

  test("can create and delete an agent profile via API", async ({
    request,
  }) => {
    const profile = await createAgentProfile(
      request,
      "Test Agent " + Date.now()
    );
    expect(profile).toHaveProperty("id");
    // Cleanup
    await deleteAgentProfile(request, profile.id);
  });
});

test.describe("INFRA-05: page-fixtures provide chatPage and sidebarPage", () => {
  test("test.extend provides chatPage and sidebarPage", async ({
    page,
    chatPage,
    sidebarPage,
  }) => {
    await goToApp(page);
    expect(chatPage).toBeTruthy();
    expect(sidebarPage).toBeTruthy();
    await expect(sidebarPage.sidebar).toBeVisible();
  });
});

test.describe("INFRA-06: helpers use no waitForTimeout", () => {
  test("goToApp source has no waitForTimeout calls", async () => {
    const helpersPath = path.resolve(__dirname, "helpers.ts");
    const src = fs.readFileSync(helpersPath, "utf-8");
    // Strip comments (lines starting with * or //) then check for waitForTimeout usage
    const codeLines = src
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
      })
      .join("\n");
    expect(codeLines).not.toContain("waitForTimeout");
  });

  test("goToApp navigates and loads sidebar", async ({ page }) => {
    await goToApp(page);
    await expect(
      page.locator('[aria-label="Topics sidebar"]')
    ).toBeVisible();
  });
});

test.describe("INFRA-07: structural data-testids are present in source", () => {
  test("source files contain required data-testid attributes", async () => {
    const clientSrc = path.resolve(__dirname, "../../client/src");

    const appSrc = fs.readFileSync(
      path.join(clientSrc, "App.tsx"),
      "utf-8"
    );
    expect(appSrc).toContain('data-testid="sidebar-topic-list"');

    const msgListSrc = fs.readFileSync(
      path.join(clientSrc, "components/Chat/MessageList.tsx"),
      "utf-8"
    );
    expect(msgListSrc).toContain('data-testid="chat-message-list"');

    const chatInputSrc = fs.readFileSync(
      path.join(clientSrc, "components/Chat/ChatInput.tsx"),
      "utf-8"
    );
    expect(chatInputSrc).toContain('data-testid="chat-message-input"');

    const connStatusSrc = fs.readFileSync(
      path.join(clientSrc, "components/Layout/ConnectionStatus.tsx"),
      "utf-8"
    );
    expect(connStatusSrc).toContain('data-testid="connection-status"');

    const tabBarSrc = fs.readFileSync(
      path.join(clientSrc, "components/Layout/PaneTabBar.tsx"),
      "utf-8"
    );
    expect(tabBarSrc).toContain('data-testid="panel-tab-bar"');

    const cmdPaletteSrc = fs.readFileSync(
      path.join(clientSrc, "components/Shared/CommandPalette.tsx"),
      "utf-8"
    );
    expect(cmdPaletteSrc).toContain('data-testid="command-palette"');
  });
});
