import { expect } from "@playwright/test";
import {
  test,
  MOCK_PROFILES,
  MOCK_HISTORY_SESSIONS,
  MOCK_LIVE_SESSIONS,
  MOCK_AGENT_SESSIONS,
  MOCK_CHAT_MESSAGES,
  MOCK_TIMELINE_EVENTS,
} from "./fixtures/agent.fixture";

test.describe("Agent Management", () => {
  test.beforeEach(async ({ agentPage, page }) => {
    await agentPage.mockAllAgentEndpoints();
    await page.goto("/");
  });

  test("AGENT-01: sessions list with status indicators", async ({
    agentPage,
    page,
  }) => {
    await agentPage.openAgentsPane();

    // Verify "History" section header is visible (uppercase span)
    await expect(page.getByText("History", { exact: true })).toBeVisible();

    // Verify "Live" section header is visible (live sessions from mock)
    await expect(page.getByText("Live", { exact: true })).toBeVisible();

    // Verify session rows are visible - check for agent names from both Live and History mocks
    // Use .first() because agent name may appear in both sections
    await expect(page.getByText(MOCK_HISTORY_SESSIONS[0].agentName!).first()).toBeVisible();
    await expect(page.getByText(MOCK_HISTORY_SESSIONS[1].agentName!).first()).toBeVisible();

    // Verify status badge text is visible (e.g., "Active" or "Completed")
    await expect(page.getByText("Active").first()).toBeVisible();
    await expect(page.getByText("Completed").first()).toBeVisible();

    // Verify session metadata renders (tokens)
    // MOCK_HISTORY_SESSIONS[1] has 32000 tokens -> "32K tok"
    await expect(page.getByText("32K tok")).toBeVisible();
  });

  test("AGENT-02: heartbeat timeline and status", async ({
    agentPage,
    page,
  }) => {
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Click "Sessions" button on first profile card
    const firstCard = agentPage.profileCards.first();
    await firstCard.locator('button:text("Sessions")').click();

    // Wait for HeartbeatTimeline modal content
    await expect(page.getByText("Session History")).toBeVisible();

    // Verify session count display
    await expect(
      page.getByText(`${MOCK_AGENT_SESSIONS.length} sessions`)
    ).toBeVisible();

    // Verify session entries render with status text
    await expect(page.getByText("active").first()).toBeVisible();
    await expect(page.getByText("completed").first()).toBeVisible();

    // Close modal via the X button on the modal header
    const modal = page.locator(".fixed.inset-0.z-50");
    await modal.locator("button:has-text('\u00D7')").click();
    await expect(modal).not.toBeVisible();
  });

  test("AGENT-03: profile CRUD (create and edit)", async ({
    agentPage,
    page,
  }) => {
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Verify initial profiles visible from mock data
    for (const profile of MOCK_PROFILES) {
      await expect(page.getByText(profile.name)).toBeVisible();
    }

    // --- Edit flow ---
    // Click "Edit" button on first profile card
    const firstCard = agentPage.profileCards.first();
    await firstCard.locator('button:text("Edit")').click();

    // Verify edit modal heading
    await expect(page.getByText("Edit Agent Profile")).toBeVisible();

    // Change name
    const nameInput = agentPage.editorNameInput;
    await nameInput.clear();
    await nameInput.fill("Updated Agent Name");

    // Save
    await agentPage.editorSaveButton.click();

    // Verify updated name appears in roster after modal closes
    await expect(page.getByText("Updated Agent Name")).toBeVisible();

    // --- Create flow ---
    await agentPage.createAgentButton.click();

    // Verify create modal heading
    await expect(page.getByText("Create Agent Profile")).toBeVisible();

    // Fill name
    await agentPage.editorNameInput.fill("New Test Agent");

    // Click Create button
    await agentPage.editorCreateButton.click();

    // Verify new agent appears in roster
    await expect(page.getByText("New Test Agent")).toBeVisible();
  });

  test("AGENT-04: roster search and status filter", async ({
    agentPage,
    page,
  }) => {
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Verify all 3 mock profiles visible
    await expect(agentPage.profileCards).toHaveCount(3);

    // --- Search filter ---
    const searchInput = agentPage.searchInput;
    // Type a specific agent name to narrow results
    await searchInput.fill("Alpha");
    // Only the matching card should be visible
    await expect(agentPage.profileCards).toHaveCount(1);
    await expect(page.getByText("Alpha Coder")).toBeVisible();

    // Clear search to restore all cards
    await searchInput.clear();
    await expect(agentPage.profileCards).toHaveCount(3);

    // --- Status filter ---
    // Click "Available" filter button
    await agentPage.statusFilterButton("available").click();
    // Only available-status profiles (Alpha Coder) should show
    await expect(agentPage.profileCards).toHaveCount(1);
    await expect(page.getByText("Alpha Coder")).toBeVisible();

    // Click "All" to reset
    await agentPage.statusFilterButton("all").click();
    await expect(agentPage.profileCards).toHaveCount(3);

    // Click "Offline" filter
    await agentPage.statusFilterButton("offline").click();
    // Only offline profile (Gamma Researcher) should show
    await expect(agentPage.profileCards).toHaveCount(1);
    await expect(page.getByText("Gamma Researcher")).toBeVisible();
  });

  test("AGENT-05: session transcript with timestamps and tool calls", async ({
    agentPage,
    page,
  }) => {
    // Override default empty chat history mocks with real messages
    await agentPage.mockChatApiHistory(MOCK_CHAT_MESSAGES);

    await agentPage.openAgentsPane();

    // Click first session row in the History section to open SessionDetail
    await page.getByText(MOCK_HISTORY_SESSIONS[0].agentName!).first().click();

    // Verify SessionDetail header shows agent name
    await expect(
      page
        .locator("div")
        .filter({ hasText: MOCK_HISTORY_SESSIONS[0].agentName! })
        .first()
    ).toBeVisible();

    // Verify message bubbles render with content from mock chat messages
    await expect(
      page.getByText("Please implement the authentication module")
    ).toBeVisible();
    await expect(
      page.getByText("I will implement JWT authentication", { exact: false })
    ).toBeVisible();

    // Verify timestamps are visible on messages (HH:MM format)
    // MOCK_CHAT_MESSAGES[0] timestamp "2026-03-27T09:01:00Z" -> localized time
    const timeElements = page.locator(
      ".text-right:has-text(':'), .text-\\[9px\\]:has-text(':')"
    );
    await expect(timeElements.first()).toBeVisible();

    // Verify tool calls indicator on assistant message (2 tool calls)
    await expect(page.getByText("2 tool calls")).toBeVisible();

    // Verify heartbeat entry: status dot + timestamp
    // MOCK_TIMELINE_EVENTS has heartbeat with tokensUsed: 1200
    await expect(page.getByText("+1K tok").first()).toBeVisible();

    // Verify action entry: action label text from MOCK_TIMELINE_EVENTS
    await expect(page.getByText("Task completed")).toBeVisible();
    await expect(page.getByText("Auth module finished")).toBeVisible();
  });

  test("AGENT-06: session viewer pane navigation", async ({
    agentPage,
    page,
  }) => {
    await agentPage.openAgentsPane();

    // Verify session list is visible (History section header)
    await expect(page.getByText("History", { exact: true })).toBeVisible();

    // Click a session row to open SessionDetail
    await page.getByText(MOCK_HISTORY_SESSIONS[0].agentName!).first().click();

    // Verify SessionDetail header: agent name text visible
    const headerName = page.locator(".text-\\[12px\\].font-medium").filter({
      hasText: MOCK_HISTORY_SESSIONS[0].agentName!,
    });
    await expect(headerName).toBeVisible();

    // Verify status badge visible (e.g., "Active" for first mock session)
    const statusBadge = page
      .locator(".text-\\[9px\\].font-medium")
      .filter({ hasText: "Active" });
    await expect(statusBadge.first()).toBeVisible();

    // Verify "Pane" button visible in header (open in pane action)
    await expect(page.getByText("Pane")).toBeVisible();

    // Click the back button (ArrowLeft icon button) to return to session list
    const backButton = page.locator("button").filter({
      has: page.locator("svg.lucide-arrow-left"),
    });
    await backButton.click();

    // Verify session list is visible again (History header reappears)
    await expect(page.getByText("History", { exact: true })).toBeVisible();

    // Verify the session rows are visible again
    await expect(
      page.getByText(MOCK_HISTORY_SESSIONS[0].agentName!).first()
    ).toBeVisible();
  });

  test("AGENT-07: agent assignment to topic", async ({ agentPage, page }) => {
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Click "Assign" button on first profile card
    const firstCard = agentPage.profileCards.first();
    await firstCard.locator('button:text("Assign")').click();

    // Topic ID input modal appears -- verify header text
    await expect(
      page.getByText(`Assign ${MOCK_PROFILES[0].name}`)
    ).toBeVisible();

    // Fill the topic input with a test topic ID
    const topicInput = page.locator('input[name="topicInput"]');
    await topicInput.fill("test-topic-123");

    // Click "Continue" button
    await page.locator('button:text("Continue")').click();

    // AgentAssignPanel modal appears -- verify "Assign Agents" header
    await expect(page.getByText("Assign Agents")).toBeVisible();

    // Verify topic name is shown below header
    await expect(page.getByText("test-topic-123")).toBeVisible();

    // Verify "Available" section header shows agent count
    await expect(page.getByText(/Available \(\d+\)/)).toBeVisible();

    // Click "Worker" button next to the first available agent
    const workerBtn = page.locator('button:text("Worker")').first();
    await workerBtn.click();

    // After assign, the component re-fetches profiles.
    // Verify the assigned agent now appears in the "Assigned" section
    await expect(page.getByText(/Assigned \(\d+\)/)).toBeVisible();

    // Verify a role badge appears for the assigned agent
    await expect(page.getByText("worker").first()).toBeVisible();

    // Verify the "Remove" button (unassign) is visible for assigned agent
    await expect(page.locator('button[title="Remove"]').first()).toBeVisible();
  });
});
