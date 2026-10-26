/**
 * A card carries its BOARD id, the project store wants the UUID: the node lane
 * resolves the checkout from either, or a card created on the board would find
 * no repository to plant its branch in.
 *
 * @covers KANBAN-76
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { projectIdForPath } from "../../shared/board";
import { projectPathOfAnyId } from "./project-identity";

describe("projectPathOfAnyId", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT)");
  db.query("INSERT INTO projects (id, path) VALUES (?, ?)").run("3f1c-uuid", "/Users/a/Projects/winfleet");
  const paths = new Map([["3f1c-uuid", "/Users/a/Projects/winfleet"]]);
  const getPath = (id: string) => paths.get(id) ?? null;

  test("a card's board id finds the checkout (the remote lane asks with this one)", () => {
    const boardId = projectIdForPath("/Users/a/Projects/winfleet");
    expect(boardId).not.toBe("3f1c-uuid");
    expect(projectPathOfAnyId(db, getPath, boardId)).toBe("/Users/a/Projects/winfleet");
  });

  test("the store id still works", () => {
    expect(projectPathOfAnyId(db, getPath, "3f1c-uuid")).toBe("/Users/a/Projects/winfleet");
  });

  test("an unknown id has no checkout", () => {
    expect(projectPathOfAnyId(db, getPath, "nessuno-xyz")).toBeNull();
  });
});
