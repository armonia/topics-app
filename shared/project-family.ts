/**
 * PROJECT FAMILIES: a project can sit under another one («parent») and either
 * share its board (`accorpa`) or keep its own (`separa`).
 *
 * Why it exists: one repository often has sibling checkouts that were each
 * registered as a project (a worktree opened by itself, a module repo that is
 * part of a bigger product). Their cards and chats belong together on one board
 * and under one sidebar entry, but the cards keep the `project_id` they were
 * born with: nothing in `tasks` is rewritten, the parent's board simply reads a
 * wider set of ids.
 *
 * Everything here is pure and works on BOARD ids (`projectIdForPath(path)`), the
 * identity the tasks table and the client use. The database rows carry their own
 * `projects.id`; `FamilyRow` holds both, so the server translates once and the
 * client never needs the row id.
 *
 * The family is exactly one level deep, like the organisation tree: a parent
 * has children, a child has no children. That is what keeps the board filter a
 * flat list and rules out cycles without a graph walk.
 */
import { projectIdForPath } from "./board";

export const MERGE_MODES = ["accorpa", "separa"] as const;
export type MergeMode = (typeof MERGE_MODES)[number];

export function isMergeMode(v: unknown): v is MergeMode {
  return typeof v === "string" && (MERGE_MODES as readonly string[]).includes(v);
}

/** What the family logic needs from a `projects` row. */
export interface FamilyRow {
  /** `projects.id`. */
  id: string;
  path: string;
  /** `projects.id` of the parent, null for a top-level project. */
  parentId: string | null;
  mergeMode: MergeMode;
  archived?: boolean;
  name?: string;
}

/** The board id of a row (the key tasks are filed under). */
export function boardIdOfRow(row: Pick<FamilyRow, "path">): string {
  return projectIdForPath(row.path.replace(/[\\/]+$/, ""));
}

/**
 * The board ids a parent board shows: its own, then every child that is merged
 * into it. A child, or an unknown id, answers with itself alone, so the caller
 * can use the result as a filter without asking first whether the id is a parent.
 */
