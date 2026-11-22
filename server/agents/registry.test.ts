// @covers AGENTS-REG-01
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createAgent, readAgents, readIdentity, registryHome, slugifyAgentId } from "./registry";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function identityFolder(root: string, folder: string, name: string, job: string): string {
  const ws = join(root, folder);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "IDENTITY.md"), `# ${name}\n${job}\n`);
  return ws;
}

function threeAgentsHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agents-registry-"));
  dirs.push(home);
  const a = identityFolder(home, "ws/a", "Prima", "Scrive il codice");
  const b = identityFolder(home, "ws/b", "Seconda", "Risponde alle chat");
  const c = identityFolder(home, "ws/c", "Terza", "Fa i turni di notte");
  writeFileSync(join(home, "engine.json"), JSON.stringify({
    agents: { a: { workspace: a }, b: { workspace: b }, c: { workspace: c } },
  }));
  return home;
}

describe("readAgents", () => {
  test("three agents in the config, three records", () => {
    const home = threeAgentsHome();
    const agents = readAgents(home);
    expect(agents).toHaveLength(3);
    expect(agents.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(agents[0].name).toBe("Prima");
    expect(agents[0].job).toBe("Scrive il codice");
    expect(agents[1].name).toBe("Seconda");
    expect(agents[2].job).toBe("Fa i turni di notte");
  });

  test("no configuration, empty home, no error", () => {
    expect(readAgents("")).toEqual([]);
  });

  test("no configuration, engine.json missing, no error", () => {
    const home = mkdtempSync(join(tmpdir(), "agents-registry-"));
    dirs.push(home);
    expect(readAgents(home)).toEqual([]);
  });

  test("an entry with no workspace is skipped, not thrown", () => {
    const home = mkdtempSync(join(tmpdir(), "agents-registry-"));
    dirs.push(home);
    writeFileSync(join(home, "engine.json"), JSON.stringify({ agents: { ghost: {} } }));
    expect(readAgents(home)).toEqual([]);
  });
});

describe("readIdentity", () => {
  test("missing IDENTITY.md answers empty, not a throw", () => {
    expect(readIdentity(join(tmpdir(), "does-not-exist-" + Math.random()))).toEqual({ name: "", job: "" });
  });
});

describe("slugifyAgentId", () => {
  test("lowercases, strips accents and punctuation", () => {
    expect(slugifyAgentId("Attilio Cianci")).toBe("attilio-cianci");
    expect(slugifyAgentId("Città")).toBe("citta");
  });
  test("a name with no usable characters throws", () => {
    expect(() => slugifyAgentId("***")).toThrow();
  });
});

describe("createAgent", () => {
  test("writes only IDENTITY.md and one engine.json entry, backed up", () => {
    const home = mkdtempSync(join(tmpdir(), "agents-registry-"));
    dirs.push(home);
    writeFileSync(join(home, "engine.json"), JSON.stringify({ agents: {} }));
    const agentsRoot = join(home, "agents");

    const agent = createAgent(home, agentsRoot, { name: "Quarta", job: "Fa da guardia" });

    expect(agent.id).toBe("quarta");
    expect(readdirSync(agent.workspace)).toEqual(["IDENTITY.md"]);
    expect(readFileSync(join(agent.workspace, "IDENTITY.md"), "utf8")).toContain("Fa da guardia");

    const engine = JSON.parse(readFileSync(join(home, "engine.json"), "utf8"));
    expect(engine.agents.quarta.workspace).toBe(agent.workspace);
    expect(readdirSync(join(home, "backups")).some((f) => f.startsWith("engine.json."))).toBe(true);
  });

  test("a duplicate id is rejected, the first agent untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "agents-registry-"));
    dirs.push(home);
    writeFileSync(join(home, "engine.json"), JSON.stringify({ agents: {} }));
    const agentsRoot = join(home, "agents");

    const first = createAgent(home, agentsRoot, { name: "Quinta", job: "Prima venuta" });
    expect(() => createAgent(home, agentsRoot, { name: "Quinta", job: "Seconda venuta" }))
      .toThrow(/already exists/);

    expect(readFileSync(join(first.workspace, "IDENTITY.md"), "utf8")).toContain("Prima venuta");
    const engine = JSON.parse(readFileSync(join(home, "engine.json"), "utf8"));
    expect(Object.keys(engine.agents)).toEqual(["quinta"]);
  });

  test("no engine configured refuses rather than guessing a home", () => {
    expect(() => createAgent("", "/tmp/whatever", { name: "X", job: "Y" })).toThrow("no engine configured");
  });
});

describe("registryHome", () => {
  test("an explicit setting wins", () => {
    expect(registryHome({ JARVIS_CHANNELS_HOME: "/custom/home" })).toBe("/custom/home");
  });

  test("with nothing set, it falls back to the engine's standard folder, same as agent-config's reader", () => {
    const home = registryHome({});
    expect(home).toContain("jarvis-channels");
  });
});
