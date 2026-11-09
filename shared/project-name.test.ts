/**
 * The name of a project nobody registered: one function for the Kanban lanes
 * and the Plan tiles.
 *
 * @covers KANBAN-106
 */
import { describe, expect, test } from "bun:test";
import { UNKNOWN_PROJECT_NAME, projectNameFromId, unregisteredProjectName } from "./project-name";

describe("projectNameFromId", () => {
  test("an id that is a path is named by its folder", () => {
    expect(projectNameFromId("/Users/x/.openclaw/workspace/topics-app")).toBe("topics-app");
    expect(projectNameFromId("/Users/x/Projects/topics-app/")).toBe("topics-app");
    expect(projectNameFromId("C:\\Users\\x\\Projects\\quadra")).toBe("quadra");
    expect(projectNameFromId("/")).toBeNull();
  });

  test("a board slug loses its hash, a name with dashes keeps them", () => {
    expect(projectNameFromId("acquapub-oz86j7")).toBe("acquapub");
    expect(projectNameFromId("armonia-site-rr0tuo")).toBe("armonia-site");
    expect(projectNameFromId("fase2-i18n-unit-pts9bf")).toBe("fase2-i18n-unit");
  });

  test("an UUID has no name inside", () => {
    expect(projectNameFromId("405fbb0d-6fdd-4874-b52d-ce96180f9e2a")).toBeNull();
    expect(projectNameFromId("D9F1A2B3-0000-4C1D-8E2F-1234567890AB")).toBeNull();
  });
});

describe("unregisteredProjectName", () => {
  test("the name when there is one, the sentence when the id is a code", () => {
    expect(unregisteredProjectName("/Users/x/.openclaw/workspace/topics-app")).toBe("topics-app");
    expect(unregisteredProjectName("quadra-lh40qh")).toBe("quadra");
    expect(unregisteredProjectName("405fbb0d-6fdd-4874-b52d-ce96180f9e2a")).toBe(UNKNOWN_PROJECT_NAME);
  });
});
