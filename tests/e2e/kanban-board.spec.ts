import { expect } from "@playwright/test";
import { test } from "./fixtures/kanban.fixture";
import { createTopic, createTask, cleanupAll } from "./helpers/api-fixtures";
import { dndDrag, dndReorder } from "./helpers/dnd-helpers";

test.describe("Kanban Board", () => {
  const TS = Date.now();
  let topicId: string;
  const projectPath = `/tmp/e2e-kanban-${TS}`;
  let projectId: string;

  test.beforeAll(async ({ request }) => {
    // Create a topic with projectPath so the board is accessible
    const topic = await createTopic(request, `E2E-Kanban-${TS}`, {
      projectPath,
    });
    topicId = topic.id;
    projectId = encodeURIComponent(projectPath);

    // Seed tasks in various columns
    await createTask(request, projectId, `KB-Backlog-${TS}`, { status: "backlog" });
    await createTask(request, projectId, `KB-Todo-${TS}`, { status: "todo" });
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
  });

  test.afterAll(async ({ request }) => {
    await cleanupAll(request, { topics: [topicId] });
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

  // KANBAN-03: Drag task between columns moves it and persists on reload
  test("KANBAN-03: drag task between columns moves it", async ({ kanbanPage, page }) => {
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));

    const todoColumn = kanbanPage.getColumn("todo");
    const inProgressColumn = kanbanPage.getColumn("in_progress");

    // Verify the task starts in the todo column
    await expect(todoColumn.getByText(`KB-Todo-${TS}`)).toBeVisible();

    // Get the drag handle for the task
    const dragHandle = kanbanPage.getTaskDragHandle(new RegExp(`KB-Todo-${TS}`));
    await expect(dragHandle).toBeVisible();

    // Drag to in_progress column
    await dndDrag(page, dragHandle, inProgressColumn);

    // Verify task moved to in_progress
    await expect(inProgressColumn.getByText(`KB-Todo-${TS}`)).toBeVisible({ timeout: 10000 });

    // Verify persistence: navigate to board again after reload
    await kanbanPage.gotoProjectBoard(projectPath, new RegExp(`E2E-Kanban-${TS}`));
    await expect(
      kanbanPage.getColumn("in_progress").getByText(`KB-Todo-${TS}`)
    ).toBeVisible({ timeout: 10000 });
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
});
