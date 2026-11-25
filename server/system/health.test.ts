// @covers SYSTEM-PAGE-01
import { describe, expect, test } from "bun:test";
import type { MemoryStore } from "../memory/stores";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registryHealthInput } from "./registry-health";
import { collectHealth, HEALTH_PROBLEM_TYPES, type HealthInput, type HealthProblemType } from "./health";

function store(over: Partial<MemoryStore> & { id: string }): MemoryStore {
  return {
    kind: "agent",
    ownerAgentId: null,
    path: "/x",
    index: { path: "/x/MEMORY.md", lines: 3, chars: 80, overLimit: false },
    cards: [{ file: "a.md", name: "a", description: "", type: "note" }],
    receivedBy: ["alpha"],
    readableBy: [],
    ...over,
  };
}

const healthy = (): HealthInput => ({
  agents: [
    { id: "alpha", name: "Alpha", missingPersonaFiles: [], hasOwnRules: false },
    { id: "beta", name: "Beta", missingPersonaFiles: [], hasOwnRules: false },
  ],
  stores: [store({ id: "agent:alpha", ownerAgentId: "alpha" })],
  jobs: [{ id: "j1", name: "Nightly", agentId: "alpha" }],
  chats: [{ id: "c1", name: "Release notes" }],
  contradictions: [],
  tools: [{ name: "github", ok: true }],
  sharedRulesPresent: true,
});

/** One of every kind of problem at once. */
const broken = (): HealthInput => ({
  agents: [
    { id: "alpha", name: "Alpha", missingPersonaFiles: ["IDENTITY.md"], hasOwnRules: true },
    { id: "beta", name: "Beta", missingPersonaFiles: [], hasOwnRules: false },
  ],
  stores: [
    store({ id: "agent:beta", ownerAgentId: "beta", receivedBy: [] }),
    store({ id: "agent:alpha", ownerAgentId: "alpha", index: null }),
    store({ id: "project:p", kind: "project", index: { path: "/p", lines: 900, chars: 90000, overLimit: true } }),
  ],
  jobs: [{ id: "j1", name: "Nightly", agentId: null }],
  chats: [{ id: "c1", name: "  " }],
  contradictions: [{ id: "k1", sources: ["base", "user rules"], about: "reply language" }],
  tools: [{ name: "github", ok: false, reason: "connection refused" }],
  sharedRulesPresent: false,
});

describe("collectHealth", () => {
  test("a healthy system has no problems", () => {
    expect(collectHealth(healthy())).toEqual([]);
  });

  test("every type has a sentence and a destination", () => {
    const problems = collectHealth(broken());
    const seen = new Set(problems.map((p) => p.type));
    expect([...seen].sort()).toEqual((Object.keys(HEALTH_PROBLEM_TYPES) as HealthProblemType[]).sort());
    for (const p of problems) {
      expect(p.sentence.length).toBeGreaterThan(10);
      expect(p.destination.section).toBeTruthy();
    }
  });

  test("a problem with an owner opens that agent", () => {
    const byType = (t: HealthProblemType) => collectHealth(broken()).find((p) => p.type === t);
    expect(byType("memory-unreceived")?.destination).toEqual({ section: "memory", agentId: "beta", ref: "agent:beta" });
    expect(byType("persona-file-missing")?.destination).toEqual({ section: "identity", agentId: "alpha" });
    expect(byType("rules-single-agent")?.destination.agentId).toBe("alpha");
    expect(byType("job-without-agent")?.destination).toEqual({ section: "jobs", ref: "j1" });
  });

  test("a job whose agent no longer exists counts as without agent", () => {
    const input = healthy();
    input.jobs = [{ id: "j2", name: "Ghost", agentId: "gone" }];
    expect(collectHealth(input).map((p) => p.type)).toEqual(["job-without-agent"]);
  });

  test("fixing the data removes the problem on the next read", () => {
    const input = broken();
    const before = collectHealth(input).length;
    input.jobs = [{ id: "j1", name: "Nightly", agentId: "alpha" }];
    const after = collectHealth(input);
    expect(after.length).toBe(before - 1);
    expect(after.some((p) => p.type === "job-without-agent")).toBe(false);
  });

  test("rules present in two agents or shared are not a problem", () => {
    const input = broken();
    input.sharedRulesPresent = true;
    expect(collectHealth(input).some((p) => p.type === "rules-single-agent")).toBe(false);
  });
});

