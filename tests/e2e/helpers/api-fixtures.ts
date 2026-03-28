import type { APIRequestContext } from "@playwright/test";

const BASE = "https://localhost:3333";

// --- Topic fixtures ---

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
  return res.json() as Promise<{ id: string; name: string; slug: string }>;
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
  await request
    .delete(`${BASE}/api/topics/${id}`, {
      ignoreHTTPSErrors: true,
    })
    .catch((err) => console.warn(`[cleanup] deleteTopic ${id}:`, err.message));
}

// --- Task fixtures ---

export async function createTask(
  request: APIRequestContext,
  projectId: string,
  text: string,
  opts?: { status?: string; priority?: string }
): Promise<{ id: string; text: string; status: string; priority: string }> {
  const res = await request.post(`${BASE}/api/boards/${projectId}/tasks`, {
    data: {
      text,
      status: opts?.status || "todo",
      priority: opts?.priority || "medium",
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

// --- Cleanup helper ---

interface CleanupItems {
  topics?: string[];
  tasks?: Array<{ projectId: string; taskId: string }>;
  agents?: string[];
}

export async function cleanupAll(
  request: APIRequestContext,
  created: CleanupItems
): Promise<void> {
  const errors: string[] = [];

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
