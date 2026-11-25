/** @covers AGENTS-NAV-01 */
import { describe, expect, test } from "bun:test";
import { agentsRouteFromHash, agentsRouteToHash } from "./agentsNav";

describe("agentsRouteToHash / agentsRouteFromHash", () => {
  test("round-trips the overview", () => {
    expect(agentsRouteToHash({ view: "overview" })).toBe("#agenti");
    expect(agentsRouteFromHash("#agenti")).toEqual({ view: "overview" });
    expect(agentsRouteFromHash("")).toBeNull();
  });

  test("round-trips an agent's Attività (the default)", () => {
    const route = { view: "agent", agentId: "main", tab: "activity" } as const;
    expect(agentsRouteToHash(route)).toBe("#agenti/main");
    expect(agentsRouteFromHash("#agenti/main")).toEqual(route);
  });

  test("round-trips a Configure section, surviving a reload", () => {
    const route = { view: "agent", agentId: "main", tab: "configure", section: "identity" } as const;
    expect(agentsRouteToHash(route)).toBe("#agenti/main/configura/identity");
    expect(agentsRouteFromHash("#agenti/main/configura/identity")).toEqual(route);
  });

  test("an agent id with slashes or spaces round-trips through encoding", () => {
    const route = { view: "agent", agentId: "a b/c", tab: "activity" } as const;
    expect(agentsRouteFromHash(agentsRouteToHash(route))).toEqual(route);
  });

  test("a hash outside #agenti resolves to nothing", () => {
    expect(agentsRouteFromHash("#tab/xyz")).toBeNull();
  });
});
