/**
 * @covers SESSENV-01
 *
 * The inherited environment, read from real files in a temporary home.
 *
 * The point of the surface is not "a list appears": it is that each row says
 * WHICH FILE put it there, and that a server which is absent says why. Those
 * two are the questions a person actually has, so they are what is asserted
 * here, on files written by the test rather than on the machine's own home.
 *
 * The masking test is the one that must never regress: this payload leaves the
 * server and reaches a browser, and an MCP definition legitimately carries
 * tokens in argv and in `env`.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveSessionEnvironment } from "./session-environment";

const root = mkdtempSync(join(tmpdir(), "session-env-"));
const home = join(root, "home");
const cwd = join(root, "project");
const mcpConfig = join(root, "claude.json");

const ENV_KEYS = ["TOPICS_MCP_CONFIG_FILE", "TOPICS_SESSION_MCP_ALLOW", "TOPICS_SESSION_MCP_DENY", "TOPICS_SESSION_MCP_INHERIT_ALL", "TOPICS_SESSION_MCP_COLDBOOT_OK"];
const backup: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) backup[k] = process.env[k];

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  for (const k of ENV_KEYS) delete process.env[k];
  writeJson(mcpConfig, { mcpServers: {} });
  process.env.TOPICS_MCP_CONFIG_FILE = mcpConfig;
});

afterAll(() => {
  for (const [k, v] of Object.entries(backup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("hooks and permissions", () => {
  test("every hook says which of the three files declared it", () => {
    writeJson(join(home, ".claude", "settings.json"), {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard-user" }] }] },
    });
    writeJson(join(cwd, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "guard-project" }] }] },
    });
    writeJson(join(cwd, ".claude", "settings.local.json"), {
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "guard-local" }] }] },
    });

    const env = resolveSessionEnvironment({ home, cwd });
    expect(env.hooks.map((h) => [h.event, h.matcher, h.command, h.source])).toEqual([
      ["PreToolUse", "Bash", "guard-user", "user"],
      ["Stop", null, "guard-project", "project"],
      ["PostToolUse", "Edit", "guard-local", "local"],
    ]);
    expect(env.hooks[2].file).toBe(join(cwd, ".claude", "settings.local.json"));
  });

  test("the guard Topics installs itself is listed as ours, not as the user's", () => {
    const env = resolveSessionEnvironment({ home, cwd, topicsGuard: true });
    expect(env.hooks.map((h) => h.source)).toEqual(["topics"]);
    expect(resolveSessionEnvironment({ home, cwd }).hooks).toEqual([]);
  });

  test("allow/deny/ask rules keep their file, and the last mode wins", () => {
    writeJson(join(home, ".claude", "settings.json"), {
      permissions: { allow: ["Bash(ls:*)"], deny: ["Read(./.env)"], defaultMode: "default" },
    });
    writeJson(join(cwd, ".claude", "settings.local.json"), {
      permissions: { ask: ["Bash(git push:*)"], defaultMode: "acceptEdits" },
    });

    const env = resolveSessionEnvironment({ home, cwd });
    expect(env.permissions.mode).toBe("acceptEdits");
    expect(env.permissions.rules.map((r) => [r.effect, r.rule, r.source])).toEqual([
      ["allow", "Bash(ls:*)", "user"],
      ["deny", "Read(./.env)", "user"],
      ["ask", "Bash(git push:*)", "local"],
    ]);
  });

  test("a missing or broken settings file is reported, not thrown", () => {
    writeFileSync(join(cwd, ".claude", "settings.json"), "{ not json");
    const env = resolveSessionEnvironment({ home, cwd });
    expect(env.hooks).toEqual([]);
    expect(env.settingsFiles.map((f) => [f.source, f.exists])).toEqual([
      ["user", false],
      ["project", true],
      ["local", false],
    ]);
  });
});

describe("commands and skills", () => {
  test("a custom command is found with its description and its path", () => {
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(join(home, ".claude", "commands", "recap.md"), "---\ndescription: Sum up the session\n---\nbody\n");
    const env = resolveSessionEnvironment({ home, cwd });
    const recap = env.commands.find((c) => c.name === "recap");
    expect(recap).toEqual({
      name: "recap",
      kind: "command",
      file: join(home, ".claude", "commands", "recap.md"),
      description: "Sum up the session",
    });
  });
});

describe("mcp", () => {
  test("an inherited server is mounted, and the bridge is always there", () => {
    writeJson(mcpConfig, { mcpServers: { search: { type: "http", url: "https://example.test/mcp" } } });
    const env = resolveSessionEnvironment({ home, cwd });
    expect(env.mcp.policy).toBe("inherit");
    expect(env.mcp.servers.map((s) => [s.name, s.state, s.origin])).toEqual([
      ["topics", "mounted", "bridge"],
      ["search", "mounted", "inherited"],
    ]);
    expect(env.mcp.source).toBe(mcpConfig);
  });

  test("an excluded server keeps the rule that dropped it", () => {
    writeJson(mcpConfig, { mcpServers: { "chrome-devtools": { command: "node", args: ["x"] } } });
    const env = resolveSessionEnvironment({ home, cwd });
    const dropped = env.mcp.servers.find((s) => s.name === "chrome-devtools");
    expect(dropped?.state).toBe("excluded");
    expect(dropped?.reason).toContain("exclusion list");
  });

  test("a bridge-only session shows the fleet as scoped away, not as broken", () => {
    writeJson(mcpConfig, { mcpServers: { search: { type: "http", url: "https://example.test/mcp" } } });
    const env = resolveSessionEnvironment({ home, cwd, mcpPolicy: "bridge-only" });
    expect(env.mcp.policy).toBe("bridge-only");
    expect(env.mcp.strict).toBe(true);
    const search = env.mcp.servers.find((s) => s.name === "search");
    expect(search?.state).toBe("excluded");
    expect(search?.reason).toContain("bridge-only");
  });

  test("no token reaches the payload, from argv, from a query or from env", () => {
    writeJson(mcpConfig, {
      mcpServers: {
        local: { command: "node", args: ["server.js", "--api-token=s3cret-argv"], env: { API_KEY: "s3cret-env" } },
        remote: { type: "http", url: "https://example.test/mcp?token=s3cret-query" },
      },
    });
    const payload = JSON.stringify(resolveSessionEnvironment({ home, cwd }));
    expect(payload).not.toContain("s3cret");
    expect(payload).toContain("--api-token=***");
  });
});

describe("runtimes that do not read those files", () => {
  test("the native provider inherits nothing, and says so", () => {
    writeJson(join(home, ".claude", "settings.json"), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "guard-user" }] }] },
    });
    const env = resolveSessionEnvironment({ home, cwd, provider: "claude" });
    expect(env.inherits).toBe(false);
    expect(env.hooks).toEqual([]);
    expect(env.mcp.servers).toEqual([]);
  });
});