export function mergedBoardIds(rows: readonly FamilyRow[], boardId: string): string[] {
  const parent = rows.find((r) => !r.archived && boardIdOfRow(r) === boardId);
  if (!parent) return [boardId];
  const ids = [boardId];
  for (const r of rows) {
    if (r.parentId !== parent.id || r.mergeMode !== "accorpa" || r.archived) continue;
    const id = boardIdOfRow(r);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The board id whose settings a project falls back on: its parent's, when it is
 * merged (`accorpa`) under a live one. null for everyone else (no parent, `separa`,
 * archived or missing parent), who keep only their own.
 */
export function inheritedSettingsBoardId(rows: readonly FamilyRow[], boardId: string): string | null {
  const child = rows.find((r) => !r.archived && boardIdOfRow(r) === boardId);
  if (!child || !child.parentId || child.mergeMode !== "accorpa") return null;
  const parent = rows.find((r) => r.id === child.parentId && !r.archived);
  return parent ? boardIdOfRow(parent) : null;
}

/** One link of the family, in board ids: what the client needs to draw a merged lane. */
export interface BoardFamilyLink {
  /** Board id of the child. */
  projectId: string;
  /** Board id of the parent. */
  parentProjectId: string;
  mode: MergeMode;
  /** Row ids, for the PATCH that changes the link. */
  rowId: string;
  parentRowId: string;
}

/** Every child with a live parent, as board ids. Archived rows and dangling parents are left out. */
export function familyLinks(rows: readonly FamilyRow[]): BoardFamilyLink[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: BoardFamilyLink[] = [];
  for (const r of rows) {
    if (!r.parentId || r.archived) continue;
    const parent = byId.get(r.parentId);
    if (!parent || parent.archived) continue;
    out.push({
      projectId: boardIdOfRow(r),
      parentProjectId: boardIdOfRow(parent),
      mode: r.mergeMode,
      rowId: r.id,
      parentRowId: parent.id,
    });
  }
  return out;
}

/** Child board id → parent board id, only for the links that merge. */
export function mergedParentMap(links: readonly Pick<BoardFamilyLink, "projectId" | "parentProjectId" | "mode">[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of links) if (l.mode === "accorpa") map.set(l.projectId, l.parentProjectId);
  return map;
}

/**
 * THE SINGLE LABEL for a project, in one place. A child merged (`accorpa`)
 * into a live parent reads as the parent AND the child («Sito Armonia ·
 * Nuvola»): the parent says which product it belongs to, the child still says
 * where the agent actually works. Everyone else — a separated project, a
 * top-level one, an unknown id — reads as just its own name.
 *
 * Pure: `nameOf` is the caller's own name resolver (the client reads its
 * project index, the server reads `buildProjectNames`), so this holds no
 * network state and works on both sides.
 */
export interface ProjectFamilyLabel {
  /** The parent's name, only when the project is merged into one. */
  parent: string | null;
  child: string;
}

export function projectFamilyLabel(
  projectId: string,
  parentOf: ReadonlyMap<string, string>,
  nameOf: (id: string) => string,
): ProjectFamilyLabel {
  const parentId = parentOf.get(projectId);
  return parentId ? { parent: nameOf(parentId), child: nameOf(projectId) } : { parent: null, child: nameOf(projectId) };
}

/** `projectFamilyLabel`, flattened to the one-line text every non-visual surface needs. */
export function formatProjectFamilyLabel(label: ProjectFamilyLabel): string {
  return label.parent ? `${label.parent} · ${label.child}` : label.child;
}

export type ParentRefusal =
  | "unknown_project"
  | "unknown_parent"
  | "self"
  | "parent_is_child"
  | "has_children"
  | "same_path";

/**
 * Why `childId` cannot be put under `parentId`, or null when it can. Both are
 * `projects.id`. `parentId === null` (becoming top-level again) is always fine.
 */
export function refuseParent(rows: readonly FamilyRow[], childId: string, parentId: string | null): ParentRefusal | null {
  const child = rows.find((r) => r.id === childId);
  if (!child) return "unknown_project";
  if (parentId === null) return null;
  if (parentId === childId) return "self";
  const parent = rows.find((r) => r.id === parentId);
  if (!parent) return "unknown_parent";
  if (parent.parentId) return "parent_is_child";
  if (rows.some((r) => r.parentId === childId)) return "has_children";
  if (boardIdOfRow(parent) === boardIdOfRow(child)) return "same_path";
  return null;
}

// ── Suggestions ──────────────────────────────────────────────────────────────

const lastSegment = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
const parentFolder = (path: string): string => path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
const firstToken = (name: string): string => name.toLowerCase().split(/[-_. ]/)[0] ?? "";

/**
 * How likely `candidate` is the project `child` belongs with, from the two
 * hints a person would use: the same name prefix (`site` / `site-modules`)
 * and the same containing folder. 0 = no hint.
 */
export function siblingScore(child: Pick<FamilyRow, "path">, candidate: Pick<FamilyRow, "path">): number {
  const a = lastSegment(child.path).toLowerCase();
  const b = lastSegment(candidate.path).toLowerCase();
  let score = 0;
  const prefixed = (long: string, short: string) => short.length > 1 && long.startsWith(short) && /[-_. ]/.test(long.charAt(short.length));
  if (prefixed(a, b) || prefixed(b, a)) score += 4;
  else if (firstToken(a).length > 2 && firstToken(a) === firstToken(b)) score += 2;
  if (parentFolder(child.path) !== "" && parentFolder(child.path) === parentFolder(candidate.path)) score += 1;
  return score;
}

/**
 * The projects worth offering as a parent for `childId`, best first: only those
 * that can really be one (top level, live, not itself) and show at least one
 * sibling hint. The rest of the live projects are still choosable, just not
 * suggested.
 */
export function suggestParents(rows: readonly FamilyRow[], childId: string): FamilyRow[] {
  const child = rows.find((r) => r.id === childId);
  if (!child) return [];
  return rows
    .filter((r) => r.id !== childId && !r.archived && refuseParent(rows, childId, r.id) === null)
    .map((r) => ({ r, s: siblingScore(child, r) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s || (x.r.name ?? x.r.path).localeCompare(y.r.name ?? y.r.path))
    .map((x) => x.r);
}

/** Every project that can be picked as a parent of `childId`, suggestions first. */
export function parentChoices(rows: readonly FamilyRow[], childId: string): { suggested: FamilyRow[]; others: FamilyRow[] } {
  const suggested = suggestParents(rows, childId);
  const pickedIds = new Set(suggested.map((r) => r.id));
  const others = rows
    .filter((r) => r.id !== childId && !r.archived && !pickedIds.has(r.id) && refuseParent(rows, childId, r.id) === null)
    .sort((x, y) => (x.name ?? x.path).localeCompare(y.name ?? y.path));
  return { suggested, others };
}
