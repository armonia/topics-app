/**
 * What the «/» menu lists besides Topics' own group, per declared engine
 * (CMDUI-01, SKILL-01): the engine's group read from the engine, «your
 * skills» only where the engine expands them.
 *
 * @covers CMDUI-01, SKILL-01
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { slashMenuEntries } from "./slash-command-menu";
import { recordCliSlashCommands, recordEngineCommands, resetCliSlashCommands } from "./slash-command-source";

let home: string;
let cwd: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "menu-home-"));
  cwd = mkdtempSync(join(tmpdir(), "menu-cwd-"));
  mkdirSync(join(home, ".claude", "commands"), { recursive: true });
  writeFileSync(join(home, ".claude", "commands", "recap.md"), "---\ndescription: Riassunto\n---\n");
  for (const s of ["vai", "spenta"]) {
    mkdirSync(join(home, ".claude", "skills", s), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: la skill ${s}\n---\n`);
  }
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { spenta: "off" } }));
});
afterAll(() => { for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => resetCliSlashCommands());

const names = (list: Array<{ name: string; group: string }>, group: string) => list.filter((e) => e.group === group).map((e) => e.name);

describe("slashMenuEntries", () => {
  test("Claude Code with its init: the CLI's own names in the engine group, the skills (and a plugin's) in the other", () => {
    recordCliSlashCommands("topic:cc", { type: "system", subtype: "init", cwd, slash_commands: ["init", "code-review", "compact", "agents", "vai", "recap", "marketing:brief"] });
    const list = slashMenuEntries({ provider: "claude-code", sessionKey: "topic:cc", projectPath: cwd, cwd, home });
    expect(names(list, "engine")).toEqual(["agents", "code-review", "compact", "init"]);
    expect(names(list, "skills")).toEqual(["marketing:brief", "recap", "vai"]);
    // The kind is still declared for every entry (SKILL-01).
    expect(list.every((e) => e.kind === "command" || e.kind === "skill")).toBe(true);
    expect(list.find((e) => e.name === "spenta")).toBeUndefined();
  });

  test("once commands_changed has spoken, its `builtin` flag decides the split", () => {
    recordCliSlashCommands("topic:cc", { type: "system", subtype: "commands_changed", commands: [{ name: "init", builtin: true, description: "Initialize" }, { name: "plugin-thing", description: "x" }] });
    const list = slashMenuEntries({ provider: "claude-code", sessionKey: "topic:cc", projectPath: cwd, cwd, home });
    expect(names(list, "engine")).toEqual(["init"]);
    expect(list.find((e) => e.name === "init")?.description).toBe("Initialize");
    expect(names(list, "skills")).toContain("plugin-thing");
  });

  test("a Claude Code chat with no list seen yet: the skills from the folders, no engine group", () => {
    const list = slashMenuEntries({ provider: "claude-code", sessionKey: "topic:new", projectPath: cwd, cwd, home });
    expect(names(list, "engine")).toEqual([]);
    expect(names(list, "skills")).toEqual(["recap", "vai"]);
  });

  test("Topics' native engine: its skills only, no commands, no switched-off skill", () => {
    recordCliSlashCommands("topic:cc", { type: "system", subtype: "init", cwd, slash_commands: ["init"] });
    const list = slashMenuEntries({ provider: "topics", sessionKey: "topic:n", projectPath: cwd, cwd, home });
    expect(list.map((e) => [e.name, e.group, e.kind])).toEqual([["vai", "skills", "skill"]]);
  });

  test("Codex, the API engines and OpenClaw: nothing (a typed /name is prose there)", () => {
    recordCliSlashCommands("topic:cc", { type: "system", subtype: "init", cwd, slash_commands: ["init"] });
    for (const provider of ["codex", "openclaw", "anthropic"]) {
      expect(slashMenuEntries({ provider, sessionKey: "topic:x", projectPath: cwd, cwd, home }), provider).toEqual([]);
    }
  });

  test("an ACP agent: the commands it announced", () => {
    recordEngineCommands("topic:j", [{ name: "models", description: "List models" }, { name: "model" }], { provider: "jcode", projectPath: cwd });
    const list = slashMenuEntries({ provider: "jcode", sessionKey: "topic:other", projectPath: cwd, cwd, home });
    expect(names(list, "engine")).toEqual(["model", "models"]);
    expect(names(list, "skills")).toEqual([]);
  });

  test("no topic (a draft before its engine is known): the folders, as before", () => {
    const list = slashMenuEntries({ provider: null, cwd, home });
    expect(names(list, "skills")).toEqual(["recap", "vai"]);
  });
});
