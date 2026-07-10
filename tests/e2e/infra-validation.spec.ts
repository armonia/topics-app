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
import { execFileSync } from "child_process";

function grepOutsidePaneState(pattern: string): string[] {
  let out = "";
  try {
    out = execFileSync(
      "grep",
      ["-r", "-n", pattern, "client/src", "--include=*.ts", "--include=*.tsx"],
      { encoding: "utf8" }
    );
  } catch (e: any) {
    // grep exits 1 on zero matches — treat as empty
    out = e.stdout?.toString() ?? "";
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((l) => !l.startsWith("client/src/state/pane/"))
    .filter((l) => !l.includes("PANE-01-ALLOWED"))
    // Drop full-line comments — a JSDoc/`//` mention of a banned key is
    // documentation, not a real access. grep lines are `path:lineno:content`;
    // strip the `path:lineno:` prefix, then apply the same comment test as
    // INFRA-06 above. Real violations are always non-comment code.
    .filter((l) => {
      const content = l.replace(/^[^:]*:\d+:/, "").trim();
      return (
        !content.startsWith("//") &&
        !content.startsWith("*") &&
        !content.startsWith("/*")
      );
    });
}

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

    // ConnectionStatus.tsx was removed in 8daa9b5b (refactor(ui): simplify
    // connection status indicator); the testid now lives on the sidebar status
    // bar's gateway button.
    const connStatusSrc = fs.readFileSync(
      path.join(clientSrc, "components/Sidebar/SidebarStatusBar.tsx"),
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

test.describe("PANE-01: no legacy pane-state access outside state/pane/", () => {
  test("PANE-01: no hits for 'topics-open-panels' outside client/src/state/pane/", () => {
    expect(grepOutsidePaneState("topics-open-panels")).toEqual([]);
  });

  test("PANE-01: no hits for 'topics-focused-panel' outside client/src/state/pane/", () => {
    expect(grepOutsidePaneState("topics-focused-panel")).toEqual([]);
  });

  test("PANE-01: no hits for 'topics-panel-order' outside client/src/state/pane/", () => {
    expect(grepOutsidePaneState("topics-panel-order")).toEqual([]);
  });

  test("PANE-01: no hits for 'topics-closed-tabs' outside client/src/state/pane/", () => {
    expect(grepOutsidePaneState("topics-closed-tabs")).toEqual([]);
  });

  test("PANE-01: no hits for 'topics-grid-layout' outside client/src/state/pane/", () => {
    expect(grepOutsidePaneState("topics-grid-layout")).toEqual([]);
  });

  test("PANE-01: no hits for 'topics-project-layout' outside client/src/state/pane/", () => {
    expect(grepOutsidePaneState("topics-project-layout")).toEqual([]);
  });

  test("PANE-01: no hits for 'project-layout-' outside client/src/state/pane/", () => {
    expect(grepOutsidePaneState("project-layout-")).toEqual([]);
  });

  test("PANE-01: no hits for 'topics-project-panes-' outside client/src/state/pane/", () => {
    // Legacy per-project localStorage key — the only writer is the
    // projectLayoutSync adapter; every other consumer must read the pane-store
    // reducer's `projects[projectPath]` instead.
    expect(grepOutsidePaneState("topics-project-panes-")).toEqual([]);
  });

  test("PANE-01: no hits for 'topics-panel-grid-layout' outside client/src/state/pane/ (allowed in Layout/)", () => {
    // `topics-panel-grid-layout` is the panel-grid layout (sidebar/main/details
    // split ratios) — orthogonal to pane state but lives under components/Layout.
    // This gate documents the carve-out: hits outside state/pane/ AND outside
    // components/Layout/ are regressions.
    const hits = grepOutsidePaneState("topics-panel-grid-layout").filter(
      (l) => !l.startsWith("client/src/components/Layout/"),
    );
    expect(hits).toEqual([]);
  });

  test("PANE-01: no hits for 'closedTabRecord' outside client/src/state/pane/", () => {
    expect(grepOutsidePaneState("closedTabRecord")).toEqual([]);
  });

  test("PANE-01: no hits for 'projectLayoutSync' outside client/src/state/pane/", () => {
    expect(grepOutsidePaneState("projectLayoutSync")).toEqual([]);
  });

  test("PANE-01: no hits for '/api/ui-state' outside client/src/state/pane/", () => {
    expect(grepOutsidePaneState("/api/ui-state")).toEqual([]);
  });
});
