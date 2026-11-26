/**
 * Reads the `projects` table as `FamilyRow`s for the pure family logic in
 * `shared/project-family.ts`. Tolerant on purpose: a database without the table
 * (a test bench) or without the family columns (a schema older than the accorpa /
 * separa migration) answers with no family, which is the same as "every project
 * stands alone".
 */
import type { Database } from "bun:sqlite";
import { isMergeMode, type FamilyRow } from "../../shared/project-family";

interface RawRow {
  id: string;
  name: string | null;
  path: string;
  archived: number | null;
  parent_id: string | null;
  merge_mode: string | null;
}

export function loadFamilyRows(db: Database): FamilyRow[] {
  let rows: RawRow[];
  try {
    rows = db.query("SELECT id, name, path, archived, parent_id, merge_mode FROM projects").all() as RawRow[];
  } catch {
    // Table or columns missing: nobody has a parent.
    return [];
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? undefined,
    path: r.path,
    archived: r.archived === 1,
    parentId: r.parent_id ?? null,
    mergeMode: isMergeMode(r.merge_mode) ? r.merge_mode : "accorpa",
  }));
}
