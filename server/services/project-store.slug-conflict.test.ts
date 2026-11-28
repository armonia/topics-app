/**
 * Reproduces the real cause of card 79ab687d's empty preview photo: the old
 * preview seed registered a project with a fixed name/slug before creating
 * its topic, and `preview-worktree.ts` never clears its `/tmp/topics-preview-
 * <port>` root between runs on the same port. A second run against that
 * reused data hit the project's unique slug a second time and the insert
 * threw `SlugConflictError` (409) before the topic — and so the deep link —
 * ever existed. `scripts/preview-seed.ts` now registers no project at all;
 * this test keeps the mechanism it removed provable on its own.
 *
 * @covers KANBAN-126
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createProjectStore, SlugConflictError } from "./project-store";

function freshStore() {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
    color TEXT, icon TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    org_id TEXT, owner_person_id TEXT, incognito INTEGER NOT NULL DEFAULT 0,
    parent_id TEXT, merge_mode TEXT
  )`);
  db.run("CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT)");
  return createProjectStore(db);
}

describe("project store, the preview seed's old slug conflict", () => {
  test("registering the same preview project twice (same DATA_DIR, two runs) throws SlugConflictError", () => {
    const store = freshStore();
    const path = "/tmp/topics-preview-3402/example-project"; // allow-shared-tmp: a data value (the real path from card 79ab687d's logs), never written to by this in-memory test
    const slug = store.slugify("Example project");
    store.create({ name: "Example project", slug, path });
    expect(() => store.create({ name: "Example project", slug, path })).toThrow(SlugConflictError);
  });
});
