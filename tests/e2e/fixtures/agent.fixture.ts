import { test as base, type Page } from "@playwright/test";

/**
 * Deterministic mock data for agent management E2E tests.
 * All values are fixed (no Math.random) to ensure reproducible assertions.
 */

// ── Mock Profiles ─────────────────────────────────────────────

export const MOCK_PROFILES = [
  {
    id: "agent-alpha",
    name: "Alpha Coder",
    role: "lead" as const,
    modelPreference: "claude-sonnet-4-20250514",
    maxConcurrentTasks: 3,
    capabilities: ["coding", "architecture", "review"],
    avatarEmoji: "\uD83E\uDD16",
    status: "available" as const,
    assignments: [],
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-27T10:00:00Z",
  },
  {
    id: "agent-beta",
    name: "Beta Tester",
    role: "worker" as const,
    modelPreference: "claude-sonnet-4-20250514",
    maxConcurrentTasks: 2,
    capabilities: ["testing", "debugging"],
    avatarEmoji: "\uD83D\uDC7E",
    status: "busy" as const,
    assignments: [
      {
        agentId: "agent-beta",
        topicId: "topic-1",
        role: "worker" as const,
        assignedAt: "2026-03-27T08:00:00Z",
      },
    ],
    createdAt: "2026-03-05T00:00:00Z",
    updatedAt: "2026-03-27T11:00:00Z",
  },
  {
    id: "agent-gamma",
    name: "Gamma Researcher",
    role: "specialist" as const,
    modelPreference: null,
    maxConcurrentTasks: 1,
    capabilities: ["research"],
    avatarEmoji: "\uD83E\uDDE0",
    status: "offline" as const,
    assignments: [],
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-26T15:00:00Z",
  },
];

// ── Mock Session History Items ────────────────────────────────

export const MOCK_HISTORY_SESSIONS = [
  {
    id: "sess-hist-1",
    agentId: "agent-alpha",
    sessionKey: "alpha-session-001",
    topicId: "topic-1",
    status: "active",
    taskId: "task-42",
    startedAt: "2026-03-27T09:00:00Z",
    lastHeartbeat: "2026-03-27T09:30:00Z",
    completedAt: null,
    totalTokens: 15000,
    errorMessage: null,
    agentName: "Alpha Coder",
    agentAvatar: "\uD83E\uDD16",
    agentRole: "lead",
    topicName: "Feature Implementation",
  },
  {
    id: "sess-hist-2",
    agentId: "agent-beta",
    sessionKey: "beta-session-002",
    topicId: "topic-2",
    status: "completed",
    taskId: "task-43",
    startedAt: "2026-03-27T07:00:00Z",
    lastHeartbeat: "2026-03-27T08:45:00Z",
    completedAt: "2026-03-27T08:50:00Z",
    totalTokens: 32000,
    errorMessage: null,
    agentName: "Beta Tester",
    agentAvatar: "\uD83D\uDC7E",
    agentRole: "worker",
    topicName: "Bug Fixes",
  },
];

// ── Mock Agent Sessions (for HeartbeatTimeline) ───────────────

export const MOCK_AGENT_SESSIONS = [
  {
    id: "agent-sess-1",
    agentId: "agent-alpha",
    sessionKey: "alpha-hb-001",
    topicId: "topic-1",
    status: "active",
    taskId: "task-42",
    startedAt: "2026-03-27T09:00:00Z",
    lastHeartbeat: "2026-03-27T09:30:00Z",
    completedAt: null,
    totalTokens: 15000,
    errorMessage: null,
  },
  {
    id: "agent-sess-2",
    agentId: "agent-alpha",
    sessionKey: "alpha-hb-002",
    topicId: "topic-3",
    status: "completed",
    taskId: "task-40",
    startedAt: "2026-03-26T14:00:00Z",
    lastHeartbeat: "2026-03-26T16:00:00Z",
    completedAt: "2026-03-26T16:05:00Z",
    totalTokens: 45000,
    errorMessage: null,
  },
];

// ── Mock Timeline Events ──────────────────────────────────────

export const MOCK_TIMELINE_EVENTS = [
  {
    type: "session_start" as const,
    timestamp: "2026-03-27T09:00:00Z",
    data: { status: "active" },
  },
  {
    type: "heartbeat" as const,
    timestamp: "2026-03-27T09:05:00Z",
    data: { status: "active", tokensUsed: 1200, currentTask: "Implementing auth" },
  },
  {
    type: "action" as const,
    timestamp: "2026-03-27T09:15:00Z",
    data: {
      actionType: "task.completed",
      detail: { text: "Auth module finished" },
    },
  },
  {
    type: "heartbeat" as const,
    timestamp: "2026-03-27T09:20:00Z",
    data: { status: "active", tokensUsed: 800 },
  },
];

// ── Page Object ───────────────────────────────────────────────

export class AgentPage {
  constructor(private page: Page) {}

  // ── Navigation ────────────────────────────────────────────

  async openAgentsPane() {
    const agentsBtn = this.page.locator('button[title="Agents"]');
    await agentsBtn.click();
    await this.sessionsTab.waitFor({ state: "visible", timeout: 10_000 });
  }

  async switchToRosterTab() {
    await this.rosterTab.click();
    await this.rosterHeading.waitFor({ state: "visible", timeout: 10_000 });
  }

  async switchToSessionsTab() {
    await this.sessionsTab.click();
  }

  // ── Tab Locators ──────────────────────────────────────────

  get sessionsTab() {
    return this.page.locator('button:text("Sessions")').first();
  }

