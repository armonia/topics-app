/**
 * Le fixture sono l'output LETTERALE di `git show`, catturato da un repo vero.
 * Il punto e' proprio che assomiglia a `--porcelain -z` senza esserlo.
 *
 * @covers GIT-COMMIT-VIEW-01
 */
import { test, expect, describe } from "bun:test";
import { parseNameStatusZ, mergeCommitFiles, scopeCommitFiles } from "./git-show";

// git show --name-status -z --format= HEAD
const NAME_STATUS = "A\x00agg.md\x00D\x00città.md\x00R100\x00vecchio.md\x00nuovo.md\x00M\x00t.md\x00";
// git show --numstat -z --format= HEAD  (stesso commit)
const NUMSTAT = "1\t0\tagg.md\x000\t1\tcittà.md\x000\t0\t\x00vecchio.md\x00nuovo.md\x001\t0\tt.md\x00";

describe("parseNameStatusZ", () => {
  test("la lettera e' un campo a se', non incollata al path", () => {
    // In `--porcelain -z` sarebbe " M t.md" tutto insieme: chi riusa quel
    // parser qui legge "M" come record troppo corto, lo salta, e la lista dei
    // file di ogni commit esce vuota senza un errore.
    const v = parseNameStatusZ(NAME_STATUS);
    expect(v.map(x => x.path)).toEqual(["agg.md", "città.md", "nuovo.md", "t.md"]);
    expect(v.map(x => x.status)).toEqual(["A", "D", "R", "M"]);
  });

  test("il punteggio del rename non finisce nello stato", () => {
    // `R100` vuol dire rename identico al 100%: la lettera e' una sola.
    const [rinominato] = parseNameStatusZ("R100\x00vecchio.md\x00nuovo.md\x00");
    expect(rinominato.status).toBe("R");
    expect(rinominato.origPath).toBe("vecchio.md");
    expect(rinominato.path).toBe("nuovo.md");
  });

  test("i tre campi del rename non fanno slittare i record successivi", () => {
    const v = parseNameStatusZ("R100\x00a.md\x00b.md\x00M\x00dopo.md\x00");
    expect(v).toHaveLength(2);
    expect(v[1]).toEqual({ path: "dopo.md", status: "M" });
  });

  test("un commit vuoto e' una lista vuota, non un errore", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });
});

describe("mergeCommitFiles", () => {
  test("mette insieme il cosa e il quanto", () => {
    const f = mergeCommitFiles(NAME_STATUS, NUMSTAT);
    expect(f).toHaveLength(4);
    expect(f.find(x => x.path === "agg.md")).toMatchObject({ status: "A", added: 1, removed: 0 });
    expect(f.find(x => x.path === "città.md")).toMatchObject({ status: "D", added: 0, removed: 1 });
    expect(f.find(x => x.path === "t.md")).toMatchObject({ status: "M", added: 1, removed: 0 });
  });

  test("il rename tiene il path di provenienza e i suoi zero", () => {
    const rinominato = mergeCommitFiles(NAME_STATUS, NUMSTAT).find(x => x.path === "nuovo.md")!;
    expect(rinominato.status).toBe("R");
    expect(rinominato.origPath).toBe("vecchio.md");
    expect(rinominato.added).toBe(0);
    expect(rinominato.removed).toBe(0);
  });

  test("un file senza conteggi resta a zero invece di sparire", () => {
    // Il cambio di solo modo (chmod) compare in name-status e non in numstat:
    // scartarlo vorrebbe dire che il commit sembra non averlo toccato.
    const f = mergeCommitFiles("M\x00solo-modo.sh\x00", "");
    expect(f).toEqual([{ path: "solo-modo.sh", status: "M", added: 0, removed: 0 }]);
  });

  test("un binario e' segnato come tale", () => {
    const f = mergeCommitFiles("M\x00logo.png\x00", "-\t-\tlogo.png\x00");
    expect(f[0]).toMatchObject({ binary: true, added: 0, removed: 0 });
  });
});

describe("scopeCommitFiles", () => {
  const files = mergeCommitFiles(
    "M\x00sotto/a.md\x00M\x00fuori/b.md\x00",
    "3\t1\tsotto/a.md\x005\t0\tfuori/b.md\x00",
  );

  test("tiene solo i file della sottocartella e accorcia i path", () => {
    const out = scopeCommitFiles(files, "sotto/");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ path: "a.md", added: 3, removed: 1 });
  });

  test("senza prefisso non tocca niente", () => {
    expect(scopeCommitFiles(files, "")).toHaveLength(2);
  });

  test("un rename che viene da FUORI tiene il path di provenienza intero", () => {
    // Accorciarlo darebbe un path che non esiste da nessuna parte.
    const f = mergeCommitFiles("R100\x00altrove/v.md\x00sotto/n.md\x00", "");
    const [out] = scopeCommitFiles(f, "sotto/");
    expect(out.path).toBe("n.md");
    expect(out.origPath).toBe("altrove/v.md");
  });
});
