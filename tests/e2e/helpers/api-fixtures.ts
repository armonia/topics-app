import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

const BASE = "http://localhost:13334";

// --- Topic fixtures ---

/**
 * Wait for a topic created via `createTopic` to appear in the mounted UI.
 *
 * Review finding #18: `createTopic` seeds the sidebar by direct state
 * injection into `ui-state/pane-store-v2` and `ui-state/panels` — it
 * bypasses the normal hydration/mount path that React goes through on a
 * fresh page load. That's deliberate (it's the fastest way to set up a
 * pane for a test), but it means a raw `createTopic()` call gives you no
 * evidence that the UI actually rendered the topic. If the hydration path
 * regresses, tests that depend on the sidebar being populated after
 * `createTopic` would pass as false positives (the DB has the row, the
 * injected key has the right shape, but nothing reaches the DOM).
 *
 * Call this helper AFTER `createTopic` (and AFTER `page.goto(...)`) in any
 * test whose assertions depend on the topic being present in the rendered
 * tab bar. Resolves when either:
 *   - a pane tab with the matching `data-pane-id` is visible, OR
 *   - a sidebar row with the matching topic id is visible
 * (the selectors are OR'd so this works against both pane-store-v2 and
 * legacy openPanels-seeded setups).
 */
export async function waitForTopicVisible(
  page: Page,
  topicId: string,
  opts?: { timeout?: number },
): Promise<void> {
  const timeout = opts?.timeout ?? 5000;
  const tabLocator = page.locator(`[data-pane-id="${topicId}"]`).first();
  const sidebarLocator = page.locator(`[data-topic-id="${topicId}"]`).first();
  // `or()` resolves as soon as either locator matches; keeps the helper
  // resilient to layout variants where a topic is only in the sidebar list
  // and the tab hasn't been activated yet, or vice-versa.
  await expect(tabLocator.or(sidebarLocator)).toBeVisible({ timeout });
}

/**
 * Create a topic AND seed it into the sidebar via direct state injection.
 *
 * IMPORTANT (finding #18): state injection BYPASSES the React mount/
 * hydration path — the returned topic exists in the DB and in the
 * persisted ui-state keys, but this function does NOT await UI readiness.
 * If your test asserts on the sidebar/tab-bar AFTER a `page.goto(...)`,
 * call `waitForTopicVisible(page, topic.id)` to prove the injected state
 * actually reached the DOM; otherwise a regression in the hydration path
 * will surface as a false positive (state is there, UI never rendered it).
 */