  get rosterTab() {
    return this.page.locator('button:text("Roster")');
  }

  // ── Roster Locators ───────────────────────────────────────

  get rosterHeading() {
    return this.page.getByRole("heading", { name: "Agent Roster" });
  }

  get createAgentButton() {
    return this.page.locator('button:text("+ Create Agent")');
  }

  get searchInput() {
    return this.page.locator('input[placeholder="Search agents..."]');
  }

  get profileCards() {
    return this.page.locator(".grid > div").filter({
      has: this.page.locator('button:text("Edit")'),
    });
  }

  statusFilterButton(status: string) {
    // Filter buttons show capitalized status text (e.g., "All", "Available")
    const label = status === "all" ? "All" : status.charAt(0).toUpperCase() + status.slice(1);
    // Use a regex to match the button text (may include a count after the label)
    return this.page.locator(
      `.flex.items-center.gap-1 button:text("${label}")`
    );
  }

  // ── Editor Modal Locators ─────────────────────────────────

  get editorModal() {
    return this.page.locator(".fixed.inset-0.z-50").filter({
      has: this.page.locator('text="Agent Profile"'),
    });
  }

  get editorNameInput() {
    return this.page.locator('input[placeholder="Agent name..."]');
  }

  get editorSaveButton() {
    return this.page.locator('button:text("Save")');
  }

  get editorCreateButton() {
    return this.page.locator('button:text("Create")');
  }

  get editorCancelButton() {
    return this.page.locator('button:text("Cancel")');
  }

  // ── HeartbeatTimeline Locators ────────────────────────────

  get heartbeatTimelineHeading() {
    return this.page.getByText("Session History");
  }

  // ── Mock Helpers ──────────────────────────────────────────

  /**
   * Register all agent API endpoint mocks. Call BEFORE page.goto().
   */
  async mockAllAgentEndpoints() {
    await this.mockSessionsEndpoint(MOCK_HISTORY_SESSIONS);
    await this.mockSessionHistoryEndpoint(MOCK_HISTORY_SESSIONS);
    await this.mockProfilesEndpoint([...MOCK_PROFILES]);
    await this.mockProfileUpdateEndpoint();
    await this.mockAgentSessionsEndpoint(MOCK_AGENT_SESSIONS);
    await this.mockTimelineEndpoint(MOCK_TIMELINE_EVENTS);
    await this.mockSessionChatHistory([]);
    await this.mockAssignEndpoints();
  }

  async mockSessionsEndpoint(sessions: any[]) {
    await this.page.route("**/api/agents/sessions?*", async (route) => {
      if (route.request().url().includes("/history")) {
        return route.fallback();
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions }),
      });
    });
  }

  async mockSessionHistoryEndpoint(sessions: any[], total?: number) {
    await this.page.route("**/api/agents/sessions/history*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions,
          total: total ?? sessions.length,
          limit: 30,
          offset: 0,
        }),
      });
    });
  }

  async mockProfilesEndpoint(profiles: any[]) {
    await this.page.route("**/api/agents/profiles", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ profiles }),
        });
      } else if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        const newProfile = {
          id: "new-profile-001",
          ...body,
          status: "available",
          createdAt: "2026-03-28T00:00:00Z",
          updatedAt: "2026-03-28T00:00:00Z",
          assignments: [],
        };
        profiles.push(newProfile);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify(newProfile),
        });
      } else {
        await route.fallback();
      }
    });
  }

  async mockProfileUpdateEndpoint() {
    await this.page.route("**/api/agents/profiles/*", async (route) => {
      const url = route.request().url();
      // Don't intercept sub-paths like /sessions, /assign, /unassign
      const pathAfterProfiles = url.split("/api/agents/profiles/")[1] || "";
      if (pathAfterProfiles.includes("/")) {
        return route.fallback();
      }

      if (route.request().method() === "PATCH") {
        const body = JSON.parse(route.request().postData() || "{}");
        const id = pathAfterProfiles.split("?")[0];
        const existing = MOCK_PROFILES.find((p) => p.id === id) || MOCK_PROFILES[0];
        const updated = { ...existing, ...body, updatedAt: "2026-03-28T00:00:00Z" };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(updated),
        });
      } else if (route.request().method() === "DELETE") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      } else {
        await route.fallback();
      }
    });
  }

  async mockAgentSessionsEndpoint(sessions: any[]) {
    await this.page.route("**/api/agents/profiles/*/sessions", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions }),
      });
    });
  }

  async mockTimelineEndpoint(events: any[]) {
    await this.page.route("**/api/agents/sessions/*/timeline", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          session: null,
          events,
          heartbeatCount: events.filter((e: any) => e.type === "heartbeat").length,
          actionCount: events.filter((e: any) => e.type === "action").length,
        }),
      });
    });
  }

  async mockSessionChatHistory(messages: any[]) {
    await this.page.route("**/api/agents/sessions/*/history*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages }),
      });
    });
  }

  async mockAssignEndpoints() {
    await this.page.route("**/api/agents/profiles/*/assign", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agentId: "agent-alpha",
          topicId: body.topicId,
          role: body.role || "worker",
          assignedAt: "2026-03-28T00:00:00Z",
        }),
      });
    });

    await this.page.route("**/api/agents/profiles/*/unassign", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
  }
}

// ── Fixture Export ─────────────────────────────────────────────

export const test = base.extend<{ agentPage: AgentPage }>({
  agentPage: async ({ page }, use) => {
    await use(new AgentPage(page));
  },
});
