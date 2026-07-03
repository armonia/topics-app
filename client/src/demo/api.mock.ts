/* Mock of @/lib/api for the landing demo. Real client components import these
   exact names; we return generic placeholder data and a safe Proxy fallback so
   any un-mocked method resolves to {} instead of crashing. NO network. */

import type { Topic } from '../types';
import type { BoardTask, TaskStatus } from '../lib/api';

const now = () => new Date().toISOString();
// any property not explicitly mocked becomes an async () => ({}) — keeps the
// real components from crashing when they call something we didn't anticipate.
function mk<T extends object>(impl: T): T {
  return new Proxy(impl, {
    get(t, p) {
      return p in t
        ? (t as Record<string | symbol, unknown>)[p]
        : (async () => ({}));
    },
  });
}

const MOCK_TOPICS: Record<string, Topic> = {
  "t-ship": { id: "t-ship", name: "ship-v1.1", slug: "ship-v1-1", parentId: null, links: [], sessionKey: "s-ship", color: "#4d7cff", icon: "🚀", createdAt: now(), updatedAt: now(), archived: false, projectPath: "/demo/topics-app" },
  "t-landing": { id: "t-landing", name: "landing", slug: "landing", parentId: null, links: [], sessionKey: "s-landing", color: "#8b6cff", icon: "🎨", createdAt: now(), updatedAt: now(), archived: false, projectPath: "/demo/topics-app" },
  "t-auth": { id: "t-auth", name: "auth", slug: "auth", parentId: null, links: [], sessionKey: "s-auth", color: "#22d3ee", icon: "🔒", createdAt: now(), updatedAt: now(), archived: false, projectPath: "/demo/topics-app" },
  "t-docs": { id: "t-docs", name: "docs", slug: "docs", parentId: null, links: [], sessionKey: "s-docs", color: "#f5a524", icon: "📝", createdAt: now(), updatedAt: now(), archived: false, projectPath: "/demo/topics-app" },
};

const TASK = (id: string, text: string, status: TaskStatus, order: number, priority = 2, extra: Partial<BoardTask> = {}): BoardTask => ({
  id, text, status, kanbanOrder: order, createdAt: now(), completedAt: status === "done" ? now() : null,
  chatId: null,
  projectId: "/demo/topics-app", description: null, priority, assignedTo: null, assignedAgentId: null,
  assignedTopicId: null, claudeTaskId: null, fingerprint: null, dueDate: null, inProgressAt: null,
  updatedAt: now(), archived: false, blocks: [], blockedBy: [], tags: [], ...extra,
});
const MOCK_TASKS = [
  TASK("k1", "Telemetry opt-in", "backlog", 0, 1),
  TASK("k2", "i18n pass", "backlog", 1, 1),
  TASK("k3", "Sign macOS build", "todo", 0, 3),
  TASK("k4", "Empty states", "todo", 1, 2),
  TASK("k5", "Ship v1.1 release", "in_progress", 0, 4, { assignedTo: "claude" }),
  TASK("k6", "Landing site", "in_progress", 1, 3, { assignedTo: "claude" }),
  TASK("k7", "Per-agent token hashing", "review", 0, 3),
  TASK("k8", "Split panes", "done", 0, 2),
  TASK("k9", "Auto-update", "done", 1, 2),
  TASK("k10", "Grain + aurora pass", "done", 2, 1),
];

const GIT_STATUS = {
  branch: "main",
  lastCommit: { hash: "a1b2c3d", message: "feat: cross-platform release", author: "you", ago: "2 min ago" },
  files: [
    { path: "package.json", status: "M" },
    { path: ".github/workflows/release.yml", status: "A" },
    { path: "client/src/App.tsx", status: "M" },
    { path: "CHANGELOG.md", status: "M" },
    { path: "server/routes/release.ts", status: "??" },
  ],
  ahead: 1, behind: 0,
};

const SCRIPTS = [
  { processId: "p1", scriptName: "dev:server", command: "bun server.ts", projectPath: "/demo/topics-app", status: "running", pid: 4811, startedAt: now(), ports: [3333], source: "script" },
  { processId: "p2", scriptName: "dev:client", command: "vite", projectPath: "/demo/topics-app", status: "running", pid: 4822, startedAt: now(), ports: [5173], source: "script" },
  { processId: "p3", scriptName: "test", command: "bun test", projectPath: "/demo/topics-app", status: "done", pid: null, startedAt: now(), completedAt: now(), exitCode: 0, ports: [] },
];
const SCRIPT_OUTPUT: Record<string, string> = {
  p1: "$ bun server.ts\n[server] listening on https://localhost:3333\n[db] migrations up to date\n[ws] gateway connected\n[server] ready in 312ms\n",
  p2: "$ vite\n  VITE v6  ready in 287 ms\n  ➜  Local:   http://localhost:5173/\n  ➜  press h + enter to show help\n",
  p3: "$ bun test\n 24 pass\n 0 fail\nRan 24 tests across 6 files. [1.2s]\n",
};

