/**
 * A stringified missing project ("null") must not give birth to a card on a board nobody reads
 * (card a5906c31: the intake composer sent `/boards/null/tasks`).
 */
import { test, expect } from "bun:test";
import { TaskServiceError } from "./tasks";
import { freshDb, svc, PID } from "./tasks-test-db";

test("create refuses a project id that is a stringified null", () => {
  const s = svc(freshDb());
  for (const bad of ["null", "undefined", " NULL "]) {
    expect(() => s.create({ projectId: bad, text: "stray" })).toThrow(TaskServiceError);
  }
  expect(s.create({ projectId: PID, text: "fine" }).projectId).toBe(PID);
});
