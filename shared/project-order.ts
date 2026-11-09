/**
 * THE ORDER OF PROJECT GROUPS, decided in one place.
 *
 * The Kanban lanes (client) and the Plan tiles (server, `services/plan.ts`) list
 * projects with this one function, so a project is found in the same place in
 * both views. The rule, asked for in #614: a project with something waiting for
 * the person comes first (that is why one opens the board), then every project
 * by name, ties on the id.
 *
 * Not by size and not by activity: a group that jumps up the board every time
 * one of its cards is created is a group nobody finds twice in the same place.
 * «Waiting» is the one thing allowed to move a group, and it is the person's
 * own call to action.
 */

/** A fixed locale: the server and every browser must agree on the order. */
const BY_NAME = new Intl.Collator("en", { sensitivity: "base" });

export interface ProjectOrderKey {
  projectId: string;
  name: string;
  /** Something in this project waits for the person (`waitOnPerson`, shared/waits-on-person.ts). */
  waiting: boolean;
}

export function compareProjectGroups(a: ProjectOrderKey, b: ProjectOrderKey): number {
  if (a.waiting !== b.waiting) return a.waiting ? -1 : 1;
  return BY_NAME.compare(a.name, b.name) || (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0);
}

/** A sorted copy; `nameOf` and `waitsOf` read the group, the caller keeps its own shape. */
export function sortProjectGroups<T extends { projectId: string }>(
  groups: readonly T[],
  nameOf: (group: T) => string,
  waitsOf: (group: T) => boolean,
): T[] {
  return groups
    .map((group) => ({ group, key: { projectId: group.projectId, name: nameOf(group), waiting: waitsOf(group) } }))
    .sort((a, b) => compareProjectGroups(a.key, b.key))
    .map((entry) => entry.group);
}
