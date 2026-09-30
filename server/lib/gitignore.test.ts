/**
 * @covers GIT-IGNORE-01
 */
/** I casi vengono dal `.gitignore` di questo repo, dove il vecchio parse
 *  faceva sparire file che git traccia. */
import { test, expect } from "bun:test";
import { IgnoreSet } from "./gitignore";

test("una regola ancorata non colpisce le omonime in profondità", () => {
  const ig = new IgnoreSet().addFile("/data/\n");
  expect(ig.ignores("data", true)).toBe(true);
  expect(ig.ignores("data/topics.db", false)).toBe(true);
  // Il caso che faceva sparire `landing/src/data/`, che git traccia.
  expect(ig.ignores("landing/src/data", true)).toBe(false);
  expect(ig.ignores("landing/src/data/changelog.json", false)).toBe(false);
});

test("una regola senza slash vale a qualunque profondità", () => {
  const ig = new IgnoreSet().addFile("node_modules/\n");
  expect(ig.ignores("node_modules", true)).toBe(true);
  expect(ig.ignores("client/node_modules", true)).toBe(true);
  expect(ig.ignores("a/b/c/node_modules", true)).toBe(true);
});

test("la negazione riapre ciò che una riga prima aveva chiuso", () => {
  const ig = new IgnoreSet().addFile("tests/\n!tests/\n");
  expect(ig.ignores("tests", true)).toBe(false);
  // Prima `!tests/` finiva nel set come un pattern chiamato `!tests`, che non
  // matchava niente, e `tests/` restava escluso.
  expect(ig.size).toBe(2);
});

test("vince l'ultima regola che matcha, non la prima", () => {
  const ig = new IgnoreSet().addFile("*.log\n!importante.log\ndebug/*.log\n");
  expect(ig.ignores("app.log", false)).toBe(true);
  expect(ig.ignores("importante.log", false)).toBe(false);
  expect(ig.ignores("debug/x.log", false)).toBe(true);
});

test("le wildcard IN MEZZO al nome funzionano", () => {
  const ig = new IgnoreSet().addFile("tabbar-*.png\n");
  expect(ig.ignores("tabbar-01.png", false)).toBe(true);
  expect(ig.ignores("shots/tabbar-01.png", false)).toBe(true);
  expect(ig.ignores("tabbar.png", false)).toBe(false);
  // Il vecchio matcher aveva solo i rami `*.ext` e `prefisso*`, quindi questo
  // pattern non ha mai escluso niente.
  expect(ig.ignores("altro-01.png", false)).toBe(false);
});

test("`*` non attraversa le cartelle, `**` sì", () => {
  const a = new IgnoreSet().addFile("src/*.ts\n");
  expect(a.ignores("src/index.ts", false)).toBe(true);
  expect(a.ignores("src/deep/index.ts", false)).toBe(false);

  const b = new IgnoreSet().addFile("src/**/*.ts\n");
  expect(b.ignores("src/deep/index.ts", false)).toBe(true);
  expect(b.ignores("src/a/b/c.ts", false)).toBe(true);
});

test("`pattern/` vale solo per le cartelle", () => {
  const ig = new IgnoreSet().addFile("build/\n");
  expect(ig.ignores("build", true)).toBe(true);
  // Un FILE che si chiama `build` non è escluso da `build/`.
  expect(ig.ignores("build", false)).toBe(false);
});

test("escludere una cartella esclude i suoi discendenti", () => {
  const ig = new IgnoreSet().addFile("dist\n");
  expect(ig.ignores("dist/assets/app.js", false)).toBe(true);
});

test("commenti, righe vuote e spazi in coda", () => {
  const ig = new IgnoreSet().addFile("# un commento\n\n   \ntmp\n");
  expect(ig.size).toBe(1);
  expect(ig.ignores("tmp", true)).toBe(true);
});

test("un .gitignore annidato vale solo dalla sua cartella in giù", () => {
  const ig = new IgnoreSet().addFile("*.snap\n", "client/src/__tests__");
  expect(ig.ignores("client/src/__tests__/a.snap", false)).toBe(true);
  expect(ig.ignores("client/src/__tests__/deep/a.snap", false)).toBe(true);
  // Fuori dalla sua cartella non tocca niente.
  expect(ig.ignores("server/a.snap", false)).toBe(false);
});

test("il set si clona senza che il figlio sporchi il padre", () => {
  const parent = new IgnoreSet().addFile("a\n");
  const child = parent.clone().addFile("b\n");
  expect(child.ignores("b", false)).toBe(true);
  expect(parent.ignores("b", false)).toBe(false);
});

test("the merged rules answer exactly like the rules one at a time", () => {
  // Deterministic fuzz: rule files drawn from a pool that mixes every shape
  // the compiler treats differently (plain names, globs, folder-only,
  // anchored, nested base, negation runs), checked against paths from a pool.
  const patterns = [
    "node_modules/", "dist", "*.log", "!keep.log", "/data/", "data", "build/", "!build/",
    "tabbar-*.png", "src/*.ts", "src/**/*.ts", "**/cache", "a?c", "[ab]*.txt", "!a", "a/",
    "deep/", "!deep/keep", "x/y/", ".env", "!.env.example", "*.gen.ts", "\\!bang", "sp\\ ace",
  ];
  const segs = ["a", "b", "abc", "data", "build", "src", "deep", "keep", "keep.log", "x.log",
    "tabbar-1.png", "dist", "node_modules", "cache", "y", "x", "f.ts", "f.gen.ts", ".env",
    ".env.example", "a.txt", "!bang", "sp ace", "line\nbreak"];
  let seed = 42;
  const nextRandom = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let checked = 0;
  for (let round = 0; round < 60; round++) {
    const set = new IgnoreSet();
    const files = 1 + nextRandom(3);
    for (let f = 0; f < files; f++) {
      const lines = Array.from({ length: 2 + nextRandom(10) }, () => patterns[nextRandom(patterns.length)]);
      set.addFile(lines.join("\n"), f === 0 ? "" : ["src", "a/b", "deep"][nextRandom(3)]);
    }
    for (let p = 0; p < 200; p++) {
      const path = Array.from({ length: 1 + nextRandom(4) }, () => segs[nextRandom(segs.length)]).join("/");
      for (const isDir of [true, false]) {
        expect([path, isDir, set.ignores(path, isDir)]).toEqual([path, isDir, set.ignoresRuleByRule(path, isDir)]);
        checked++;
      }
    }
  }
  expect(checked).toBe(24_000);
});

test("adding rules after a lookup recompiles them", () => {
  const ig = new IgnoreSet().addFile("a\n");
  expect(ig.ignores("b", false)).toBe(false);
  ig.addFile("b\n");
  expect(ig.ignores("b", false)).toBe(true);
});
