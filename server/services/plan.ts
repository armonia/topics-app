/**
 * The Plan: Project -> Area -> Milestone -> Card -> Sources, over the board.
 *
 * No card is copied: the card stays the truth about its status, the plan only
 * says which result it serves. Counts, progress and signals are COMPUTED on
 * every read and never stored (a stored value goes stale, a computed one cannot).
 */
import type { Database } from "bun:sqlite";
import { isAgentWorking, type TaskStatus } from "../../shared/board";
import { buildProjectNames, loadRegisteredProjects } from "./project-display-name";
import { STAGE_AI_REVIEW, awaitsHuman } from "../../shared/workflow";
import { isGroupingParent } from "../../shared/grouping-parent";
import { waitOnPerson } from "../../shared/waits-on-person";
import { findDuplicateGroups } from "../../shared/task-similarity";
import {
  PLAN_SOURCE_KINDS,
  type PlanActivity, type PlanArea, type PlanCard, type PlanCounts, type PlanMilestone, type PlanNeed, type PlanProgress,
  type PlanProject, type PlanSignal, type PlanSource, type PlanSourceKind, type PlanTree,
} from "../../shared/plan";

export const STALE_DAYS = 7;
const DAY_MS = 86_400_000;

/** A milestone row as SQLite returns it. */
interface MilestoneRow {
  id: string; area_id: string; title: string; expected_result: string | null; completion_criteria: string | null;
  owner: string | null; status: string; target_date: string | null; position: number;
}

interface TaskRow {
  id: string; project_id: string; text: string; status: TaskStatus;
  assigned_topic_id: string | null; origin_topic_id: string | null;
  delivery_branch: string | null; delivery_commit: string | null; checks_state: string | null;
  updated_at: string; created_at: string; parent_task_id?: string | null;
  description?: string | null; stage?: string | null; human_ask?: string | null;
  dispatch_state?: string | null; dispatch_error?: string | null; dispatch_attempts?: number | null;
  in_progress_at?: string | null; delivered_by?: string | null; landing_state?: string | null;
}

interface CommentRow { task_id: string; content: string; kind: string | null; author: string | null; message_id: string | null; quiet: number | null }

/**
 * Does this open card need the person, and why? The rule is `waitOnPerson`
 * (shared/waits-on-person.ts), the same for every reader.
 */
export function needOf(
  t: Pick<TaskRow, "id" | "text" | "status" | "description" | "stage" | "human_ask" | "dispatch_state" | "dispatch_error">,
  comments: readonly CommentRow[],
): PlanNeed | null {
  const w = waitOnPerson(t, comments.map((c) => ({
    content: c.content, kind: c.kind, author: c.author, messageId: c.message_id, quiet: !!c.quiet,
  })));
  return w ? { taskId: t.id, text: t.text, ...w } : null;
}

/**
 * The header state of a group of cards, with the Kanban's rules. «At work»
 * means an agent is on the card now (`isAgentWorking`), or the reviewer agent
 * in AI review: status in_progress alone is not work. Then what waits for a
 * person's approval (`awaitsHuman`), then what is left to do, and «stale»
 * only when every open card has been idle past STALE_DAYS. Grouping parents
 * are not work and stay out.
 */
export function activityOf(
  all: readonly Pick<PlanCard, "status" | "signals" | "stage" | "dispatchState" | "grouping">[],
): PlanActivity {
  const cards = all.filter((c) => !c.grouping);
  const open = cards.filter((c) => c.status !== "done");
  const working = open.filter((c) => isAgentWorking(c.dispatchState) || (c.status === "review" && c.stage === STAGE_AI_REVIEW)).length;
  const review = open.filter((c) => awaitsHuman(c)).length;
  if (working > 0) return { state: "working", count: working };
  if (review > 0) return { state: "review", count: review };
  if (open.length > 0 && open.every((c) => c.signals.includes("stale"))) return { state: "stale", count: open.length };
  if (open.length > 0) return { state: "todo", count: open.length };
  if (cards.length > 0) return { state: "done", count: cards.length };
  return { state: "empty", count: 0 };
}

