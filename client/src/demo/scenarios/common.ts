/* Builders both scenarios share. They exist because the real types are wide
 * (a board task has 58 required fields) and a scenario should read as its
 * data, not as 58 nulls per card. Each builder fills the fields a demo has no
 * value for with the value the server sends when nothing happened: null, 0,
 * false or an empty list. */
import type { AppSettingsWire, PaneStoreSeed } from "../scenario";
import type { BoardSettings, BoardTask, DispatchCapacity, TaskStatus } from "../../lib/board";
import type { SystemStatus } from "../../hooks/useSystemStatus";
import type { Pane, Topic } from "../../types";
import type { ProjectUsageResponse } from "../../../../shared/usage-shapes";

/** The fields a demo card actually decides; everything else gets its idle value. */
export interface TaskFields {
  id: string;
  projectId: string;
  text: string;
  status: TaskStatus;
  kanbanOrder: number;
  at: string;
  priority?: number;
  assignedTo?: string | null;
  description?: string | null;
}

export function boardTask(f: TaskFields): BoardTask {
  const task: BoardTask = {
    id: f.id, projectId: f.projectId, text: f.text, description: f.description ?? null,
    status: f.status, priority: f.priority ?? 2, priorityAuto: false, kanbanOrder: f.kanbanOrder,
    assignedTo: f.assignedTo ?? null, createdAt: f.at, updatedAt: f.at,
    assignedTopicId: null, dispatchState: null, dispatchError: null, parentTaskId: null,
    urlProbeStatus: null, previewImage: null, previewRetiredAt: null, previewRetiredReason: null,
    planFirst: false, agentMs: 0, agentTokens: 0, agentCacheReadTokens: 0, agentCostCents: 0,
    subtaskCount: 0, subtaskDoneCount: 0, userCommentCount: 0, model: null, machineId: null,
    blockedByTaskId: null, blockedBy: null, subtaskWork: null, waitingOnCount: 0, queueReason: null,
    reuseBlockerContext: false, deliveryBranch: null, deliveryCommit: null, reviewAt: null,
    deliveryFilesChanged: null, deliveryInsertions: null, deliveryDeletions: null,
    deliveryUncommittedFiles: null, landingState: null, deployState: null, checksState: null,
    checksAt: null, checksCommit: null, checks: null, deliveredBy: null, deliveredReason: null,
    doneActor: null, reopenedAt: null, reopenedBy: null, reopenedActor: null, labels: [],
  };
  if (f.status === "done") task.completedAt = f.at;
  if (f.status === "in_progress") task.inProgressAt = f.at;
  return task;
}

/** A board's settings with every automation off, as a board nobody configured. */
export function boardSettings(projectId: string): BoardSettings {
  return {
    projectId, autoDispatch: false, dispatchEffort: "auto", dispatchUseWorktree: false,
    dispatchAutoMerge: false, deployCommand: "", dispatchTimeoutMin: 0, dispatchIdleMin: 0,
    dispatchMcp: "bridge-only", dispatchModel: "auto", dispatchTopicsRouting: null,
    dispatchMachineId: null, dispatchOverflow: false, dispatchStayLocal: false, language: "inherit",
    dispatchFanOut: 1, dispatchRetryCap: 0, dispatchRetryBackoffS: 0, requireApprovalForDone: false,
    requireReviewBeforeDone: false, reviewChecks: [], dispatchPaused: false, nightMode: false,
    nightModeUntil: "", nightModeStartedAt: null,
  };
}

/* GET /api/system/dispatch-capacity on a quiet machine with no agent running.
 * The board's load chip shows `running - recommended` when it is positive; the
 * generic fallback ([]) made it "Stop NaN". */
export function idleDispatchCapacity(): DispatchCapacity {
  return {
    recommended: 4, cores: 10, totalMemGB: 16, load1: 1.2, oursCores: 0, budgetCores: 5, budgetShare: 0.5,
    budgetCoreUnits: 5, usableCoreUnits: 10, usedCoreUnits: 0, usedMemGB: 0, otherCoreUnits: 1.2, frozen: 0,
    availableMemGB: 8, agentCostMemGB: 1, freeQuotaMemGB: 8, reason: "", running: 0,
  };
}

