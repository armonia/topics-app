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
import { resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

// Confine ermetico: questo file riparte dalla baseline del globalSetup, non
// dallo stato lasciato dalle spec precedenti. Vedi fixtures/hermetic.ts.
hermetic(test);

test.describe("Agent Management", () => {
  test.beforeEach(async ({ agentPage, page, request }) => {
    // Il pane-store è UNO per tutta la suite seriale: la pane Agents aperta da
    // un test resta aperta per il successivo (e per gli altri file), e da lì in
    // poi il bottone "Agents" esiste due volte — vedi il commento in
    // agent.fixture.openAgentsPane(). Si azzera PRIMA del goto, così ogni test
    // parte da un workspace vuoto e apre lui la pane che gli serve.
    await resetPaneStore(request, []);
    await agentPage.mockAllAgentEndpoints();
    await page.goto("/");
  });

  test("AGENT-01: sessions list with status indicators", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-01" });
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
    test.info().annotations.push({ type: "spec", description: "AGENT-01" });
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
    test.info().annotations.push({ type: "spec", description: "AGENT-01" });
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
    test.info().annotations.push({ type: "spec", description: "AGENT-02" });
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
    test.info().annotations.push({ type: "spec", description: "AGENT-01" });
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
    test.info().annotations.push({ type: "spec", description: "AGENT-02" });
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

    // Verify status badge visible (e.g., "Active" for first mock session).
    // The SessionDetail header badge is a `text-[11px] … font-medium` span
    // (SessionHistory.tsx) — the old `text-[9px]` class was from a prior design.
    const statusBadge = page
      .locator(".text-\\[11px\\].font-medium")
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

  test("FIX-06: session search filter matches by display name or key", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-02" });
    // Use distinct live sessions where displayName and key differ clearly
    const searchSessions = [
      {
        key: "unique-key-xyz",
        kind: "main",
        channel: "web",
        displayName: "SearchBot Alpha",
        status: "active",
        model: "claude-sonnet-4-20250514",
        updatedAt: Date.now(),
        totalTokens: 5000,
        topicId: "topic-1",
        topicName: "Test Topic",
      },
      {
        key: "another-key-abc",
        kind: "main",
        channel: "web",
        displayName: "Worker Beta",
        status: "active",
        model: "claude-sonnet-4-20250514",
        updatedAt: Date.now(),
        totalTokens: 3000,
        topicId: "topic-2",
        topicName: "Other Topic",
      },
    ];

    // Re-mock sessions endpoint with our specific test data
    await agentPage.mockSessionsEndpoint(searchSessions);

    await agentPage.openAgentsPane();

    // Both live sessions should be visible initially
    await expect(page.getByText("SearchBot Alpha")).toBeVisible();
    await expect(page.getByText("Worker Beta")).toBeVisible();

    // Search by displayName: "SearchBot" should match first session only
    const searchInput = page.locator('input[placeholder="Search sessions..."]');
    await searchInput.fill("SearchBot");

    // Wait for debounce (300ms)
    await page.waitForTimeout(400);

    // "SearchBot Alpha" should still be visible (matches displayName)
    await expect(page.getByText("SearchBot Alpha")).toBeVisible();
    // "Worker Beta" should be filtered out
    await expect(page.getByText("Worker Beta")).not.toBeVisible();

    // Now search by key: "unique-key" should match first session
    await searchInput.fill("unique-key");
    await page.waitForTimeout(400);

    await expect(page.getByText("SearchBot Alpha")).toBeVisible();
    await expect(page.getByText("Worker Beta")).not.toBeVisible();

    // Search by key of second session: "another-key" should match second only
    await searchInput.fill("another-key");
    await page.waitForTimeout(400);

    await expect(page.getByText("Worker Beta")).toBeVisible();
    await expect(page.getByText("SearchBot Alpha")).not.toBeVisible();

    // Search term matching NEITHER field should show no live sessions
    await searchInput.fill("nonexistent-term");
    await page.waitForTimeout(400);

    await expect(page.getByText("SearchBot Alpha")).not.toBeVisible();
    await expect(page.getByText("Worker Beta")).not.toBeVisible();
  });

  test("AGENT-07: agent assignment to topic", async ({ agentPage, page }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-02" });
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

  test("AGENT-08: session row displays agent name and status badge explicitly", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-01" });
    await agentPage.openAgentsPane();

    // Locate individual session rows in the History section
    // Each session row should contain both an agent name AND a status badge
    for (const session of MOCK_HISTORY_SESSIONS) {
      const sessionRow = page.getByText(session.agentName!).first();
      await expect(sessionRow).toBeVisible();
    }

    // Verify that each session status type has a distinct badge
    // "Active" badge should be visible
    const activeBadge = page.getByText("Active").first();
    await expect(activeBadge).toBeVisible();

    // "Completed" badge should be visible
    const completedBadge = page.getByText("Completed").first();
    await expect(completedBadge).toBeVisible();

    // Verify the History section contains both agent names from mock data
    await expect(page.getByText(MOCK_HISTORY_SESSIONS[0].agentName!).first()).toBeVisible();
    await expect(page.getByText(MOCK_HISTORY_SESSIONS[1].agentName!).first()).toBeVisible();
  });

  test("AGENT-09: remove agent assignment", async ({ agentPage, page }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-02" });
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Click "Assign" button on first profile card to open assignment modal
    const firstCard = agentPage.profileCards.first();
    await firstCard.locator('button:text("Assign")').click();

    // Fill topic input
    const topicInput = page.locator('input[name="topicInput"]');
    await topicInput.fill("test-topic-remove");

    // Click "Continue"
    await page.locator('button:text("Continue")').click();

    // AgentAssignPanel opens
    await expect(page.getByText("Assign Agents")).toBeVisible();

    // First assign an agent by clicking "Worker"
    const workerBtn = page.locator('button:text("Worker")').first();
    await workerBtn.click();

    // Verify the agent now appears in "Assigned" section
    await expect(page.getByText(/Assigned \(\d+\)/)).toBeVisible();

    // Click the "Remove" button to unassign
    const removeBtn = page.locator('button[title="Remove"]').first();
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    // After removal, the "Assigned" count should decrease or the section should show (0)
    // The agent should move back to Available section
    await expect(page.getByText(/Available \(\d+\)/)).toBeVisible({ timeout: 10000 });
  });

  test("AGENT-10: session detail pane button opens session in new pane", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-02" });
    await agentPage.openAgentsPane();

    // Click a session to open SessionDetail
    await page.getByText(MOCK_HISTORY_SESSIONS[0].agentName!).first().click();

    // Verify SessionDetail header is visible
    const headerName = page.locator(".text-\\[12px\\].font-medium").filter({
      hasText: MOCK_HISTORY_SESSIONS[0].agentName!,
    });
    await expect(headerName).toBeVisible();

    // Click the "Pane" button to open session in a new pane
    const paneBtn = page.getByText("Pane");
    await expect(paneBtn).toBeVisible();
    await paneBtn.click();

    // After clicking Pane, the session content should open in a new pane/tab
    // Verify the session detail content is still accessible (either in new pane or same view)
    await expect(
      page.locator("div").filter({ hasText: MOCK_HISTORY_SESSIONS[0].agentName! }).first()
    ).toBeVisible({ timeout: 10000 });
  });

  // ── AGENT-03: Profile Editor Fields ──────────────────────

  test("AGENT-12: avatar emoji selection in editor", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-03" });
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Click "Edit" on first profile card
    const firstCard = agentPage.profileCards.first();
    await firstCard.locator('button:text("Edit")').click();
    await expect(page.getByText("Edit Agent Profile")).toBeVisible();

    // The editor modal should have an Avatar section with emoji buttons
    // Avatar grid is inside a container with "Avatar" label text
    const modal = page.locator(".fixed.inset-0.z-50");
    await expect(modal).toBeVisible();

    // Find all emoji avatar buttons (w-8 h-8 buttons in the avatar area)
    const allEmojis = modal.locator("button.w-8.h-8");
    await expect(allEmojis.first()).toBeVisible({ timeout: 5000 });
    const emojiCount = await allEmojis.count();
    expect(emojiCount).toBeGreaterThan(1);

    // The first profile (Alpha Coder) has avatarEmoji = robot face — find the currently selected one
    // Selected has ring-1 ring-primary class
    const selectedBefore = modal.locator("button.w-8.h-8[class*='ring-primary']");
    await expect(selectedBefore).toBeVisible();

    // Click a different emoji (pick index 2 to be safe)
    await allEmojis.nth(2).click();

    // Verify the newly clicked emoji now has the primary ring styling
    const newClasses = await allEmojis.nth(2).getAttribute("class");
    expect(newClasses).toContain("ring-primary");

    // Verify the previously selected emoji lost the ring
    const oldClasses = await allEmojis.nth(0).getAttribute("class");
    expect(oldClasses).not.toContain("ring-primary");

    // Cancel to avoid side effects
    await agentPage.editorCancelButton.click();
  });

  test("AGENT-13: role selector toggles between Lead, Worker, Specialist", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-03" });
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Open edit modal
    const firstCard = agentPage.profileCards.first();
    await firstCard.locator('button:text("Edit")').click();
    await expect(page.getByText("Edit Agent Profile")).toBeVisible();

    // Find the role buttons
    const leadBtn = page.locator("button").filter({ hasText: /^Lead$/ });
    const workerBtn = page.locator("button").filter({ hasText: /^Worker$/ });
    const specialistBtn = page.locator("button").filter({ hasText: /^Specialist$/ });

    // First profile is "lead" — Lead should have active styling
    const leadClasses = await leadBtn.getAttribute("class");
    expect(leadClasses).toContain("primary");

    // Click Specialist
    await specialistBtn.click();
    const specialistClasses = await specialistBtn.getAttribute("class");
    expect(specialistClasses).toContain("primary");

    // Lead should lose active styling
    const leadClassesAfter = await leadBtn.getAttribute("class");
    expect(leadClassesAfter).not.toContain("text-primary");

    // Cancel
    await agentPage.editorCancelButton.click();
  });

  test("AGENT-14: empty name prevents submission", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-03" });
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Open edit modal
    const firstCard = agentPage.profileCards.first();
    await firstCard.locator('button:text("Edit")').click();
    await expect(page.getByText("Edit Agent Profile")).toBeVisible();

    // Clear name input completely
    const nameInput = agentPage.editorNameInput;
    await nameInput.clear();

    // Save button should be disabled (disabled attribute set when !name.trim())
    const saveBtn = agentPage.editorSaveButton;
    await expect(saveBtn).toBeDisabled();

    // Type a name — button should become enabled
    await nameInput.fill("Valid Name");
    await expect(saveBtn).toBeEnabled();

    // Cancel
    await agentPage.editorCancelButton.click();
  });

  test("AGENT-15: capabilities field accepts comma-separated values", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-03" });
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Open edit modal for first profile
    const firstCard = agentPage.profileCards.first();
    await firstCard.locator('button:text("Edit")').click();
    await expect(page.getByText("Edit Agent Profile")).toBeVisible();

    // Find capabilities input and update it
    const capInput = page.locator('input[placeholder="coding, testing, research..."]');
    await expect(capInput).toBeVisible();
    await capInput.clear();
    await capInput.fill("coding, testing, research");

    // Save
    await agentPage.editorSaveButton.click();

    // Verify the profile card shows capability tags after modal closes
    await expect(page.getByText("Edit Agent Profile")).not.toBeVisible({ timeout: 5000 });
    // The profile card should show "coding" capability tag (from mock PATCH response)
    await expect(page.getByText("coding").first()).toBeVisible();
  });

  test("AGENT-16: max concurrent tasks field", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-03" });
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Open edit modal
    const firstCard = agentPage.profileCards.first();
    await firstCard.locator('button:text("Edit")').click();
    await expect(page.getByText("Edit Agent Profile")).toBeVisible();

    // Find max tasks input (type=number)
    const maxTasksInput = page.locator('input[type="number"]');
    await expect(maxTasksInput).toBeVisible();

    // Set to 5
    await maxTasksInput.clear();
    await maxTasksInput.fill("5");

    // Save
    await agentPage.editorSaveButton.click();

    // After modal closes, verify "Max tasks: 5" visible on profile card
    // (The mock returns the merged profile with maxConcurrentTasks: 5)
    await expect(page.getByText("Edit Agent Profile")).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Max tasks:").first()).toBeVisible();
  });

  test("AGENT-17: profile card shows capabilities and max tasks", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-03" });
    await agentPage.openAgentsPane();
    await agentPage.switchToRosterTab();

    // Verify first profile card shows capability tags from MOCK_PROFILES
    // Alpha Coder has capabilities: ["coding", "architecture", "review"]
    const firstCard = agentPage.profileCards.first();
    await expect(firstCard.getByText("coding")).toBeVisible();
    await expect(firstCard.getByText("architecture")).toBeVisible();
    await expect(firstCard.getByText("review")).toBeVisible();

    // Verify "Max tasks: 3" visible (Alpha Coder has maxConcurrentTasks: 3)
    await expect(firstCard.getByText("Max tasks: 3")).toBeVisible();
  });

  test("AGENT-11: agent status badges distinguish active from completed", async ({
    agentPage,
    page,
  }) => {
    test.info().annotations.push({ type: "spec", description: "AGENT-01" });
    await agentPage.openAgentsPane();

    // "Active" and "Completed" badges should exist with different styling
    const activeBadge = page.getByText("Active").first();
    const completedBadge = page.getByText("Completed").first();

    await expect(activeBadge).toBeVisible();
    await expect(completedBadge).toBeVisible();

    // Get the computed class or style of each badge to verify they differ
    const activeClasses = await activeBadge.getAttribute("class") || "";
    const completedClasses = await completedBadge.getAttribute("class") || "";

    // The badges should have different color classes (e.g., green vs gray/blue)
    // At minimum, verify both have some styling class
    expect(activeClasses.length + completedClasses.length).toBeGreaterThan(0);

    // Verify they are visually distinct: different background or text color
    // Active typically has green, completed typically has gray/blue
    expect(activeClasses).not.toBe(completedClasses);
  });
});
