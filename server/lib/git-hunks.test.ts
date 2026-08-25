/**
 * Il parse e' la meta' facile. Quella che conta e' se `git apply` ACCETTA la
 * patch che ricostruiamo: i numeri del lato nuovo vanno ricalcolati, e
 * sbagliarli non da' un risultato storto ma un «corrupt patch» — oppure, con
 * `--recount`, uno stage silenziosamente spostato. Quindi qui si applica per
 * davvero, su repo veri, e si guarda cosa e' finito nell'indice.
 *
 * @covers GIT-HUNK-01
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { parseUnifiedDiff, buildPatch, summarizeHunks } from "./git-hunks";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Il diff LETTERALE di git per il repo che `preparaRepo` costruisce.
const DIFF = `diff --git a/f.txt b/f.txt
index 7927c62..81300e6 100644
--- a/f.txt
+++ b/f.txt
@@ -1,6 +1,6 @@
 riga 1
 riga 2
-riga 3
+riga 3 MODIFICATA
 riga 4
 riga 5
 riga 6
@@ -8,6 +8,8 @@ riga 7
 riga 8
 riga 9
 riga 10
+riga NUOVA A
+riga NUOVA B
 riga 11
 riga 12
 riga 13
@@ -21,8 +23,6 @@ riga 20
 riga 21
 riga 22
 riga 23
-riga 24
-riga 25
 riga 26
 riga 27
 riga 28
`;

describe("parseUnifiedDiff", () => {
  test("separa l'intestazione dai blocchi", () => {
    const p = parseUnifiedDiff(DIFF);
    expect(p.header[0]).toBe("diff --git a/f.txt b/f.txt");
    expect(p.hunks).toHaveLength(3);
  });

  test("legge i numeri e conta cosa fa ogni blocco", () => {
    const [uno, due, tre] = parseUnifiedDiff(DIFF).hunks;
    expect(uno).toMatchObject({ oldStart: 1, oldCount: 6, added: 1, removed: 1 });
    expect(due).toMatchObject({ oldStart: 8, oldCount: 6, added: 2, removed: 0, context: "riga 7" });
    expect(tre).toMatchObject({ oldStart: 21, oldCount: 8, added: 0, removed: 2 });
  });

  test("un blocco senza virgola vale una riga sola", () => {
    // `@@ -5 +5,2 @@` e' legale e vuol dire conteggio 1.
    const p = parseUnifiedDiff("--- a\n+++ b\n@@ -5 +5,2 @@\n riga\n+nuova\n");
    expect(p.hunks[0]).toMatchObject({ oldStart: 5, oldCount: 1, newCount: 2 });
  });

  test("un diff senza blocchi non e' un errore", () => {
    expect(parseUnifiedDiff("").hunks).toHaveLength(0);
  });
});

describe("buildPatch", () => {
  test("senza blocchi scelti torna null invece di una patch vuota", () => {
    expect(buildPatch(parseUnifiedDiff(DIFF), [])).toBeNull();
  });

  test("un indice fuori portata viene ignorato, non fa esplodere niente", () => {
    expect(buildPatch(parseUnifiedDiff(DIFF), [99])).toBeNull();
    expect(buildPatch(parseUnifiedDiff(DIFF), [0, 99])).toContain("riga 3 MODIFICATA");
  });

  test("il lato VECCHIO resta intatto: la patch si applica all'indice", () => {
    const patch = buildPatch(parseUnifiedDiff(DIFF), [2])!;
    expect(patch).toContain("@@ -21,8");
  });

  test("il lato NUOVO scorre col delta dei blocchi TENUTI, non di quelli saltati", () => {
    // Tenendo solo il terzo, prima di lui non e' stato tenuto niente: delta 0,
    // quindi il nuovo inizio coincide col vecchio.
    expect(buildPatch(parseUnifiedDiff(DIFF), [2])!).toContain("@@ -21,8 +21,6 @@");
    // Tenendo il secondo (+2) e poi il terzo, il terzo scorre di 2.
    const dueEtre = buildPatch(parseUnifiedDiff(DIFF), [1, 2])!;
    expect(dueEtre).toContain("@@ -8,6 +8,8 @@");
    expect(dueEtre).toContain("@@ -21,8 +23,6 @@");
  });

  test("finisce con un a-capo: senza, git rifiuta la patch", () => {
    expect(buildPatch(parseUnifiedDiff(DIFF), [0])!.endsWith("\n")).toBe(true);
  });
});

// ── E qui si smette di parlare di stringhe ──────────────────────────────────

let repo = "";

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function righeIniziali(): string[] {
  return Array.from({ length: 40 }, (_, i) => `riga ${i + 1}\n`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "hunks-"));
  git(["init", "-q", "."]);
  git(["config", "user.email", "a@b.c"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "f.txt"), righeIniziali().join(""));
  git(["add", "-A", "--", "."]);
  git(["commit", "-qm", "primo"]);

  const l = righeIniziali();
  l[2] = "riga 3 MODIFICATA\n";
  l.splice(10, 0, "riga NUOVA A\n", "riga NUOVA B\n");
  l.splice(25, 2);
  writeFileSync(join(repo, "f.txt"), l.join(""));
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function applica(patch: string, args: string[]) {
  execFileSync("git", args, { cwd: repo, input: patch, stdio: ["pipe", "pipe", "pipe"] });
}

describe("git apply accetta davvero la patch ricostruita", () => {
  test("il diff del repo e' quello della fixture", () => {
    // Se questo cade, la fixture di sopra non descrive piu' git e ogni
    // asserzione basata su di lei sta misurando il nulla.
    const vero = git(["diff", "--", "f.txt"]);
    expect(vero.split("\n").slice(2).join("\n")).toBe(DIFF.split("\n").slice(2).join("\n"));
  });

  test("mette in stage SOLO il blocco scelto", () => {
    const patch = buildPatch(parseUnifiedDiff(git(["diff", "--", "f.txt"])), [1])!;
    applica(patch, ["apply", "--cached", "-"]);

    const staged = git(["diff", "--cached", "--", "f.txt"]);
    expect(staged).toContain("riga NUOVA A");
    // Le altre due modifiche restano fuori dall'indice.
    expect(staged).not.toContain("riga 3 MODIFICATA");
    expect(staged).not.toContain("-riga 24");
    // E il file su disco non e' stato toccato: si mette in stage, non si scrive.
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toContain("riga 3 MODIFICATA");
  });

  test("l'ULTIMO blocco da solo: e' quello dove i numeri sbagliati si vedono", () => {
    // Saltando i primi due si saltano +1-1 e +2: con il lato nuovo non
    // ricalcolato, `git apply` risponde «corrupt patch».
    const patch = buildPatch(parseUnifiedDiff(git(["diff", "--", "f.txt"])), [2])!;
    applica(patch, ["apply", "--cached", "-"]);

    const staged = git(["diff", "--cached", "--", "f.txt"]);
    expect(staged).toContain("-riga 24");
    expect(staged).not.toContain("riga NUOVA A");
  });

  test("due blocchi non contigui insieme", () => {
    const patch = buildPatch(parseUnifiedDiff(git(["diff", "--", "f.txt"])), [0, 2])!;
    applica(patch, ["apply", "--cached", "-"]);

    const staged = git(["diff", "--cached", "--", "f.txt"]);
    expect(staged).toContain("riga 3 MODIFICATA");
    expect(staged).toContain("-riga 24");
    expect(staged).not.toContain("riga NUOVA A");
  });

  test("tutti i blocchi: stesso esito di `git add` sul file", () => {
    const patch = buildPatch(parseUnifiedDiff(git(["diff", "--", "f.txt"])), [0, 1, 2])!;
    applica(patch, ["apply", "--cached", "-"]);
    // Niente piu' fuori dall'indice: l'albero e l'indice coincidono.
    expect(git(["diff", "--", "f.txt"]).trim()).toBe("");
  });

  test("togliere dall'indice un blocco solo: la patch va al contrario", () => {
    git(["add", "--", "f.txt"]);
    const patch = buildPatch(parseUnifiedDiff(git(["diff", "--cached", "--", "f.txt"])), [1])!;
    applica(patch, ["apply", "--cached", "-R", "-"]);

    const staged = git(["diff", "--cached", "--", "f.txt"]);
    expect(staged).not.toContain("riga NUOVA A");
    expect(staged).toContain("riga 3 MODIFICATA");
    // Il file su disco ce l'ha ancora: e' uscito dall'indice, non dal lavoro.
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toContain("riga NUOVA A");
  });

  test("scartare un blocco solo: quello sparisce DAL FILE, gli altri no", () => {
    const patch = buildPatch(parseUnifiedDiff(git(["diff", "--", "f.txt"])), [1])!;
    applica(patch, ["apply", "-R", "-"]);

    const contenuto = readFileSync(join(repo, "f.txt"), "utf8");
    expect(contenuto).not.toContain("riga NUOVA A");
    expect(contenuto).toContain("riga 3 MODIFICATA");
    expect(contenuto).not.toContain("riga 24\n");
  });

  test("un file senza a-capo finale: la nota `\\ No newline` non conta come riga", () => {
    // Contarla sballa i totali nell'intestazione e la patch viene rifiutata.
    writeFileSync(join(repo, "senza.txt"), "uno\ndue");
    git(["add", "--", "senza.txt"]);
    git(["commit", "-qm", "senza a-capo"]);
    writeFileSync(join(repo, "senza.txt"), "uno\nDUE");

    const parsed = parseUnifiedDiff(git(["diff", "--", "senza.txt"]));
    const patch = buildPatch(parsed, [0])!;
    applica(patch, ["apply", "--cached", "-"]);
    expect(git(["diff", "--cached", "--", "senza.txt"])).toContain("+DUE");
  });
});

describe("summarizeHunks", () => {
  test("da alla UI di che si tratta senza portarsi dietro le righe", () => {
    const s = summarizeHunks(parseUnifiedDiff(DIFF));
    expect(s).toHaveLength(3);
    expect(s[1]).toEqual({ index: 1, context: "riga 7", added: 2, removed: 0, oldStart: 8 });
  });
});