export async function createTopic(
  request: APIRequestContext,
  name: string,
  opts?: { parentId?: string; systemPrompt?: string; projectPath?: string; color?: string; icon?: string }
): Promise<{ id: string; name: string; slug: string }> {
  const res = await request.post(`${BASE}/api/topics`, {
    data: { name, ...opts },
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) throw new Error(`Failed to create topic: ${res.status()}`);
  const topic = (await res.json()) as { id: string; name: string; slug: string };

  // Unified timeline sidebar (since commit c9d168e) only shows topics with an
  // open tab or unread messages. UI topic creation (App.tsx handleCreateTopic)
  // auto-opens a tab; raw-API creation must mirror that — otherwise the topic
  // stays invisible in the sidebar even though it exists in the DB.
  //
  // Phase 30 moved pane persistence from /api/ui-state/panels → pane-store-v2
  // (reducer snapshot). Seed both endpoints so tests work against both pre-
  // and post-Phase-30 clients.
  await seedTopicIntoSidebar(request, topic.id).catch(() => {
    // Non-fatal — tests that don't rely on sidebar visibility still work.
  });

  return topic;
}

/** Make a topic visible in the unified timeline sidebar by pre-seeding both
 *  the legacy openPanels endpoint AND the Phase 30 pane-store-v2 snapshot. */
async function seedTopicIntoSidebar(request: APIRequestContext, topicId: string): Promise<void> {
  // --- Legacy panels endpoint (pre-Phase-30 clients) ---
  try {
    const cur = await request.get(`${BASE}/api/ui-state/panels`, { ignoreHTTPSErrors: true });
    let openPanels: string[] = [];
    if (cur.ok()) {
      const body = (await cur.json()) as { value?: { openPanels?: string[] }; openPanels?: string[] };
      openPanels = body?.value?.openPanels ?? body?.openPanels ?? [];
    }
    if (!openPanels.includes(topicId)) {
      await request.put(`${BASE}/api/ui-state/panels`, {
        data: { openPanels: [...openPanels, topicId] },
        ignoreHTTPSErrors: true,
      });
    }
  } catch { /* ignore */ }

  // --- Phase 30 pane-store-v2 reducer snapshot ---
  // Shape (see client/src/state/pane/selectors.ts selectSyncableSnapshot):
  //   { panes, groups, projects, groupOrder, closedStack, lastSeq }
  // App.tsx's openPanels mirrors store.groups['group:default'].paneIds — so
  // injecting the topic there is what makes it appear in the sidebar.
  try {
    const cur = await request.get(`${BASE}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
    let snapshot: any = {
      panes: {},
      groups: { 'group:default': { id: 'group:default', paneIds: [], splitRatio: 1, splitAxis: 'horizontal' } },
      projects: {},
      groupOrder: ['group:default'],
      closedStack: [],
      lastSeq: 0,
    };
    if (cur.ok()) {
      const body = (await cur.json()) as { value?: any };
      if (body?.value && typeof body.value === 'object' && 'groups' in body.value) {
        snapshot = body.value;
      }
    }
    if (!snapshot.groups) snapshot.groups = {};
    if (!snapshot.groups['group:default']) {
      snapshot.groups['group:default'] = { id: 'group:default', paneIds: [], splitRatio: 1, splitAxis: 'horizontal' };
    }
    if (!Array.isArray(snapshot.groups['group:default'].paneIds)) {
      snapshot.groups['group:default'].paneIds = [];
    }
    if (!snapshot.groups['group:default'].paneIds.includes(topicId)) {
      snapshot.groups['group:default'].paneIds.push(topicId);
    }
    if (!snapshot.panes) snapshot.panes = {};
    if (!snapshot.panes[topicId]) {
      snapshot.panes[topicId] = { id: topicId, type: 'chat', title: '', topicId };
    }
    if (!Array.isArray(snapshot.groupOrder)) snapshot.groupOrder = ['group:default'];
    if (!snapshot.groupOrder.includes('group:default')) snapshot.groupOrder.unshift('group:default');
    snapshot.lastSeq = (snapshot.lastSeq ?? 0) + 1;

    await request.put(`${BASE}/api/ui-state/pane-store-v2`, {
      data: snapshot,
      ignoreHTTPSErrors: true,
    });
  } catch { /* ignore */ }
}

export async function patchTopic(
  request: APIRequestContext,
  id: string,
  data: Record<string, unknown>
): Promise<void> {
  const res = await request.patch(`${BASE}/api/topics/${id}`, {
    data,
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) throw new Error(`Failed to patch topic: ${res.status()}`);
}

export async function deleteTopic(
  request: APIRequestContext,
  id: string
): Promise<void> {
  // Phase 30.1 polish — destroy the topic's BrowserContext (Playwright
  // server-side Chromium pool, max 20 concurrent) BEFORE deleting the
  // topic record. Each browser-* spec creates contexts via agent/open or
  // navigate; without explicit cleanup, the pool fills up over the suite
  // and subsequent specs fail with "Max contexts reached" 500s.
  // 404 is fine — context might not exist for this topic. Catch to be safe
  // either way (DELETE could 5xx during shutdown).
  await request
    .delete(`${BASE}/api/browsers/${id}`, { ignoreHTTPSErrors: true })
    .catch(() => { /* best-effort */ });
  await request
    .delete(`${BASE}/api/topics/${id}`, {
      ignoreHTTPSErrors: true,
    })
    .catch((err) => console.warn(`[cleanup] deleteTopic ${id}:`, err.message));
  // Also remove this topic's pane IDs from pane-store-v2 + openPanels to keep
  // subsequent test files from seeing orphan references accumulating in the
  // reducer snapshot and the legacy openPanels array.
  await removeTopicFromSidebar(request, id).catch(() => { /* best-effort */ });
}

/** Strip a topic's pane IDs from pane-store-v2 snapshot and from openPanels.
 *  Idempotent; safe to call after the topic has already been deleted. */
async function removeTopicFromSidebar(request: APIRequestContext, topicId: string): Promise<void> {
  // --- Legacy openPanels ---
  try {
    const cur = await request.get(`${BASE}/api/ui-state/panels`, { ignoreHTTPSErrors: true });
    if (cur.ok()) {
      const body = (await cur.json()) as { value?: { openPanels?: string[] }; openPanels?: string[] };
      const openPanels: string[] = body?.value?.openPanels ?? body?.openPanels ?? [];
      if (openPanels.includes(topicId)) {
        await request.put(`${BASE}/api/ui-state/panels`, {
          data: { openPanels: openPanels.filter((x) => x !== topicId) },
          ignoreHTTPSErrors: true,
        });
      }
    }
  } catch { /* ignore */ }

  // --- Phase 30 pane-store-v2 snapshot ---
  try {
    const cur = await request.get(`${BASE}/api/ui-state/pane-store-v2`, { ignoreHTTPSErrors: true });
    if (!cur.ok()) return;
    const body = (await cur.json()) as { value?: any };
    const snap = body?.value;
    if (!snap || typeof snap !== 'object') return;

    let changed = false;
    // Remove pane entry keyed by topic id
    if (snap.panes && snap.panes[topicId]) {
      delete snap.panes[topicId];
      changed = true;
    }
    // Scrub the id from every group's paneIds
    if (snap.groups && typeof snap.groups === 'object') {
      for (const g of Object.values(snap.groups) as any[]) {
        if (Array.isArray(g?.paneIds) && g.paneIds.includes(topicId)) {
          g.paneIds = g.paneIds.filter((x: string) => x !== topicId);
          changed = true;
        }
      }
    }
    if (changed) {
      snap.lastSeq = (snap.lastSeq ?? 0) + 1;
      await request.put(`${BASE}/api/ui-state/pane-store-v2`, {
        data: snap,
        ignoreHTTPSErrors: true,
      });
    }
  } catch { /* ignore */ }
}

// --- Task fixtures ---

export async function createTask(
  request: APIRequestContext,
  projectId: string,
  text: string,
  opts?: { status?: string; priority?: string | number; assignedTo?: string }
): Promise<{ id: string; text: string; status: string; priority: string }> {
  const res = await request.post(`${BASE}/api/boards/${projectId}/tasks`, {
    data: {
      text,
      status: opts?.status || "todo",
      priority: opts?.priority ?? 2,
      ...(opts?.assignedTo ? { assignedTo: opts.assignedTo } : {}),
    },
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) throw new Error(`Failed to create task: ${res.status()}`);
  return res.json() as Promise<{
    id: string;
    text: string;
    status: string;
    priority: string;
  }>;
}

export async function deleteTask(
  request: APIRequestContext,
  projectId: string,
  taskId: string
): Promise<void> {
  await request
    .delete(`${BASE}/api/boards/${projectId}/tasks/${taskId}`, {
      ignoreHTTPSErrors: true,
    })
    .catch((err) =>
      console.warn(`[cleanup] deleteTask ${projectId}/${taskId}:`, err.message)
    );
}

// --- Agent profile fixtures ---

export async function createAgentProfile(
  request: APIRequestContext,
  name: string,
  opts?: { model?: string; systemPrompt?: string }
): Promise<{ id: string; name: string; model: string }> {
  const res = await request.post(`${BASE}/api/agents/profiles`, {
    data: { name, ...opts },
    ignoreHTTPSErrors: true,
  });
  if (!res.ok())
    throw new Error(`Failed to create agent profile: ${res.status()}`);
  return res.json() as Promise<{ id: string; name: string; model: string }>;
}

export async function deleteAgentProfile(
  request: APIRequestContext,
  id: string
): Promise<void> {
  await request
    .delete(`${BASE}/api/agents/profiles/${id}`, {
      ignoreHTTPSErrors: true,
    })
    .catch((err) =>
      console.warn(`[cleanup] deleteAgentProfile ${id}:`, err.message)
    );
}

// --- Approval fixtures ---

export async function createApproval(
  request: APIRequestContext,
  projectId: string,
  taskId: string,
  opts?: { approvalType?: string; fromStatus?: string; toStatus?: string; confidenceScore?: number; justification?: string; requestedBy?: string }
): Promise<{ id: string }> {
  const res = await request.post(`${BASE}/api/boards/${projectId}/approvals`, {
    data: {
      taskId,
      approvalType: opts?.approvalType || "status_change",
      fromStatus: opts?.fromStatus || "review",
      toStatus: opts?.toStatus || "done",
      confidenceScore: opts?.confidenceScore || 85,
      rubricScores: { quality: 4, completeness: 5 },
      justification: opts?.justification || "All acceptance criteria met",
      requestedBy: opts?.requestedBy || "test-agent",
    },
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) throw new Error(`Failed to create approval: ${res.status()}`);
  return res.json() as Promise<{ id: string }>;
}

// --- Board memory fixtures ---

export async function createBoardMemory(
  request: APIRequestContext,
  projectId: string,
  content: string,
  opts?: { tags?: string | string[]; source?: string }
): Promise<{ id: string }> {
  // Normalize tags to an array (server expects array, stores as JSON)
  const tags = Array.isArray(opts?.tags) ? opts.tags : (opts?.tags ? opts.tags.split(",").map(t => t.trim()) : ["test"]);
  const res = await request.post(`${BASE}/api/boards/${projectId}/memory`, {
    data: {
      content,
      tags,
      source: opts?.source || "manual",
    },
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) throw new Error(`Failed to create board memory: ${res.status()}`);
  return res.json() as Promise<{ id: string }>;
}

// --- Terminal session fixtures ---

export async function createTerminalSession(
  request: APIRequestContext,
  opts?: { cwd?: string; type?: string; topicId?: string; name?: string; cols?: number; rows?: number }
): Promise<{ id: string; name: string; cwd: string }> {
  const res = await request.post(`${BASE}/api/terminal/sessions`, {
    data: {
      cwd: opts?.cwd || '/tmp',
      type: opts?.type || 'shell',
      topicId: opts?.topicId,
      name: opts?.name,
      cols: opts?.cols || 120,
      rows: opts?.rows || 30,
    },
    ignoreHTTPSErrors: true,
  });
  if (!res.ok()) throw new Error(`Failed to create terminal session: ${res.status()}`);
  return res.json();
}

export async function deleteTerminalSession(
  request: APIRequestContext,
  sessionId: string
): Promise<void> {
  await request.delete(`${BASE}/api/terminal/sessions/${sessionId}`, {
    ignoreHTTPSErrors: true,
  }).catch(() => {});
}

export async function listTerminalSessions(
  request: APIRequestContext,
  topicId?: string
): Promise<Array<{ id: string; name: string; cwd: string; type: string }>> {
  const url = topicId
    ? `${BASE}/api/terminal/sessions?topicId=${topicId}`
    : `${BASE}/api/terminal/sessions`;
  const res = await request.get(url, { ignoreHTTPSErrors: true });
  if (!res.ok()) return [];
  return res.json();
}

// --- Cleanup helper ---

interface CleanupItems {
  topics?: string[];
  tasks?: Array<{ projectId: string; taskId: string }>;
  agents?: string[];
  terminalSessions?: string[];
}

export async function cleanupAll(
  request: APIRequestContext,
  created: CleanupItems
): Promise<void> {
  const errors: string[] = [];

  for (const id of created.terminalSessions ?? []) {
    await deleteTerminalSession(request, id).catch((err) =>
      errors.push(`terminal ${id}: ${err.message}`)
    );
  }

  for (const id of created.topics ?? []) {
    await deleteTopic(request, id).catch((err) =>
      errors.push(`topic ${id}: ${err.message}`)
    );
  }

  for (const { projectId, taskId } of created.tasks ?? []) {
    await deleteTask(request, projectId, taskId).catch((err) =>
      errors.push(`task ${projectId}/${taskId}: ${err.message}`)
    );
  }

  for (const id of created.agents ?? []) {
    await deleteAgentProfile(request, id).catch((err) =>
      errors.push(`agent ${id}: ${err.message}`)
    );
  }

  if (errors.length > 0) {
    console.warn(`[cleanupAll] ${errors.length} cleanup errors:`, errors);
  }
}