export function countCards(cards: readonly { status: string }[]): PlanCounts {
  const byStatus: Record<string, number> = {};
  for (const c of cards) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  return { total: cards.length, done: byStatus.done ?? 0, byStatus };
}

/** Progress of a group; grouping parents are containers, not results, and do not count. */
function progressOf(all: readonly { status: string; grouping?: true }[]): PlanProgress {
  const c = countCards(all.filter((x) => !x.grouping));
  return { ...c, ratio: c.total === 0 ? 0 : c.done / c.total };
}

/**
 * Signals of ONE card, except duplicate (it needs the comparison with the others).
 * `delivered_but_open` is a card that was delivered (a commit, or landed) and
 * then went back to work: a card in review is the approval itself, already in
 * «waiting for you». A grouping parent has no owner to miss.
 */
export function cardSignals(
  t: Pick<TaskRow, "status" | "assigned_topic_id" | "delivery_commit" | "updated_at" | "landing_state">,
  ownerOfMilestone: string | null,
  nowMs: number,
  opts: { grouping?: boolean } = {},
): PlanSignal[] {
  const out: PlanSignal[] = [];
  const open = t.status !== "done";
  if (open && t.status !== "review" && (t.delivery_commit || t.landing_state === "landed")) out.push("delivered_but_open");
  if (open && !opts.grouping && !t.assigned_topic_id && !ownerOfMilestone) out.push("no_owner");
  const updated = Date.parse(t.updated_at);
  if (open && Number.isFinite(updated) && nowMs - updated > STALE_DAYS * DAY_MS) out.push("stale");
  return out;
}

function implicitSources(t: TaskRow): PlanSource[] {
  const out: PlanSource[] = [];
  if (t.assigned_topic_id) out.push({ kind: "topic", label: "assigned", topicId: t.assigned_topic_id, implicit: true });
  if (t.origin_topic_id && t.origin_topic_id !== t.assigned_topic_id) {
    out.push({ kind: "topic", label: "origin", topicId: t.origin_topic_id, implicit: true });
  }
  if (t.delivery_branch) out.push({ kind: "branch", label: t.delivery_branch, implicit: true });
  if (t.delivery_commit) out.push({ kind: "commit", label: t.delivery_commit, implicit: true });
  if (t.checks_state) out.push({ kind: "check", label: t.checks_state, implicit: true });
  return out;
}

interface SourceRow { id: string; task_id: string | null; milestone_id: string | null; kind: PlanSourceKind; label: string; url: string | null }
const toSource = (r: SourceRow): PlanSource => ({ id: r.id, kind: r.kind, label: r.label, url: r.url, implicit: false });

