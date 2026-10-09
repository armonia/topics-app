import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { mergeMuseSettings, museBridgeEntry, stageMuseConfig } from "./mcp-config";

const bridge = museBridgeEntry({ command: "/bin/bun", args: ["run", "topics-mcp-server.ts", "--session-key=topic:abc"] });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function realDir(settings: unknown): string {
  const d = mkdtempSync(join(tmpdir(), "muse-real-"));
  dirs.push(d);
  writeFileSync(join(d, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(d, "auth.json"), "{}");
  mkdirSync(join(d, "skills"));
  return d;
}

describe("muse MCP config", () => {
  test("the bridge is a stdio entry in Muse's dialect", () => {
    expect(bridge).toEqual({ transport: "stdio", command: "/bin/bun", args: ["run", "topics-mcp-server.ts", "--session-key=topic:abc"] });
  });

  test("the user's servers stay, the bridge is added under `topics`", () => {
    const merged = mergeMuseSettings({ model: "m", mcpServers: { gateway: { transport: "streamable_http", url: "http://x" } } }, bridge);
    expect(merged.model).toBe("m");
    expect(merged.mcpServers).toEqual({ gateway: { transport: "streamable_http", url: "http://x" }, topics: bridge });
  });

  test("a same-named user entry loses to the session-bound bridge", () => {
    const merged = mergeMuseSettings({ mcpServers: { topics: { transport: "stdio", command: "old" } } }, bridge);
    expect((merged.mcpServers as Record<string, unknown>).topics).toEqual(bridge);
  });

  test("staging writes the merged settings 0600 and links auth and skills", () => {
    const real = realDir({ model: "m", mcpServers: { exa: { transport: "streamable_http", url: "u" } } });
    const { configHome, cleanup } = stageMuseConfig(bridge, real);
    const staged = join(configHome, "muse");
    const settings = JSON.parse(readFileSync(join(staged, "settings.json"), "utf8"));
    expect(Object.keys(settings.mcpServers)).toEqual(["exa", "topics"]);
    expect(statSync(join(staged, "settings.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(staged, "auth.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(staged, "skills")).isSymbolicLink()).toBe(true);
    // The real settings are never touched.
    expect(JSON.parse(readFileSync(join(real, "settings.json"), "utf8")).mcpServers.topics).toBeUndefined();
    cleanup();
    expect(existsSync(configHome)).toBe(false);
  });

  test("without a real settings file the bridge is the only server", () => {
    const real = mkdtempSync(join(tmpdir(), "muse-empty-"));
    dirs.push(real);
    const { configHome, cleanup } = stageMuseConfig(bridge, real);
    const settings = JSON.parse(readFileSync(join(configHome, "muse", "settings.json"), "utf8"));
    expect(settings.mcpServers).toEqual({ topics: bridge });
    cleanup();
  });
});
