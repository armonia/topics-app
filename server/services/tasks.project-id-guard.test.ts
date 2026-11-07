/**
 * A stringified missing project ("null") must not give birth to a card on a board nobody reads
 * (card a5906c31: the intake composer sent `/boards/null/tasks`).
 *
 * @covers KANBAN-106
 */
import { test, expect } from "bun:test";
import { TaskServiceError, createTaskService, projectIdForPath } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";

test("create refuses a project id that is a stringified null", () => {
  const s = svc(freshDb());
  for (const bad of ["null", "undefined", " NULL "]) {
    expect(() => s.create({ projectId: bad, text: "stray" })).toThrow(TaskServiceError);
  }
  expect(s.create({ projectId: PID, text: "fine" }).projectId).toBe(PID);
});

test("create refuses a board that no project owns when the host lists its projects", () => {
  const dir = "/work/real-project";
  const s = createTaskService(freshDb(), { listRepoRoots: () => [dir], requireKnownBoard: true });
  for (const bad of ["no-such-board-xyz", "None", "[object Object]"]) {
    expect(() => s.create({ projectId: bad, text: "stray" })).toThrow(TaskServiceError);
  }
  expect(s.create({ projectId: projectIdForPath(dir), text: "fine" }).text).toBe("fine");
});
