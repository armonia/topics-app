/**
 * Characterization test for the MCP tool surface: the exact tools/list every
 * profile sees (names, descriptions, inputSchema, annotations, order) and the
 * set of tool names with a handler. Descriptions are read by the models and by
 * the board protocol parity test, so a structural refactor must leave this
 * golden file byte-identical. Regenerate on purpose only:
 *   UPDATE_TOOL_SURFACE=1 bun test server/mcp/tool-surface.characterization.test.ts
 * @covers KANBAN-06
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TOOL_HANDLERS, isToolAllowedForProfile, toolsForProfile } from "./topics-mcp-server";

const GOLDEN = join(import.meta.dir, "tool-surface.golden.json");
const PROFILES = [undefined, "dispatch", "codex-dispatch", "global-orchestrator"] as const;
const PLATFORMS: NodeJS.Platform[] = ["darwin", "win32"];

// An empty home and no project: no agent profiles, so the spawn_agent text is stable.
const home = mkdtempSync(join(tmpdir(), "tool-surface-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function surface() {
  const lists: Record<string, unknown> = {};
  const allowed: Record<string, string[]> = {};
  const handlers = Object.keys(TOOL_HANDLERS).sort();
  for (const profile of PROFILES) {
    for (const platform of PLATFORMS) {
      lists[`${profile ?? "default"}/${platform}`] = toolsForProfile(profile, platform, { cwd: null, home });
    }
    allowed[profile ?? "default"] = handlers.filter((n) => isToolAllowedForProfile(profile, n));
  }
  return { lists, handlers, allowed };
}

describe("MCP tool surface", () => {
  test("matches the golden file", () => {
    const actual = JSON.stringify(surface(), null, 2) + "\n";
    if (process.env.UPDATE_TOOL_SURFACE === "1") writeFileSync(GOLDEN, actual);
    expect(actual).toBe(readFileSync(GOLDEN, "utf-8"));
  });
});