export const topicsApi = mk({
  getAll: async () => ({ topics: MOCK_TOPICS, workspaceProjects: ["/demo/topics-app"] }),
  create: async (d: Partial<Topic>) => ({ ...MOCK_TOPICS["t-ship"], ...d, id: "t-new" }),
  update: async (id: string, d: Partial<Topic>) => ({ ...MOCK_TOPICS[id], ...d }),
  markRead: async () => ({ ok: true }),
  reorder: async () => ({ ok: true }),
});
export const chatApi = mk({ getHistory: async () => ({ messages: [] }), abort: async () => ({ ok: true }) });
export const searchApi = mk({});
export const unreadApi = mk({ getAll: async () => ({}) });
export const uploadApi = mk({});
export const filesApi = mk({
  list: async () => ([
    { name: "client", type: "dir", path: "/demo/topics-app/client", children: [] },
    { name: "server", type: "dir", path: "/demo/topics-app/server", children: [] },
    { name: "README.md", type: "file", path: "/demo/topics-app/README.md", size: 4200 },
    { name: "package.json", type: "file", path: "/demo/topics-app/package.json", size: 1900 },
  ]),
  content: async () => "// generic preview\nexport const hello = 'world';\n",
});
export const gitApi = mk({
  status: async () => GIT_STATUS,
  diff: async (_p: string, file: string) => ({ file, diff: `diff --git a/${file} b/${file}\n@@ -1,3 +1,4 @@\n const x = 1;\n-const y = 2;\n+const y = 3;\n+const z = 4;\n` }),
  branches: async () => ([{ name: "main", current: true, isRemote: false }, { name: "feat/landing", current: false, isRemote: false }]),
  log: async () => ([]),
  stage: async () => ({ ok: true }), unstage: async () => ({ ok: true }),
  commit: async () => ({ ok: true }), pull: async () => ({ ok: true }), push: async () => ({ ok: true }),
});
export const autoNameApi = mk({});
export const openclawControlApi = mk({});
export const tasksApi = mk({ list: async () => ({ tasks: MOCK_TASKS }) });
export const boardsApi = mk({
  listTasks: async () => ({ tasks: MOCK_TASKS }),
  createTask: async (_p: string, d: Partial<BoardTask>) => TASK("k-new", d?.text || "New task", d?.status || "todo", 99),
  updateTask: async (_p: string, id: string, u: Partial<BoardTask>) => ({ ...MOCK_TASKS.find(t => t.id === id), ...u }),
  moveTask: async (_p: string, id: string, status: string) => ({ ...MOCK_TASKS.find(t => t.id === id), status }),
  deleteTask: async () => ({ ok: true }), archiveTask: async () => ({ ok: true }),
  settings: async () => ({ projectId: "/demo/topics-app", requireApprovalForDone: false, requireReviewBeforeDone: false, blockStatusWithPending: false, onlyLeadCanChangeStatus: false, maxAgents: 4, autoExpireHours: 0 }),
});
export const approvalsApi = mk({ list: async () => ({ approvals: [] }) });
export const tagsApi = mk({ list: async () => ({ tags: [] }) });
export const processesApi = mk({ list: async () => ([
  { sessionKey: "s-ship", label: "claude-code", status: "running", startedAt: now() },
]) });
export const scriptsApi = mk({
  list: async () => ({ scripts: SCRIPTS }),
  output: async (id: string) => ({ output: SCRIPT_OUTPUT[id] || SCRIPT_OUTPUT.p1, offset: 99, done: id === "p3", status: id === "p3" ? "done" : "running", exitCode: id === "p3" ? 0 : undefined }),
  run: async () => ({ processId: "p-new", scriptName: "x", pid: 1, startedAt: now() }),
  stop: async () => ({ ok: true }),
});
export const commandApi = mk({});
export const memoryApi = mk({});
export const openclawContextApi = mk({});
export const contextAnalysisApi = mk({});
export const contextPreviewApi = mk({ fetch: async () => ({}) });
export const contextSnapshotsApi = mk({});
export const usageApi = mk({});
export const topicMessagesApi = mk({});
export const agentProfilesApi = mk({ list: async () => ([
  { id: "a1", name: "Lead", role: "lead", modelPreference: "opus", maxConcurrentTasks: 3, capabilities: [], avatarEmoji: "🧭", status: "online", createdAt: now(), updatedAt: now() },
  { id: "a2", name: "Worker", role: "worker", modelPreference: "sonnet", maxConcurrentTasks: 2, capabilities: [], avatarEmoji: "⚙️", status: "idle", createdAt: now(), updatedAt: now() },
]) });
export const dashboardApi = mk({
  getKPIs: async () => ({ throughputDay: 12, throughputWeek: 64, avgCycleTimeHours: 3.2, wipCount: 4, errorRate: 0.02, tokenSpendDay: 1.4, tokenSpendWeek: 9.1, agentUtilization: 0.62, approvalTurnaroundHours: 1.1, pendingApprovals: 0 }),
  getTimeSeries: async () => ([]), getAgentStats: async () => ([]),
});
export const boardMemoryApi = mk({ list: async () => ([]) });
export const agentActionsApi = mk({});
export const providersApi = mk({ snapshot: async () => ({ providers: [], defaultProvider: null, generatedAt: now() }) });
export const projectsApi = mk({ list: async () => ({ projects: [{ path: "/demo/topics-app", name: "topics-app" }] }) });
export const machinesApi = mk({ list: async () => ([]) });
export const worktreesApi = mk({ list: async () => ([]) });
// standalone (non-*Api) value exports the real api.ts provides
export function getMediaUrl(path: string): string { return path || ""; }
export function isProvidersSnapshot(v: unknown): boolean {
  return !!v && typeof v === "object" && Array.isArray((v as Record<string, unknown>).providers);
}

export const terminalsApi = mk({ list: async () => ([]) });
export const remoteAccessApi = mk({});
export const browserApi = mk({});
export const browserContextsApi = mk({ list: async () => ([]) });
