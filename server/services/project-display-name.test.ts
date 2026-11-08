/**
 * One name per project, for the Kanban index and the Plan alike.
 *
 * @covers KANBAN-106
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { projectIdForPath } from "../../shared/board";
import { buildProjectNames, loadRegisteredProjects, projectDisplayName } from "./project-display-name";

describe("projectDisplayName", () => {
  test("the registered name wins, else the folder name", () => {
    expect(projectDisplayName("/x/Projects/cartella", "Nome vero")).toBe("Nome vero");
    expect(projectDisplayName("/x/Projects/cartella/", "  ")).toBe("cartella");
    expect(projectDisplayName("/x/Projects/cartella", null)).toBe("cartella");
    expect(projectDisplayName(null, null)).toBeNull();
  });
});

describe("buildProjectNames", () => {
  test("a project registered under another name shows that name, found by board id and by row id", () => {
    const map = buildProjectNames([{ id: "row1", name: "Zeta rinominato", path: "/x/alfa" }], ["/x/alfa", "/x/beta"]);
    const alfa = projectIdForPath("/x/alfa");
    expect(map.get(alfa)?.name).toBe("Zeta rinominato");
    expect(map.get("row1")).toBe(map.get(alfa));
    expect(map.get(projectIdForPath("/x/beta"))?.name).toBe("beta");
  });

  test("two different projects with one name are told apart by board id, the same way for every caller", () => {
    const map = buildProjectNames([{ id: "x1", name: "attilio", path: null }, { id: "x2", name: "attilio", path: null }]);
    expect(map.get("x1")?.name).toBe("attilio (x1)");
    expect(map.get("x2")?.name).toBe("attilio (x2)");
    const byFolder = buildProjectNames([], ["/a/app", "/b/app"]);
    expect(byFolder.get(projectIdForPath("/a/app"))?.name).toBe(`app (${projectIdForPath("/a/app")})`);
  });

  test("a registered row and a known dir on one path are one project; an archived twin does not make it a duplicate", () => {
    const map = buildProjectNames([{ id: "r", name: "Uno", path: "/x/uno/" }, { id: "old", name: "Uno", path: "/y/uno", archived: 1 }], ["/x/uno"]);
    expect(map.get(projectIdForPath("/x/uno"))?.name).toBe("Uno");
    expect(map.get(projectIdForPath("/x/uno"))?.path).toBe("/x/uno");
  });
});

describe("loadRegisteredProjects", () => {
  test("a missing table is an empty list, and a table without `archived` still loads", () => {
    const db = new Database(":memory:");
    expect(loadRegisteredProjects(db)).toEqual([]);
    db.run("CREATE TABLE projects (id TEXT, name TEXT, path TEXT)");
    db.run("INSERT INTO projects VALUES ('a', 'A', '/x/a')");
    expect(loadRegisteredProjects(db)).toEqual([{ id: "a", name: "A", path: "/x/a" }]);
  });
});
