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
import { isValidSlashCommandName, readSlashCommandSource, listSlashCommandFiles } from "./slash-command-source";

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