describe("registryHealthInput", () => {
  const write = (dir: string, name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));
  const setup = (groups: unknown[], jobs: unknown[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), "health-"));
    write(dir, "config.json", { rules: { groups, agents: [] } });
    write(dir, "engine.json", { agents: { alpha: { workspace: join(dir, "alpha") } } });
    write(dir, "jobs.json", jobs);
    return dir;
  };
  const types = (dir: string, titles: Record<string, string>) => {
    const input = registryHealthInput(dir, titles);
    const agents = [{ id: "alpha", name: "Alpha", missingPersonaFiles: [], hasOwnRules: false }];
    return collectHealth({ agents, stores: [], tools: [], sharedRulesPresent: true, ...input }).map((p) => p.type);
  };

  test("a chat written twice with another mention is a source contradiction", () => {
    const dir = setup([
      { channel: "discord", chat: "1", mention: true, active: true },
      { channel: "discord", chat: "1", mention: false, active: true },
    ]);
    expect(types(dir, { "1": "general" })).toEqual(["source-contradiction"]);
  });

  test("a job in jobs.json with no agent, where no agent is called main, is a job without agent", () => {
    const dir = setup([], [{ id: "j", name: "Nightly", run: { kind: "agent" } }]);
    expect(types(dir, {})).toEqual(["job-without-agent"]);
  });

  test("a job in jobs.json with no agent runs as main: not a problem when main exists", () => {
    // The channels engine gives such a job the agent "main" (cron.rs). Counting
    // it as «never does anything» put 160 false errors on the live System page.
    const dir = setup([], [{ id: "j", name: "Nightly", run: { kind: "agent" } }]);
    write(dir, "engine.json", { agents: { main: { workspace: join(dir, "main") } } });
    const input = registryHealthInput(dir, {});
    const agents = [{ id: "main", name: "Main", missingPersonaFiles: [], hasOwnRules: false }];
    const problems = collectHealth({ agents, stores: [], tools: [], sharedRulesPresent: true, ...input });
    expect(problems.map((p) => p.type)).toEqual([]);
  });

  test("every problem carries the pieces of its sentence, for the client to say it in the reader's language", () => {
    const problems = collectHealth({
      agents: [{ id: "a", name: "Alpha", missingPersonaFiles: ["IDENTITY.md"], hasOwnRules: false }],
      stores: [],
      jobs: [{ id: "j", name: "Nightly", agentId: null }],
      chats: [],
      contradictions: [{ id: "c", sources: ["config.json", "engine.json"], about: "the model" }],
      tools: [{ name: "docs", ok: false, reason: "exit 1" }],
      sharedRulesPresent: true,
    });
    expect(Object.fromEntries(problems.map((p) => [p.type, p.vars]))).toEqual({
      "job-without-agent": { job: "Nightly" },
      "source-contradiction": { about: "the model", first: "config.json", second: "engine.json" },
      "tool-down": { tool: "docs", reason: "exit 1" },
      "persona-file-missing": { agent: "Alpha", files: "IDENTITY.md" },
    });
  });

  test("a channel chat whose name does not resolve is unnamed", () => {
    const dir = setup([{ channel: "discord", chat: "7", active: true }, { channel: "discord", chat: "8", active: true }]);
    expect(types(dir, { "8": "named" })).toEqual(["chat-unnamed"]);
  });

  test("a Topics topic without a name gives nothing", () => {
    const dir = setup([]);
    expect(types(dir, { "x": "y" })).toEqual([]);
  });
});

describe("unreceived project memories", () => {
  test("hundreds of them are one problem with a count, not one problem each", () => {
    const stores = ["-a-one", "-a-two", "-a-three"].map((id) => store({ id: `project:${id}`, kind: "project", receivedBy: [] }));
    const problems = collectHealth({ ...healthy(), stores }).filter((p) => p.type === "memory-unreceived");
    expect(problems).toHaveLength(1);
    expect(problems[0]!.vars).toEqual({ count: "3" });
  });
});
