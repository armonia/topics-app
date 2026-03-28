/**
 * Playwright global setup — runs BEFORE all test suites.
 * Cleans up stale E2E test data from previous failed runs.
 *
 * This prevents test pollution: if a test run crashes mid-suite,
 * leftover E2E-* topics/tasks are cleaned up before the next run.
 */

const BASE = "https://localhost:3333";

async function globalSetup() {
  // Disable TLS verification for localhost self-signed certs
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  try {
    // Clean up stale E2E topics
    const topicsRes = await fetch(`${BASE}/api/topics`, {
      headers: { Accept: "application/json" },
    });
    if (topicsRes.ok) {
      const data = (await topicsRes.json()) as {
        topics: Record<string, { id: string; name: string }>;
      };
      const staleTopics = Object.values(data.topics).filter(
        (t) => t.name && t.name.startsWith("E2E-")
      );
      if (staleTopics.length > 0) {
        console.log(
          `[global-setup] Cleaning ${staleTopics.length} stale E2E topics...`
        );
        for (const topic of staleTopics) {
          await fetch(`${BASE}/api/topics/${topic.id}`, {
            method: "DELETE",
          }).catch(() => {});
        }
      }
    }

    // Clean up stale E2E tasks — the /api/boards/tasks endpoint returns
    // an object with project keys, each containing an array of tasks
    const boardsRes = await fetch(`${BASE}/api/boards/tasks`, {
      headers: { Accept: "application/json" },
    });
    if (boardsRes.ok) {
      const data = await boardsRes.json();
      // Handle both array and object response formats
      const tasks: Array<{ id: string; text: string; projectPath?: string }> =
        Array.isArray(data) ? data : Object.values(data).flat() as any;
      const staleTasks = (tasks || []).filter(
        (t: any) => t && t.text && (t.text.startsWith("KB-") || t.text.startsWith("E2E-"))
      );
      if (staleTasks.length > 0) {
        console.log(
          `[global-setup] Cleaning ${staleTasks.length} stale E2E tasks...`
        );
        for (const task of staleTasks) {
          const projectId = encodeURIComponent((task as any).projectPath || "");
          await fetch(`${BASE}/api/boards/${projectId}/tasks/${task.id}`, {
            method: "DELETE",
          }).catch(() => {});
        }
      }
    }
  } catch (err) {
    // Server might not be running — don't fail setup
    console.warn("[global-setup] Could not clean stale data:", (err as Error).message);
  }
}

export default globalSetup;
