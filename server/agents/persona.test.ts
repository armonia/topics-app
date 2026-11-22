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
  test("layers come in order: base, user, identity, agent — each once", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(home, "USER.md"), "The user works in Rome, Italy.");
    writeFileSync(join(ws, "IDENTITY.md"), "# Scout\nFinds things fast.");
    writeFileSync(join(ws, "SOUL.md"), "Never names a real person in a commit.");

    const persona = assemblePersona("scout", ws, paths(home));

    expect(persona.layers.map((l) => l.name)).toEqual([...PERSONA_LAYER_NAMES]);
    expect(new Set(persona.layers.map((l) => l.name)).size).toBe(persona.layers.length);
    expect(persona.layers[0].content).toBe(BASE_SOUL);
    expect(persona.layers[1].content).toBe("The user works in Rome, Italy.");
    expect(persona.layers[2].content).toBe("# Scout\nFinds things fast.");
    expect(persona.layers[3].content).toBe("Never names a real person in a commit.");
    expect(persona.text.indexOf(BASE_SOUL)).toBeLessThan(persona.text.indexOf("Rome"));
    expect(persona.text.indexOf("Rome")).toBeLessThan(persona.text.indexOf("Scout"));
    expect(persona.text.indexOf("Scout")).toBeLessThan(persona.text.indexOf("real person"));
  });

  test("an agent with only IDENTITY.md still receives base + user + its name", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(ws, "IDENTITY.md"), "# Lone agent\nDoes one thing.");

    const persona = assemblePersona("lone", ws, paths(home));

    expect(persona.layers).toHaveLength(4);
    expect(persona.layers[0].content).toBe(BASE_SOUL); // base, always shipped
    expect(persona.layers[1].content).toBe(""); // no USER.md configured
    expect(persona.layers[2].content).toContain("Lone agent");
    expect(persona.layers[3].content).toBe(""); // no agent-specific additions
    expect(persona.text).toContain(BASE_SOUL);
    expect(persona.text).toContain("Lone agent");
  });

  test("missing files mean empty layers, never a throw", () => {
    const home = tmp();
    const ws = join(tmpdir(), "does-not-exist-" + Math.random());
    expect(() => assemblePersona("ghost", ws, paths(home))).not.toThrow();
    const persona = assemblePersona("ghost", ws, paths(home));
    expect(persona.layers[2].content).toBe("");
    expect(persona.layers[3].content).toBe("");
  });

  test("token weight scales with each layer's own content, not the whole text", () => {
    const home = tmp();
    const ws = tmp();
    writeFileSync(join(ws, "IDENTITY.md"), "x".repeat(400));

    const persona = assemblePersona("heavy", ws, paths(home));

    expect(persona.layers[2].tokens).toBe(100); // 400 chars / 4
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
});
