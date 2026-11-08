/**
 * Shapes of `/api/plan`: Project -> Area -> Milestone -> Card -> Sources.
 * One declaration for both sides: the server builds them, the client only shows.
 */

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
  status: string;
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

export interface PlanCounts { total: number; done: number; byStatus: Record<string, number> }
export interface PlanProgress extends PlanCounts { ratio: number }

export interface PlanMilestone {
  id: string; areaId: string; title: string;
  expectedResult: string | null; completionCriteria: string | null;
  // `targetDate`, not `dueDate`: the board feed drops a card's `dueDate` and
  // its test fails on any client read of that word.
  owner: string | null; status: string; targetDate: string | null; position: number;
  progress: PlanProgress;
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
  /** Open cards of the project (not done), in milestones or not. */
  openCount: number;
  progress: PlanProgress;
  areas: PlanArea[];
  /** Project cards not yet linked to a milestone: the "to place" group. */
  unplaced: { progress: PlanProgress; tasks: PlanCard[] };
}
export interface PlanTree { projects: PlanProject[]; includeDone: boolean }
