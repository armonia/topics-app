/**
 * The agents registry: read from jarvis-channels' files, written back safely.
 *
 * @covers AGCFG-02
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyEdit, readRegistry, type Paths } from "./agent-config";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function fixture(): Paths {
  const home = mkdtempSync(join(tmpdir(), "agent-config-"));
  dirs.push(home);
  const ws = join(home, "ws"); const secondWs = join(ws, "gtm");
  mkdirSync(secondWs, { recursive: true });
  writeFileSync(join(ws, "IDENTITY.md"), "# Jarvis\n"); writeFileSync(join(secondWs, "IDENTITY.md"), "# Visione\n");
  writeFileSync(join(home, "engine.json"), JSON.stringify({ model: "claude-sonnet-5-5", agents: { main: { workspace: ws }, gtm: { workspace: secondWs } } }));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    channels: { discord: { default: { token: "keychain:d/j" }, visione: { token: "keychain:d/v" } }, telegram: { token: "keychain:t" } },
    rules: {
      models: { discord: { "*": "anthropic/claude-opus-5-5" } },
      agents: [{ channel: "discord", agent: "gtm", account: "visione", chat: "42" }],
      groups: [
        { channel: "discord", chat: "42", active: true, mention: true },
        { channel: "discord", chat: "42", active: true, mention: false, account: "visione" },
        { channel: "telegram", chat: "*", active: true, mention: true, senders: ["1"] },
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
    expect(jarvis.chats.map((c) => c.chat)).toEqual(["42", "*"]);
    expect(visione.chats).toHaveLength(1);
    expect(visione.chats[0].routed).toBe(true);
    expect(jarvis.jobs.map((j) => j.id)).toEqual(["a"]);
    expect(visione.jobs[0].schedule).toBe("ogni 30 min");
    expect(visione.persona["IDENTITY.md"]).toContain("Visione");
    expect(JSON.stringify(agents)).not.toContain("keychain:");
    const text = issues.map((i) => i.text).join("\n");
    expect(text).toContain("discord:42: regola scritta 2 volte");
    expect(text).toContain("engine.json dice claude-sonnet-5-5");
    expect(text).toContain("1 lavori a orario senza agente");
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
    expect(() => applyEdit(p, { kind: "chat", channel: "discord", chat: "nope", mention: true })).toThrow("non trovata");
    expect(() => applyEdit(p, { kind: "chat", channel: "discord", chat: "42", mention: "si" as any })).toThrow("true o false");
    expect(() => applyEdit(p, { kind: "persona", agent: "main", file: "../x.md", text: "x".repeat(30) })).toThrow("non modificabile");
    expect(() => applyEdit(p, { kind: "persona", agent: "main", file: "SOUL.md", text: "" })).toThrow("troppo corto");
    expect(readFileSync(join(p.home, "config.json"), "utf8")).toBe(before);
  });

  test("persona writes into the agent's workspace", () => {
    const p = fixture();
    const r = applyEdit(p, { kind: "persona", agent: "gtm", file: "IDENTITY.md", text: "# Visione\nOperativa e stretta, misura." });
    expect(r.file).toBe(join(p.home, "ws", "gtm", "IDENTITY.md"));
    expect(readFileSync(r.file, "utf8")).toContain("Operativa");
    expect(r.backup).not.toBeNull();
  });
});
