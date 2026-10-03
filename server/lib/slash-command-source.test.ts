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
import { isValidSlashCommandName, readSlashCommandSource, listSlashCommandFiles, isKnownSlashCommand, recordCliSlashCommands, resetCliSlashCommands } from "./slash-command-source";

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