export function buildPlan(
  db: Database,
  opts: { projectId?: string; includeDone?: boolean; now?: number; knownDirs?: readonly string[] } = {},
): PlanTree {
  const nowMs = opts.now ?? Date.now();
  const includeDone = !!opts.includeDone;
  const where = opts.projectId ? "AND project_id = ?" : "";
  const params = opts.projectId ? [opts.projectId] : [];

  const tasks = db.query(
    `SELECT id, project_id, text, status, assigned_topic_id, origin_topic_id, delivery_branch,
            delivery_commit, checks_state, updated_at, created_at, parent_task_id,
            description, stage, human_ask, dispatch_state, dispatch_error, dispatch_attempts,
            in_progress_at, delivered_by, landing_state
       FROM tasks WHERE archived = 0 ${where}`,
  ).all(...params) as TaskRow[];
  // Threads of OPEN cards only: a closed card asks nothing, and the full
  // history is tens of thousands of rows.
  const openIds = tasks.filter((t) => t.status !== "done").map((t) => t.id);
  const commentsOf = new Map<string, CommentRow[]>();
  for (let i = 0; i < openIds.length; i += 500) {
    const chunk = openIds.slice(i, i + 500);
    const rows = db.query(
      `SELECT task_id, content, kind, author, message_id, quiet FROM task_comments
        WHERE task_id IN (${chunk.map(() => "?").join(",")}) ORDER BY created_at, rowid`,
    ).all(...chunk) as CommentRow[];
    for (const c of rows) commentsOf.set(c.task_id, [...(commentsOf.get(c.task_id) ?? []), c]);
  }
  const areas = db.query(
    `SELECT id, project_id, name, position FROM plan_areas ${opts.projectId ? "WHERE project_id = ?" : ""} ORDER BY position, created_at`,
  ).all(...params) as { id: string; project_id: string; name: string; position: number }[];
  const milestones = db.query(
    `SELECT * FROM plan_milestones ORDER BY position, created_at`,
  ).all() as MilestoneRow[];
  const links = db.query(`SELECT task_id, milestone_id FROM plan_task_links`).all() as { task_id: string; milestone_id: string }[];
  const sources = db.query(`SELECT id, task_id, milestone_id, kind, label, url FROM plan_sources ORDER BY created_at`).all() as SourceRow[];

  // One rule for the name and the path of a project, shared with the Kanban's
  // project index (`services/project-display-name.ts`): same heading, same order.
  // Board ids are path slugs (`quadra-lh40qh`), not `projects.id`: the index
  // resolves both, or every project shows its slug instead of the name people know.
  const projectNames = buildProjectNames(loadRegisteredProjects(db), opts.knownDirs ?? []);

  const milestoneOf = new Map(links.map((l) => [l.task_id, l.milestone_id]));
  // A sub-card lives where its mother lives (same board): the plan shows it
  // under her, not loose among the unplaced cards. Walk up to the root among
  // the cards read; a cycle stops at the first repeated step.
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const rootOf = (t: TaskRow): TaskRow => {
    const seen = new Set<string>([t.id]);
    let cur = t;
    while (cur.parent_task_id) {
      const up = taskById.get(cur.parent_task_id);
      if (!up || up.project_id !== cur.project_id || seen.has(up.id)) break;
      seen.add(up.id); cur = up;
    }
    return cur;
  };
  const rootIdOf = new Map(tasks.map((t) => [t.id, rootOf(t).id]));
  const areaOfMilestone = new Map(milestones.map((m) => [m.id, m.area_id]));
  const projectOfArea = new Map(areas.map((a) => [a.id, a.project_id]));
  // A link to a milestone of another project does not count: the card stays unplaced.
  const validFor = (t: TaskRow, mid: string | undefined): mid is string => {
    const area = mid ? areaOfMilestone.get(mid) : undefined;
    return !!area && projectOfArea.get(area) === t.project_id;
  };
  // Up first: a mother with no milestone of her own goes where her sub-cards
  // are (the most frequent milestone, the first met on a tie), so she is not
  // left among the unplaced while they sit in a milestone.
  const kidsMilestones = new Map<string, Map<string, number>>();
  for (const t of tasks) {
    const root = rootIdOf.get(t.id)!;
    const mid = milestoneOf.get(t.id);
    if (root === t.id || !validFor(t, mid)) continue;
    const tally = kidsMilestones.get(root) ?? new Map<string, number>();
    tally.set(mid, (tally.get(mid) ?? 0) + 1);
    kidsMilestones.set(root, tally);
  }
  for (const [root, tally] of kidsMilestones) {
    if (validFor(taskById.get(root)!, milestoneOf.get(root))) continue;
    let best: string | undefined;
    for (const [mid, n] of tally) if (best === undefined || n > (tally.get(best) ?? 0)) best = mid;
    if (best !== undefined) milestoneOf.set(root, best);
  }
  // Then down: a sub-card with no milestone follows its mother.
  for (const t of tasks) {
    const root = rootIdOf.get(t.id)!;
    if (root !== t.id && !milestoneOf.has(t.id) && milestoneOf.has(root)) milestoneOf.set(t.id, milestoneOf.get(root)!);
  }
  // Grouping parents: the same predicate that spares them from the parked sweep.
  const openKids = new Map<string, number>();
  for (const t of tasks) {
    if (t.parent_task_id && t.status !== "done") openKids.set(t.parent_task_id, (openKids.get(t.parent_task_id) ?? 0) + 1);
  }
  const grouping = new Set(tasks.filter((t) => isGroupingParent(t, openKids.get(t.id) ?? 0)).map((t) => t.id));
  const milestoneById = new Map(milestones.map((m) => [m.id, m]));
  const srcByTask = new Map<string, PlanSource[]>();
  const srcByMilestone = new Map<string, PlanSource[]>();
  for (const s of sources) {
    const map = s.task_id ? srcByTask : srcByMilestone;
    const key = (s.task_id ?? s.milestone_id) as string;
    map.set(key, [...(map.get(key) ?? []), toSource(s)]);
  }

  // Duplicates: the same function as GET /api/boards/:projectId/duplicates,
  // per project and on open cards only (history is not merged).
  const dupOf = new Map<string, string>();
  const byProject = new Map<string, TaskRow[]>();
  for (const t of tasks) byProject.set(t.project_id, [...(byProject.get(t.project_id) ?? []), t]);
  for (const list of byProject.values()) {
    const open = list.filter((t) => t.status !== "done");
    for (const g of findDuplicateGroups(open.map((t) => ({ id: t.id, text: t.text, createdAt: t.created_at })))) {
      for (const d of g.duplicates) dupOf.set(d.id, g.survivor.id);
      dupOf.set(g.survivor.id, g.survivor.id);
    }
  }

  const toCard = (t: TaskRow): PlanCard => {
    const mid = milestoneOf.get(t.id);
    const owner = mid ? (milestoneById.get(mid)?.owner ?? null) : null;
    const isGrouping = grouping.has(t.id);
    const signals = cardSignals(t, owner, nowMs, { grouping: isGrouping });
    const survivor = dupOf.get(t.id);
    const card: PlanCard = {
      id: t.id, text: t.text, status: t.status, stage: t.stage ?? null, dispatchState: t.dispatch_state ?? null,
      ...(isGrouping ? { grouping: true as const } : {}), projectId: t.project_id,
      assignedTopicId: t.assigned_topic_id, originTopicId: t.origin_topic_id,
      updatedAt: t.updated_at, signals,
      sources: [...implicitSources(t), ...(srcByTask.get(t.id) ?? [])],
    };
    const root = rootIdOf.get(t.id);
    if (root && root !== t.id) card.parentTaskId = root;
    if (survivor) {
      // The survivor only heads the group: the signal goes on the duplicates.
      if (survivor !== t.id) { card.signals.unshift("duplicate"); card.duplicateOf = survivor; }
    }
    return card;
  };

  const visible = (c: PlanCard) => includeDone || c.status !== "done";
  const cardsByMilestone = new Map<string, PlanCard[]>();
  const unplacedByProject = new Map<string, PlanCard[]>();
  // Counts use ALL cards (progress needs the done ones); the list shows done
  // cards only with includeDone.
  const allByMilestone = new Map<string, PlanCard[]>();
  const allUnplaced = new Map<string, PlanCard[]>();
  const placeOf = (t: TaskRow): { valid: boolean; key: string } => {
    const mid = milestoneOf.get(t.id);
    return validFor(t, mid) ? { valid: true, key: mid } : { valid: false, key: t.project_id };
  };
  for (const t of tasks) {
    const card = toCard(t);
    // Counts follow the card's own milestone.
    const own = placeOf(t);
    const bucketAll = own.valid ? allByMilestone : allUnplaced;
    bucketAll.set(own.key, [...(bucketAll.get(own.key) ?? []), card]);
    if (visible(card)) {
      // The list shows a sub-card under her visible mother, even when its own
      // link points to another milestone: the container and its content are one row.
      const root = card.parentTaskId ? taskById.get(card.parentTaskId) : undefined;
      const shownAt = root && (includeDone || root.status !== "done") ? placeOf(root) : own;
      const bucket = shownAt.valid ? cardsByMilestone : unplacedByProject;
      bucket.set(shownAt.key, [...(bucket.get(shownAt.key) ?? []), card]);
    }
  }
  // Visible children go under their visible mother; when the mother is hidden
  // (done, without "show completed") the child stays in the list on its own.
  for (const bucket of [cardsByMilestone, unplacedByProject]) {
    for (const [key, list] of bucket) {
      const byId = new Map(list.map((c) => [c.id, c]));
      const top: PlanCard[] = [];
      for (const c of list) {
        const mother = c.parentTaskId ? byId.get(c.parentTaskId) : undefined;
        if (mother) (mother.children ??= []).push(c);
        else top.push(c);
      }
      bucket.set(key, top);
    }
  }

  const projectIds = new Set<string>([...tasks.map((t) => t.project_id), ...areas.map((a) => a.project_id)]);
  const built: PlanProject[] = [...projectIds].map((pid) => {
    const projectAreas: PlanArea[] = areas.filter((a) => a.project_id === pid).map((a) => {
      const ms: PlanMilestone[] = milestones.filter((m) => m.area_id === a.id).map((m) => {
        const all = allByMilestone.get(m.id) ?? [];
        const shown = cardsByMilestone.get(m.id) ?? [];
        const signals = [...new Set(shown.flatMap((c) => c.signals))];
        return {
          id: m.id, areaId: m.area_id, title: m.title,
          expectedResult: m.expected_result, completionCriteria: m.completion_criteria,
          owner: m.owner, status: m.status, targetDate: m.target_date, position: m.position,
          progress: progressOf(all), activity: activityOf(all), signals, sources: srcByMilestone.get(m.id) ?? [], tasks: shown,
        };
      });
      const allCards = ms.flatMap((m) => allByMilestone.get(m.id) ?? []);
      return { id: a.id, projectId: pid, name: a.name, position: a.position, progress: progressOf(allCards), milestones: ms };
    });
    const unplacedAll = allUnplaced.get(pid) ?? [];
    const everything = [...projectAreas.flatMap((a) => a.milestones.flatMap((m) => allByMilestone.get(m.id) ?? [])), ...unplacedAll];
    // Header counts follow the Kanban feed (`includeOrphanSubtasks`): a card is a
    // board card when it has no parent or its parent is no longer open; grouping
    // parents are board cards too, they only stay out of progress and activity.
    const openCards = everything.filter((c) => c.status !== "done");
    const openIds = new Set(openCards.map((c) => c.id));
    const isBoardCard = (c: { parentTaskId?: string | null }) => !c.parentTaskId || !openIds.has(c.parentTaskId);
    const needsYou = (byProject.get(pid) ?? [])
      .map((t) => needOf(t, commentsOf.get(t.id) ?? []))
      .filter((x): x is PlanNeed => !!x);
    return {
      projectId: pid, name: projectNames.get(pid)?.name ?? pid, path: projectNames.get(pid)?.path ?? null,
      openCount: openCards.filter(isBoardCard).length,
      openSubCount: openCards.filter((c) => !isBoardCard(c)).length,
      progress: progressOf(everything), activity: activityOf(everything), needsYou, areas: projectAreas,
      unplaced: { progress: progressOf(unplacedAll), tasks: unplacedByProject.get(pid) ?? [] },
    };
  });
  // A project with nothing open and no plan of its own is history: it stays out
  // unless done cards were asked for. Order: projects with something waiting
  // for the person first (that is why one opens the view), then projects at
  // work, then those with a plan of their own, then by open work.
  const projects = built
    .filter((p) => includeDone || p.openCount + p.openSubCount > 0 || p.areas.length > 0)
    .sort((a, b) => Number(b.needsYou.length > 0) - Number(a.needsYou.length > 0)
      || Number(b.activity.state === "working") - Number(a.activity.state === "working")
      || Number(b.areas.length > 0) - Number(a.areas.length > 0) || b.openCount - a.openCount || a.name.localeCompare(b.name));
  return { projects, includeDone };
}

