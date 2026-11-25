/**
 * The read-only check that flags a project whose folder is a linked worktree.
 *
 * @covers WORKTREE-STD-05
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { checkProjectsAgainstWorktrees, readProjectsForCheck } from "./project-worktree-check";

const facts = (top: string, common: string) => () => ({ topLevel: top, commonDir: common });

describe("project-worktree-check", () => {
  it("reads rows without a parent_id column as parentless and skips archived ones", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE projects (id TEXT, slug TEXT, path TEXT, archived INTEGER)");
    db.run("INSERT INTO projects VALUES ('a','a','/nonexistent/a',0), ('b','b','/nonexistent/b',1)");
    expect(readProjectsForCheck(db)).toEqual([{ id: "a", slug: "a", path: "/nonexistent/a", parentId: null }]);
  });

  it("reads parent_id when the column exists", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE projects (id TEXT, slug TEXT, path TEXT, archived INTEGER, parent_id TEXT)");
    db.run("INSERT INTO projects VALUES ('a','a','/nonexistent/a',0,'p')");
    expect(readProjectsForCheck(db)[0]!.parentId).toBe("p");
  });

  it("reports a vanished project under the worktree root as an offender until it has a parent", () => {
    const root = "/nonexistent/root";
    const rows = [{ id: "w", slug: "w", path: `${root}/x/gone`, parentId: null }];
    expect(checkProjectsAgainstWorktrees(rows, { worktreeRoot: root, gitFacts: facts("/x", "/y") }).offenders).toHaveLength(1);
    expect(checkProjectsAgainstWorktrees([{ ...rows[0]!, parentId: "p" }], { worktreeRoot: root }).offenders).toHaveLength(0);
  });
});
