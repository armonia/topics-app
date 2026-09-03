/**
 * The contract of the two blocks that bring the native runtime level with the CLI.
 *
 * The case that matters is the expansion of `@path`: without it the rules block
 * arrives halved and nobody notices — the text is there, it is the rules that
 * are missing.
 *
 * @covers NATIVE-CTX-01, NATIVE-SKILL-01, NATIVE-EFFORT-01
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readUserRules, listSkills, skillsBlock, thinkingBudgetFor, thinkingConfigFor, clampMaxTokens, DEFAULT_MAX_TOKENS,
} from "./native-parity";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "parity-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("readUserRules", () => {
  it("torna null se il file non c'è (non una stringa vuota: chi chiama deve poter saltare il blocco)", () => {
    expect(readUserRules(home)).toBeNull();
  });

  it("espande un import @~/... perché è lì che stanno le regole vere", () => {
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Regole\n@~/.claude/TOOLS.md\nfine\n");
    writeFileSync(join(home, ".claude", "TOOLS.md"), "usa trash, non rm");
    const out = readUserRules(home)!;
    expect(out).toContain("usa trash, non rm");
    expect(out).not.toContain("@~/.claude/TOOLS.md");
    expect(out).toContain("fine");
  });

  it("un import che non esiste resta scritto com'era invece di sparire", () => {
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "@~/manca.md\n");
    expect(readUserRules(home)).toContain("@~/manca.md");
  });
});

describe("listSkills", () => {
  const skill = (name: string, description: string) => {
    const dir = join(home, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\ncorpo lungo\n`);
  };

  it("prende nome e descrizione dal frontmatter, in ordine", () => {
    skill("zebra", "l'ultima");
    skill("alfa", "la prima");
    expect(listSkills(home).map((s) => s.name)).toEqual(["alfa", "zebra"]);
    expect(listSkills(home)[0]!.description).toBe("la prima");
  });

  it("taglia le descrizioni lunghe: l'elenco si paga a ogni turno", () => {
    skill("prolissa", "x".repeat(400));
    expect(listSkills(home)[0]!.description.length).toBeLessThanOrEqual(181);
  });

  it("il CORPO non entra nell'elenco: quello lo carica il tool skill", () => {
    skill("qualcosa", "fa qualcosa");
    expect(skillsBlock(home)).not.toContain("corpo lungo");
    expect(skillsBlock(home)).toContain("qualcosa: fa qualcosa");
  });

  it("nessuna skill installata = nessun blocco, non un titolo vuoto", () => {
    expect(skillsBlock(home)).toBe("");
  });
});

describe("thinkingBudgetFor (solo per i modelli vecchi)", () => {
  it("low sui modelli a budget e' nessun pensiero: sotto 1024 l'API rifiuta", () => {
    expect(thinkingBudgetFor("low")).toBe(0);
  });
  it("la scala cresce con il tier", () => {
    const s = ["medium", "high", "xhigh", "max"].map(thinkingBudgetFor);
    expect(s).toEqual([...s].sort((a, b) => a - b));
    expect(s[0]).toBeGreaterThan(1024);
  });
  it("un tier sconosciuto o assente non accende il thinking di nascosto", () => {
    expect(thinkingBudgetFor(null)).toBe(0);
    expect(thinkingBudgetFor("turbo")).toBe(0);
  });
});

/**
 * THE SLIDER HAS TO MOVE THE RIGHT PARAMETER, and which one depends on the
 * generation. Measured on 2026-09-03: with the default `claude-sonnet-5` the
 * loop sent `{type: "enabled", budget_tokens}`, which that family rejects, and
 * `low` sent no thinking at all where thinking cannot be switched off.
 */
