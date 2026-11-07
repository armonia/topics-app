/**
 * The Plan: Project -> Area -> Milestone -> Card -> Sources, over the board.
 *
 * No card is copied: the card stays the truth about its status, the plan only
 * says which result it serves. Counts, progress and signals are COMPUTED on
 * every read and never stored (a stored value goes stale, a computed one cannot).
 */
import type { Database } from "bun:sqlite";
import { projectIdForPath } from "../../shared/board";
import { findDuplicateGroups } from "../../shared/task-similarity";
import {
  PLAN_SOURCE_KINDS,
  type PlanArea, type PlanCard, type PlanCounts, type PlanMilestone, type PlanProgress,
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
  id: string; project_id: string; text: string; status: string;
  assigned_topic_id: string | null; origin_topic_id: string | null;
  delivery_branch: string | null; delivery_commit: string | null; checks_state: string | null;
  updated_at: string; created_at: string;
}

export function countCards(cards: readonly { status: string }[]): PlanCounts {
  const byStatus: Record<string, number> = {};
  for (const c of cards) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  return { total: cards.length, done: byStatus.done ?? 0, byStatus };
}

function progressOf(cards: readonly { status: string }[]): PlanProgress {
  const c = countCards(cards);
  return { ...c, ratio: c.total === 0 ? 0 : c.done / c.total };
}

/** Signals of ONE card, except duplicate (it needs the comparison with the others). */
export function cardSignals(
  t: Pick<TaskRow, "status" | "assigned_topic_id" | "delivery_branch" | "delivery_commit" | "updated_at">,
  ownerOfMilestone: string | null,
  nowMs: number,
): PlanSignal[] {
  const out: PlanSignal[] = [];
  const open = t.status !== "done";
  if (open && (t.delivery_branch || t.delivery_commit)) out.push("delivered_but_open");
  if (open && !t.assigned_topic_id && !ownerOfMilestone) out.push("no_owner");
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
  opts: { projectId?: string; includeDone?: boolean; now?: number } = {},
): PlanTree {
  const nowMs = opts.now ?? Date.now();
  const includeDone = !!opts.includeDone;
  const where = opts.projectId ? "AND project_id = ?" : "";
  const params = opts.projectId ? [opts.projectId] : [];

  const tasks = db.query(
    `SELECT id, project_id, text, status, assigned_topic_id, origin_topic_id, delivery_branch,
            delivery_commit, checks_state, updated_at, created_at
       FROM tasks WHERE archived = 0 ${where}`,
  ).all(...params) as TaskRow[];
  const areas = db.query(
    `SELECT id, project_id, name, position FROM plan_areas ${opts.projectId ? "WHERE project_id = ?" : ""} ORDER BY position, created_at`,
  ).all(...params) as { id: string; project_id: string; name: string; position: number }[];
  const milestones = db.query(
    `SELECT * FROM plan_milestones ORDER BY position, created_at`,
  ).all() as MilestoneRow[];
  const links = db.query(`SELECT task_id, milestone_id FROM plan_task_links`).all() as { task_id: string; milestone_id: string }[];
  const sources = db.query(`SELECT id, task_id, milestone_id, kind, label, url FROM plan_sources ORDER BY created_at`).all() as SourceRow[];

  let names = new Map<string, string>();
  let paths = new Map<string, string>();
  try {
    // Board ids are path slugs (`quadra-lh40qh`), not `projects.id`: resolve both,
    // or every project shows its slug instead of the name people know.
    const rows = db.query(`SELECT id, name, path FROM projects`).all() as { id: string; name: string; path: string | null }[];
    names = new Map(rows.flatMap((p) => [[p.id, p.name], ...(p.path ? [[projectIdForPath(p.path), p.name]] : [])] as [string, string][]));
    paths = new Map(rows.flatMap((p) => (p.path ? [[p.id, p.path], [projectIdForPath(p.path), p.path]] : []) as [string, string][]));
  } catch { /* projects table absent (test bench): fall back to the id */ }

  const milestoneOf = new Map(links.map((l) => [l.task_id, l.milestone_id]));
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

  const areaOfMilestone = new Map(milestones.map((m) => [m.id, m.area_id]));
  const projectOfArea = new Map(areas.map((a) => [a.id, a.project_id]));

  const toCard = (t: TaskRow): PlanCard => {
    const mid = milestoneOf.get(t.id);
    const owner = mid ? (milestoneById.get(mid)?.owner ?? null) : null;
    const signals = cardSignals(t, owner, nowMs);
    const survivor = dupOf.get(t.id);
    const card: PlanCard = {
      id: t.id, text: t.text, status: t.status, projectId: t.project_id,
      assignedTopicId: t.assigned_topic_id, originTopicId: t.origin_topic_id,
      updatedAt: t.updated_at, signals,
      sources: [...implicitSources(t), ...(srcByTask.get(t.id) ?? [])],
    };
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
  for (const t of tasks) {
    const card = toCard(t);
    const mid = milestoneOf.get(t.id);
    // A link to a milestone of another project does not count: the card stays unplaced.
    const mArea = mid ? areaOfMilestone.get(mid) : undefined;
    const valid = mid && mArea && projectOfArea.get(mArea) === t.project_id;
    const bucketAll = valid ? allByMilestone : allUnplaced;
    const key = valid ? (mid as string) : t.project_id;
    bucketAll.set(key, [...(bucketAll.get(key) ?? []), card]);
    if (visible(card)) {
      const bucket = valid ? cardsByMilestone : unplacedByProject;
      bucket.set(key, [...(bucket.get(key) ?? []), card]);
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
          progress: progressOf(all), signals, sources: srcByMilestone.get(m.id) ?? [], tasks: shown,
        };
      });
      const allCards = ms.flatMap((m) => allByMilestone.get(m.id) ?? []);
      return { id: a.id, projectId: pid, name: a.name, position: a.position, progress: progressOf(allCards), milestones: ms };
    });
    const unplacedAll = allUnplaced.get(pid) ?? [];
    const everything = [...projectAreas.flatMap((a) => a.milestones.flatMap((m) => allByMilestone.get(m.id) ?? [])), ...unplacedAll];
    return {
      projectId: pid, name: names.get(pid) ?? pid, path: paths.get(pid) ?? null,
      openCount: everything.filter((c) => c.status !== "done").length,
      progress: progressOf(everything), areas: projectAreas,
      unplaced: { progress: progressOf(unplacedAll), tasks: unplacedByProject.get(pid) ?? [] },
    };
  });
  // A project with nothing open and no plan of its own is history: it stays out
  // unless done cards were asked for. Projects with a plan come first (that is
  // where the work has been ordered), then by open work, largest first.
  const projects = built
    .filter((p) => includeDone || p.openCount > 0 || p.areas.length > 0)
    .sort((a, b) => Number(b.areas.length > 0) - Number(a.areas.length > 0) || b.openCount - a.openCount || a.name.localeCompare(b.name));
  // Two boards can carry the same project name (`attilio` and `attilio-mn52yh`):
  // without the id the list shows two identical rows and nobody can tell them apart.
  const seenNames = new Map<string, number>();
  for (const p of projects) seenNames.set(p.name, (seenNames.get(p.name) ?? 0) + 1);
  for (const p of projects) if ((seenNames.get(p.name) ?? 0) > 1) p.name = `${p.name} (${p.projectId})`;
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