export function topic(f: { id: string; name: string; icon: string; color: string; at: string; projectPath?: string }): Topic {
  const t: Topic = {
    id: f.id, name: f.name, slug: f.id, parentId: null, links: [], sessionKey: `s-${f.id}`,
    color: f.color, icon: f.icon, createdAt: f.at, updatedAt: f.at, archived: false,
  };
  if (f.projectPath) t.projectPath = f.projectPath;
  return t;
}

/* GET /api/app-settings: an installation already in use (first run done) with
 * every preference untouched, which is what a fresh server reports as null. */
export function appSettings(): AppSettingsWire {
  return {
    settings: {
      aiProvider: null, claudeModel: null, claudeMaxTokens: null, claudeEffort: null, openaiModel: null,
      openaiMaxTokens: null, codexModel: null, codexReasoningEffort: null, museModel: null,
      claudeCodePermissionMode: null, codexApprovalMode: null, claudeCodeEnabled: null,
      outputLanguage: null, discordPresenceEnabled: null, discordDetailLevel: null, agentRuntime: null,
      profilePublishCost: null, profileShareToken: null, turnCheckpointsEnabled: null,
      calendarEnabled: null, calendarFeedUrl: null, calendarRefreshMinutes: null,
      calendarHorizonDays: null, browserStoreCacheReapEnabled: null, browserStoreReapEnabled: null,
      browserStoreReapAfterDays: null, firstRunDoneAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

export function systemStatus(at: string, sessions: number, topicCount: number): SystemStatus {
  return {
    timestamp: at,
    gateway: { online: true, status: "online", latencyMs: 12, lastCheckedAt: at },
    server: { uptimeMs: 1000000, startedAt: at, memoryMB: 41, heapUsedMB: 20, heapTotalMB: 40 },
    connections: { wsClients: 1, activeStreams: 0, streamKeys: [], browserWsContexts: 0, browserWsSockets: 0 },
    topics: { activeCount: topicCount, totalCount: topicCount },
    cronJobs: { enabled: 0, disabled: 0, total: 0 },
    sessions: { total: sessions, byType: { "claude-code": sessions } },
  };
}

/** GET /api/usage/projects with nothing measured yet. */
export function emptyUsage(at: string): ProjectUsageResponse {
  return {
    projects: [],
    totals: { chatTokens: 0, taskTokens: 0, totalTokens: 0, costUsd: 0 },
    cost: { currency: "usd", partial: false, excluded: { taskTokens: 0, messages: 0, models: [] }, estimated: { messages: 0, usd: 0 } },
    sideCalls: { calls: 0, unmeasured: 0, unpriced: 0, failed: 0, costUsd: 0, byPurpose: [] },
    range: "7d",
    cachedAt: at,
  };
}

/** A project window pane id, as the pane store derives it from the path. */
export function projectPaneId(path: string): string { return `project:${encodeURIComponent(path)}`; }

/** The pane-store envelope around a scenario's panes and spaces. */
export function paneStore(panes: Pane[], spaces: PaneStoreSeed["spaces"]): PaneStoreSeed {
  return {
    panes: Object.fromEntries(panes.map((p) => [p.id, p])),
    // ONE app-level group holds the tab ORDER: that is all `groups` is (there
    // is only ever `group:default`). The grouping the user sees is `spaces`.
    groups: { "group:default": { id: "group:default", paneIds: panes.map((p) => p.id), splitRatio: 0.5, splitAxis: "vertical" } },
    groupOrder: ["group:default"],
    spaces,
    closedStack: [],
    lastSeq: 1000,
    // The reducer's LWW gate drops a hydrate unless server_seq beats the live
    // lastSeq; hydrateFromLocalSnapshot derives the applied seq from server_seq.
    server_seq: 1000,
    savedAt: 1748856600000,
    senderId: "landing-demo",
  };
}
