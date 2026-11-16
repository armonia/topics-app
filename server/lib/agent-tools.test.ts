/**
 * @covers AGENT-TOOLS-01
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentToolsInventory } from "./agent-tools";

describe("buildAgentToolsInventory", () => {
  test("reads skills and extra MCP files from the given home, and maps fleet states", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-tools-"));
    try {
      mkdirSync(join(home, ".agents", "skills", "demo"), { recursive: true });
      writeFileSync(join(home, ".agents", "skills", "demo", "SKILL.md"), "---\nname: demo-skill\ndescription: A demo\n---\nbody");
      writeFileSync(join(home, "extra.json"), JSON.stringify({ mcpServers: { extra: { type: "http", url: "https://x" } } }));
      const result = buildAgentToolsInventory({
        home,
        settings: { extraMcpFiles: ["~/extra.json"], extraSkillDirs: [], parkedMcp: ["b"] },
        fleet: {
          enabled: true, mounting: false, source: join(home, ".claude.json"),
          servers: [
            { name: "a", transport: "http", state: "ready", tools: ["t1", "t2"], skills: [] },
            { name: "b", transport: "stdio", state: "excluded", tools: [], skills: [], reason: "rule" },
            { name: "c", transport: "http", state: "needs-auth", tools: [], skills: [] },
          ],
        },
        clis: [{ id: "x", name: "X", path: null, installed: false, install: "npm i x" }],
      });
      expect(result.mcp.map((m) => [m.name, m.state])).toEqual([["a", "active"], ["b", "parked"], ["c", "needs-auth"], ["extra", "parked"]]);
      expect(result.mcp[1].parkedByUser).toBe(true);
      expect(result.mcp[0].source).toBe("~/.claude.json");
      expect(result.skills).toEqual([{ name: "demo-skill", description: "A demo", source: "~/.agents/skills" }]);
      expect(result.clis[0].installed).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reads a block-scalar description (|-) as its indented lines joined by a space", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-tools-"));
    try {
      mkdirSync(join(home, ".agents", "skills", "claude-api"), { recursive: true });
      writeFileSync(
        join(home, ".agents", "skills", "claude-api", "SKILL.md"),
        "---\nname: claude-api\ndescription: |-\n  Reference for the Claude API.\n  TRIGGER when code imports anthropic.\nallowed-tools: Read\n---\nbody",
      );
      mkdirSync(join(home, ".agents", "skills", "folded"), { recursive: true });
      writeFileSync(
        join(home, ".agents", "skills", "folded", "SKILL.md"),
        "---\nname: folded\ndescription: >-\n  First folded line\n  second line\n---\nbody",
      );
      const result = buildAgentToolsInventory({
        home,
        settings: { extraMcpFiles: [], extraSkillDirs: [], parkedMcp: [] },
        fleet: { enabled: true, mounting: false, source: null, servers: [] },
        clis: [],
      });
      expect(result.skills).toEqual([
        { name: "claude-api", description: "Reference for the Claude API. TRIGGER when code imports anthropic.", source: "~/.agents/skills" },
        { name: "folded", description: "First folded line second line", source: "~/.agents/skills" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
