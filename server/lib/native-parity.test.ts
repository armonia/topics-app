/**
 * The contract of the two blocks that bring the native runtime level with the CLI.
 *
 * The case that matters is the expansion of `@path`: without it the rules block
 * arrives halved and nobody notices — the text is there, it is the rules that
 * are missing.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUserRules, listSkills, skillsBlock, thinkingBudgetFor } from "./native-parity";

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
  const skill = (nome: string, desc: string) => {
    const dir = join(home, ".claude", "skills", nome);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${nome}\ndescription: ${desc}\n---\n\ncorpo lungo\n`);
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

describe("thinkingBudgetFor", () => {
  it("low non è «poco pensiero», è nessuno: sotto 1024 l'API rifiuta", () => {
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

describe("listSkills — i casi che le facevano sparire", () => {
  const skillLink = (nome: string, desc: string) => {
    const vero = join(home, "altrove", nome);
    mkdirSync(vero, { recursive: true });
    writeFileSync(join(vero, "SKILL.md"), `---\nname: ${nome}\ndescription: ${desc}\n---\ncorpo\n`);
    symlinkSync(vero, join(home, ".claude", "skills", nome));
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