describe("thinkingConfigFor", () => {
  it("la famiglia 5 prende adaptive + output_config.effort, per TUTTI i tier, low compreso", () => {
    for (const model of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-7", "claude-opus-4-8"]) {
      for (const tier of ["low", "medium", "high", "xhigh", "max"]) {
        const c = thinkingConfigFor(model, tier);
        expect(c.thinking, `${model}/${tier}`).toEqual({ type: "adaptive" });
        expect(c.output_config, `${model}/${tier}`).toEqual({ effort: tier });
        expect(c.minMaxTokens).toBe(0);
      }
    }
  });

  it("low sulla famiglia 5 NON e' «nessun pensiero»: Fable rifiuta disabled, Opus 5 lo rifiuta a xhigh/max", () => {
    const c = thinkingConfigFor("claude-fable-5", "low");
    expect(c.thinking).toEqual({ type: "adaptive" });
    expect(c.output_config).toEqual({ effort: "low" });
  });

  it("il suffisso [1m] e' nostro e non cambia la generazione", () => {
    expect(thinkingConfigFor("claude-opus-5[1m]", "high")).toEqual(thinkingConfigFor("claude-opus-5", "high"));
  });

  it("la 4.6 vuole adaptive ESPLICITO e non conosce xhigh: si abbassa a high", () => {
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(thinkingConfigFor(model, "xhigh")).toEqual({
        thinking: { type: "adaptive" }, output_config: { effort: "high" }, minMaxTokens: 0,
      });
      expect(thinkingConfigFor(model, "max").output_config).toEqual({ effort: "max" });
    }
  });

  it("un tier assente o sconosciuto sulla famiglia 5 lascia decidere il modello: adaptive, nessun effort", () => {
    for (const tier of [null, undefined, "turbo", ""]) {
      const c = thinkingConfigFor("claude-opus-5", tier);
      expect(c.thinking).toEqual({ type: "adaptive" });
      expect("output_config" in c).toBe(false);
    }
  });

  it("i modelli vecchi restano a budget_tokens, senza output_config, e low li lascia senza pensiero", () => {
    for (const model of ["claude-haiku-4-5-20251001", "claude-sonnet-4-5", "claude-opus-4-1", "modello-mai-visto"]) {
      const high = thinkingConfigFor(model, "high");
      expect(high.thinking).toEqual({ type: "enabled", budget_tokens: 10_000 });
      expect("output_config" in high).toBe(false);
      // The budget has to fit under the cap: the floor says by how much.
      expect(high.minMaxTokens).toBe(10_000 + 4096);
      const low = thinkingConfigFor(model, "low");
      expect("thinking" in low).toBe(false);
      expect(low.minMaxTokens).toBe(0);
    }
  });
});

/**
 * 16384 was half the CLI's cap: a `write_file` above ~16k tokens could never
 * succeed here while it did on the CLI.
 */
describe("clampMaxTokens", () => {
  it("il default e' quello del catalogo CLI, 64k", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(64_000);
    expect(clampMaxTokens(undefined)).toBe(64_000);
    expect(clampMaxTokens(null)).toBe(64_000);
  });
  it("un valore impostato passa, dentro [1024, 128000]", () => {
    expect(clampMaxTokens(32_000)).toBe(32_000);
    expect(clampMaxTokens(10)).toBe(1_024);
    expect(clampMaxTokens(999_999)).toBe(128_000);
  });
  it("un valore scritto male non diventa una richiesta rifiutata", () => {
    expect(clampMaxTokens(Number.NaN)).toBe(64_000);
    expect(clampMaxTokens(-5)).toBe(64_000);
  });
});

describe("listSkills — i casi che le facevano sparire", () => {
  const skillLink = (name: string, description: string) => {
    const realDir = join(home, "altrove", name);
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\ncorpo\n`);
    symlinkSync(realDir, join(home, ".claude", "skills", name));
  };

  it("una skill raggiunta da un SYMLINK non è meno installata: 31 su 43 sparivano così", () => {
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    skillLink("linkata", "arriva da un link");
    expect(listSkills(home).map((s) => s.name)).toContain("linkata");
  });

  it("legge una description scritta come blocco YAML (`|`), non la stringa «|»", () => {
    const dir = join(home, ".claude", "skills", "bloccata");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"),
      "---\nname: bloccata\ndescription: |\n  prima riga\n  seconda riga\n---\ncorpo\n");
    expect(listSkills(home)[0]!.description).toBe("prima riga seconda riga");
  });
});
