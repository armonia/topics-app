/**
 * Il corpo di un comando, e il cancello che lo protegge.
 *
 * Il nome arriva dal CLIENT: senza controllo, un `../` o una barra leggerebbero
 * qualunque file della macchina — la stessa classe di difetto già trovata sulle
 * rotte dei file. Metà di questi test provano che NON si può uscire.
 *
 * @covers SKILL-01, SKILL-02
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { isValidSlashCommandName, readSlashCommandSource, listSlashCommandFiles, disabledSkillNames, isKnownSlashCommand, recordCliSlashCommands, resetCliSlashCommands, engineCommandsFor, recordEngineCommands } from "./slash-command-source";

let home: string;
let cwd: string;
let segreto: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sc-home-"));
  cwd = mkdtempSync(join(tmpdir(), "sc-cwd-"));
  mkdirSync(join(home, ".claude", "commands"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills", "vai"), { recursive: true });
  mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
  writeFileSync(join(home, ".claude", "commands", "recap.md"), "Fai un riassunto in 2 righe.");
  writeFileSync(join(home, ".claude", "skills", "vai", "SKILL.md"), "---\nname: vai\n---\n\nProcedi fino in fondo.");
  writeFileSync(join(cwd, ".claude", "commands", "locale.md"), "comando del progetto");
  segreto = join(tmpdir(), `sc-segreto-${Date.now()}.md`);
  writeFileSync(segreto, "NON DEVE USCIRE");
});

afterAll(() => {
  for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
  rmSync(segreto, { force: true });
});

describe("isValidSlashCommandName", () => {
  test("i nomi veri passano", () => {
    for (const n of ["recap", "vai", "opsx:propose", "jarvis-custom-skills:master", "a_b-c"]) {
      expect(isValidSlashCommandName(n), n).toBe(true);
    }
  });

  test("tutto ciò che può uscire dalla cartella NON passa", () => {
    for (const n of ["../etc/passwd", "a/b", "a\\b", "..", ".", "/abs", "", "1inizia-con-cifra", "a b"]) {
      expect(isValidSlashCommandName(n), n).toBe(false);
    }
  });

  test("un nome assurdo di lunghezza non passa", () => {
    expect(isValidSlashCommandName("a".repeat(200))).toBe(false);
  });
});

describe("readSlashCommandSource", () => {
  test("un comando dell'utente", () => {
    const out = readSlashCommandSource("recap", { home, cwd });
    expect(out?.kind).toBe("command");
    expect(out?.body).toContain("riassunto in 2 righe");
  });

  test("una skill a cartella", () => {
    const out = readSlashCommandSource("vai", { home, cwd });
    expect(out?.kind).toBe("skill");
    expect(out?.body).toContain("Procedi fino in fondo");
  });

  test("un comando del progetto", () => {
    expect(readSlashCommandSource("locale", { home, cwd })?.body).toBe("comando del progetto");
  });

  test("un comando che non esiste", () => {
    expect(readSlashCommandSource("nonesiste", { home, cwd })).toBeNull();
  });

  test("NON si esce dalla cartella con un percorso", () => {
    for (const n of ["../../../etc/passwd", "..%2Fetc", "a/../../b"]) {
      expect(readSlashCommandSource(n, { home, cwd }), n).toBeNull();
    }
  });

  test("NON si esce nemmeno con un link simbolico", () => {
    const link = join(home, ".claude", "commands", "furbo.md");
    symlinkSync(segreto, link);
    expect(readSlashCommandSource("furbo", { home, cwd })).toBeNull();
  });

  test("il corpo si tronca invece di caricare un file enorme", () => {
    writeFileSync(join(home, ".claude", "commands", "grosso.md"), "x".repeat(5000));
    expect(readSlashCommandSource("grosso", { home, cwd, maxBytes: 100 })?.body.length).toBe(100);
  });
});

describe("listSlashCommandFiles", () => {
  test("elenca comandi e skill, senza duplicati", () => {
    const list = listSlashCommandFiles({ home, cwd });
    const names = list.map((x) => x.name).sort();
    expect(names).toContain("recap");
    expect(names).toContain("vai");
    expect(names).toContain("locale");
    expect(new Set(names).size).toBe(names.length);
    expect(list.find((x) => x.name === "vai")?.kind).toBe("skill");
  });
});

describe("skills Claude Code has switched off are not offered", () => {
  // `skillOverrides: { name: "off" }` in the settings the CLI reads. Ten such
  // skills were in the menu on the Mac this was measured on; typing one was a
  // paid turn in which the model said it could not run it.
  test("an override «off» in the user's settings hides the skill, one without stays", () => {
    const h = mkdtempSync(join(tmpdir(), "sc-off-home-"));
    const c = mkdtempSync(join(tmpdir(), "sc-off-cwd-"));
    try {
      for (const name of ["spenta", "accesa"]) {
        mkdirSync(join(h, ".claude", "skills", name), { recursive: true });
        writeFileSync(join(h, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
      }
      writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { spenta: "off", accesa: "on" } }));
      const names = listSlashCommandFiles({ home: h, cwd: c }).map((x) => x.name);
      expect(names).toContain("accesa");
      expect(names).not.toContain("spenta");
    } finally {
      for (const d of [h, c]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("the project's and the local settings are read too, the later winning", () => {
    const h = mkdtempSync(join(tmpdir(), "sc-off-home-"));
    const c = mkdtempSync(join(tmpdir(), "sc-off-cwd-"));
    try {
      mkdirSync(join(h, ".claude"), { recursive: true });
      mkdirSync(join(c, ".claude"), { recursive: true });
      writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { a: "off", b: "off" } }));
      writeFileSync(join(c, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { c: "off" } }));
      writeFileSync(join(c, ".claude", "settings.local.json"), JSON.stringify({ skillOverrides: { b: "on" } }));
      expect([...disabledSkillNames(h, c)].sort()).toEqual(["a", "c"]);
    } finally {
      for (const d of [h, c]) rmSync(d, { recursive: true, force: true });
    }
  });

  test("no settings, or unreadable ones, switch nothing off", () => {
    const h = mkdtempSync(join(tmpdir(), "sc-off-home-"));
    try {
      mkdirSync(join(h, ".claude"), { recursive: true });
      writeFileSync(join(h, ".claude", "settings.json"), "{ non json");
      expect(disabledSkillNames(h, h).size).toBe(0);
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("isKnownSlashCommand", () => {
  test("user commands, user skills, project commands and project skills are known", () => {
    mkdirSync(join(cwd, ".claude", "skills", "del-progetto"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "skills", "del-progetto", "SKILL.md"), "corpo");
    for (const n of ["recap", "vai", "locale", "del-progetto"]) {
      expect(isKnownSlashCommand(n, { home, cwd }), n).toBe(true);
    }
  });

  test("project folders count only when there is a project", () => {
    expect(isKnownSlashCommand("locale", { home, cwd: null })).toBe(false);
    expect(isKnownSlashCommand("vai", { home, cwd: null })).toBe(true);
  });

  test("a namespaced name is a command by its shape", () => {
    expect(isKnownSlashCommand("opsx:propose", { home, cwd })).toBe(true);
  });

  test("a well-formed name that does not exist, like the first segment of /tmp, is not", () => {
    for (const n of ["tmp", "Users", "etc", "inventato"]) {
      expect(isKnownSlashCommand(n, { home, cwd }), n).toBe(false);
    }
  });

  test("an inadmissible name is refused before touching the disk", () => {
    for (const n of ["../commands/recap", "a/b", ""]) {
      expect(isKnownSlashCommand(n, { home, cwd }), n).toBe(false);
    }
  });
});

describe("the CLI's own list of slash commands (system/init)", () => {
  const init = (slash_commands: unknown) => ({ type: "system", subtype: "init", session_id: "s", slash_commands });

  test("a bundled skill the disk does not know is known once the session's init has listed it", () => {
    resetCliSlashCommands();
    expect(isKnownSlashCommand("simplify", { home, cwd, cliSessionKey: "topic:a" })).toBe(false);
    recordCliSlashCommands("topic:a", init(["compact", "simplify", "/code-review", "loop", "claude-api", "plugin-skill"]));
    for (const n of ["simplify", "code-review", "loop", "claude-api", "plugin-skill"]) {
      expect(isKnownSlashCommand(n, { home, cwd, cliSessionKey: "topic:a" }), n).toBe(true);
    }
    // A pasted path is still not a command: the CLI did not list it.
    expect(isKnownSlashCommand("tmp", { home, cwd, cliSessionKey: "topic:a" })).toBe(false);
  });

  test("a session that has not spoken yet (its first turn) borrows the latest list", () => {
    resetCliSlashCommands();
    recordCliSlashCommands("topic:a", init(["simplify"]));
    expect(isKnownSlashCommand("simplify", { home, cwd, cliSessionKey: "topic:new" })).toBe(true);
  });

  test("a session's own list wins over the latest one, and the disk still answers after it", () => {
    resetCliSlashCommands();
    recordCliSlashCommands("topic:a", init(["only-in-a"]));
    recordCliSlashCommands("topic:b", init(["only-in-b"]));
    expect(isKnownSlashCommand("only-in-a", { home, cwd, cliSessionKey: "topic:a" })).toBe(true);
    expect(isKnownSlashCommand("only-in-b", { home, cwd, cliSessionKey: "topic:a" })).toBe(false);
    expect(isKnownSlashCommand("recap", { home, cwd, cliSessionKey: "topic:a" })).toBe(true);
  });

  test("without a claude-code session key only the disk answers", () => {
    resetCliSlashCommands();
    recordCliSlashCommands("topic:a", init(["simplify"]));
    expect(isKnownSlashCommand("simplify", { home, cwd })).toBe(false);
  });

  test("lines that are not an init with a list record nothing", () => {
    resetCliSlashCommands();
    recordCliSlashCommands("topic:a", { type: "system", subtype: "compact_boundary", slash_commands: ["x1"] });
    recordCliSlashCommands("topic:a", init("simplify"));
    recordCliSlashCommands("topic:a", init([42, "../etc", ""]));
    recordCliSlashCommands("topic:a", null);
    expect(isKnownSlashCommand("x1", { home, cwd, cliSessionKey: "topic:a" })).toBe(false);
    expect(isKnownSlashCommand("simplify", { home, cwd, cliSessionKey: "topic:a" })).toBe(false);
  });
});

describe("a skill switched off is not a command the CLI expands", () => {
  test("isKnownSlashCommand says no for a skill «off» in skillOverrides, on disk or in the CLI's list", () => {
    const h = mkdtempSync(join(tmpdir(), "sc-offknown-home-"));
    const c = mkdtempSync(join(tmpdir(), "sc-offknown-cwd-"));
    try {
      for (const name of ["spenta", "accesa"]) {
        mkdirSync(join(h, ".claude", "skills", name), { recursive: true });
        writeFileSync(join(h, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
      }
      writeFileSync(join(h, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { spenta: "off" } }));
      resetCliSlashCommands();
      recordCliSlashCommands("topic:off", { type: "system", subtype: "init", slash_commands: ["spenta", "accesa"] });
      expect(isKnownSlashCommand("accesa", { home: h, cwd: c, cliSessionKey: "topic:off" })).toBe(true);
      expect(isKnownSlashCommand("spenta", { home: h, cwd: c })).toBe(false);
      expect(isKnownSlashCommand("spenta", { home: h, cwd: c, cliSessionKey: "topic:off" })).toBe(false);
      // The project's own settings switch it off too.
      mkdirSync(join(c, ".claude"), { recursive: true });
      writeFileSync(join(c, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { accesa: "off" } }));
      expect(isKnownSlashCommand("accesa", { home: h, cwd: c })).toBe(false);
    } finally {
      resetCliSlashCommands();
      for (const d of [h, c]) rmSync(d, { recursive: true, force: true });
    }
  });
});

/** @covers CMDUI-01 */
describe("the engine's list for the menu: the session's, then its project's, then the engine's", () => {
  test("init gives the names, commands_changed the descriptions, and a later init keeps them", () => {
    resetCliSlashCommands();
    recordCliSlashCommands("topic:m", { type: "system", subtype: "commands_changed", commands: [{ name: "init", description: "Initialize", builtin: true }, { name: "vai", description: "Procedi" }] });
    recordCliSlashCommands("topic:m", { type: "system", subtype: "init", cwd: "/p/uno", slash_commands: ["init", "vai", "simplify"] });
    const found = engineCommandsFor({ sessionKey: "topic:m", provider: "claude-code" })!;
    expect(found.from).toBe("session");
    const list = found.commands;
    expect(list.map((c) => c.name)).toEqual(["init", "vai", "simplify"]);
    expect(list[0]).toMatchObject({ description: "Initialize", builtin: true });
  });

  test("a chat that has not started its CLI borrows its project's list, then the engine's; another engine has none", () => {
    resetCliSlashCommands();
    recordCliSlashCommands("topic:a", { type: "system", subtype: "init", cwd: "/p/uno", slash_commands: ["only-uno"] });
    recordCliSlashCommands("topic:b", { type: "system", subtype: "init", cwd: "/p/due", slash_commands: ["only-due"] });
    expect(engineCommandsFor({ sessionKey: "topic:new", provider: "claude-code", projectPath: "/p/uno" })).toMatchObject({ from: "project", commands: [{ name: "only-uno" }] });
    // Another project's list is marked as such: the menu keeps only the CLI's own names from it.
    expect(engineCommandsFor({ sessionKey: "topic:new", provider: "claude-code", projectPath: "/p/tre" })).toMatchObject({ from: "engine", commands: [{ name: "only-due" }] });
    expect(engineCommandsFor({ sessionKey: "topic:new", provider: "gemini" })).toBeNull();
    recordEngineCommands("topic:g", [{ name: "memory", description: "Memory" }], { provider: "gemini", projectPath: "/p/uno" });
    expect(engineCommandsFor({ provider: "gemini", projectPath: "/p/uno" })!.commands.map((c) => c.name)).toEqual(["memory"]);
  });

  test("nothing seen since the start: no list, and nothing is spawned to get one", () => {
    resetCliSlashCommands();
    expect(engineCommandsFor({ sessionKey: "topic:x", provider: "claude-code", projectPath: "/p/uno" })).toBeNull();
  });
});
