/**
 * @covers TRASH-01
 */
import { test, expect, describe } from "bun:test";
import { homeTrashDir, uniqueTrashName, moveToTrash, moveToTrashDir } from "./trash";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("homeTrashDir", () => {
  test("su macOS e' ~/.Trash", () => {
    expect(homeTrashDir("darwin", { HOME: "/Users/x" })).toBe("/Users/x/.Trash");
  });

  test("su Linux segue XDG", () => {
    expect(homeTrashDir("linux", { HOME: "/home/x" })).toBe("/home/x/.local/share/Trash");
    expect(homeTrashDir("linux", { HOME: "/home/x", XDG_DATA_HOME: "/dati" })).toBe("/dati/Trash");
  });

  test("senza HOME non inventa un percorso", () => {
    expect(homeTrashDir("darwin", {})).toBeNull();
  });
});

describe("uniqueTrashName", () => {
  test("se il nome e' libero lo tiene", () => {
    expect(uniqueTrashName("/t", "a.txt", () => false)).toBe("a.txt");
  });

  test("su collisione numera PRIMA dell'estensione", () => {
    // Nel cestino arrivano file da cartelle diverse: due `index.ts` si
    // incontrano di continuo, e sovrascrivere sarebbe un altro modo di perdere
    // roba. `index 2.ts`, non `index.ts 2`.
    const presi = new Set(["/t/index.ts"]);
    expect(uniqueTrashName("/t", "index.ts", p => presi.has(p))).toBe("index 2.ts");
  });

  test("continua a contare finche' non trova posto", () => {
    const presi = new Set(["/t/a.txt", "/t/a 2.txt", "/t/a 3.txt"]);
    expect(uniqueTrashName("/t", "a.txt", p => presi.has(p))).toBe("a 4.txt");
  });

  test("un nome senza estensione non ne guadagna una", () => {
    const presi = new Set(["/t/LICENSE"]);
    expect(uniqueTrashName("/t", "LICENSE", p => presi.has(p))).toBe("LICENSE 2");
  });
});

describe("moveToTrash", () => {
  test("un file che non esiste e' un errore, non un successo silenzioso", async () => {
    const r = await moveToTrash(join(tmpdir(), `non-esiste-${Date.now()}`));
    expect(r.ok).toBe(false);
    expect(r.error).toContain("non esiste");
  });

  test("il file sparisce da dove stava", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trash-test-"));
    const file = join(dir, `da-cestinare-${Date.now()}.txt`);
    writeFileSync(file, "contenuto\n");

    const r = await moveToTrash(file);
    expect(r.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    // Dove sia finito non si puo' verificare da qui: leggere `~/.Trash` su
    // macOS richiede Full Disk Access. Che sia un cestino e non un `rm` lo
    // prova il test su `moveToTrashDir`, dove la radice la scegliamo noi.
    if (r.target) rmSync(r.target, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("moveToTrashDir", () => {
  test("sposta, non cancella: il contenuto e' ancora li'", () => {
    const dir = mkdtempSync(join(tmpdir(), "trash-src-"));
    const cestino = mkdtempSync(join(tmpdir(), "trash-dst-"));
    const file = join(dir, "importante.txt");
    writeFileSync(file, "contenuto che non va perso\n");

    const r = moveToTrashDir(file, cestino, false);
    expect(r.ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(r.target!, "utf8")).toBe("contenuto che non va perso\n");

    rmSync(dir, { recursive: true, force: true });
    rmSync(cestino, { recursive: true, force: true });
  });

  test("due file con lo stesso nome non si sovrascrivono", () => {
    const cestino = mkdtempSync(join(tmpdir(), "trash-dst-"));
    const a = mkdtempSync(join(tmpdir(), "trash-a-"));
    const b = mkdtempSync(join(tmpdir(), "trash-b-"));
    writeFileSync(join(a, "index.ts"), "primo\n");
    writeFileSync(join(b, "index.ts"), "secondo\n");

    const r1 = moveToTrashDir(join(a, "index.ts"), cestino, false);
    const r2 = moveToTrashDir(join(b, "index.ts"), cestino, false);
    expect(r1.target).not.toBe(r2.target);
    expect(readFileSync(r1.target!, "utf8")).toBe("primo\n");
    expect(readFileSync(r2.target!, "utf8")).toBe("secondo\n");

    for (const d of [cestino, a, b]) rmSync(d, { recursive: true, force: true });
  });

  test("una cartella intera arriva con dentro le sue cose", () => {
    const dir = mkdtempSync(join(tmpdir(), "trash-src-"));
    const cestino = mkdtempSync(join(tmpdir(), "trash-dst-"));
    const sotto = join(dir, "cartella");
    mkdirSync(sotto, { recursive: true });
    writeFileSync(join(sotto, "dentro.txt"), "x\n");

    const r = moveToTrashDir(sotto, cestino, false);
    expect(r.ok).toBe(true);
    expect(existsSync(join(r.target!, "dentro.txt"))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
    rmSync(cestino, { recursive: true, force: true });
  });

  test("in forma XDG scrive anche il .trashinfo con il path di partenza", () => {
    // Senza, il file e' nel cestino ma «Rimetti a posto» non sa dove rimetterlo.
    const dir = mkdtempSync(join(tmpdir(), "trash-src-"));
    const cestino = mkdtempSync(join(tmpdir(), "trash-dst-"));
    const file = join(dir, "nota.md");
    writeFileSync(file, "x\n");

    const r = moveToTrashDir(file, cestino, true);
    expect(r.ok).toBe(true);
    expect(r.target).toBe(join(cestino, "files", "nota.md"));
    expect(readFileSync(join(cestino, "info", "nota.md.trashinfo"), "utf8")).toContain(`Path=${file}`);

    rmSync(dir, { recursive: true, force: true });
    rmSync(cestino, { recursive: true, force: true });
  });

  test("se non ci riesce lo DICE, non cancella per ripiego", () => {
    const cestino = mkdtempSync(join(tmpdir(), "trash-dst-"));
    const r = moveToTrashDir(join(tmpdir(), `mai-esistito-${Date.now()}`), cestino, false);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    rmSync(cestino, { recursive: true, force: true });
  });
});
