/**
 * The one order of project groups, for the Kanban lanes and the Plan tiles.
 *
 * @covers KANBAN-107
 */
import { describe, expect, test } from "bun:test";
import { compareProjectGroups, sortProjectGroups } from "./project-order";

type Group = { projectId: string; name: string; waiting?: boolean };
const order = (groups: Group[]) =>
  sortProjectGroups(groups, (g) => g.name, (g) => !!g.waiting).map((g) => g.projectId);

describe("sortProjectGroups", () => {
  test("by name ignoring case and accents of the letter, ties on the id", () => {
    expect(order([{ projectId: "z", name: "zeta" }, { projectId: "b", name: "Alfa" }, { projectId: "a", name: "alfa" }]))
      .toEqual(["a", "b", "z"]);
    expect(order([{ projectId: "x", name: "Èlla" }, { projectId: "y", name: "Ella" }, { projectId: "w", name: "Dora" }]))
      .toEqual(["w", "x", "y"]);
  });

  test("a project waiting for the person comes first, whatever its name", () => {
    expect(order([
      { projectId: "a", name: "alfa" },
      { projectId: "z", name: "zeta", waiting: true },
      { projectId: "m", name: "mu" },
    ])).toEqual(["z", "a", "m"]);
  });

  test("the waiting ones are told apart by name, then by id, like everyone else", () => {
    expect(order([
      { projectId: "z", name: "zeta", waiting: true },
      { projectId: "b", name: "alfa", waiting: true },
      { projectId: "a", name: "Alfa", waiting: true },
      { projectId: "q", name: "beta" },
    ])).toEqual(["a", "b", "z", "q"]);
  });

  test("the input is not reordered in place, and the same input always gives the same order", () => {
    const groups: Group[] = [{ projectId: "z", name: "zeta" }, { projectId: "b", name: "Alfa", waiting: true }, { projectId: "a", name: "alfa" }];
    const first = order(groups);
    expect(groups.map((g) => g.projectId)).toEqual(["z", "b", "a"]);
    expect(order([...groups].reverse())).toEqual(first);
  });

  test("compareProjectGroups is the same rule on bare keys", () => {
    const a = { projectId: "a", name: "alfa", waiting: false };
    const b = { projectId: "b", name: "alfa", waiting: false };
    const w = { projectId: "w", name: "zeta", waiting: true };
    expect(compareProjectGroups(a, b)).toBeLessThan(0);
    expect(compareProjectGroups(b, a)).toBeGreaterThan(0);
    expect(compareProjectGroups(w, a)).toBeLessThan(0);
    expect(compareProjectGroups(a, a)).toBe(0);
  });
});
