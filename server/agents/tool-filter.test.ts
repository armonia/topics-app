import { describe, expect, test } from "bun:test";
import { ALL_TOOLS_FILTER, allowedNames, filterByName, parseAgentToolFilter, resolveAgentToolFilter } from "./tool-filter";
import { buildAgentToolsInventory } from "../lib/agent-tools";
import type { AgentToolsSettings } from "../../shared/agent-tools";
import type { McpFleetStatus } from "../../shared/session-environment";

function settings(agentFilters: AgentToolsSettings["agentFilters"] = {}): AgentToolsSettings {
  return { extraMcpFiles: [], extraSkillDirs: [], parkedMcp: [], agentFilters };
}

const TWO_SERVER_FLEET: McpFleetStatus = {
  enabled: true,
  mounting: false,
  mounted: true,
  source: "/home/x/.claude.json",
  servers: [
    { name: "kept", transport: "stdio", state: "ready", tools: ["mcp__kept__do"], skills: [] },
    { name: "dropped", transport: "stdio", state: "ready", tools: ["mcp__dropped__do"], skills: [] },
  ],
};

describe("resolveAgentToolFilter", () => {
  test("an agent with no filter gets everything", () => {
    expect(resolveAgentToolFilter("jarvis", settings())).toEqual(ALL_TOOLS_FILTER);
  });

  test("no agent id at all (an unbound turn) gets everything too", () => {
    expect(resolveAgentToolFilter(null, settings({ jarvis: { mode: "selected", servers: ["kept"] } }))).toEqual(ALL_TOOLS_FILTER);
  });

  test("an agent with 'selected' keeps only its own names", () => {
    const filter = resolveAgentToolFilter("jarvis", settings({ jarvis: { mode: "selected", servers: ["kept"] } }));
    expect(filter).toEqual({ mode: "selected", servers: ["kept"] });
  });
});

describe("allowedNames / filterByName", () => {
  test("'all' keeps everything, in catalog order", () => {
    expect(allowedNames(ALL_TOOLS_FILTER, ["kept", "dropped"])).toEqual(["kept", "dropped"]);
  });

  test("'selected' drops everything not named", () => {
    const filter = { mode: "selected" as const, servers: ["kept"] };
    expect(allowedNames(filter, ["kept", "dropped"])).toEqual(["kept"]);
    expect(filterByName(filter, [{ name: "kept" }, { name: "dropped" }])).toEqual([{ name: "kept" }]);
  });
});

describe("parseAgentToolFilter", () => {
  test("rejects an unknown mode", () => {
    expect(() => parseAgentToolFilter({ mode: "some" })).toThrow();
  });

  test("dedupes and drops blank server names", () => {
    expect(parseAgentToolFilter({ mode: "selected", servers: ["a", "a", "", "b"] })).toEqual({ mode: "selected", servers: ["a", "b"] });
  });
});

describe("buildAgentToolsInventory — the catalog shows who uses what", () => {
  test("an agent with no filter is listed against every server", () => {
    const inventory = buildAgentToolsInventory({
      settings: settings(),
      fleet: TWO_SERVER_FLEET,
      clis: [],
      agents: [{ id: "jarvis", name: "Jarvis" }],
    });
    expect(inventory.mcp.map((m) => m.name)).toEqual(["kept", "dropped"]);
    for (const m of inventory.mcp) expect(m.agents).toEqual(["jarvis"]);
  });

  test("an agent with 'selected' appears only next to the server it kept (SYSTEM-02)", () => {
    const inventory = buildAgentToolsInventory({
      settings: settings({ jarvis: { mode: "selected", servers: ["kept"] } }),
      fleet: TWO_SERVER_FLEET,
      clis: [],
      agents: [{ id: "jarvis", name: "Jarvis" }],
    });
    const kept = inventory.mcp.find((m) => m.name === "kept")!;
    const dropped = inventory.mcp.find((m) => m.name === "dropped")!;
    expect(kept.agents).toEqual(["jarvis"]);
    expect(dropped.agents).toEqual([]);
  });
});

describe("buildAgentToolsInventory — what the turn itself receives", () => {
  test("THE BARRA: an agent with 'solo questi' and one server kept gets ONLY that server's tools in its turn", () => {
    const inventory = buildAgentToolsInventory({
      settings: settings({ jarvis: { mode: "selected", servers: ["kept"] } }),
      fleet: TWO_SERVER_FLEET,
      clis: [],
      agentId: "jarvis",
    });
    // A turn that ignored the filter would receive both servers: this is the
    // line a mutation on the filtering code turns red.
    expect(inventory.mcp.map((m) => m.name)).toEqual(["kept"]);
  });

  test("an agent without a filter still receives every server in its turn", () => {
    const inventory = buildAgentToolsInventory({
      settings: settings(),
      fleet: TWO_SERVER_FLEET,
      clis: [],
      agentId: "visione",
    });
    expect(inventory.mcp.map((m) => m.name)).toEqual(["kept", "dropped"]);
  });
});

describe("buildAgentToolsInventory — token weight is measured, not guessed", () => {
  test("an active server's tokens come from its real tool schemas", () => {
    const inventory = buildAgentToolsInventory({
      settings: settings(),
      fleet: TWO_SERVER_FLEET,
      clis: [],
      toolSpecs: [
        { name: "mcp__kept__do", description: "d", input_schema: { type: "object", properties: {} } },
        { name: "mcp__dropped__do", description: "d", input_schema: { type: "object", properties: {} } },
      ],
    });
    const kept = inventory.mcp.find((m) => m.name === "kept")!;
    expect(kept.tokens).toBeGreaterThan(0);
    expect(inventory.tokenWeight.alwaysOn).toBeGreaterThan(0);
  });

  test("a parked server has no measurable tokens", () => {
    const inventory = buildAgentToolsInventory({
      settings: settings(),
      fleet: { ...TWO_SERVER_FLEET, servers: [{ name: "parked", transport: "stdio", state: "excluded", tools: [], skills: [] }] },
      clis: [],
    });
    expect(inventory.mcp[0].tokens).toBeNull();
  });
});
