// @covers AGENTS-PERSONA-01
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assemblePersona, PERSONA_LAYER_NAMES } from "./persona";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "persona-"));
  dirs.push(d);
  return d;
}

function paths(home: string) {
  return { home, expand: (p: string) => p };
}

const BASE_SOUL = readFileSync(join(import.meta.dir, "base", "SOUL.md"), "utf8").trim();

describe("assemblePersona", () => {
  test("layers come in order: base, rules, profile, identity, agent — each once", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(home, "USER.md"), "The user works in Rome, Italy.");
    writeFileSync(join(home, "RULES.md"), "Always answer in Italian.");
    writeFileSync(join(ws, "IDENTITY.md"), "# Scout\nFinds things fast.");
    writeFileSync(join(ws, "SOUL.md"), "Never names a real person in a commit.");
    writeFileSync(join(ws, "AGENTS.md"), "Run the gates before delivering.");

    const persona = assemblePersona("scout", ws, paths(home));

    expect(persona.layers.map((l) => l.name)).toEqual([...PERSONA_LAYER_NAMES]);
    expect(new Set(persona.layers.map((l) => l.name)).size).toBe(persona.layers.length);
    expect(persona.layers[0].content).toBe(BASE_SOUL);
    expect(persona.layers[1].content).toBe("Always answer in Italian.");
    expect(persona.layers[2].content).toBe("The user works in Rome, Italy.");
    expect(persona.layers[3].content).toBe("# Scout\nFinds things fast.");
    expect(persona.layers[4].content).toBe("Never names a real person in a commit.\n\nRun the gates before delivering.");
    expect(persona.text.indexOf(BASE_SOUL)).toBeLessThan(persona.text.indexOf("Italian"));
    expect(persona.text.indexOf("Italian")).toBeLessThan(persona.text.indexOf("Rome"));
    expect(persona.text.indexOf("Rome")).toBeLessThan(persona.text.indexOf("Scout"));
    expect(persona.text.indexOf("Scout")).toBeLessThan(persona.text.indexOf("real person"));
    expect(persona.text.indexOf("real person")).toBeLessThan(persona.text.indexOf("gates"));
  });

  test("an agent with only IDENTITY.md still receives base + user + its name", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(ws, "IDENTITY.md"), "# Lone agent\nDoes one thing.");

    const persona = assemblePersona("lone", ws, paths(home));

    expect(persona.layers).toHaveLength(5);
    expect(persona.layers[0].content).toBe(BASE_SOUL); // base, always shipped
    expect(persona.layers[1].content).toBe(""); // no RULES.md yet
    expect(persona.layers[2].content).toBe(""); // no USER.md anywhere
    expect(persona.layers[3].content).toContain("Lone agent");
    expect(persona.layers[4].content).toBe(""); // no agent-specific additions
    expect(persona.text).toContain(BASE_SOUL);
    expect(persona.text).toContain("Lone agent");
  });

  test("the agent layer breaks its weight down to the file it came from", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(ws, "IDENTITY.md"), "# Scout\n");
    writeFileSync(join(ws, "SOUL.md"), "Never names a real person in a commit.");
    writeFileSync(join(ws, "AGENTS.md"), "Run the gates before delivering.");

    const persona = assemblePersona("scout", ws, paths(home));
    const agentLayer = persona.layers.find((l) => l.name === "agent")!;

    expect(agentLayer.files).toEqual([
      { name: "SOUL.md", tokens: agentLayer.files![0].tokens },
      { name: "AGENTS.md", tokens: agentLayer.files![1].tokens },
    ]);
    expect(agentLayer.files!.reduce((sum, f) => sum + f.tokens, 0)).toBeLessThanOrEqual(agentLayer.tokens);

    // A layer with no second file (identity) carries no breakdown at all.
    expect(persona.layers.find((l) => l.name === "identity")!.files).toBeUndefined();
  });

  test("missing files mean empty layers, never a throw", () => {
    const home = tmp();
    const ws = join(tmpdir(), "does-not-exist-" + Math.random());
    expect(() => assemblePersona("ghost", ws, paths(home))).not.toThrow();
    const persona = assemblePersona("ghost", ws, paths(home));
    expect(persona.layers[3].content).toBe("");
    expect(persona.layers[4].content).toBe("");
  });

  test("token weight scales with each layer's own content, not the whole text", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(ws, "IDENTITY.md"), "x".repeat(400));

    const persona = assemblePersona("heavy", ws, paths(home));

    expect(persona.layers[3].tokens).toBe(100); // 400 chars / 4
    expect(persona.layers[1].tokens).toBe(0);
  });

  // Mutation check: dropping the base layer from the assembly (e.g.
  // commenting it out, or shipping an empty base/SOUL.md) must turn this
  // suite red. Both the explicit non-empty assertion below and the ordering
  // assertions above already fail if `assemblePersona` stops reading it.
  test("the base layer ships non-empty — it is the shared soul every agent needs", () => {
    expect(BASE_SOUL.length).toBeGreaterThan(0);
    const persona = assemblePersona("any", tmp(), paths(tmp()));
    expect(persona.layers[0].content.length).toBeGreaterThan(0);
  });

  // (a) a fixture equal to today's four files loses no non-generic section.
  test("no loss: every section of SOUL, USER and AGENTS reaches the assembled text", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(ws, "IDENTITY.md"), "# Ident\nI am the principal.");
    writeFileSync(join(ws, "SOUL.md"), "## Permissions\nMay read DMs from the owner.\n\n## Voice\nDry and short.");
    writeFileSync(join(ws, "USER.md"), "## Profile\nLives in Rome.\n\n## Timezone\nEurope/Rome.");
    writeFileSync(join(ws, "AGENTS.md"), "## Operations\nRun the gates.\n\n## Memory\nSearch before rebuilding.");

    const { text } = assemblePersona("principal", ws, paths(home));

    for (const part of ["May read DMs", "Dry and short", "Lives in Rome", "Europe/Rome", "Run the gates", "Search before rebuilding", "I am the principal"]) {
      expect(text).toContain(part);
    }
  });

  // (b) guests behind the wall get identity and profile, nothing else.
  test("walled: only identity and profile, nothing of base, rules, SOUL or AGENTS", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(home, "RULES.md"), "RULE-MARKER");
    writeFileSync(join(ws, "IDENTITY.md"), "IDENT-MARKER");
    writeFileSync(join(ws, "USER.md"), "PROFILE-MARKER");
    writeFileSync(join(ws, "SOUL.md"), "SOUL-MARKER");
    writeFileSync(join(ws, "AGENTS.md"), "AGENTS-MARKER");

    const persona = assemblePersona("guest", ws, paths(home), { walled: true });

    expect(persona.layers.map((l) => l.name)).toEqual(["profile", "identity"]);
    expect(persona.text).toContain("IDENT-MARKER");
    expect(persona.text).toContain("PROFILE-MARKER");
    for (const out of [BASE_SOUL, "RULE-MARKER", "SOUL-MARKER", "AGENTS-MARKER"]) expect(persona.text).not.toContain(out);
  });

  // (c) before the migration the profile comes from the agent's folder; once
  // `<home>/USER.md` exists it wins.
  test("profile falls back to the agent folder until <home>/USER.md exists", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(ws, "USER.md"), "from the agent folder");
    expect(assemblePersona("a", ws, paths(home)).layers[2].content).toBe("from the agent folder");
    writeFileSync(join(home, "USER.md"), "from home");
    expect(assemblePersona("a", ws, paths(home)).layers[2].content).toBe("from home");
  });
});
