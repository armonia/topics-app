/**
 * The agents registry: read from jarvis-channels' files, written back safely.
 *
 * @covers AGCFG-02
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyEdit, createAgentConfigRouter, defaultPaths, readRegistry, type Paths } from "./agent-config";
import { registryHome } from "../agents/registry";

function ctx() {
  return { json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }) };
}

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function fixture(): Paths {
  const home = mkdtempSync(join(tmpdir(), "agent-config-"));
  dirs.push(home);
  const ws = join(home, "ws"); const visionWs = join(ws, "gtm");
  mkdirSync(visionWs, { recursive: true });
  writeFileSync(join(ws, "IDENTITY.md"), "# Jarvis\n"); writeFileSync(join(visionWs, "IDENTITY.md"), "# Visione\n");
  writeFileSync(join(home, "engine.json"), JSON.stringify({ model: "claude-sonnet-5-5", agents: { main: { workspace: ws }, gtm: { workspace: visionWs, account: "visione" } } }));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    channels: { discord: { default: { token: "keychain:d/j" }, visione: { token: "keychain:d/v" } }, telegram: { token: "keychain:t" } },
    rules: {
      models: { discord: { "*": "anthropic/claude-opus-5-5" } },
      agents: [{ channel: "discord", agent: "gtm", account: "visione", chat: "42" }],
      groups: [
        { channel: "discord", chat: "42", active: true, mention: true },
        { channel: "discord", chat: "42", active: true, mention: false, account: "visione" },
        { channel: "telegram", chat: "*", active: true, mention: true, senders: ["1"] },
        { channel: "discord", chat: "77", active: true, mention: true },
        { channel: "discord", chat: "77", active: true, mention: false, account: "visione" },
      ],
    },
  }));
  writeFileSync(join(home, "jobs.json"), JSON.stringify([
    { id: "a", name: "Brief", paused: false, run: { kind: "agent", prompt: "x" }, schedule: { kind: "cron", expr: "0 8 * * *" } },
    { id: "b", name: "Giro", paused: false, run: { kind: "agent", agent: "gtm", prompt: "y" }, schedule: { kind: "every", minutes: 30 } },
  ]));
  return { home, expand: (p) => p };
}

describe("readRegistry", () => {
  test("splits chats, jobs and persona per agent and names the incoherences", () => {
    const p = fixture();
    const { agents, issues } = readRegistry(p);
    const [jarvis, visione] = agents;
    expect(jarvis.name).toBe("Jarvis");
    expect(jarvis.chats.map((c) => c.chat)).toEqual(["42", "*", "77"]);
    expect(visione.chats).toHaveLength(2);
    expect(visione.chats[0].twoAgents).toBe(true);
    expect(jarvis.chats[2].twoAgents).toBe(false);
    expect(visione.chats[0].routed).toBe(true);
    expect(jarvis.jobs.map((j) => j.id)).toEqual(["a"]);
    expect(visione.jobs[0].schedule).toBe("ogni 30 min");
    expect(visione.persona["IDENTITY.md"]).toContain("Visione");
    expect(JSON.stringify(agents)).not.toContain("keychain:");
    const text = issues.map((i) => i.text).join("\n");
    // 42 is routed to Visione on purpose: not an issue. 77 is not routed: it is.
    expect(text).not.toContain("discord:42");
    expect(text).toContain("discord:77: regola scritta 2 volte");
    expect(text).not.toContain("engine.json");
    expect(text).toContain("1 lavori a orario senza agente");
  });

  test("exposes the raw chat -> agent overrides and who follows each chat", () => {
    const p = fixture();
    const { agents, routes } = readRegistry(p);
    const [jarvis, visione] = agents;
    expect(routes).toEqual([{ channel: "discord", chat: "42", agent: "gtm" }]);
    // 42 and 77 both have a group row under each agent's own account: both follow them,
    // the override on 42 only decides who answers, not who the tree lists as following it.
    expect(jarvis.chats.find((c) => c.chat === "42")!.followedBy.sort()).toEqual(["gtm", "main"]);
    expect(visione.chats.find((c) => c.chat === "77")!.followedBy.sort()).toEqual(["gtm", "main"]);
  });

  test("a second agent with its own account keeps its own chats, not the default's", () => {
    const p = fixture();
    const { agents } = readRegistry(p);
    const [jarvis, visione] = agents;
    expect(visione.chats.every((c) => c.account === "visione")).toBe(true);
    expect(jarvis.chats.every((c) => c.account !== "visione")).toBe(true);
  });

  test("a Discord account nobody declares is an issue, not a silent default", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-config-"));
    dirs.push(home);
    const wsA = join(home, "ws", "a"); const wsB = join(home, "ws", "b");
    mkdirSync(wsA, { recursive: true }); mkdirSync(wsB, { recursive: true });
    writeFileSync(join(wsA, "IDENTITY.md"), "# Prima\n"); writeFileSync(join(wsB, "IDENTITY.md"), "# Seconda\n");
    // "b" never declares `account`: its own Discord account ("orphan") has no owner.
    writeFileSync(join(home, "engine.json"), JSON.stringify({ agents: { a: { workspace: wsA }, b: { workspace: wsB } } }));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      channels: { discord: { default: { token: "keychain:d" }, orphan: { token: "keychain:o" } } },
      rules: { groups: [] },
    }));
    const { issues } = readRegistry({ home, expand: (x) => x });
    const text = issues.map((i) => i.text).join("\n");
    expect(text).toContain('account Discord "orphan"');
    expect(text).not.toContain('"default"');
  });

  test("a single agent owns every account without ambiguity: no issue", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-config-"));
    dirs.push(home);
    const wsA = join(home, "ws", "a");
    mkdirSync(wsA, { recursive: true });
    writeFileSync(join(wsA, "IDENTITY.md"), "# Sola\n");
    writeFileSync(join(home, "engine.json"), JSON.stringify({ agents: { a: { workspace: wsA } } }));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      channels: { discord: { whatever: { token: "keychain:o" } } },
      rules: { groups: [] },
    }));
    const { issues } = readRegistry({ home, expand: (x) => x });
    expect(issues.map((i) => i.text).join("\n")).not.toContain("account Discord");
  });
});

describe("defaultPaths", () => {
  test("agrees with the registry's own home resolver (both routes must see the same agents)", () => {
    expect(defaultPaths({ FOO: "bar" }).home).toBe(registryHome({ FOO: "bar" }));
    expect(defaultPaths({ JARVIS_CHANNELS_HOME: "/x" }).home).toBe(registryHome({ JARVIS_CHANNELS_HOME: "/x" }));
  });
});

describe("applyEdit", () => {
  test("pausing a job writes jobs.json after a backup", () => {
    const p = fixture();
    const r = applyEdit(p, { kind: "job", id: "b", paused: true });
    expect(r.restart).toBe(false);
    expect(JSON.parse(readFileSync(join(p.home, "jobs.json"), "utf8"))[1].paused).toBe(true);
    expect(readdirSync(join(p.home, "backups")).some((f) => f.startsWith("jobs.json."))).toBe(true);
  });

  test("a chat edit touches only that agent's rule and asks for a restart", () => {
    const p = fixture();
    const r = applyEdit(p, { kind: "chat", channel: "discord", chat: "42", account: "visione", mention: true });
    expect(r.restart).toBe(true);
    const g = JSON.parse(readFileSync(join(p.home, "config.json"), "utf8")).rules.groups;
    expect(g[1].mention).toBe(true);
    expect(g[0].mention).toBe(true);
    expect(g[2].senders).toEqual(["1"]);
  });

  test("bad input is refused and the file is untouched", () => {
    const p = fixture();
    const before = readFileSync(join(p.home, "config.json"), "utf8");
    expect(() => applyEdit(p, { kind: "chat", channel: "discord", chat: "nope", mention: true })).toThrow("not found");
    expect(() => applyEdit(p, { kind: "chat", channel: "discord", chat: "42", mention: "si" as any })).toThrow("true or false");
    expect(() => applyEdit(p, { kind: "persona", agent: "main", file: "../x.md", text: "x".repeat(30) })).toThrow("not editable");
    expect(() => applyEdit(p, { kind: "persona", agent: "main", file: "SOUL.md", text: "" })).toThrow("too short");
    expect(readFileSync(join(p.home, "config.json"), "utf8")).toBe(before);
  });

  test("persona writes into the agent's workspace", () => {
    const p = fixture();
    const r = applyEdit(p, { kind: "persona", agent: "gtm", file: "IDENTITY.md", text: "# Visione\nOperativa e stretta, misura." });
    expect(r.file).toBe(join(p.home, "ws", "gtm", "IDENTITY.md"));
    expect(readFileSync(r.file, "utf8")).toContain("Operativa");
    expect(r.backup).not.toBeNull();
  });

  test("chat instructions and who may write are saved, bad ids refused", () => {
    const p = fixture();
    applyEdit(p, { kind: "chat", channel: "telegram", chat: "*", system: "Rispondi breve.", senders: ["1", " 2 ", "2"] });
    const g = JSON.parse(readFileSync(join(p.home, "config.json"), "utf8")).rules.groups[2];
    expect(g.system).toBe("Rispondi breve.");
    expect(g.senders).toEqual(["1", "2"]);
    applyEdit(p, { kind: "chat", channel: "telegram", chat: "*", system: "", senders: [] });
    const h = JSON.parse(readFileSync(join(p.home, "config.json"), "utf8")).rules.groups[2];
    expect(h.system).toBeUndefined();
    expect(h.senders).toBeUndefined();
    expect(() => applyEdit(p, { kind: "chat", channel: "telegram", chat: "*", senders: ["a b"] })).toThrow("list of ids");
  });

  test("a job's schedule is validated before it is written", () => {
    const p = fixture();
    applyEdit(p, { kind: "job", id: "a", schedule: { kind: "cron", expr: "30 9 * * 1-5", tz: "Europe/Rome" } });
    expect(JSON.parse(readFileSync(join(p.home, "jobs.json"), "utf8"))[0].schedule.expr).toBe("30 9 * * 1-5");
    applyEdit(p, { kind: "job", id: "b", schedule: { kind: "every", minutes: 15 } });
    const before = readFileSync(join(p.home, "jobs.json"), "utf8");
    expect(() => applyEdit(p, { kind: "job", id: "a", schedule: { kind: "cron", expr: "9 * *" } })).toThrow("5 fields");
    expect(() => applyEdit(p, { kind: "job", id: "a", schedule: { kind: "every", minutes: 0 } })).toThrow("above 0");
    expect(() => applyEdit(p, { kind: "job", id: "a", schedule: { kind: "at", at: "domani" } })).toThrow("date and time");
    expect(() => applyEdit(p, { kind: "job", id: "a" })).toThrow("nothing to change");
    expect(readFileSync(join(p.home, "jobs.json"), "utf8")).toBe(before);
  });

  test("a route edit adds, replaces and removes a chat -> agent override", () => {
    const p = fixture();
    applyEdit(p, { kind: "route", channel: "discord", chat: "77", agent: "gtm" });
    let routes = JSON.parse(readFileSync(join(p.home, "config.json"), "utf8")).rules.agents;
    expect(routes).toContainEqual({ channel: "discord", chat: "77", agent: "gtm" });
    expect(routes.find((r: any) => r.chat === "42").agent).toBe("gtm"); // untouched

    applyEdit(p, { kind: "route", channel: "discord", chat: "77", agent: "main" });
    routes = JSON.parse(readFileSync(join(p.home, "config.json"), "utf8")).rules.agents;
    expect(routes.filter((r: any) => r.channel === "discord" && r.chat === "77")).toHaveLength(1);
    expect(routes.find((r: any) => r.chat === "77").agent).toBe("main");

    applyEdit(p, { kind: "route", channel: "discord", chat: "77", agent: null });
    routes = JSON.parse(readFileSync(join(p.home, "config.json"), "utf8")).rules.agents;
    expect(routes.some((r: any) => r.chat === "77")).toBe(false);
  });
});

describe("route edit validation", () => {
  test("rejects an agent that is not in engine.agents, leaving config.json untouched", async () => {
    const p = fixture();
    const before = readFileSync(join(p.home, "config.json"), "utf8");
    expect(() => applyEdit(p, { kind: "route", channel: "discord", chat: "77", agent: "ghost" })).toThrow("unknown agent");
    const res = await createAgentConfigRouter(ctx(), () => p)(
      new Request("http://x/api/agent-config/route", { method: "POST", body: JSON.stringify({ channel: "discord", chat: "77", agent: "ghost" }) }),
      new URL("http://x/api/agent-config/route"), "/api/agent-config/route", "POST",
    );
    expect(res?.status).toBe(400);
    expect(readFileSync(join(p.home, "config.json"), "utf8")).toBe(before);
  });

  test("rejects an empty or non-string channel or chat", () => {
    const p = fixture();
    const before = readFileSync(join(p.home, "config.json"), "utf8");
    expect(() => applyEdit(p, { kind: "route", channel: "", chat: "77", agent: "gtm" })).toThrow("channel must be");
    expect(() => applyEdit(p, { kind: "route", channel: "discord", chat: 77 as unknown as string, agent: "gtm" })).toThrow("chat must be");
    expect(readFileSync(join(p.home, "config.json"), "utf8")).toBe(before);
  });
});

describe("GET /api/agent-config/persona", () => {
  test("assembles the five layers for a known agent", async () => {
    const p = fixture();
    writeFileSync(join(p.home, "USER.md"), "Works in Rome, Italy.");
    const router = createAgentConfigRouter(ctx(), () => p);
    const res = await router(
      new Request("http://x/api/agent-config/persona?agent=main"),
      new URL("http://x/api/agent-config/persona?agent=main"),
      "/api/agent-config/persona",
      "GET",
    );
    const body = await res!.json();
    expect(body.agent).toBe("main");
    expect(body.layers.map((l: { name: string }) => l.name)).toEqual(["base", "rules", "profile", "identity", "agent"]);
    expect(body.layers[2].content).toBe("Works in Rome, Italy.");
    expect(body.layers[3].content).toBe("# Jarvis");
    expect(body.layers.every((l: { tokens: number }) => typeof l.tokens === "number")).toBe(true);
  });

  test("?walled=1 returns identity and profile only", async () => {
    const p = fixture();
    writeFileSync(join(p.home, "USER.md"), "Works in Rome, Italy.");
    const router = createAgentConfigRouter(ctx(), () => p);
    const res = await router(
      new Request("http://x/api/agent-config/persona?agent=main&walled=1"),
      new URL("http://x/api/agent-config/persona?agent=main&walled=1"),
      "/api/agent-config/persona",
      "GET",
    );
    const body = await res!.json();
    expect(body.layers.map((l: { name: string }) => l.name)).toEqual(["profile", "identity"]);
  });

  test("an unknown agent answers 404, not a throw", async () => {
    const p = fixture();
    const router = createAgentConfigRouter(ctx(), () => p);
    const res = await router(
      new Request("http://x/api/agent-config/persona?agent=ghost"),
      new URL("http://x/api/agent-config/persona?agent=ghost"),
      "/api/agent-config/persona",
      "GET",
    );
    expect(res!.status).toBe(404);
  });
});