// ---------- writes ----------

export class PlanError extends Error {
  constructor(public code: "not_found" | "invalid_input" | "conflict", message: string) { super(message); }
}
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const text = (v: unknown, field: string, required = false): string | null => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new PlanError("invalid_input", `${field} is required`);
    return null;
  }
  if (typeof v !== "string") throw new PlanError("invalid_input", `${field} must be a string`);
  return v.trim() || (required ? (() => { throw new PlanError("invalid_input", `${field} is required`); })() : null);
};
const nextPos = (db: Database, table: string, col: string, id: string): number =>
  ((db.query(`SELECT MAX(position) AS m FROM ${table} WHERE ${col} = ?`).get(id) as { m: number | null }).m ?? -1) + 1;

export function createArea(db: Database, input: { projectId?: unknown; name?: unknown }) {
  const projectId = text(input.projectId, "projectId", true)!;
  const name = text(input.name, "name", true)!;
  const id = newId(), t = now();
  db.query(`INSERT INTO plan_areas (id, project_id, name, position, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(id, projectId, name, nextPos(db, "plan_areas", "project_id", projectId), t, t);
  return db.query(`SELECT * FROM plan_areas WHERE id = ?`).get(id);
}

export function updateArea(db: Database, id: string, input: { name?: unknown; position?: unknown }) {
  const row = db.query(`SELECT * FROM plan_areas WHERE id = ?`).get(id) as { name: string; position: number } | null;
  if (!row) throw new PlanError("not_found", "area not found");
  const name = input.name === undefined ? row.name : text(input.name, "name", true)!;
  const position = typeof input.position === "number" ? input.position : row.position;
  db.query(`UPDATE plan_areas SET name = ?, position = ?, updated_at = ? WHERE id = ?`).run(name, position, now(), id);
  return db.query(`SELECT * FROM plan_areas WHERE id = ?`).get(id);
}

/** Deletes the area and its milestones (CASCADE): cards are unlinked, never deleted. */
export function deleteArea(db: Database, id: string): void {
  if (!db.query(`SELECT 1 FROM plan_areas WHERE id = ?`).get(id)) throw new PlanError("not_found", "area not found");
  db.query(`DELETE FROM plan_areas WHERE id = ?`).run(id);
}

const MILESTONE_STATUS = ["open", "done", "dropped"];
export function createMilestone(db: Database, input: Record<string, unknown>) {
  const areaId = text(input.areaId, "areaId", true)!;
  if (!db.query(`SELECT 1 FROM plan_areas WHERE id = ?`).get(areaId)) throw new PlanError("not_found", "area not found");
  const title = text(input.title, "title", true)!;
  const id = newId(), t = now();
  db.query(`INSERT INTO plan_milestones (id, area_id, title, expected_result, completion_criteria, owner, target_date, position, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, areaId, title, text(input.expectedResult, "expectedResult"), text(input.completionCriteria, "completionCriteria"),
      text(input.owner, "owner"), text(input.targetDate, "targetDate"), nextPos(db, "plan_milestones", "area_id", areaId), t, t);
  return db.query(`SELECT * FROM plan_milestones WHERE id = ?`).get(id);
}

export function updateMilestone(db: Database, id: string, input: Record<string, unknown>) {
  const row = db.query(`SELECT * FROM plan_milestones WHERE id = ?`).get(id) as (MilestoneRow & Record<string, string | number | null>) | null;
  if (!row) throw new PlanError("not_found", "milestone not found");
  const pick = (key: string, col: string, required = false) =>
    key in input ? text(input[key], key, required) : row[col];
  const status = "status" in input ? String(input.status) : row.status;
  if (!MILESTONE_STATUS.includes(status)) throw new PlanError("invalid_input", "invalid status");
  let areaId = row.area_id;
  if (typeof input.areaId === "string" && input.areaId !== row.area_id) {
    const from = db.query(`SELECT project_id FROM plan_areas WHERE id = ?`).get(row.area_id) as { project_id: string } | null;
    const to = db.query(`SELECT project_id FROM plan_areas WHERE id = ?`).get(input.areaId) as { project_id: string } | null;
    if (!to) throw new PlanError("not_found", "area not found");
    if (to.project_id !== from?.project_id) throw new PlanError("invalid_input", "area belongs to another project");
    areaId = input.areaId;
  }
  db.query(`UPDATE plan_milestones SET title=?, expected_result=?, completion_criteria=?, owner=?, target_date=?, status=?, area_id=?, position=?, updated_at=? WHERE id=?`)
    .run(pick("title", "title", true), pick("expectedResult", "expected_result"), pick("completionCriteria", "completion_criteria"),
      pick("owner", "owner"), pick("targetDate", "target_date"), status, areaId,
      typeof input.position === "number" ? input.position : row.position, now(), id);
  return db.query(`SELECT * FROM plan_milestones WHERE id = ?`).get(id);
}

export function deleteMilestone(db: Database, id: string): void {
  if (!db.query(`SELECT 1 FROM plan_milestones WHERE id = ?`).get(id)) throw new PlanError("not_found", "milestone not found");
  db.query(`DELETE FROM plan_milestones WHERE id = ?`).run(id);
}

/** Links (or moves) a card to a milestone of the SAME project. One card, one milestone. */
export function linkTask(db: Database, taskId: string, milestoneId: unknown): void {
  if (typeof milestoneId !== "string" || !milestoneId) throw new PlanError("invalid_input", "milestoneId is required");
  const task = db.query(`SELECT project_id FROM tasks WHERE id = ?`).get(taskId) as { project_id: string } | null;
  if (!task) throw new PlanError("not_found", "task not found");
  const m = db.query(
    `SELECT a.project_id FROM plan_milestones m JOIN plan_areas a ON a.id = m.area_id WHERE m.id = ?`,
  ).get(milestoneId) as { project_id: string } | null;
  if (!m) throw new PlanError("not_found", "milestone not found");
  if (m.project_id !== task.project_id) throw new PlanError("invalid_input", "milestone belongs to another project");
  db.query(`INSERT INTO plan_task_links (task_id, milestone_id, created_at) VALUES (?,?,?)
            ON CONFLICT(task_id) DO UPDATE SET milestone_id = excluded.milestone_id`).run(taskId, milestoneId, now());
}

export function unlinkTask(db: Database, taskId: string): void {
  db.query(`DELETE FROM plan_task_links WHERE task_id = ?`).run(taskId);
}

export function addSource(db: Database, input: Record<string, unknown>) {
  const taskId = text(input.taskId, "taskId");
  const milestoneId = text(input.milestoneId, "milestoneId");
  if (!taskId === !milestoneId) throw new PlanError("invalid_input", "exactly one of taskId or milestoneId is required");
  const kind = String(input.kind ?? "");
  if (!(PLAN_SOURCE_KINDS as readonly string[]).includes(kind)) throw new PlanError("invalid_input", "invalid kind");
  const label = text(input.label, "label", true)!;
  if (taskId && !db.query(`SELECT 1 FROM tasks WHERE id = ?`).get(taskId)) throw new PlanError("not_found", "task not found");
  if (milestoneId && !db.query(`SELECT 1 FROM plan_milestones WHERE id = ?`).get(milestoneId)) throw new PlanError("not_found", "milestone not found");
  const id = newId();
  db.query(`INSERT INTO plan_sources (id, task_id, milestone_id, kind, label, url, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, taskId, milestoneId, kind, label, text(input.url, "url"), now());
  return db.query(`SELECT * FROM plan_sources WHERE id = ?`).get(id);
}

export function deleteSource(db: Database, id: string): void {
  if (!db.query(`SELECT 1 FROM plan_sources WHERE id = ?`).get(id)) throw new PlanError("not_found", "source not found");
  db.query(`DELETE FROM plan_sources WHERE id = ?`).run(id);
}
