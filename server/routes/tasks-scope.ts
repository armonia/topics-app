/**
 * The values the tasks router shares with the modules split out of it: the core
 * every one of them reads, and the functions they reach in each other.
 */
import type { AppContext } from "../types";
import type { TaskService } from "../services/tasks";
import type { TaskDispatcher } from "../services/task-dispatcher";
import type { createTaskAttemptStore } from "../services/task-attempts";
import type { createDeliveryCapture } from "../services/task-delivery-capture";
import type { createAutoLander } from "../services/auto-land";
import type { LandingTicket } from "../services/landing-queue";
import type { LandOutcome } from "../services/worktree-gc";
import type { ChecksLeg } from "../services/checks-gate";
import type { TasksRouterOpts } from "./tasks-opts";

export interface TasksCore {
  ctx: AppContext;
  opts: TasksRouterOpts | undefined;
  dispatcher: TaskDispatcher | undefined;
  svc: TaskService;
  attempts: ReturnType<typeof createTaskAttemptStore>;
  db: AppContext["db"];
  json: AppContext["json"];
  readJSON: AppContext["readJSON"];
  matchRoute: AppContext["matchRoute"];
  broadcastToAll: AppContext["broadcastToAll"];
  broadcastToTopicSubscribers: AppContext["broadcastToTopicSubscribers"];
  getTopicBySessionKey: AppContext["getTopicBySessionKey"];
  isPathAllowed: AppContext["isPathAllowed"];
}

// Filled by the factories, in the order the router builds them; read lazily.
export interface TasksLate {
  reapAfterLand(taskId: string, outcome: LandOutcome): Promise<void>;
  sweepRemoteDelivery(
    projectId: string, taskId: string, reason: string,
    over?: { cwd?: string | null; landed?: string | null; extra?: Array<string | null | undefined> },
  ): Promise<void>;
  capturaConsegna: ReturnType<typeof createDeliveryCapture>;
  triggerUrlProbe(taskId: string, outputUrl: string | null, projectId?: string): void;
  runChecksGate(
    taskId: string, projectId: string, legMs: number,
    checkout?: () => Promise<{ cwd: string; commit: string | null } | null>,
  ): Promise<ChecksLeg>;
  tellChatAboutChecksWait(
    sessionKey: string, topicId: string | null, taskId: string, projectId: string,
    task: { checksProgress?: { done: number; total: number } | null } | undefined,
  ): void;
  rememberDelivery(taskId: string, pathname: string, body: Record<string, unknown>): void;
  checksWaitSince: Map<string, number>;
  enqueueLandOnDone(projectId: string, taskId: string, branch: string): LandingTicket | null;
  autoLander: ReturnType<typeof createAutoLander>;
  tasksRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null>;
  forgetDeliveryMemo(taskId: string): void;
  captureDelivery<T extends { id: string; status: string }>(task: T, prevStatus?: string): Promise<T>;
}
