/**
 * The contract of the two blocks that bring the native runtime level with the CLI.
 *
 * The case that matters is the expansion of `@path`: without it the rules block
 * arrives halved and nobody notices — the text is there, it is the rules that
 * are missing.
 *
 * @covers NATIVE-CTX-01, NATIVE-SKILL-01, NATIVE-EFFORT-01, NATIVE-MEM-01
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeMemoryDir, readClaudeMemoryIndex, recallMemories, nativeWorkingDir,
  readUserRules, readUserRulesSource, listSkills, skillsBlock, thinkingBudgetFor, thinkingConfigFor, clampMaxTokens, DEFAULT_MAX_TOKENS,
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

describe("le regole vengono dall'hub ~/.agents quando c'e'", () => {
  it("legge ~/.agents/AGENTS.md e non CLAUDE.md: una copia sola, quella che leggono gli altri harness", () => {
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "regola vecchia\n@~/.claude/TOOLS.md\n");
    writeFileSync(join(home, ".claude", "TOOLS.md"), "usa trash, non rm");
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(join(home, ".agents", "AGENTS.md"), "regola dall'hub\nusa trash, non rm\n<!-- attention-span:start -->stile<!-- attention-span:end -->\n");
    const rules = readUserRulesSource(home)!;
    expect(rules.path).toBe(join(home, ".agents", "AGENTS.md"));
    expect(rules.content).toContain("regola dall'hub");
    expect(rules.content).toContain("attention-span:start");
    // No duplicate: CLAUDE.md is not added on top of the hub.
    expect(rules.content).not.toContain("regola vecchia");
  });

  it("senza hub ricade su CLAUDE.md, cosi' una macchina senza ~/.agents non perde le regole", () => {
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "regola locale\n");
    expect(readUserRulesSource(home)).toEqual({ path: join(home, ".claude", "CLAUDE.md"), content: "regola locale\n" });
  });

  it("le skill vengono dall'hub, che e' la fonte di ~/.claude/skills", () => {
    const dir = join(home, ".agents", "skills", "dall-hub");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: dall-hub\ndescription: viene dall'hub\n---\n");
    mkdirSync(join(home, ".claude", "skills", "solo-locale"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "solo-locale", "SKILL.md"), "---\nname: solo-locale\ndescription: x\n---\n");
    expect(listSkills(home).map((s) => s.name)).toEqual(["dall-hub"]);
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

  /** @covers SKILL-01 */
  it("a skill switched off in skillOverrides is not listed, nor in the prompt block", () => {
    skill("accesa", "resta");
    skill("spenta", "esce");
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { spenta: "off" } }));
    expect(listSkills(home).map((s) => s.name)).toEqual(["accesa"]);
    expect(skillsBlock(home)).not.toContain("spenta");
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

  it("an id nobody has listed yet is adaptive unless it is explicitly legacy", () => {
    for (const model of ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-4-7", "claude-haiku-5"]) {
      expect(thinkingConfigFor(model, "high").thinking, model).toEqual({ type: "adaptive" });
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

describe("Claude Code's memory on the native runtime", () => {
  const enc = (p: string) => p.replace(/[/.]/g, "-");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  let savedPath: string | undefined;
  let savedOff: string | undefined;
  beforeEach(() => {
    savedPath = process.env.PATH;
    savedOff = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedOff === undefined) delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
    else process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = savedOff;
  });

  it("the memory folder is the repo's, from a subfolder and from a worktree too", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "memrepo-")));
    try {
      git(repo, "init", "-q");
      git(repo, "commit", "-q", "--allow-empty", "-m", "x");
      mkdirSync(join(repo, "sub"));
      const wt = join(repo, "..", `${repo.split("/").pop()}-wt`);
      git(repo, "worktree", "add", "-q", wt);
      const want = join(home, ".claude", "projects", enc(repo), "memory");
      expect(claudeMemoryDir(join(repo, "sub"), home)).toBe(want);
      expect(claudeMemoryDir(wt, home)).toBe(want);
      rmSync(wt, { recursive: true, force: true });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("outside git the memory folder is the folder itself (the home, for a chat with no project)", () => {
    expect(claudeMemoryDir(home, home)).toBe(join(home, ".claude", "projects", enc(home), "memory"));
  });

  it("without a project the native turn runs in TOPICS_WORKSPACE", () => {
    const saved = process.env.TOPICS_WORKSPACE;
    process.env.TOPICS_WORKSPACE = "/ws";
    try {
      expect(nativeWorkingDir(null)).toBe("/ws");
      expect(nativeWorkingDir("/p")).toBe("/p");
    } finally {
      if (saved === undefined) delete process.env.TOPICS_WORKSPACE; else process.env.TOPICS_WORKSPACE = saved;
    }
  });

  it("the index is read and cut at Claude Code's 200 lines", () => {
    const dir = claudeMemoryDir(home, home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), Array.from({ length: 250 }, (_, i) => `- riga ${i}`).join("\n"));
    const idx = readClaudeMemoryIndex(home, home)!;
    expect(idx.path).toBe(join(dir, "MEMORY.md"));
    expect(idx.content).toContain("- riga 199");
    expect(idx.content).not.toContain("- riga 200");
  });

  it("CLAUDE_CODE_DISABLE_AUTO_MEMORY turns index and recall off, as it does for `claude`", async () => {
    const dir = claudeMemoryDir(home, home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "- qualcosa");
    // a memrecall that always answers: only the switch can make the recall silent
    fakeMemrecall(`printf '%s' '{"hookSpecificOutput":{"additionalContext":"- scheda.md"}}'`);
    process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    expect(readClaudeMemoryIndex(home, home)).toBeNull();
    expect(await recallMemories("una domanda qualunque", home, home)).toBeNull();
  });

  /** A fake `memrecall` in the user's bin, the folder launchd's PATH does not have. */
  function fakeMemrecall(body: string): string {
    mkdirSync(join(home, "bin"), { recursive: true });
    const bin = join(home, "bin", "memrecall");
    writeFileSync(bin, `#!/bin/sh\n${body}\n`);
    chmodSync(bin, 0o755);
    process.env.PATH = "/usr/bin:/bin";
    return bin;
  }

  it("the recall gets the hook's JSON and returns its additionalContext", async () => {
    const seen = join(home, "stdin.json");
    fakeMemrecall(`cat > ${seen}; printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"- scheda.md: utile"}}'`);
    expect(await recallMemories("come faccio il deploy", "/p", home)).toBe("- scheda.md: utile");
    expect(JSON.parse(readFileSync(seen, "utf-8"))).toEqual({ prompt: "come faccio il deploy", cwd: "/p" });
  });

  it("no memrecall, a failure or an empty answer: no recall, and the turn goes on", async () => {
    process.env.PATH = "/usr/bin:/bin";
    expect(await recallMemories("domanda", "/p", home)).toBeNull();
    fakeMemrecall("exit 2");
    expect(await recallMemories("domanda", "/p", home)).toBeNull();
    fakeMemrecall("exit 0");
    expect(await recallMemories("domanda", "/p", home)).toBeNull();
  });
});
