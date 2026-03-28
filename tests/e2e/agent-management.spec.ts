import { expect } from "@playwright/test";
import {
  test,
  MOCK_PROFILES,
  MOCK_HISTORY_SESSIONS,
  MOCK_LIVE_SESSIONS,
  MOCK_AGENT_SESSIONS,
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
});
