/**
 * @covers MCPSRV-02
 *
 * There is ONE inheritance rule, and it also answers the second question.
 *
 * `isColdBootServer` already has its own test (`mcp-coldboot.test.ts`); what is
 * covered here is the part that did not exist before: WHY a configured server is
 * absent. Until yesterday that reason ended up on a line of stdout, and a tool
 * missing without an explanation is indistinguishable from a bug.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveInheritedMcp } from "./mcp-inheritance";

const dir = mkdtempSync(join(tmpdir(), "mcp-inherit-"));
const configPath = join(dir, "config.json");
const ENV_KEYS = [
  "TOPICS_MCP_CONFIG_FILE",
  "TOPICS_SESSION_MCP_ALLOW",
  "TOPICS_SESSION_MCP_DENY",
  "TOPICS_SESSION_MCP_INHERIT_ALL",
  "TOPICS_SESSION_MCP_COLDBOOT_OK",
];
const backup: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) backup[k] = process.env[k];

function writeConfig(servers: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify({ mcpServers: servers }));
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.TOPICS_MCP_CONFIG_FILE = configPath;
});

afterAll(() => {
  for (const [k, v] of Object.entries(backup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveInheritedMcp", () => {
  test("eredita i server http e dice da quale file", () => {
    writeConfig({ ricerca: { type: "http", url: "https://esempio/mcp" } });
    const out = resolveInheritedMcp();
    expect(Object.keys(out.servers ?? {})).toEqual(["ricerca"]);
    expect(out.excluded).toEqual([]);
    expect(out.source).toBe(configPath);
  });

  test("il ponte `topics` non si eredita: lo monta l'host", () => {
    writeConfig({ topics: { command: "bun", args: ["x"] }, ricerca: { type: "http", url: "https://esempio/mcp" } });
    expect(Object.keys(resolveInheritedMcp().servers ?? {})).toEqual(["ricerca"]);
  });

  test("ogni esclusione porta il suo motivo, non sparisce e basta", () => {
    writeConfig({
      "chrome-devtools": { type: "stdio", command: "node", args: ["x.js"] },
      pesante: { command: "npx", args: ["-y", "pacchetto"] },
      ricerca: { type: "http", url: "https://esempio/mcp" },
    });
    const out = resolveInheritedMcp();
    expect(Object.keys(out.servers ?? {})).toEqual(["ricerca"]);
    const motivi = Object.fromEntries(out.excluded.map((e) => [e.name, e.reason]));
    expect(motivi).toEqual({ "chrome-devtools": "deny", pesante: "cold-boot" });
    for (const e of out.excluded) expect(e.detail.length).toBeGreaterThan(10);
  });

  test("con un'allowlist, chi resta fuori lo sa dire", () => {
    process.env.TOPICS_SESSION_MCP_ALLOW = "ricerca";
    writeConfig({ ricerca: { type: "http", url: "https://a" }, docs: { type: "http", url: "https://b" } });
    const out = resolveInheritedMcp();
    expect(Object.keys(out.servers ?? {})).toEqual(["ricerca"]);
    expect(out.excluded).toEqual([{ name: "docs", reason: "allowlist", detail: "not in TOPICS_SESSION_MCP_ALLOW" }]);
  });

  test("INHERIT_ALL=1 non e' «tutti»: e' «non ho titolo per decidere»", () => {
    process.env.TOPICS_SESSION_MCP_INHERIT_ALL = "1";
    writeConfig({ ricerca: { type: "http", url: "https://a" } });
    expect(resolveInheritedMcp().servers).toBeNull();
  });

  test("un file illeggibile non fa sparire i tool per un errore di parsing", () => {
    writeFileSync(configPath, "{ non json");
    expect(resolveInheritedMcp().servers).toBeNull();
  });
});
