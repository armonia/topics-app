// @covers AGENTS-TOOLS-01
import { describe, expect, test } from "bun:test";
import {
  ALL_TOOLS_FILTER,
  filterByName,
  filterMcpToolSpecsForAgent,
  parseAgentToolFilter,
  resolveAgentToolFilter,
  turnToolSpecsFor,
} from "./tool-filter";
import { resolveAgentIdForWorkspace, type AgentRecord } from "./registry";
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

describe("filterByName", () => {
  test("'all' keeps everything, in catalog order", () => {
    expect(filterByName(ALL_TOOLS_FILTER, [{ name: "kept" }, { name: "dropped" }])).toEqual([{ name: "kept" }, { name: "dropped" }]);
  });

  test("'selected' drops everything not named", () => {
    const filter = { mode: "selected" as const, servers: ["kept"] };
    expect(filterByName(filter, [{ name: "kept" }, { name: "dropped" }])).toEqual([{ name: "kept" }]);
  });
});

describe("filterMcpToolSpecsForAgent", () => {
  const specs = [{ name: "mcp__kept__do" }, { name: "mcp__dropped__do" }];

  test("THE BARRA (AGENTS-TOOLS-01): an agent with 'selected' and a kept server gets only that server's specs", () => {
    const kept = filterMcpToolSpecsForAgent("jarvis", settings({ jarvis: { mode: "selected", servers: ["kept"] } }), TWO_SERVER_FLEET, specs);
    expect(kept).toEqual([{ name: "mcp__kept__do" }]);
  });

  test("an agent with no filter gets every spec", () => {
    expect(filterMcpToolSpecsForAgent("jarvis", settings(), TWO_SERVER_FLEET, specs)).toEqual(specs);
  });

  test("no agent id gets every spec, same as no filter", () => {
    expect(filterMcpToolSpecsForAgent(null, settings({ jarvis: { mode: "selected", servers: ["kept"] } }), TWO_SERVER_FLEET, specs)).toEqual(specs);
  });
});

describe("resolveAgentIdForWorkspace", () => {
  const agents: AgentRecord[] = [{ id: "jarvis", name: "Jarvis", job: "", workspace: "/home/x/jarvis" }];

  test("a workspace matching an agent's folder gives that agent's id", () => {
    expect(resolveAgentIdForWorkspace("/home/x/jarvis", agents)).toBe("jarvis");
  });

  test("a trailing slash on either side makes no difference", () => {
    expect(resolveAgentIdForWorkspace("/home/x/jarvis/", agents)).toBe("jarvis");
  });

  test("a folder that is nobody's agent workspace gives null", () => {
    expect(resolveAgentIdForWorkspace("/home/x/not-an-agent", agents)).toBeNull();
  });

  test("no workspace at all gives null", () => {
    expect(resolveAgentIdForWorkspace(null, agents)).toBeNull();
  });
});

describe("turnToolSpecsFor — the one function the turn and the catalog share", () => {
  const agents: AgentRecord[] = [{ id: "jarvis", name: "Jarvis", job: "", workspace: "/home/x/jarvis" }];
  const specs = [{ name: "mcp__kept__do" }, { name: "mcp__dropped__do" }];

  test("THE BARRA (AGENTS-TOOLS-01): a topic whose workspace is a limited agent's folder gets only its kept server", () => {
    const result = turnToolSpecsFor(
      "/home/x/jarvis",
      agents,
      settings({ jarvis: { mode: "selected", servers: ["kept"] } }),
      TWO_SERVER_FLEET,
      specs,
    );
    expect(result).toEqual([{ name: "mcp__kept__do" }]);
  });

  test("an ordinary topic, not any agent's own folder, gets the whole fleet", () => {
    const result = turnToolSpecsFor(
      "/home/x/some-project",
      agents,
      settings({ jarvis: { mode: "selected", servers: ["kept"] } }),
      TWO_SERVER_FLEET,
      specs,
    );
    expect(result).toEqual(specs);
  });

  test("no workspace at all gets the whole fleet", () => {
    expect(turnToolSpecsFor(null, agents, settings({ jarvis: { mode: "selected", servers: ["kept"] } }), TWO_SERVER_FLEET, specs)).toEqual(specs);
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
