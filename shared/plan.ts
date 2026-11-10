/**
 * Shapes of `/api/plan`: Project -> Area -> Milestone -> Card -> Sources.
 * One declaration for both sides: the server builds them, the client only shows.
 */
import type { TaskStatus } from "./board";
import type { WaitReason } from "./waits-on-person";

export type PlanSignal = "duplicate" | "delivered_but_open" | "no_owner" | "stale";
/** `topic` is a Topics session (chat), the one the card ran in or came from. */
export type PlanSourceKind = "topic" | "pr" | "branch" | "commit" | "check" | "cron" | "other";
export const PLAN_SOURCE_KINDS: readonly PlanSourceKind[] = ["topic", "pr", "branch", "commit", "check", "cron", "other"];

export interface PlanSource {
  /** Row id in plan_sources; absent for implicit sources. */
  id?: string;
  kind: PlanSourceKind;
  label: string;
  url?: string | null;
  /** For topics: the one to open. */
  topicId?: string | null;
  implicit: boolean;
}

export interface PlanCard {
  id: string;
  text: string;
  status: TaskStatus;
  /** Workflow stage: `ai_review` is the reviewer agent's turn, not the person's. */
  stage: string | null;
  /** The dispatch chip: «at work» means an agent is here now (`isAgentWorking`), not status in_progress. */
  dispatchState: string | null;
  /** A grouping parent (`isGroupingParent`): shown with its children, kept out of every count. */
  grouping?: true;
  projectId: string;
  assignedTopicId: string | null;
  originTopicId: string | null;
  updatedAt: string;
  signals: PlanSignal[];
  /** For a duplicate: the surviving card it would be merged into. */
  duplicateOf?: string;
  /** The root card this one was split from, on the same board. */
  parentTaskId?: string;
  /** Sub-cards shown under this one (one level: grandchildren come up to the root). */
  children?: PlanCard[];
  sources: PlanSource[];
}

/** Why a card waits for the person: the reasons of `waitOnPerson` (shared/waits-on-person.ts). */
export type PlanNeedReason = WaitReason;
export interface PlanNeed {
  taskId: string;
  text: string;
  reason: PlanNeedReason;
  /** The question or the line to read, when there is one. */
  detail?: string;
}
/**
 * The summary of a group of cards for its header: `working` as soon as one
 * card is in progress, otherwise the state that best says where it stands.
 */
export type PlanActivityState = "working" | "review" | "todo" | "stale" | "done" | "empty";
export interface PlanActivity { state: PlanActivityState; count: number }

export interface PlanCounts { total: number; done: number; byStatus: Record<string, number> }
export interface PlanProgress extends PlanCounts { ratio: number }

export interface PlanMilestone {
  id: string; areaId: string; title: string;
  expectedResult: string | null; completionCriteria: string | null;
  // `targetDate`, a milestone's own date, not a card's `dueDate`.
  owner: string | null; status: string; targetDate: string | null; position: number;
  progress: PlanProgress;
  activity: PlanActivity;
  signals: PlanSignal[];
  sources: PlanSource[];
  tasks: PlanCard[];
}
export interface PlanArea {
  id: string; projectId: string; name: string; position: number;
  progress: PlanProgress; milestones: PlanMilestone[];
}
export interface PlanProject {
  projectId: string; name: string;
  /** Folder of the project, for its real icon (`ProjectFavicon`); null for virtual boards. */
  path: string | null;
  /**
   * Open cards the Kanban shows as cards (not done; no parent, or a parent no
   * longer open), grouping parents included, in milestones or not.
   */
  openCount: number;
  /** Open sub-cards, shown under their mother: counted apart so the total does not read as board cards. */
  openSubCount: number;
  progress: PlanProgress;
  activity: PlanActivity;
  /** Open cards that need the person, one line each; empty when none. */
  needsYou: PlanNeed[];
  areas: PlanArea[];
  /** Project cards not yet linked to a milestone: the "to place" group. */
  unplaced: { progress: PlanProgress; tasks: PlanCard[] };
}
export interface PlanTree { projects: PlanProject[]; includeDone: boolean }
