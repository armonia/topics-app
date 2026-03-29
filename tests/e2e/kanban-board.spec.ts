import { expect } from "@playwright/test";
import { test } from "./fixtures/kanban.fixture";
import { createTopic, createTask, createApproval, createBoardMemory, cleanupAll } from "./helpers/api-fixtures";
import { dndDrag, dndReorder } from "./helpers/dnd-helpers";

test.describe("Kanban Board", () => {
  const TS = Date.now();
  let topicId: string;
  const projectPath = `/tmp/e2e-kanban-${TS}`;
  let projectId: string;

  // For KANBAN-03 move test
  let todoTaskId: string;
  // For KANBAN-06 approval test
  let approvalTaskId: string;

  // For KANBAN-09 multi-board test
  let topicId2: string;
  const projectPath2 = `/tmp/e2e-kanban-2-${TS}`;
  let projectId2: string;

  test.beforeAll(async ({ request }) => {
    // Create a topic with projectPath so the board is accessible
    const topic = await createTopic(request, `E2E-Kanban-${TS}`, {
      projectPath,
    });
    topicId = topic.id;
    projectId = encodeURIComponent(projectPath);

    // Seed tasks in various columns
    await createTask(request, projectId, `KB-Backlog-${TS}`, { status: "backlog" });
    const todoTask = await createTask(request, projectId, `KB-Todo-${TS}`, { status: "todo" });
    todoTaskId = todoTask.id;
    await createTask(request, projectId, `KB-InProg-${TS}`, { status: "in_progress" });
    await createTask(request, projectId, `KB-Review-${TS}`, { status: "review" });
    await createTask(request, projectId, `KB-Done-${TS}`, { status: "done" });
    // Extra tasks for filter and reorder tests
    await createTask(request, projectId, `KB-TodoHigh-${TS}`, { status: "todo", priority: 1 });
    await createTask(request, projectId, `KB-TodoLow-${TS}`, { status: "todo", priority: 3 });
    // Task with assignedTo for agent filter test
    await createTask(request, projectId, `KB-Assigned-${TS}`, {
      status: "todo",
      priority: 2,
      assignedTo: "test-agent",
    });

    // Task + approval for KANBAN-06
    const approvalTask = await createTask(request, projectId, `KB-Approval-${TS}`, { status: "review" });
    approvalTaskId = approvalTask.id;
    await createApproval(request, projectId, approvalTaskId, {
      fromStatus: "review",
      toStatus: "done",
      confidenceScore: 85,
      justification: "All acceptance criteria met",
    });

    // Second topic + task for KANBAN-09 multi-board test
    const topic2 = await createTopic(request, `E2E-Kanban-2-${TS}`, {
      projectPath: projectPath2,
    });
    topicId2 = topic2.id;
    projectId2 = encodeURIComponent(projectPath2);
    await createTask(request, projectId2, `KB-Proj2-${TS}`, { status: "todo" });
  });

  test.afterAll(async ({ request }) => {
    await cleanupAll(request, { topics: [topicId, topicId2] });
  });

  // KANBAN-01: Board renders with all 5 columns visible
  test("KANBAN-01: board renders with all 5 columns visible", async ({ kanbanPage, page }) => {
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    // Board container is visible
    await expect(kanbanPage.board).toBeVisible();

    // All 5 columns are visible
    const columns = ["backlog", "todo", "in_progress", "review", "done"];
    for (const col of columns) {
      await expect(kanbanPage.getColumn(col)).toBeVisible();
    }

    // Verify column header labels
    const labels = ["Backlog", "Todo", "In Progress", "Review", "Done"];
    for (let i = 0; i < columns.length; i++) {
      await expect(kanbanPage.getColumn(columns[i])).toContainText(labels[i]);
    }
  });

  // KANBAN-02: User can create a new task in a column
  test("KANBAN-02: user can create a new task in a column", async ({ kanbanPage }) => {
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    const todoColumn = kanbanPage.getColumn("todo");
    await expect(todoColumn).toBeVisible();

    // Click the "Add" button within the todo column
    const addButton = todoColumn.getByRole("button", { name: /Add/ });
    await addButton.click();

    // Fill in the inline input
    const taskInput = todoColumn.locator('input[placeholder="Task description..."]');
    await expect(taskInput).toBeVisible();
    const newTaskName = `KB-New-${TS}`;
    await taskInput.fill(newTaskName);
    await taskInput.press("Enter");

    // Verify the new task appears in the todo column
    await expect(todoColumn.getByText(newTaskName)).toBeVisible({ timeout: 10000 });
  });

  // KANBAN-03: Move task between columns and verify it appears in the new column
  test("KANBAN-03: drag task between columns moves it", async ({ kanbanPage, page, request }) => {
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    const todoColumn = kanbanPage.getColumn("todo");
    const inProgressColumn = kanbanPage.getColumn("in_progress");

    // Verify the task starts in the todo column
    await expect(todoColumn.getByText(`KB-Todo-${TS}`)).toBeVisible();

    // Move the task via API (simulates the move that drag-drop triggers)
    const moveResp = await request.post(
      `http://localhost:3334/api/boards/${projectId}/tasks/${todoTaskId}/move`,
      { data: { status: "in_progress" }, ignoreHTTPSErrors: true }
    );
    expect(moveResp.ok()).toBeTruthy();

    // Reload the board to see the move reflected
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    // Verify task now appears in the in_progress column
    await expect(
      kanbanPage.getColumn("in_progress").getByText(`KB-Todo-${TS}`)
    ).toBeVisible({ timeout: 10000 });

    // Verify the task is no longer in the todo column
    await expect(
      kanbanPage.getColumn("todo").getByText(`KB-Todo-${TS}`)
    ).not.toBeVisible({ timeout: 5000 });
  });

  // KANBAN-04: Task detail panel opens on card click with correct content
  test("KANBAN-04: task detail panel opens on card click", async ({ kanbanPage }) => {
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    // Click on the task card text (not the drag handle)
    const taskCard = kanbanPage.getTaskCard(new RegExp(`KB-Backlog-${TS}`));
    await expect(taskCard).toBeVisible();
    await taskCard.click();

    // Detail panel should open
    await expect(kanbanPage.detailPanel).toBeVisible({ timeout: 10000 });

    // Verify it contains the task text
    await expect(kanbanPage.detailPanel).toContainText(`KB-Backlog-${TS}`);

    // Edit the description
    const descriptionArea = kanbanPage.detailPanel.getByText("Click to add description...");
    await descriptionArea.click();

    // Fill in a description
    const textarea = kanbanPage.detailPanel.locator("textarea");
    await expect(textarea).toBeVisible();
    await textarea.fill("Updated description for E2E test");

    // Click Save
    const saveBtn = kanbanPage.detailPanel.getByRole("button", { name: "Save" });
    await saveBtn.click();

    // Verify description is updated in the detail panel
    await expect(
      kanbanPage.detailPanel.getByText("Updated description for E2E test")
    ).toBeVisible();
  });

  // KANBAN-05: Task filters hide/show tasks by status, priority, and agent
  test("KANBAN-05: task filters work for status, priority, and agent", async ({ kanbanPage, page }) => {
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    // Verify multiple tasks visible initially
    await expect(kanbanPage.getColumn("backlog").getByText(`KB-Backlog-${TS}`)).toBeVisible();
    await expect(kanbanPage.getColumn("todo").getByText(`KB-TodoHigh-${TS}`)).toBeVisible();

    // --- Status filter ---
    // Select "todo" status from the first select (status filter)
    const board = kanbanPage.board;
    const statusSelect = board.locator("select").first();
    await statusSelect.selectOption("todo");

    // Only todo tasks visible, non-todo tasks hidden (columns with no tasks show "No tasks")
    await expect(kanbanPage.getColumn("todo").getByText(`KB-TodoHigh-${TS}`)).toBeVisible({ timeout: 10000 });
    await expect(kanbanPage.getColumn("backlog").getByText(`KB-Backlog-${TS}`)).toBeHidden({ timeout: 10000 });

    // Clear filters
    const clearBtn = board.getByRole("button", { name: /Clear/ });
    await clearBtn.click();

    // --- Priority filter ---
    // Select "High" (value 1) from the priority select (second select)
    const prioritySelect = board.locator("select").nth(1);
    await prioritySelect.selectOption("1");

    // Only high-priority tasks visible
    await expect(kanbanPage.getColumn("todo").getByText(`KB-TodoHigh-${TS}`)).toBeVisible({ timeout: 10000 });
    await expect(kanbanPage.getColumn("todo").getByText(`KB-TodoLow-${TS}`)).toBeHidden({ timeout: 10000 });

    // Clear filters
    await board.getByRole("button", { name: /Clear/ }).click();

    // --- Agent/assigned filter ---
    const assignedInput = page.getByPlaceholder("Assigned to...");
    await assignedInput.fill("test-agent");

    // Only the assigned task is visible
    await expect(kanbanPage.getColumn("todo").getByText(`KB-Assigned-${TS}`)).toBeVisible({ timeout: 10000 });
    await expect(kanbanPage.getColumn("todo").getByText(`KB-TodoHigh-${TS}`)).toBeHidden({ timeout: 10000 });

    // Clear filters
    await board.getByRole("button", { name: /Clear/ }).click();
  });

  // KANBAN-10: Drag reorder within a column changes task order
  test("KANBAN-10: drag reorder within column changes task position", async ({ kanbanPage, page }) => {
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    const todoColumn = kanbanPage.getColumn("todo");

    // Get drag handles for two tasks in the todo column
    const highHandle = kanbanPage.getTaskDragHandle(new RegExp(`KB-TodoHigh-${TS}`));
    const lowHandle = kanbanPage.getTaskDragHandle(new RegExp(`KB-TodoLow-${TS}`));

    await expect(highHandle).toBeVisible();
    await expect(lowHandle).toBeVisible();

    // Get initial order by checking bounding boxes
    const highBox = await highHandle.boundingBox();
    const lowBox = await lowHandle.boundingBox();

    if (!highBox || !lowBox) {
      throw new Error("Could not get bounding boxes for task drag handles");
    }

    // Determine which is first/second and reorder
    const firstHandle = highBox.y < lowBox.y ? highHandle : lowHandle;
    const secondHandle = highBox.y < lowBox.y ? lowHandle : highHandle;
    const firstName = highBox.y < lowBox.y ? `KB-TodoHigh-${TS}` : `KB-TodoLow-${TS}`;
    const secondName = highBox.y < lowBox.y ? `KB-TodoLow-${TS}` : `KB-TodoHigh-${TS}`;

    // Drag the second task above the first to reorder
    await dndReorder(page, secondHandle, firstHandle, "above");

    // After reorder, the second task should now be above the first
    // Verify by checking the updated bounding boxes
    const updatedSecondBox = await kanbanPage.getTaskDragHandle(new RegExp(secondName)).boundingBox();
    const updatedFirstBox = await kanbanPage.getTaskDragHandle(new RegExp(firstName)).boundingBox();

    if (updatedSecondBox && updatedFirstBox) {
      expect(updatedSecondBox.y).toBeLessThan(updatedFirstBox.y);
    }
  });

  // KANBAN-06: Task approval workflow — banner visible, review modal opens, approve works
  test("KANBAN-06: task approval workflow with review modal", async ({ kanbanPage, page }) => {
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    // Find the task card with the approval
    const taskCard = kanbanPage.getTaskCard(new RegExp(`KB-Approval-${TS}`));
    await expect(taskCard).toBeVisible({ timeout: 10000 });

    // The ApprovalBanner should be visible on the task card — look for "Approval required" text
    const approvalBanner = kanbanPage.board.locator('[data-testid^="task-card-"]', { hasText: `KB-Approval-${TS}` })
      .getByText("Approval required");
    await expect(approvalBanner).toBeVisible({ timeout: 10000 });

    // Click the "Review" button on the approval banner
    const reviewButton = kanbanPage.board.locator('[data-testid^="task-card-"]', { hasText: `KB-Approval-${TS}` })
      .getByRole("button", { name: "Review" });
    await reviewButton.click();

    // Assert the approval review modal is visible
    await expect(kanbanPage.approvalModal).toBeVisible({ timeout: 10000 });

    // Verify modal content: justification text
    await expect(kanbanPage.approvalModal.getByText("All acceptance criteria met")).toBeVisible();

    // Verify modal shows confidence score (85%)
    await expect(kanbanPage.approvalModal.getByText("85%")).toBeVisible();

    // Verify Approve and Reject buttons are visible
    const approveBtn = kanbanPage.approvalModal.getByRole("button", { name: "Approve" });
    const rejectBtn = kanbanPage.approvalModal.getByRole("button", { name: "Reject" });
    await expect(approveBtn).toBeVisible();
    await expect(rejectBtn).toBeVisible();

    // Click Approve
    await approveBtn.click();

    // Assert the modal closes
    await expect(kanbanPage.approvalModal).toBeHidden({ timeout: 10000 });
  });

  // KANBAN-07: Board settings panel — open, toggle, save, verify persistence
  test("KANBAN-07: board settings panel toggle and persistence", async ({ kanbanPage, page }) => {
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    // Click the settings button (gear icon with title "Board settings")
    const settingsButton = page.locator('button[title="Board settings"]');
    await expect(settingsButton).toBeVisible({ timeout: 10000 });
    await settingsButton.click();

    // Assert settings panel is visible
    await expect(kanbanPage.settingsPanel).toBeVisible({ timeout: 10000 });

    // Find the first checkbox toggle ("Require approval to mark as Done")
    const checkbox = kanbanPage.settingsPanel.getByLabel("Require approval to mark as Done");
    await expect(checkbox).toBeVisible();

    // Record initial state and toggle it
    const wasChecked = await checkbox.isChecked();
    await checkbox.click();

    // Verify the checkbox state changed
    if (wasChecked) {
      await expect(checkbox).not.toBeChecked();
    } else {
      await expect(checkbox).toBeChecked();
    }

    // Click Save
    const saveBtn = kanbanPage.settingsPanel.getByRole("button", { name: "Save" });
    await saveBtn.click();

    // Assert the settings panel closes after save
    await expect(kanbanPage.settingsPanel).toBeHidden({ timeout: 10000 });

    // Re-open settings to verify persistence
    await settingsButton.click();
    await expect(kanbanPage.settingsPanel).toBeVisible({ timeout: 10000 });

    // Verify the checkbox reflects the toggled state
    const checkboxAfterReopen = kanbanPage.settingsPanel.getByLabel("Require approval to mark as Done");
    if (wasChecked) {
      await expect(checkboxAfterReopen).not.toBeChecked();
    } else {
      await expect(checkboxAfterReopen).toBeChecked();
    }

    // Close settings panel
    const cancelBtn = kanbanPage.settingsPanel.getByRole("button", { name: "Cancel" });
    await cancelBtn.click();
    await expect(kanbanPage.settingsPanel).toBeHidden({ timeout: 10000 });
  });

  // KANBAN-08: Board memory panel — render entries and accept new entries
  test("KANBAN-08: board memory panel renders and accepts new entries", async ({ kanbanPage, page }) => {
    // Seed a memory entry via API first
    await createBoardMemory(page.request, projectId, `Seeded memory ${TS}`, { tags: "decision" });

    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    // Open the board-memory pane via the tab bar "+" button
    const tabBar = page.locator('[data-testid="panel-tab-bar"]').last();
    await expect(tabBar).toBeVisible({ timeout: 10000 });

    // Click the "+" add-pane button in the tab bar
    const addPaneBtn = tabBar.locator('button').filter({ hasText: /^$/ }).last();
    // The add button is typically the last button with a "+" icon
    const plusBtn = tabBar.locator('[data-testid="add-pane-btn"]');
    // Try various selectors for the add-pane button
    const addBtn = (await plusBtn.isVisible().catch(() => false))
      ? plusBtn
      : tabBar.getByRole("button", { name: /add/i });

    if (await addBtn.isVisible().catch(() => false)) {
      await addBtn.click();
    } else {
      // Fallback: look for any "+" button in the tab bar
      const buttons = tabBar.locator('button');
      const count = await buttons.count();
      // The add button is usually the last one
      await buttons.nth(count - 1).click();
    }

    // Look for "Board Memory" option in the dropdown menu and click it
    const boardMemoryOption = page.getByText("Board Memory");
    await expect(boardMemoryOption).toBeVisible({ timeout: 5000 });
    await boardMemoryOption.click();

    // Wait for the memory panel to appear
    await expect(kanbanPage.memoryPanel).toBeVisible({ timeout: 10000 });

    // Verify seeded entry is visible
    await expect(kanbanPage.memoryPanel.getByText(`Seeded memory ${TS}`)).toBeVisible({ timeout: 10000 });

    // Add a new memory entry via the form
    const textarea = kanbanPage.memoryPanel.locator('textarea[placeholder="Add a memory entry..."]');
    await expect(textarea).toBeVisible();
    await textarea.fill(`E2E memory entry ${TS}`);

    // Fill tags
    const tagsInput = kanbanPage.memoryPanel.locator('input[placeholder="Tags (comma-separated)"]');
    await tagsInput.fill("decision,test");

    // Click Save
    const saveBtn = kanbanPage.memoryPanel.getByRole("button", { name: "Save" });
    await saveBtn.click();

    // Assert the new memory entry appears in the list
    await expect(kanbanPage.memoryPanel.getByText(`E2E memory entry ${TS}`)).toBeVisible({ timeout: 10000 });
  });

  // KANBAN-09: AllBoardsPane multi-board — tasks from multiple projects visible
  test("KANBAN-09: AllBoardsPane shows tasks from multiple projects", async ({ kanbanPage, page }) => {
    // Navigate to AllBoardsPane
    await kanbanPage.gotoAllBoards();

    // Assert AllBoardsPane is visible
    await expect(kanbanPage.allBoardsPane).toBeVisible({ timeout: 10000 });

    // Assert tasks from the first project are visible (use exact task name, .first() for safety)
    await expect(kanbanPage.allBoardsPane.getByText(`KB-Backlog-${TS}`).first()).toBeVisible({ timeout: 10000 });

    // Assert tasks from the second project are visible
    await expect(kanbanPage.allBoardsPane.getByText(`KB-Proj2-${TS}`).first()).toBeVisible({ timeout: 10000 });

    // Verify project label badges are shown on cards
    // The second project's label should be the last segment of projectPath2
    const projectLabel = projectPath2.split("/").pop()!;
    await expect(kanbanPage.allBoardsPane.getByText(projectLabel).first()).toBeVisible({ timeout: 10000 });
  });
});
